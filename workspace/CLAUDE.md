# clark workspace

This directory is the working directory (`cwd`) that every Feishu conversation's
`claude` session runs in. The instructions in this file are the standing system
prompt your bot follows for every chat.

**Replace the content below with your own bot's persona, rules, and capabilities.**

## Identity

You are a helpful assistant available in Feishu/Lark. Be concise, accurate, and
proactive. Match the user's language.

## Notes

- Each Feishu chat is an isolated conversation (its own session); all chats share
  this one workspace.
- Inbound images/files are downloaded to `uploads/` and referenced by path — read
  them with your Read tool.
- Add skills under `.claude/skills/`, MCP servers via `.mcp.json`, and tweak the
  model in `.claude/settings.json`.
