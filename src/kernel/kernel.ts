import {
  FeishuMessageChannel,
  buildLiveCard,
  extractProgressLine,
  type LiveCardState,
} from "@/providers/feishu";
import { warmPane } from "@/providers/claude";
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

    // Deliver turns Claude Code runs autonomously between clark's own turns — e.g.
    // the doc link it produces after background subagents finish — to the bound chat.
    warmPane.onOutOfBandTurn = this._deliverOutOfBandTurn;
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
   * Kill every stale clark-* pane (and its claude process) left over from a
   * previous run. Delegates to the warm-pane manager's reliable kill-by-PID sweep
   * (awaited, so cleanup is done before the first turn can spawn a fresh pane).
   */
  private async _killOrphanedAgentProcesses(): Promise<void> {
    await warmPane.killAllPanes();
  }

  private _initLarkCliConfig(): void {
    const bot = config.feishu;
    if (!bot.appId || !bot.appSecret) return;
    const dir = bot.larkCliConfigDir;
    const configFile = `${dir}/config.json`;
    if (Bun.file(configFile).size > 0) {
      this._logger.debug({ dir }, "lark-cli config already exists");
      return;
    }
    try {
      const result = Bun.spawnSync(
        ["lark-cli", "config", "init", "--app-id", bot.appId, "--app-secret-stdin", "--brand", "feishu"],
        { stdin: Buffer.from(bot.appSecret), env: { ...Bun.env, LARKSUITE_CLI_CONFIG_DIR: dir } },
      );
      if (result.exitCode === 0) {
        this._logger.info({ dir }, "initialized lark-cli config");
      } else {
        this._logger.warn({ stderr: result.stderr.toString() }, "failed to init lark-cli config");
      }
    } catch (err) {
      // Bun.spawnSync throws (not non-zero exit) when lark-cli is not installed.
      this._logger.warn(
        { err },
        "lark-cli not found — skipping config init; Feishu-API skills will be unavailable",
      );
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
    // Bind the chat→session mapping NOW (not only at turn end) so /stop and
    // rapid follow-up messages resolve to the session that is actually running,
    // and so a failed/aborted first turn still keeps the chat on its session.
    this._sessionManager.bindChatSession(chatId, sessionId);

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
    // Interrupt any in-flight turn for this chat's session, then tear down the
    // warm pane so the next message starts a fresh interactive `claude` session.
    const sessionId = this._sessionManager.getChatSession(chatId);
    if (sessionId) {
      const runningTaskId = this._taskDispatcher.getRunningTaskForSession(sessionId);
      if (runningTaskId) {
        await this._taskDispatcher.deleteTask(runningTaskId).catch(() => {});
      }
    }
    await warmPane.killAllPanes();
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

    let runResult: RunResult | undefined;

    // Streaming delivery: ONE live Feishu card per turn. The "process" — every
    // assistant message except the last: its narration text + its tool/thinking
    // steps — is folded into the card's collapsible "execution steps" dropdown
    // and updated in real time; only the FINAL assistant message renders in the
    // card body. We only know which message is last when the stream ends, hence
    // the one-message buffer: each message is folded into the dropdown once the
    // next arrives, and whatever is still buffered at the end is the final answer.
    let bufferedAssistant: AssistantMessage | undefined;

    // --- Live card state ---
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

    // Fold a confirmed-intermediate message into the process dropdown, in block
    // order: its narration text becomes a process line, its tool/thinking blocks
    // go through ingestProgress. (extractProgressLine intentionally skips text.)
    const foldIntoProcess = (msg: AssistantMessage) => {
      for (const block of msg.content) {
        if (block.type === "text") {
          const t = block.text.trim();
          if (t) progressLines.push(t);
        } else {
          ingestProgress(block);
        }
      }
    };

    const buildCardForState = (state: LiveCardState, finalText?: string) =>
      buildLiveCard({
        progressLines,
        finalText,
        elapsedMs: Date.now() - turnStartedAt,
        state,
        runResult: state === "running" ? undefined : runResult,
        sessionId,
      });

    const postInitialCard = () => {
      writeChain = writeChain.then(async () => {
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
          // The previously-buffered message is now confirmed intermediate → fold
          // it into the process dropdown. The new message becomes the running
          // candidate for the final answer (card body).
          if (bufferedAssistant) {
            foldIntoProcess(bufferedAssistant);
          }
          bufferedAssistant = message;
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
      // Mark the card interrupted so the user isn't stuck on a "running" state
      // (the abort path also sends its own "Task stopped." reply).
      if (liveCardMessageId) {
        const errorCard = buildCardForState("error", _formatErrorText(err));
        await this._messageGateway
          .patchLiveCard(session.id, liveCardMessageId, errorCard)
          .catch(() => {});
      }
      throw err;
    }

    // Drain any pending throttled PATCH before finalizing.
    if (pendingPatchTimer) {
      clearTimeout(pendingPatchTimer);
      pendingPatchTimer = null;
    }
    await writeChain;

    // The buffered message is the final answer → card body. Render only its text
    // (its tool/thinking blocks, if any, were already folded into the dropdown).
    const finalContent = bufferedAssistant
      ? bufferedAssistant.content.filter((c) => c.type === "text")
      : [];
    const finalAssistant: AssistantMessage = {
      id: liveCardMessageId ?? "",
      role: "assistant",
      session_id: session.id,
      content:
        finalContent.length > 0
          ? finalContent
          : [{ type: "text", text: "（本轮没有产生文字结论，过程见下方步骤）" }],
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
          },
        );
        finalized = true;
      } catch (err) {
        this._logger.warn(
          { err, session_id: session.id, message_id: liveCardMessageId },
          "final live card PATCH failed; falling back to plain reply",
        );
        const doneCard = buildCardForState("done", "完整回复见下方消息");
        await this._messageGateway
          .patchLiveCard(session.id, liveCardMessageId, doneCard)
          .catch(() => {});
      }
    }

    if (!finalized) {
      // No live card (initial POST failed) or the final PATCH failed — send the
      // answer as a plain reply so the user still gets it (channel chunks it).
      await this._messageGateway
        .replyMessage(inboundMessage.id, finalAssistant, {
          streaming: false,
          runResult,
        })
        .catch(() => {});
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

    const target = chatId ?? config.notifyChatId;
    if (!target) {
      this._logger.warn(
        { task_id: _taskId },
        "scheduled task has no chat_id and NOTIFY_CHAT_ID is unset — dropping result",
      );
      return;
    }
    (assistantMessage as AssistantMessage & { _feishu_chat_id?: string })._feishu_chat_id = target;
    await this._messageGateway.postMessage(assistantMessage);
  };

  /**
   * Deliver a turn clark did NOT initiate (detected by the warm pane's follower)
   * to the Feishu chat bound to its session. Without this, an autonomous turn's
   * result — e.g. the doc link Claude produces after background subagents finish —
   * would land only in the TUI/transcript and never reach the user. Mirrors the
   * scheduled-task push path: a plain `postMessage` addressed via `_feishu_chat_id`.
   */
  private _deliverOutOfBandTurn = async (
    sessionId: string,
    message: AssistantMessage,
  ): Promise<void> => {
    const chatId = this._sessionManager.getSessionChat(sessionId);
    if (!chatId) {
      this._logger.warn(
        { session_id: sessionId },
        "autonomous turn has no bound chat — dropping",
      );
      return;
    }
    const outbound = {
      role: "assistant",
      session_id: sessionId,
      content: message.content,
      _feishu_chat_id: chatId,
    } as Omit<AssistantMessage, "id"> & { _feishu_chat_id: string };
    try {
      await this._messageGateway.postMessage(outbound);
      this._logger.info(
        { session_id: sessionId, chat_id: chatId },
        "delivered autonomous (out-of-band) turn",
      );
    } catch (err) {
      this._logger.warn(
        { err, session_id: sessionId },
        "failed to deliver autonomous turn",
      );
    }
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
