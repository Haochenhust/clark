---
name: restart
description: >
  Restart clark (the main Bun process). Use when the user says "重启", "restart",
  "restart clark", "/restart", "reboot". Refuses if another conversation has an
  active task running.
user-invocable: true
---

# Restart clark

Safely restart clark's main Bun process: confirm no OTHER conversation has an
in-flight task, then use a detached script to SIGTERM the old process and start a
fresh one.

## Red lines

- **Never bare `kill <pid>`** — that synchronously kills the current Claude Code
  child (including you), and nothing restarts clark. Always use the detached
  `nohup` pattern below.
- **If another conversation has a running/pending task, do NOT restart** — report
  it to the user and let them decide.

## Locate db + pid

clark injects absolute store paths into the agent environment:

```bash
DB="$CLARK_DB"                          # <repo>/store/clark.db
PID_FILE="$CLARK_PID"                   # <repo>/store/clark.pid
ROOT="$(dirname "$(dirname "$DB")")"    # repo root (store/ lives at the root)
LOG="$ROOT/store/clark.stdout.log"
```

## Check for other active tasks

clark runs one turn at a time per session, but other chats may be mid-task. Find
this chat's session, then look for active tasks that belong to anyone else:

```bash
SELF_SESSION=$(sqlite3 "$DB" "SELECT session_id FROM chat_sessions WHERE chat_id = '$FEISHU_CHAT_ID'")

OTHER=$(sqlite3 -separator '|' "$DB" "
  SELECT t.id, t.status
  FROM tasks t
  WHERE t.status IN ('running','pending')
    AND (t.session_id IS NULL OR t.session_id != '$SELF_SESSION')
")

if [ -n "$OTHER" ]; then
  echo "Another conversation has an active task — not restarting:"
  echo "$OTHER"
  exit 1
fi
```

> The task handling THIS restart will itself be `running`; that's expected and is
> filtered out above as "self".

## Execute the restart

```bash
PID=""
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  ps -p "$PID" -o command= 2>/dev/null | grep -q "bun run index.ts" || PID=""
fi
[ -z "$PID" ] && PID=$(pgrep -f "bun run index.ts" | head -1)
if [ -z "$PID" ]; then echo "Error: cannot find running clark process" >&2; exit 1; fi

nohup bash -c "
  sleep 5
  kill $PID
  sleep 3
  cd '$ROOT' && exec bun run index.ts
" >> "$LOG" 2>&1 < /dev/null &
disown

echo "Restart scheduled (SIGTERM PID $PID in 5s, then a fresh instance)."
echo "This conversation will end now; the new instance sends a boot notification."
```

> The 5s delay lets the final reply reach Feishu. `nohup` + `disown` + `< /dev/null`
> detach the restart from this (soon-to-die) process tree.

## Notes

- The in-flight "restart" task can't be marked `completed` after SIGTERM and will
  linger as `running`; this is inherent to self-restart and harmless.
- Restarting aborts all in-flight tasks (`dispatcher.stop()`), including this one.
