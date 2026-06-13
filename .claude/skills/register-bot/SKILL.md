---
name: register-bot
description: "Guide a first-time user through creating a Feishu/Lark bot and connecting it to clark. Use when setting up clark for the first time, or when the user says '/register-bot', 'set up the bot', 'connect Feishu', '注册bot', '配置飞书机器人'."
user-invocable: true
version: 1.0.0
effort: max
---

# Register Bot — connect a Feishu/Lark bot to clark

Guide the user through creating ONE Feishu bot and wiring it into clark. clark is a
**single-bot** app: there is exactly one Feishu app, configured via `FEISHU_APP_ID`
/ `FEISHU_APP_SECRET` in `.env`.

**You (Claude Code) automate what you can — writing `.env`, verifying config. The
user does the browser-only steps on the Feishu Open Platform (create app, tick
permissions, enable events, publish): the Open Platform has no OpenAPI for those,
so they cannot be automated.**

## Prerequisites

- The user can sign in to the Feishu Open Platform <https://open.feishu.cn/app>
  (or Lark <https://open.larksuite.com>).
- Working directory is the clark repo root, and `bun install` has been run.

## Process

### Step 1 — Create the Feishu app (user, in browser)

Open <https://open.feishu.cn/app> → **创建企业自建应用** (Create custom app), fill in
name + icon. Then open **凭证与基础信息** and copy the **App ID** and **App Secret**;
paste them back into the chat.

### Step 2 — Permissions (user ticks in browser; you provide the list)

Go to **权限管理 → 开通权限**. Follow least-privilege — only what clark needs (over-
broad scopes slow down review).

#### Tier 1 — required (9 scopes; without these the bot can't receive/send)

| Scope | Purpose |
|---|---|
| `im:message` | send messages |
| `im:message:send_as_bot` | send as the bot identity |
| `im:message.group_at_msg` | receive group @-messages |
| `im:message.group_at_msg:readonly` | read group @-messages |
| `im:message.p2p_msg` | receive direct messages |
| `im:message.p2p_msg:readonly` | read direct messages |
| `im:chat:readonly` | read basic group info (resolve group names) |
| `im:resource` | download images/files from messages |
| `im:message:reactions_operate` | add/remove emoji reactions |

#### Tier 2 — recommended (the bundled `lark-*` skills use these; low review risk)

Contacts: `contact:user.id:readonly`, `contact:user.base:readonly`, `contact:contact:readonly`
· Docs: `docx:document`, `docx:document:readonly`
· Drive: `drive:drive`, `drive:file`
· Sheets: `sheets:spreadsheet` · Bitable: `bitable:app`
· Wiki: `wiki:wiki`, `wiki:node:read`
· Calendar: `calendar:calendar`, `calendar:calendar.event`, `calendar:calendar.event.attendee`, `calendar:calendar.free_busy:readonly`
· Task: `task:task` · Group mgmt: `im:chat`, `im:chat.member`

#### Tier 3 — optional (slower review; only if the user asks)

Mail (`mail:user_mailbox.message`, `mail:user_mailbox.folder`, `mail:event`),
VC (`vc:meeting`, `vc:record`), Minutes (`minutes:minutes`), Approval (`approval:approval`),
Attendance (`attendance:task`), Board (`board:whiteboard:node:read`, `board:whiteboard:node`),
Slides (`slides:slide`).

Then click **批量开通** (submit for admin approval if required).

### Step 3 — Event subscription (long connection)

**事件与回调 → 事件配置**: set subscription mode to **长连接 (long connection)** — NOT
Webhook (clark uses `@larksuiteoapi/node-sdk`'s WSClient, which requires long
connection). Add events:

- `im.message.receive_v1` — receive messages
- `im.message.recalled_v1` — message recall

### Step 4 — Publish (user, in browser)

**版本管理与发布** → create a version → set availability → submit for review
(self-approve if you are the admin). **The bot receives nothing until a version is
published.**

### Step 5 — Write `.env` (you, automated)

Copy `.env.example` to `.env` if needed, then set the single bot's creds:

```
FEISHU_APP_ID=cli_xxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
```

Optional: `NOTIFY_CHAT_ID` (chat to send the boot notification to),
`LARKSUITE_CLI_CONFIG_DIR` (if using the `lark-*` skills).
**Do NOT set `ANTHROPIC_API_KEY`** — clark drives interactive `claude` on your
Claude Code subscription; setting it would force per-API-token billing.

### Step 6 — Make sure Claude Code is logged in

clark runs your local `claude` CLI interactively inside tmux. Run `claude` once,
sign in with your subscription, and accept the trust prompt for the `workspace/`
directory (so clark's sessions don't stall on it). Also ensure `tmux` is installed
(`tmux -V`).

### Step 7 — Customize the bot

Edit `workspace/CLAUDE.md` — that file is your bot's standing instructions / persona
for every conversation.

### Step 8 — Verify + start (you verify; user starts)

Run this checklist and report results:

- [ ] `.env` has non-empty `FEISHU_APP_ID` + `FEISHU_APP_SECRET` (grep to verify)
- [ ] user confirms Tier 1 (and any Tier 2) permissions are granted
- [ ] user confirms event subscription = long connection + the two IM events
- [ ] user confirms the app version is published
- [ ] `claude` is logged in and `tmux` is installed

When all pass, start clark: `bun run dev`. Then send the bot a direct message — it
should reply within a few seconds.

## What can't be automated

The Feishu Open Platform has **no OpenAPI** for: creating the app, ticking
permissions, configuring events, or publishing a version. **Never pretend these
steps are done** — wait for the user to confirm before moving to the next step.

## Notes

- A bot's identity is its `app_id` + `app_secret` (no `lark-cli auth login` — that
  is user OAuth, a different thing).
- clark serves exactly one bot. Each Feishu chat is an isolated conversation (its
  own session); all chats share the single `workspace/`.
- If credentials are missing or wrong, clark fails fast at startup with a clear
  error — re-check `.env`.
