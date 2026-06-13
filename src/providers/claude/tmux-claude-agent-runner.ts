/**
 * TmuxClaudeAgentRunner — drives the *interactive* `claude` CLI inside a tmux
 * pane instead of `claude -p`, so usage stays on the Claude Code subscription.
 *
 * Per turn (v1, ephemeral pane):
 *   1. write a `--settings` file whose Stop hook `touch`es a sentinel,
 *   2. `tmux new-session -d` running `claude --resume|--session-id … --settings …`
 *      (NO `--print`; ANTHROPIC_API_KEY is unset so it uses subscription auth),
 *   3. wait for the TUI to settle, then inject the prompt via bracketed paste,
 *   4. tail `~/.claude/projects/<cwd>/<sessionId>.jsonl`, yielding each new
 *      assistant/tool/system message as it lands,
 *   5. stop when the Stop-hook sentinel appears, synthesize a RunResult, kill
 *      the pane.
 *
 * It matches the AgentRunner contract 1:1 (same 4 yielded shapes), so no
 * consumer (live card, Session.stream) changes.
 *
 * NB: the readiness/trust-prompt heuristic (waitUntilReady) is the main
 * runtime-tunable part — validate against your machine + claude version.
 * Tunables: CLARK_TMUX_* env vars (see below).
 *
 * Known v1 limitations (to harden later): all chats share one workspace cwd /
 * project dir; and a resumed session that Claude forks to a NEW transcript id
 * surfaces only as a fast "no output" failure — the planned fix is a SessionStart
 * hook that reports the real session id. Long-lived warm panes + idle eviction +
 * restart re-attach are a planned v2.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  config,
  createLogger,
  extractTextContent,
  getEnv,
  type AgentRunOptions,
  type AgentRunner,
  type AssistantMessage,
  type RunResult,
  type SystemMessage,
  type ToolMessage,
  type UserMessage,
} from "@/sys";

const logger = createLogger("tmux-claude-runner");

/** Thrown when the run is aborted via the AbortSignal. */
export class AgentAbortError extends Error {
  constructor(message = "Agent execution was aborted") {
    super(message);
    this.name = "AgentAbortError";
  }
}

// --- tunables (env, with sane defaults) ---
const PANE_COLS = parseInt(getEnv("CLARK_TMUX_COLS", "200"), 10);
const PANE_ROWS = parseInt(getEnv("CLARK_TMUX_ROWS", "50"), 10);
/** Screen must be unchanged for this long before we consider the TUI ready. */
const READY_QUIESCE_MS = parseInt(getEnv("CLARK_TMUX_READY_QUIESCE_MS", "800"), 10);
const READY_TIMEOUT_MS = parseInt(getEnv("CLARK_TMUX_READY_TIMEOUT_MS", "30000"), 10);
/** Poll interval while tailing the transcript + watching for the sentinel. */
const TAIL_POLL_MS = parseInt(getEnv("CLARK_TMUX_TAIL_POLL_MS", "250"), 10);
/** Fail fast if claude produces NO transcript output within this long after injecting. */
const RESPONSE_GRACE_MS = parseInt(getEnv("CLARK_TMUX_RESPONSE_GRACE_MS", "30000"), 10);
/** Hard ceiling on a single turn. */
const TURN_TIMEOUT_MS = parseInt(getEnv("CLARK_TMUX_TURN_TIMEOUT_MS", "600000"), 10);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a tmux subcommand, capturing stdout/stderr. Never throws — tmux-absent → code 127. */
async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: 127, stdout: "", stderr: "tmux not found — install tmux (e.g. brew install tmux)" };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function paneAlive(name: string): Promise<boolean> {
  return (await tmux(["has-session", "-t", name])).code === 0;
}

async function capturePane(name: string): Promise<string> {
  return (await tmux(["capture-pane", "-p", "-t", name])).stdout;
}

async function killPane(name: string): Promise<void> {
  await tmux(["kill-session", "-t", name]);
}

/** The `--settings` JSON that registers a Stop hook touching `sentinel`. */
function stopHookSettings(sentinel: string): string {
  return JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `touch ${shellQuote(sentinel)}` }] }],
    },
  });
}

const projectsRoot = join(homedir(), ".claude", "projects");

/** Find `<sessionId>.jsonl` anywhere under ~/.claude/projects (ids are globally unique). */
function findTranscriptById(sessionId: string): string | null {
  if (!existsSync(projectsRoot)) return null;
  for (const dir of readdirSync(projectsRoot)) {
    const p = join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Count complete (newline-terminated) lines in transcript text. `split("\n")` on
 * a newline-terminated file yields a trailing "" (or a partial half-written line
 * mid-write); the last element is therefore never a complete line, so we drop it.
 * Counting it would skip one real line on every poll.
 */
function countCompleteLines(raw: string): number {
  return Math.max(0, raw.split("\n").length - 1);
}

interface RunState {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  contextUsed: number | undefined;
}

/**
 * Parse one Claude Code transcript (.jsonl) line into our message shape.
 * Returns null for line types we don't surface (attachment, skill_listing,
 * hook_success, the user's own prompt echo, summaries, etc.).
 */
function parseJsonlLine(
  line: string,
  sessionId: string,
  state: RunState,
): SystemMessage | AssistantMessage | ToolMessage | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const type = obj?.type;

  if (type === "system") {
    return {
      id: obj.uuid ?? randomUUID(),
      session_id: obj.sessionId ?? obj.session_id ?? sessionId,
      role: "system",
      subtype: obj.subtype ?? "",
    };
  }

  if (type === "assistant") {
    const msg = obj.message ?? {};
    if (msg.usage) {
      const u = msg.usage;
      state.contextUsed =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      state.inputTokens = u.input_tokens ?? state.inputTokens;
      state.outputTokens += u.output_tokens ?? 0;
      state.cacheRead = u.cache_read_input_tokens ?? state.cacheRead;
      state.cacheCreation = u.cache_creation_input_tokens ?? state.cacheCreation;
    }
    if (msg.model) state.model = msg.model;
    return {
      id: obj.uuid ?? msg.id ?? randomUUID(),
      session_id: sessionId,
      role: "assistant",
      content: (msg.content ?? []) as AssistantMessage["content"],
    };
  }

  if (type === "user") {
    const content = obj.message?.content;
    const hasToolResult = Array.isArray(content) && content.some((c: any) => c?.type === "tool_result");
    if (!hasToolResult) return null; // the user's own prompt echo — already emitted upstream
    return {
      id: obj.uuid ?? randomUUID(),
      session_id: sessionId,
      role: "tool",
      content: content as ToolMessage["content"],
    };
  }

  return null;
}

export class TmuxClaudeAgentRunner implements AgentRunner {
  readonly type = "claude";

  async *stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage | RunResult> {
    const sessionId = userMessage.session_id;
    const resume = !options.isNewSession;
    const cwd = options.cwd;
    const signal = options.signal;
    const prompt = extractTextContent(userMessage);

    const turnId = randomUUID();
    const name = `clark-${turnId.slice(0, 8)}`;
    const dir = join(config.paths.store, "clark-tmux");
    mkdirSync(dir, { recursive: true });
    const sentinel = join(dir, `stop-${turnId}.done`);
    const settingsPath = join(dir, `settings-${turnId}.json`);
    const promptFile = join(dir, `prompt-${turnId}.txt`);
    writeFileSync(settingsPath, stopHookSettings(sentinel));
    rmSync(sentinel, { force: true });

    const checkAbort = () => {
      if (signal?.aborted) throw new AgentAbortError();
    };

    // Build the claude argv. NO --print (interactive ⇒ subscription auth).
    // Model is explicit; effort comes from the workspace .claude/settings.json.
    const claudeArgs = [
      resume ? "--resume" : "--session-id",
      sessionId,
      "--model",
      config.agents.default.model,
      "--settings",
      settingsPath,
    ];
    // `unset ANTHROPIC_API_KEY` is critical: if it leaks in from the tmux server
    // env, claude would bill per-API-token instead of using the subscription.
    const command = `unset ANTHROPIC_API_KEY; exec ${["claude", ...claudeArgs].map(shellQuote).join(" ")}`;

    // Env passed into the pane (lark-cli targeting + skill helpers); never ANTHROPIC_API_KEY.
    const envArgs: string[] = [];
    const pushEnv = (k: string, v: string | undefined) => {
      if (v) envArgs.push("-e", `${k}=${v}`);
    };
    pushEnv("FEISHU_APP_ID", config.feishu.appId);
    pushEnv("FEISHU_APP_SECRET", config.feishu.appSecret);
    pushEnv("LARKSUITE_CLI_CONFIG_DIR", config.feishu.larkCliConfigDir);
    if (options.chatId) pushEnv("FEISHU_CHAT_ID", options.chatId);
    // Absolute store paths + the running session id, so workspace skills
    // (scheduled-tasks, restart) reach the db/pid and identify themselves
    // without guessing the repo root from a (possibly custom) workspace cwd.
    pushEnv("CLARK_DB", config.paths.resolveDataFilePath("clark.db"));
    pushEnv("CLARK_PID", config.paths.resolveDataFilePath("clark.pid"));
    pushEnv("CLARK_SESSION_ID", sessionId);

    const launchedAt = Date.now();
    const state: RunState = {
      model: config.agents.default.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      contextUsed: undefined,
    };

    try {
      checkAbort();
      logger.debug({ session_id: sessionId, resume, name, cwd }, "spawning tmux claude pane");
      const created = await tmux([
        "new-session",
        "-d",
        "-s",
        name,
        "-x",
        String(PANE_COLS),
        "-y",
        String(PANE_ROWS),
        "-c",
        cwd,
        ...envArgs,
        command,
      ]);
      if (created.code !== 0) {
        throw new Error(`tmux new-session failed: ${created.stderr.trim()}`);
      }

      await this._waitUntilReady(name, signal);

      // Resolve the transcript path by session id (forked-resume ids surface as a
      // fast "no output" failure via the grace check below).
      let transcript = findTranscriptById(sessionId);
      let baselineLines = transcript ? countCompleteLines(readFileSync(transcript, "utf-8")) : 0;

      // Inject the prompt via bracketed paste, then Enter.
      checkAbort();
      writeFileSync(promptFile, prompt);
      await tmux(["load-buffer", "-b", "clark", promptFile]);
      await tmux(["paste-buffer", "-b", "clark", "-p", "-d", "-t", name]);
      await tmux(["send-keys", "-t", name, "Enter"]);
      logger.debug({ session_id: sessionId, bytes: prompt.length }, "prompt injected");
      const injectedAt = Date.now();

      // Tail the transcript and watch for the Stop sentinel.
      let done = false;
      let sawContent = false;
      while (true) {
        checkAbort();
        if (Date.now() - launchedAt > TURN_TIMEOUT_MS) {
          logger.warn({ session_id: sessionId }, "turn timeout — abandoning");
          break;
        }

        if (!transcript) transcript = findTranscriptById(sessionId);

        if (transcript) {
          // Drop the trailing split element (empty terminator or partial write).
          const complete = readFileSync(transcript, "utf-8").split("\n").slice(0, -1);
          for (let i = baselineLines; i < complete.length; i++) {
            const line = complete[i]?.trim();
            if (!line) continue;
            const parsed = parseJsonlLine(line, sessionId, state);
            if (parsed) yield parsed;
          }
          if (complete.length > baselineLines) sawContent = true;
          baselineLines = complete.length;
        }

        if (done) break;
        if (existsSync(sentinel)) {
          // Turn finished; loop once more to drain any final lines, then exit.
          done = true;
          continue;
        }
        // Fail fast if claude produced nothing this turn (bad login, lost prompt,
        // or a resumed session that forked to a different transcript id).
        if (!sawContent && Date.now() - injectedAt > RESPONSE_GRACE_MS) {
          throw new Error(
            "claude produced no transcript output for this turn — check that `claude` is logged in, " +
              "tmux input reached the pane, and the resumed session id matches its transcript",
          );
        }
        await sleep(TAIL_POLL_MS);
      }

      const result: RunResult = {
        type: "run_result",
        model: state.model,
        cost_usd: 0, // not reported by interactive transcripts; left at 0 for v1
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          cache_read_input_tokens: state.cacheRead,
          cache_creation_input_tokens: state.cacheCreation,
        },
        context_used: state.contextUsed,
      };
      yield result;
    } finally {
      await killPane(name);
      rmSync(sentinel, { force: true });
      rmSync(settingsPath, { force: true });
      rmSync(promptFile, { force: true });
    }
  }

  /**
   * Wait for the TUI to render and settle before injecting. Heuristic — the
   * Stop hook can't help before the first turn. Accepts the workspace-trust
   * prompt defensively if it appears (best practice: pre-trust the workspace
   * by running `claude` in it once).
   */
  private async _waitUntilReady(name: string, signal?: AbortSignal): Promise<void> {
    const start = Date.now();
    let lastHash = "";
    let stableSince = Date.now();
    while (true) {
      if (signal?.aborted) throw new AgentAbortError();
      if (!(await paneAlive(name))) {
        throw new Error("claude pane exited before becoming ready (check `claude` login / install)");
      }
      const screen = await capturePane(name);
      if (/trust the files|Do you trust/i.test(screen)) {
        await tmux(["send-keys", "-t", name, "Enter"]);
      }
      const hash = `${screen.length}:${screen.slice(-220)}`;
      if (hash === lastHash) {
        if (Date.now() - stableSince >= READY_QUIESCE_MS) return;
      } else {
        lastHash = hash;
        stableSince = Date.now();
      }
      if (Date.now() - start > READY_TIMEOUT_MS) {
        logger.warn({ name }, "readiness wait timed out; injecting anyway");
        return;
      }
      await sleep(150);
    }
  }
}
