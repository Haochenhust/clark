/**
 * WarmPaneManager — the single, long-lived interactive `claude` pane that clark
 * feeds messages into. v2 model (single-conversation, strictly serial):
 *
 *   - ONE warm pane at a time, bound to the current session. It is spawned cold
 *     on the first message of a session and then KEPT ALIVE — there is no idle
 *     timeout. It is torn down only by `/new` (reset), a session switch, or a
 *     health failure (see below). Subsequent messages inject into the already-
 *     ready prompt, so the readiness/injection race is paid once per session,
 *     not once per message.
 *
 *   - Every TURN is time-boxed independently of the pane's lifetime. The monitor
 *     is a set of bounded signals (done / pane-death / idle-stall / hard-deadline
 *     / abort); the only unbounded one is the happy-path "done", so a turn can
 *     never hang the pipeline. A turn that stalls/times out is abandoned with a
 *     user-visible notice WITHOUT killing the pane.
 *
 *   - Fault replacement (the one exception to "only /new closes it"): if a turn
 *     leaves claude wedged mid-turn, we interrupt it (Esc) back to the prompt; if
 *     that fails, we tear the pane down and the NEXT message transparently
 *     respawns with `--resume <sessionId>` — the conversation is on disk, so no
 *     context is lost. This is health-driven, not time-driven.
 *
 * The manager is a module-level singleton (`warmPane`) because createAgentRunner()
 * builds a fresh runner per turn, so the pane state must outlive any one runner.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  type AssistantMessage,
  type RunResult,
  type SystemMessage,
  type ToolMessage,
  type UserMessage,
} from "@/sys";

const logger = createLogger("warm-pane");

/** Thrown when the turn is aborted via the AbortSignal (e.g. /stop, /new, shutdown). */
export class AgentAbortError extends Error {
  constructor(message = "Agent execution was aborted") {
    super(message);
    this.name = "AgentAbortError";
  }
}

// --- tunables (env, with sane defaults) ---
const PANE_COLS = parseInt(getEnv("CLARK_TMUX_COLS", "200"), 10);
const PANE_ROWS = parseInt(getEnv("CLARK_TMUX_ROWS", "50"), 10);
/** Screen must be unchanged for this long before the cold-start TUI is "ready". */
const READY_QUIESCE_MS = parseInt(getEnv("CLARK_TMUX_READY_QUIESCE_MS", "800"), 10);
const READY_TIMEOUT_MS = parseInt(getEnv("CLARK_TMUX_READY_TIMEOUT_MS", "30000"), 10);
/** Poll interval while tailing the transcript + watching the bounded signals. */
const TAIL_POLL_MS = parseInt(getEnv("CLARK_TMUX_TAIL_POLL_MS", "250"), 10);
/** Pause after pasting the prompt before sending Enter, so Ink absorbs the paste. */
const INJECT_ENTER_DELAY_MS = parseInt(getEnv("CLARK_TMUX_INJECT_ENTER_DELAY_MS", "200"), 10);
/** If no real turn starts within this long after an inject, re-inject (lost paste). */
const REINJECT_WAIT_MS = parseInt(getEnv("CLARK_TMUX_REINJECT_WAIT_MS", "6000"), 10);
/** Max prompt injection attempts (initial + retries) before declaring inject_fail. */
const MAX_INJECT_ATTEMPTS = parseInt(getEnv("CLARK_TMUX_MAX_INJECT_ATTEMPTS", "3"), 10);
/** Fail fast if NO real turn starts within this long after injecting (lost prompt). */
const RESPONSE_GRACE_MS = parseInt(getEnv("CLARK_TMUX_RESPONSE_GRACE_MS", "30000"), 10);
/** After the Stop sentinel fires, keep tailing this long to drain the final line. */
const STOP_DRAIN_MS = parseInt(getEnv("CLARK_TMUX_STOP_DRAIN_MS", "1500"), 10);
/**
 * The deadlock guard: a turn is "wedged" only when it shows NO sign of life for
 * this long — no transcript growth AND the claude process tree burns no CPU. A
 * genuinely long task (compile / deep think / download) keeps the tree busy, so
 * it is never killed merely for taking a while; only a tool hung on a dead socket
 * (idle tree) trips this. There is deliberately NO hard total-time ceiling — a
 * runaway that keeps burning CPU is left for the user to `/stop`.
 */
const NO_LIFE_MS = parseInt(getEnv("CLARK_TURN_NO_LIFE_MS", "300000"), 10);
/** How often to sample process-tree CPU (cheaper than every tail poll). */
const CPU_PROBE_MS = parseInt(getEnv("CLARK_CPU_PROBE_MS", "5000"), 10);
/** Tree CPU% above this counts as "doing real work" → resets the no-life clock. */
const CPU_ACTIVE_PCT = parseFloat(getEnv("CLARK_CPU_ACTIVE_PCT", "2"));
/** Per tmux subcommand timeout — so a wedged tmux server can't hang us. */
const TMUX_CMD_MS = parseInt(getEnv("CLARK_TMUX_CMD_TIMEOUT_MS", "5000"), 10);
/** Grace for a `/exit` to land before we SIGKILL the pane during teardown. */
const EXIT_GRACE_MS = parseInt(getEnv("CLARK_TMUX_EXIT_GRACE_MS", "3000"), 10);

/**
 * Env vars unset before launching the pane's `claude` (only present when clark
 * was itself started from inside a Claude Code / cmux session; if inherited they
 * break subscription billing / transcript capture). See the original runner.
 */
const SANITIZED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_NO_FLICKER",
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  "NODE_OPTIONS",
] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a tmux subcommand with a hard timeout. Never throws — absent tmux → 127. */
async function tmux(
  args: string[],
  timeoutMs = TMUX_CMD_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return { code: 127, stdout: "", stderr: "tmux not found — install tmux (e.g. brew install tmux)" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    const code = await proc.exited;
    return { code: timedOut ? 124 : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
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

async function sendKey(name: string, key: string): Promise<void> {
  await tmux(["send-keys", "-t", name, key]);
}

/**
 * Sum %CPU across a process and all its descendants (the pane's claude plus any
 * tool subprocesses — bash, web browser, MCP servers). Used as a liveness signal:
 * a genuine long task keeps some of the tree busy; a tool hung on a dead socket
 * leaves the whole tree at ~0%. Returns 0 on any error (treated as "no CPU").
 */
async function treeCpuPercent(rootPid: number): Promise<number> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,pcpu="], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return 0;
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, 5000);
  let out: string;
  try {
    out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    await proc.exited;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }

  const kids = new Map<number, number[]>();
  const pct = new Map<number, number>();
  for (const line of out.split("\n")) {
    const m = line.trim().split(/\s+/);
    if (m.length < 3) continue;
    const pid = parseInt(m[0] ?? "", 10);
    const ppid = parseInt(m[1] ?? "", 10);
    const cpu = parseFloat(m[2] ?? "");
    if (!Number.isFinite(pid)) continue;
    pct.set(pid, Number.isFinite(cpu) ? cpu : 0);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid)!.push(pid);
  }

  let total = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    total += pct.get(p) ?? 0;
    for (const c of kids.get(p) ?? []) stack.push(c);
  }
  return total;
}

/**
 * The pane's `--settings` JSON. A Stop hook touches `sentinel` (so the monitor
 * knows a turn ended) and the interactive tools that would wedge a headless pane
 * are denied (they'd block forever waiting for a user interaction that never comes).
 */
function paneSettings(sentinel: string): string {
  return JSON.stringify({
    permissions: {
      deny: ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"],
    },
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

/** Count complete (newline-terminated) lines; drop the trailing partial/empty element. */
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

function freshState(): RunState {
  return {
    model: config.agents.default.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    contextUsed: undefined,
  };
}

/** Parse one Claude Code transcript object into our message shape (or null to skip). */
function parseTranscriptObj(
  obj: any,
  sessionId: string,
  state: RunState,
): SystemMessage | AssistantMessage | ToolMessage | null {
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

interface WarmPane {
  sessionId: string;
  /** tmux session name, `clark-<sessionId[:8]>` (so the orphan killer matches). */
  name: string;
  sentinel: string;
  settingsPath: string;
  promptFile: string;
  /** PID of the claude process in the pane — root of the CPU liveness probe. */
  panePid?: number;
}

/** The terminal state of one turn. Everything except `done` is a bounded exit. */
type TurnOutcome =
  | { kind: "done" }
  | { kind: "dead"; failureText: string }
  | { kind: "stalled"; failureText: string }
  | { kind: "inject_fail"; failureText: string }
  | { kind: "aborted" };

type StreamYield = SystemMessage | AssistantMessage | ToolMessage | RunResult;

export class WarmPaneManager {
  private _pane: WarmPane | null = null;
  /** Strict serial guard — clark only ever runs one turn at a time. */
  private _busy = false;
  private _logger = logger;

  /**
   * Run one turn for `userMessage` in the warm pane (spawning/reusing as needed),
   * streaming its messages and a final RunResult. Never hangs: every wait is bounded.
   */
  async *stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncGenerator<StreamYield, void, void> {
    if (this._busy) {
      // Should not happen under serial dispatch; defensive — never touch the pane.
      yield this._notice(userMessage.session_id, "（正在处理上一条消息，请稍候…）");
      return;
    }
    this._busy = true;

    const sessionId = userMessage.session_id;
    const state = freshState();
    let pane: WarmPane | null = null;
    let outcome: TurnOutcome = { kind: "done" };

    try {
      pane = await this._ensurePane(sessionId, options);

      const prompt = extractTextContent(userMessage);
      // A prompt starting with `!` is a bash command to the TUI even under paste; neutralize.
      const injectPrompt = prompt.startsWith("!") ? ` ${prompt}` : prompt;
      writeFileSync(pane.promptFile, injectPrompt);
      rmSync(pane.sentinel, { force: true });
      const baseline = this._transcriptLineCount(sessionId);

      await this._injectOnce(pane);
      outcome = yield* this._monitor(pane, options.signal, state, baseline);

      if (outcome.kind === "aborted") throw new AgentAbortError();
      if ("failureText" in outcome) yield this._notice(sessionId, outcome.failureText);
      yield this._buildRunResult(state);
    } catch (err) {
      if (err instanceof AgentAbortError) throw err; // settle in finally, then propagate
      this._logger.error({ err, session_id: sessionId }, "warm pane turn failed");
      yield this._notice(sessionId, "⚠️ 启动 Claude 失败，请重发一次。");
      yield this._buildRunResult(state);
    } finally {
      if (pane) await this._settle(pane, outcome).catch(() => {});
      this._busy = false;
    }
  }

  /**
   * Tear down the warm pane (used by `/new`). The next message spawns a fresh one.
   * Safe to call while a turn is in flight: the in-flight monitor sees the pane
   * die and ends as `dead`; the identity guard in `_settle` avoids clobbering.
   */
  async reset(): Promise<void> {
    const pane = this._pane;
    this._pane = null;
    if (pane) await this._teardown(pane).catch(() => {});
  }

  // --- pane lifecycle ---

  private async _ensurePane(sessionId: string, options: AgentRunOptions): Promise<WarmPane> {
    // Different session (only after /new minted a fresh id) → rotate.
    if (this._pane && this._pane.sessionId !== sessionId) {
      await this._teardown(this._pane);
      this._pane = null;
    }
    // Warm reuse if the pane is still alive.
    if (this._pane) {
      if (await paneAlive(this._pane.name)) return this._pane;
      await this._teardown(this._pane); // dead leftover
      this._pane = null;
    }
    const pane = await this._spawn(sessionId, options);
    this._pane = pane;
    return pane;
  }

  private async _spawn(sessionId: string, options: AgentRunOptions): Promise<WarmPane> {
    const dir = join(config.paths.store, "clark-tmux");
    mkdirSync(dir, { recursive: true });
    const name = `clark-${sessionId.slice(0, 8)}`;
    const pane: WarmPane = {
      sessionId,
      name,
      sentinel: join(dir, `stop-${sessionId}.done`),
      settingsPath: join(dir, `settings-${sessionId}.json`),
      promptFile: join(dir, `prompt-${sessionId}.txt`),
    };
    writeFileSync(pane.settingsPath, paneSettings(pane.sentinel));
    rmSync(pane.sentinel, { force: true });

    // NO --print (interactive ⇒ subscription auth). --resume reuses the on-disk
    // transcript; --session-id only for a brand-new session.
    const claudeArgs = [
      options.isNewSession ? "--session-id" : "--resume",
      sessionId,
      "--model",
      config.agents.default.model,
      "--settings",
      pane.settingsPath,
    ];
    const command = `unset ${SANITIZED_ENV_VARS.join(" ")}; exec ${["claude", ...claudeArgs].map(shellQuote).join(" ")}`;

    const envArgs: string[] = [];
    const pushEnv = (k: string, v: string | undefined) => {
      if (v) envArgs.push("-e", `${k}=${v}`);
    };
    pushEnv("FEISHU_APP_ID", config.feishu.appId);
    pushEnv("FEISHU_APP_SECRET", config.feishu.appSecret);
    pushEnv("LARKSUITE_CLI_CONFIG_DIR", config.feishu.larkCliConfigDir);
    if (options.chatId) pushEnv("FEISHU_CHAT_ID", options.chatId);
    pushEnv("CLARK_DB", config.paths.resolveDataFilePath("clark.db"));
    pushEnv("CLARK_PID", config.paths.resolveDataFilePath("clark.pid"));
    pushEnv("CLARK_SESSION_ID", sessionId);

    this._logger.info({ session_id: sessionId, name, resume: !options.isNewSession }, "spawning warm pane");
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
      options.cwd,
      ...envArgs,
      command,
    ]);
    if (created.code !== 0) {
      throw new Error(`tmux new-session failed: ${created.stderr.trim()}`);
    }
    await this._waitUntilReady(name, options.signal);
    // Record the pane's process (claude, after the shell exec'd into it) so the
    // monitor's CPU liveness probe knows which tree to watch.
    const pidLine = (await tmux(["list-panes", "-t", name, "-F", "#{pane_pid}"])).stdout.trim();
    const pid = parseInt(pidLine.split("\n")[0] ?? "", 10);
    if (Number.isFinite(pid)) pane.panePid = pid;
    return pane;
  }

  /** Wait for the cold-start TUI to render and settle before the first inject. */
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
        await sendKey(name, "Enter");
      }
      const hash = `${screen.length}:${screen.slice(-220)}`;
      if (hash === lastHash) {
        if (Date.now() - stableSince >= READY_QUIESCE_MS) return;
      } else {
        lastHash = hash;
        stableSince = Date.now();
      }
      if (Date.now() - start > READY_TIMEOUT_MS) {
        this._logger.warn({ name }, "readiness wait timed out; injecting anyway");
        return;
      }
      await sleep(150);
    }
  }

  // --- the bounded monitor (replaces the old unbounded while-loop) ---

  private async *_monitor(
    pane: WarmPane,
    signal: AbortSignal | undefined,
    state: RunState,
    baseline: number,
  ): AsyncGenerator<StreamYield, TurnOutcome, void> {
    let transcript = findTranscriptById(pane.sessionId);
    let baselineLines = baseline;
    let sawTurnStart = false;
    let lastLiveAt = Date.now();
    let lastCpuProbeAt = 0;
    const injectedAt = Date.now();
    let lastInjectAt = injectedAt;
    let injectAttempts = 1;
    let done = false;
    let drainUntil = 0;

    while (true) {
      if (signal?.aborted) return { kind: "aborted" };

      if (!transcript) transcript = findTranscriptById(pane.sessionId);
      if (transcript) {
        const complete = readFileSync(transcript, "utf-8").split("\n").slice(0, -1);
        if (complete.length > baselineLines) lastLiveAt = Date.now(); // new transcript = real progress
        for (let i = baselineLines; i < complete.length; i++) {
          const line = complete[i]?.trim();
          if (!line) continue;
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (obj?.type === "user" || obj?.type === "assistant") sawTurnStart = true;
          const parsed = parseTranscriptObj(obj, pane.sessionId, state);
          if (parsed) yield parsed;
        }
        baselineLines = complete.length;
      }

      // Liveness probe (every CPU_PROBE_MS, cheaper than the tail poll): if the
      // claude process tree is burning CPU, real work is happening → stay alive.
      // Combined with transcript growth above, this lets a long-but-working turn
      // run indefinitely while still catching a tool hung on a dead socket.
      if (sawTurnStart && pane.panePid && Date.now() - lastCpuProbeAt > CPU_PROBE_MS) {
        lastCpuProbeAt = Date.now();
        if ((await treeCpuPercent(pane.panePid)) > CPU_ACTIVE_PCT) lastLiveAt = Date.now();
      }

      if (done) {
        if (Date.now() >= drainUntil) return { kind: "done" };
      } else if (existsSync(pane.sentinel)) {
        // Turn finished cleanly; drain the late-flushed final line, then done.
        done = true;
        drainUntil = Date.now() + STOP_DRAIN_MS;
      } else if (!(await paneAlive(pane.name))) {
        return { kind: "dead", failureText: "⚠️ Claude 进程已退出，本轮中断，请重发一次。" };
      } else if (sawTurnStart && Date.now() - lastLiveAt > NO_LIFE_MS) {
        const mins = Math.round(NO_LIFE_MS / 60000);
        this._logger.warn({ session_id: pane.sessionId }, "turn wedged — no progress and no CPU");
        return { kind: "stalled", failureText: `⚠️ 这条消息卡住了（约 ${mins} 分钟无任何进展、进程也没有活动），已中止。可以重试，或把任务拆小一点。` };
      } else if (
        !sawTurnStart &&
        injectAttempts < MAX_INJECT_ATTEMPTS &&
        Date.now() - lastInjectAt > REINJECT_WAIT_MS
      ) {
        injectAttempts++;
        this._logger.warn({ session_id: pane.sessionId, attempt: injectAttempts }, "no turn started — re-injecting");
        await this._injectOnce(pane);
        lastInjectAt = Date.now();
      } else if (!sawTurnStart && Date.now() - injectedAt > RESPONSE_GRACE_MS) {
        this._logger.warn({ session_id: pane.sessionId }, "no turn started within grace — injection failed");
        return { kind: "inject_fail", failureText: "⚠️ 没能把你的消息送达 Claude，请再发一次。" };
      }

      await sleep(TAIL_POLL_MS);
    }
  }

  // --- injection ---

  /** Clear the input (C-u), (re)load + bracketed-paste the prompt, pause, Enter. */
  private async _injectOnce(pane: WarmPane): Promise<void> {
    await tmux(["send-keys", "-t", pane.name, "C-u"]);
    await tmux(["load-buffer", "-b", "clark", pane.promptFile]);
    await tmux(["paste-buffer", "-b", "clark", "-p", "-d", "-t", pane.name]);
    await sleep(INJECT_ENTER_DELAY_MS);
    await tmux(["send-keys", "-t", pane.name, "Enter"]);
  }

  // --- settle / recover / teardown ---

  /** After a turn, return the pane to a reusable state (or drop it if unrecoverable). */
  private async _settle(pane: WarmPane, outcome: TurnOutcome): Promise<void> {
    if (outcome.kind === "done") return; // claude is back at the prompt, stays warm
    if (outcome.kind === "dead") {
      await this._teardown(pane);
      if (this._pane === pane) this._pane = null;
      return;
    }
    // stalled | inject_fail | aborted → claude may be mid-turn; interrupt it.
    const recovered = await this._interruptToIdle(pane);
    if (!recovered) {
      await this._teardown(pane);
      if (this._pane === pane) this._pane = null; // next message respawns via --resume
    }
  }

  /** Send Esc to bail claude's current turn back to the prompt. */
  private async _interruptToIdle(pane: WarmPane): Promise<boolean> {
    if (!(await paneAlive(pane.name))) return false;
    await sendKey(pane.name, "Escape");
    await sleep(300);
    await sendKey(pane.name, "Escape");
    await sleep(400);
    // If still alive after the interrupt, treat as reusable. If it actually
    // didn't recover, the NEXT turn's monitor will stall and respawn — the
    // monitor is the backstop, so an imperfect interrupt is still safe.
    return paneAlive(pane.name);
  }

  /** Graceful `/exit` → bounded wait → SIGKILL. Always ends, always cleans up files. */
  private async _teardown(pane: WarmPane): Promise<void> {
    try {
      await sendKey(pane.name, "Escape");
      await sleep(150);
      await tmux(["send-keys", "-t", pane.name, "-l", "/exit"]);
      await tmux(["send-keys", "-t", pane.name, "Enter"]);
    } catch {
      /* best effort */
    }
    const deadline = Date.now() + EXIT_GRACE_MS;
    while (Date.now() < deadline) {
      if (!(await paneAlive(pane.name))) break;
      await sleep(200);
    }
    await killPane(pane.name);
    rmSync(pane.sentinel, { force: true });
    rmSync(pane.settingsPath, { force: true });
    rmSync(pane.promptFile, { force: true });
  }

  // --- helpers ---

  private _transcriptLineCount(sessionId: string): number {
    const t = findTranscriptById(sessionId);
    return t ? countCompleteLines(readFileSync(t, "utf-8")) : 0;
  }

  private _notice(sessionId: string, text: string): AssistantMessage {
    return {
      id: randomUUID(),
      session_id: sessionId,
      role: "assistant",
      content: [{ type: "text", text }],
    };
  }

  private _buildRunResult(state: RunState): RunResult {
    return {
      type: "run_result",
      model: state.model,
      cost_usd: 0, // interactive transcripts don't report a per-turn dollar cost
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        cache_read_input_tokens: state.cacheRead,
        cache_creation_input_tokens: state.cacheCreation,
      },
      context_window: getEnv("CLARK_CONTEXT_WINDOW")
        ? parseInt(getEnv("CLARK_CONTEXT_WINDOW"), 10)
        : /\[1m\]/i.test(config.agents.default.model)
          ? 1_000_000
          : 200_000,
      context_used: state.contextUsed,
    };
  }
}

/** The process-wide single warm pane. */
export const warmPane = new WarmPaneManager();
