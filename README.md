# clark

**Drive Claude Code as a Feishu/Lark bot — through `tmux`, not `claude -p`.**

clark is a single Feishu bot backed by your local Claude Code. A message from
Feishu is fed to an *interactive* `claude` session running inside a `tmux` pane;
the reply streams back as a live Feishu card. Because it drives the real
interactive CLI (not `claude -p`, not the Agent SDK), every turn runs on your
**Claude Code subscription** instead of per-API-token billing.

> Lineage: extracted from a private multi-bot assistant ("Darwin"), stripped to a
> single bot, with the `claude -p` agent runner replaced by a tmux-driven
> interactive runner.

---

## Why this exists

As of **2026-06-15**, Anthropic bills `claude -p` (print / headless mode) and the
Agent SDK against a **separate API credit pool** — they no longer draw on your
Pro/Max subscription. The *interactive* Claude Code you type into a terminal
**still runs on the subscription**.

So any bot that wants to drive Claude headlessly faces a fork:

| Approach | Billing |
| --- | --- |
| `claude -p` / Agent SDK (e.g. most "remote control" bots) | per-API-token ❌ |
| **Interactive `claude` driven via tmux (clark)** | **subscription ✅** |

clark takes the second path: it programmatically *types into* the interactive
CLI through a tmux pane, so Anthropic sees an ordinary `entrypoint: cli` session.
It **never sets `ANTHROPIC_API_KEY`**.

---

## How it works

```
 Feishu msg ─▶ kernel ─▶ per-chat session ─▶ TmuxClaudeAgentRunner
                                              │
                                              │ 1. tmux new-session: sanitize env,
                                              │    exec  claude --resume|--session-id
                                              │          --settings <stop-hook.json>
                                              │    (NO --print → subscription billing)
                                              │ 2. inject prompt: paste-buffer + Enter
                                              │ 3. tail ~/.claude/projects/<cwd>/<id>.jsonl
                                              │    → assistant / tool / system blocks
                                              │ 4. Stop hook touches a sentinel → turn done
                                              ▼
                          one live Feishu card, updated in real time:
                          · process (narration + tool steps) → collapsible dropdown
                          · final answer                       → card body
```

- **Subscription, not API** — interactive `claude` (entrypoint `cli`, no
  `--print`) is covered by your Pro/Max plan.
- **Turn detection** uses Claude Code's own **Stop hook** (registered via
  `--settings`) writing a sentinel file — no screen-scraping heuristics.
- **Content** is read from the session transcript `.jsonl`, never parsed off the
  TUI. (Interactive `--resume` appends to the *same* file, so multi-turn works.)
- **Per-chat sessions** — each Feishu chat keeps its own conversation thread
  (24 h TTL); all chats share one `workspace/` directory.
- **One pane per turn (v1)** — panes are ephemeral. (Long-lived warm panes with
  idle eviction are planned.)

---

## Design notes — the hard-won lessons

The interesting part of clark is everything that had to be true for "type into a
TUI and read its transcript" to actually work. These are the traps and fixes.

**1. The signal Anthropic bills on.** Billing keys off the *entrypoint*, not the
binary. Interactive = `cli`; `-p` = `print`. clark launches plain interactive
`claude` and keeps `ANTHROPIC_API_KEY` out of the environment, so the turn is
subscription-billed. That's the whole premise.

**2. The child-session trap (the bug that ate a day).** If clark is started from
*inside* another Claude Code / orchestration session, the spawned `claude`
inherits `CLAUDE_CODE_CHILD_SESSION=1` (plus a parent session id and a
`NODE_OPTIONS` shim). That makes it a **nested child**: it answers, it bills, the
Stop hook fires — but it writes **no top-level transcript**, so tailing the
`.jsonl` silently finds nothing. Fix: the runner **sanitizes the environment**
(unsets those vars) before `exec claude`, guaranteeing a clean top-level session
every time. In a normal terminal deployment they're absent anyway — but the
sanitize makes it bulletproof.

**3. Driving an interactive TUI is the real work.** None of this is `claude -p`'s
clean stdio:
- *Readiness* — wait for the TUI to render and settle before injecting.
- *Injection* — bracketed-paste the prompt, pause briefly so Ink absorbs the
  paste, then send Enter (Enter races the paste otherwise). Clear the input with
  `Ctrl-U` first so a partial earlier attempt can't corrupt it.
- *The `!` gotcha* — a message starting with `!` is taken as a **bash command**
  by the TUI (even under bracketed paste). So inbound images are handed to claude
  as a plain `Read <path> to view it` instruction, **not** `![](path)` markdown.
- *Lost-paste recovery* — on a slow session resume the paste can land before the
  input box is ready and vanish. If no real turn starts within a few seconds, the
  runner **re-injects** (up to N times).
- *No silent hang* — if a turn still never starts within the grace window (~30 s),
  it gives up with a "please resend" message instead of waiting forever. (Notably,
  [`claude-pee`](https://github.com/sbhattap/claude-pee) — the same
  PTY + transcript-tail + Stop-hook architecture — has *no* timeout and would hang
  indefinitely here.)

**4. `--resume` appends in place.** Interactive `claude --resume <id>` appends to
the same `<id>.jsonl`. (`claude --print --resume` *forks* to a new id — a
different beast.) That's why tailing one file per chat is enough for multi-turn
memory.

**5. No fake dollar cost.** Subscription turns have no per-token charge, so the
card footer shows token counts but **omits a price** — it only appears if a runner
ever reports a real `cost_usd > 0`.

**6. `effortLevel`, not `effort`.** The `.claude/settings.json` key Claude Code
actually reads for reasoning effort is `effortLevel` (verified empirically;
`effort` is a silent no-op).

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [tmux](https://github.com/tmux/tmux) ≥ 3.x &nbsp;(`brew install tmux`)
- [Claude Code](https://docs.claude.com/en/docs/claude-code), installed and
  **logged in** with your subscription (run `claude` once and sign in)
- A Feishu/Lark account that can create a custom app

## Quick start

```bash
git clone <this repo> && cd clark
bun install

cp .env.example .env            # fill in FEISHU_APP_ID / FEISHU_APP_SECRET (see below)

# one-time: trust the workspace so claude doesn't stall on the trust prompt
( cd workspace && claude )      # answer "Yes, I trust this folder", then /exit

bun run dev                     # migrations auto-apply on first boot
```

`bun run dev` prints `[ws] ws client ready` once the long-connection to Feishu is
up. Send the bot a direct message; it should reply within a few seconds.

> The SQLite schema migration is committed and applied automatically on startup.
> `bun run db:generate` is only needed if you *change* the schema.

## Registering the Feishu bot

The Feishu Open Platform has no API for creating apps / ticking permissions /
publishing, so these steps are manual (a browser). clark also ships a
`/register-bot` skill that walks a fresh user through them interactively.

1. **Create the app** — <https://open.feishu.cn/app> → *创建企业自建应用* (Create
   custom app). Open *凭证与基础信息* and copy the **App ID** + **App Secret** into
   `.env`.

2. **Permissions** — *权限管理 → 开通权限*. Least-privilege; the required 9 scopes
   for receiving/sending messages:

   ```
   im:message                       im:message:send_as_bot
   im:message.group_at_msg          im:message.group_at_msg:readonly
   im:message.p2p_msg               im:message.p2p_msg:readonly
   im:chat:readonly                 im:resource
   im:message:reactions_operate
   ```

   (Optional, only if you want the bundled `lark-*` skills to reach your docs /
   sheets / calendar etc.: add `contact:*`, `docx:*`, `drive:*`, `sheets:*`,
   `wiki:*`, `calendar:*` as needed.)

3. **Events** — *事件与回调 → 事件配置*. Set the subscription mode to **长连接 (long
   connection)**, NOT Webhook — clark uses the SDK's WSClient. Add:

   ```
   im.message.receive_v1     im.message.recalled_v1
   ```

4. **Publish** — *版本管理与发布* → create a version → set availability → submit.
   **The bot receives nothing until a version is published.**

5. **Add the bot capability** if the app doesn't have it — *添加应用能力 → 机器人*.

Then `bun run dev` and DM the bot.

## Configuration

**`.env`**

| Var | Purpose |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | bot credentials (required) |
| `NOTIFY_CHAT_ID` | chat to send the boot/restart notice to (optional) |
| `WORKSPACE_DIR` | the cwd every chat's claude runs in (default `./workspace`) |
| `LARKSUITE_CLI_CONFIG_DIR` | exported into the agent env for the `lark-*` skills (optional) |
| `CLARK_LOG_LEVEL` | `trace`\|`debug`\|`info`\|`warn`\|`error` (default `info`) |

There is deliberately **no `ANTHROPIC_API_KEY`** — setting it would force
per-API-token billing, the exact thing clark avoids.

**`workspace/CLAUDE.md`** — your bot's persona / standing instructions for every
chat. Edit this to define who the bot is.

**`workspace/.claude/settings.json`** — model + reasoning effort the pane's
claude uses:

```json
{ "model": "claude-opus-4-8", "effortLevel": "xhigh" }
```

Lighter/faster: `claude-sonnet-4-6` at `"high"`.

**Runner tunables** (env, sane defaults — rarely needed):
`CLARK_TMUX_TURN_TIMEOUT_MS` (default `0` = no limit),
`CLARK_TMUX_REINJECT_WAIT_MS`, `CLARK_TMUX_MAX_INJECT_ATTEMPTS`,
`CLARK_TMUX_RESPONSE_GRACE_MS`, `CLARK_TMUX_READY_*`, `CLARK_TMUX_COLS/ROWS`.

## Project layout

```
index.ts                      boot entrypoint
src/kernel/                   message dispatch, per-chat sessions, task queue, live-card delivery
src/providers/claude/         TmuxClaudeAgentRunner — the interactive-claude runner
src/providers/feishu/         Feishu channel: inbound parsing, live-card rendering, uploads
src/sys/                      config, messaging types, agent-runner contract, logging
workspace/                    the bot's cwd: CLAUDE.md persona + .claude/ (settings, skills)
drizzle/                      committed SQLite migrations (auto-applied on boot)
```

## License

MIT
