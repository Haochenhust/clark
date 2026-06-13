# clark

**Drive Claude Code as a Feishu/Lark bot — through `tmux`, not `claude -p`.**

clark is a single Feishu bot backed by your local Claude Code. A message from
Feishu is fed to an *interactive* `claude` session running inside a `tmux`
pane; the reply streams back to a Feishu card. Because it drives the real
interactive CLI (not `claude -p`, not the Agent SDK), usage runs on your
**Claude Code subscription** instead of per-API-token billing.

> Lineage: extracted from a private multi-bot assistant ("Darwin"), stripped to
> a single bot, with the `claude -p` agent runner replaced by a tmux-driven
> interactive runner.

## How it works

```
Feishu msg ─▶ kernel ─▶ per-chat session ─▶ TmuxClaudeAgentRunner
                                             │  send-keys / paste-buffer → tmux pane
                                             │      (interactive claude, no --print)
                                             │  Stop hook (--settings) touches a sentinel → turn done
                                             └─ tail ~/.claude/projects/<cwd>/<sessionId>.jsonl → content
                                                                  ▼
                                            assistant blocks ─▶ throttled live Feishu card
```

- **Subscription, not API** — interactive `claude` (entrypoint `cli`, no `--print`) is covered by your Pro/Max plan. clark never sets `ANTHROPIC_API_KEY`.
- **Turn detection** via Claude Code's own **Stop hook** writing a sentinel file — no screen-scraping heuristics.
- **Content** is read from the session transcript `.jsonl`, never from the TUI.
- **Persistence** — tmux sessions outlive the clark process, so a restart re-attaches in-flight turns.
- **Per-chat sessions** — each Feishu chat keeps its own conversation thread; all chats share one workspace.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [tmux](https://github.com/tmux/tmux) ≥ 3.x &nbsp;(`brew install tmux`)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and **logged in** (`claude`, then sign in with your subscription)
- A Feishu/Lark custom app (bot)

## Setup

```bash
bun install
cp .env.example .env          # fill in FEISHU_APP_ID / FEISHU_APP_SECRET
bun run db:generate           # generate the SQLite schema
# put your bot's instructions in workspace/CLAUDE.md
bun run dev
```

## Status

🚧 Work in progress — core extraction and the tmux runner are under active development.

## License

MIT
