import {
  FeishuMessageChannel,
  buildLiveCard,
  extractProgressLine,
  type LiveCardState,
} from "@/providers/feishu";
import * as feishuMessagingSchema from "@/providers/feishu/messaging/data";
import { DataConnection } from "@/data";
import type { AssistantMessage, RunResult, UserMessage } from "@/sys";
import {
  config,
  createLogger,
  extractTextContent,
  uuid,
  type InboundMessageTaskPayload,
  type ScheduledTaskPayload,
} from "@/sys";

import { splitMarkdownBySize } from "@/providers/feishu/messaging/message-renderer";
import { MultiChannelMessageGateway } from "./messaging";
import { SessionManager } from "./sessioning";
import * as sessioningSchema from "./sessioning/data";
import { TaskDispatcher } from "./tasking";
import * as taskingSchema from "./tasking/data";

class Kernel {
  private _logger = createLogger("kernel");
  private _database!: DataConnection;
  private _sessionManager!: SessionManager;
  private _taskDispatcher!: TaskDispatcher;
  private _messageGateway!: MultiChannelMessageGateway;

  constructor() {
    this._initDatabase();
    this._initSessionManager();
    this._initTaskDispatcher();
    this._initMessageGateway();
  }

  get sessionManager() {
    return this._sessionManager;
  }
  get taskDispatcher() {
    return this._taskDispatcher;
  }

  private _initDatabase(): void {
    this._database = new DataConnection({
      ...taskingSchema,
      ...sessioningSchema,
      ...feishuMessagingSchema,
    });
  }

  private _initSessionManager(): void {
    this._sessionManager = new SessionManager(this._database.db);
  }

  private _initTaskDispatcher(): void {
    this._taskDispatcher = new TaskDispatcher({
      db: this._database.db,
      concurrency: config.tasking.concurrency,
    });
    this._taskDispatcher.route(
      "inbound_message",
      this._handleInboundMessageTask,
    );
    this._taskDispatcher.route("scheduled_task", this._handleScheduledTask);
  }

  private _initMessageGateway(): void {
    this._messageGateway = new MultiChannelMessageGateway();

    this._messageGateway.registerChannel(
      new FeishuMessageChannel(this._database.db),
    );

    this._messageGateway.on("message:inbound", this._handleInboundMessage);
    this._messageGateway.on("message:recalled", this._handleMessageRecall);
  }

  async start(): Promise<void> {
    await this._killOrphanedAgentProcesses();
    this._initLarkCliConfig();
    await this._sessionManager.start();
    await this._taskDispatcher.start();
    await this._messageGateway.start();
    this._logger.info("clark kernel started");
    this._notifyRestart();
  }

  /**
   * Kill stale clark tmux panes left over from a previous run. The interactive
   * runner names each pane "clark-<sessionId>"; any such session is orphaned
   * once this process restarts, so tear them all down. Tolerates tmux being
   * absent (no server / not installed).
   */
  private async _killOrphanedAgentProcesses(): Promise<void> {
    try {
      const list = Bun.spawnSync(["tmux", "list-sessions", "-F", "#{session_name}"]);
      if (list.exitCode !== 0) return; // no tmux server / no sessions
      const names = list.stdout
        .toString()
        .split("\n")
        .map((n) => n.trim())
        .filter((n) => n.startsWith("clark-"));
      for (const name of names) {
        Bun.spawn(["tmux", "kill-session", "-t", name]);
      }
      if (names.length > 0) {
        this._logger.info(
          { count: names.length },
          "Killed orphaned clark tmux panes from previous run",
        );
        await Bun.sleep(1000);
      }
    } catch {
      /* tmux not installed — safe to ignore */
    }
  }

  private _initLarkCliConfig(): void {
    const bot = config.feishu;
    const dir = bot.larkCliConfigDir;
    const configFile = `${dir}/config.json`;
    if (Bun.file(configFile).size > 0) {
      this._logger.debug({ dir }, "lark-cli config already exists");
      return;
    }
    const result = Bun.spawnSync(
      ["lark-cli", "config", "init", "--app-id", bot.appId, "--app-secret-stdin", "--brand", "feishu"],
      { stdin: Buffer.from(bot.appSecret), env: { ...Bun.env, LARKSUITE_CLI_CONFIG_DIR: dir } },
    );
    if (result.exitCode === 0) {
      this._logger.info({ dir }, "initialized lark-cli config");
    } else {
      this._logger.warn({ stderr: result.stderr.toString() }, "failed to init lark-cli config");
    }
  }

  private _notifyRestart(): void {
    const chatId = config.notifyChatId;
    if (!chatId) return;
    this._messageGateway
      .sendNotification(
        config.feishu.channelId,
        chatId,
        `${config.assistantName} 已重新启动，所有系统正常运行。`,
      )
      .catch((err) => {
        this._logger.warn({ err }, "Failed to send restart notification");
      });
  }

  /**
   * Reload scheduled tasks from the database and re-register them with bunqueue.
   * Called when the process receives SIGUSR1 (e.g., after a skill inserts new tasks).
   */
  async reloadScheduledTasks(): Promise<void> {
    await this._taskDispatcher.reloadScheduledTasks();
  }

  /**
   * Gracefully shut down the kernel. Stops subsystems in reverse order:
   * gateway (stop accepting messages) → dispatcher (drain queue, kill running agents) → database.
   */
  async stop(): Promise<void> {
    this._logger.info("clark kernel shutting down...");
    this._messageGateway.stop();
    await this._taskDispatcher.stop();
    this._database.close();
    this._logger.info("clark kernel stopped");
  }

  // --- Message handlers ---

  private _handleInboundMessage = async (message: UserMessage) => {
    const text = extractTextContent(message).trim();

    if (text === "/stop") {
      try {
        await this._handleStopCommand(message);
      } catch (err) {
        this._logger.error({ err, message_id: message.id }, "/stop handler failed");
      }
      return;
    }

    if (text === "/new") {
      try {
        await this._handleNewSessionCommand(message);
      } catch (err) {
        this._logger.error({ err, message_id: message.id }, "/new handler failed");
      }
      return;
    }

    // Resume this chat's session (TTL-checked by getChatSession), or mint a
    // fresh one. The chat_id is the conversation key; the session_id is the
    // Claude session bound to it.
    const chatId = this._extractChatId(message);
    let sessionId = this._sessionManager.getChatSession(chatId);
    if (!sessionId) {
      sessionId = uuid();
    }
    message.session_id = sessionId;

    const task: InboundMessageTaskPayload = {
      type: "inbound_message",
      message,
    };
    await this._taskDispatcher.dispatch(sessionId, task);
  };

  private _handleStopCommand = async (message: UserMessage) => {
    const chatId = this._extractChatId(message);
    const sessionId = this._sessionManager.getChatSession(chatId) ?? message.session_id;
    const runningTaskId =
      this._taskDispatcher.getRunningTaskForSession(sessionId);
    if (runningTaskId) {
      await this._taskDispatcher.deleteTask(runningTaskId);
      await this._messageGateway.replyMessage(
        message.id,
        {
          role: "assistant",
          session_id: sessionId,
          content: [{ type: "text", text: "Task stopped." }],
        },
        { streaming: false, channelId: message.channel_id },
      );
    } else {
      await this._messageGateway.replyMessage(
        message.id,
        {
          role: "assistant",
          session_id: sessionId,
          content: [{ type: "text", text: "No running task found." }],
        },
        { streaming: false, channelId: message.channel_id },
      );
    }
  };

  private _handleNewSessionCommand = async (message: UserMessage) => {
    const chatId = this._extractChatId(message);
    this._sessionManager.clearChatSession(chatId);
    await this._messageGateway.replyMessage(
      message.id,
      {
        role: "assistant",
        session_id: message.session_id,
        content: [
          {
            type: "text",
            text: "Session reset. Next message starts a fresh conversation.",
          },
        ],
      },
      { streaming: false, channelId: message.channel_id },
    );
  };

  private _handleMessageRecall = async (
    messageId: string,
    channelId: string,
  ) => {
    const taskId = this._taskDispatcher.getTaskByMessageId(messageId);
    if (taskId) {
      await this._taskDispatcher.deleteTask(taskId);
      this._logger.info(
        { message_id: messageId, task_id: taskId, channel_id: channelId },
        "task stopped due to message recall",
      );
    }
  };

  // --- Task handlers ---

  private _handleInboundMessageTask = async (
    _taskId: string,
    sessionId: string,
    payload: InboundMessageTaskPayload,
    signal?: AbortSignal,
  ) => {
    const inboundMessage = payload.message;
    const chatId = this._extractChatId(inboundMessage);
    const cwd = config.workspaceDir;

    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: inboundMessage.channel_id,
      firstMessage: inboundMessage,
      cwd,
      chatId,
    });

    const contents: AssistantMessage["content"] = [];
    let lastMessage: AssistantMessage | undefined;
    let runResult: RunResult | undefined;

    // --- Live streaming card state (per design/feishu-streaming-design.md §4) ---
    //   progressLines buffered from the content stream, throttled per (category,
    //   key) at 5 s and deduped against the immediately previous line. A single
    //   Feishu card is POSTed on first progress, PATCHed at most every
    //   PATCH_MIN_INTERVAL_MS while content arrives, and finalized via the
    //   channel's full render pipeline at turn-end.
    const PATCH_MIN_INTERVAL_MS = 1500;
    const PROGRESS_THROTTLE_MS = 5000;
    const turnStartedAt = Date.now();
    const progressLines: string[] = [];
    const lastSeenAtByKey = new Map<string, number>();
    let lastProgressKey: string | null = null;
    let liveCardMessageId: string | null = null;
    let lastPatchAt = 0;
    let pendingPatchTimer: ReturnType<typeof setTimeout> | null = null;
    let writeChain: Promise<void> = Promise.resolve();

    const ingestProgress = (block: AssistantMessage["content"][number]) => {
      const extracted = extractProgressLine(block);
      if (!extracted) return;
      const now = Date.now();
      // Per-key window: identical (category, key) within 5 s is dropped. A
      // different tool / different thought always gets through.
      const lastSeen = lastSeenAtByKey.get(extracted.key) ?? 0;
      if (now - lastSeen < PROGRESS_THROTTLE_MS) return;
      // Adjacent dedup: never stutter the same line twice in a row.
      if (extracted.key === lastProgressKey) return;
      lastSeenAtByKey.set(extracted.key, now);
      lastProgressKey = extracted.key;
      progressLines.push(extracted.line);
    };

    const buildCardForState = (state: LiveCardState, finalText?: string) =>
      buildLiveCard({
        progressLines,
        finalText,
        elapsedMs: Date.now() - turnStartedAt,
        state,
        runResult: state === "running" ? undefined : runResult,
        effortLevel: config.agents.default.effortLevel,
        sessionId,
      });

    const postInitialCard = () => {
      writeChain = writeChain.then(async () => {
        // POST unconditionally on first assistant-content arrival so every
        // turn gets the unified live-card UX — even short chats that produce
        // no progress lines (e.g. an empty thinking block + a text answer).
        // Without this, those turns used to fall back to the legacy reply
        // path, showing an awkward empty "Show 1 step" panel.
        if (liveCardMessageId) return;
        try {
          const card = buildCardForState("running");
          liveCardMessageId = await this._messageGateway.postLiveCard(
            session.id,
            inboundMessage.id,
            card,
          );
          lastPatchAt = Date.now();
        } catch (err) {
          this._logger.warn(
            { err, session_id: session.id },
            "live card initial POST failed",
          );
        }
      });
    };

    const schedulePatch = () => {
      if (!liveCardMessageId || pendingPatchTimer) return;
      const elapsed = Date.now() - lastPatchAt;
      const delay = Math.max(0, PATCH_MIN_INTERVAL_MS - elapsed);
      pendingPatchTimer = setTimeout(() => {
        pendingPatchTimer = null;
        writeChain = writeChain.then(async () => {
          if (!liveCardMessageId) return;
          lastPatchAt = Date.now();
          const card = buildCardForState("running");
          await this._messageGateway.patchLiveCard(
            session.id,
            liveCardMessageId,
            card,
          );
        });
      }, delay);
    };

    const onContentAppended = () => {
      if (!liveCardMessageId) {
        postInitialCard();
      } else {
        schedulePatch();
      }
    };

    try {
      const stream = await session.stream(inboundMessage, { signal });
      for await (const message of stream) {
        if ("role" in message && message.role === "assistant") {
          contents.push(...message.content);
          lastMessage = message;
          for (const block of message.content) {
            ingestProgress(block);
          }
          onContentAppended();
        } else if ("type" in message && message.type === "run_result") {
          runResult = message;
        }
      }
    } catch (err) {
      // Cancel any scheduled PATCH and wait for in-flight writes before propagating.
      if (pendingPatchTimer) {
        clearTimeout(pendingPatchTimer);
        pendingPatchTimer = null;
      }
      await writeChain.catch(() => {});
      // Try to mark the card as interrupted so the user isn't left staring at a
      // "still running" state. Best-effort only — if this fails, the caller's
      // error handling still runs below.
      if (liveCardMessageId) {
        const errorCard = buildCardForState("error", _formatErrorText(err));
        await this._messageGateway
          .patchLiveCard(session.id, liveCardMessageId, errorCard)
          .catch(() => {});
      }
      throw err;
    }
    if (!lastMessage) {
      throw new Error("No assistant message received from the agent.");
    }

    // Drain any pending throttled PATCH before finalizing.
    if (pendingPatchTimer) {
      clearTimeout(pendingPatchTimer);
      pendingPatchTimer = null;
    }
    await writeChain;

    const finalAssistant: AssistantMessage = {
      id: liveCardMessageId ?? "",
      role: "assistant",
      session_id: session.id,
      content: contents,
    };

    let finalized = false;
    if (liveCardMessageId && !this._messageGateway.isLiveCardDead(session.id, liveCardMessageId)) {
      try {
        await this._messageGateway.patchFinalLiveCard(
          session.id,
          liveCardMessageId,
          finalAssistant,
          {
            progressLines,
            elapsedMs: Date.now() - turnStartedAt,
            state: "done",
            runResult,
            effortLevel: config.agents.default.effortLevel,
          },
        );
        finalized = true;
      } catch (err) {
        this._logger.warn(
          { err, session_id: session.id, message_id: liveCardMessageId },
          "final live card PATCH failed; falling back to chunked reply",
        );
        // Best-effort: mark the card as "done" so user doesn't see "处理中" forever
        const doneCard = buildCardForState("done", "完整回复见下方消息");
        await this._messageGateway
          .patchLiveCard(session.id, liveCardMessageId, doneCard)
          .catch(() => {});
      }
    }

    if (!finalized) {
      // Either no live card was ever created (short-run turn) or the final
      // PATCH failed. Split content into size-safe chunks and send as
      // multiple reply messages so the user still gets the full answer.
      const lastText = contents.findLast((c) => c.type === "text");
      const replyOpts = {
        streaming: false,
        runResult,
        effortLevel: config.agents.default.effortLevel,
      };
      if (lastText && lastText.type === "text") {
        const chunks = splitMarkdownBySize(lastText.text, 8_000);
        const nonTextContent = contents.filter((c) => c.type !== "text");
        // First chunk: includes non-text content (thinking, tool_use) + first text chunk
        await this._messageGateway.replyMessage(
          inboundMessage.id,
          {
            role: "assistant",
            session_id: session.id,
            content: [...nonTextContent, { type: "text", text: chunks[0]! }],
          },
          replyOpts,
        );
        // Remaining chunks: text-only follow-up replies
        for (let i = 1; i < chunks.length; i++) {
          await this._messageGateway.replyMessage(
            inboundMessage.id,
            {
              role: "assistant",
              session_id: session.id,
              content: [{ type: "text", text: chunks[i]! }],
            },
            { streaming: false },
          );
        }
      } else {
        await this._messageGateway.replyMessage(
          inboundMessage.id,
          { role: "assistant", session_id: session.id, content: contents },
          replyOpts,
        );
      }
    }

    // Remove the ⏱ reaction now that the reply is complete
    this._messageGateway
      .removeReaction(inboundMessage.id, sessionId)
      .catch(() => {});

    // Persist chat → session binding for continuity on the next message.
    this._sessionManager.bindChatSession(chatId, sessionId);
  };

  private _handleScheduledTask = async (
    _taskId: string,
    sessionId: string,
    payload: ScheduledTaskPayload,
    signal?: AbortSignal,
  ) => {
    // chat_id is purely a delivery address here — the single workspace is the cwd.
    const chatId = payload.chat_id;
    const cwd = config.workspaceDir;

    const userMessage: UserMessage = {
      id: uuid(),
      role: "user",
      session_id: sessionId,
      content: [
        {
          type: "text",
          text: `> This message is automatically triggered by a scheduled task.\n> Time: ${new Date().toString()}\n\n${payload.instruction}`,
        },
      ],
    };
    const session = await this._sessionManager.resolveSession(sessionId, {
      channelId: config.feishu.channelId,
      cwd,
      firstMessage: userMessage,
      chatId: chatId ?? undefined,
    });
    const assistantMessage = await session.run(userMessage, { signal });
    if (extractTextContent(assistantMessage).includes("[SKIPPED]")) return;

    if (chatId) {
      (assistantMessage as AssistantMessage & { _feishu_chat_id?: string })
        ._feishu_chat_id = chatId;
    }
    await this._messageGateway.postMessage(assistantMessage);
  };

  /** Extract Feishu chat_id from the message (attached by FeishuMessageChannel). */
  private _extractChatId(message: UserMessage): string {
    const chatId = (message as UserMessage & { _feishu_chat_id?: string })
      ._feishu_chat_id;
    return chatId ?? message.session_id;
  }
}

function _formatErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `⚠️ 运行被中断\n\n${msg}`;
}

export const kernel = new Kernel();
