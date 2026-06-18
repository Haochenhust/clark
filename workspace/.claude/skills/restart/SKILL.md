---
name: restart
description: >
  Restart clark (the main Bun process). Use when the user says "重启", "restart",
  "restart clark", "/restart", "reboot". Refuses if another conversation has an
  active task running.
user-invocable: true
---

# Restart clark

Safely restart clark: confirm no OTHER conversation has an in-flight task, then
restart the process — via `launchctl kickstart` when clark runs as a launchd
service (the common case), or a detached SIGTERM+relaunch when it runs standalone.

## Red lines

- **If clark is launchd-managed, NEVER `kill`+relaunch manually** — launchd auto-
  respawns the killed process while your manual relaunch starts another, leaving
  TWO instances that fight over the warm pane (`duplicate session: clark-…` →
  "启动 Claude 失败" on every turn). Use `launchctl kickstart -k` instead — it
  restarts the one managed instance in place. (This has actually happened.)
- **Never bare `kill <pid>` synchronously** — it kills the current Claude Code
  child (including you) before anything restarts clark. Always detach via the
  `nohup` pattern below so the restart outlives this turn.
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

clark runs one turn at a time per session, but other chats may be mid-task. This
turn's own session id is in `$CLARK_SESSION_ID`; look for active tasks belonging
to anyone else:

```bash
SELF_SESSION="$CLARK_SESSION_ID"

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

Detect how clark runs and restart accordingly. The 5s detached delay lets the
final reply reach Feishu before the process (and this conversation) dies; `nohup`
+ `disown` + `< /dev/null` detach the restart from this (soon-to-die) process tree.

```bash
# launchctl lists managed services as "PID  Status  Label"; column 3 is the label.
LABEL=$(launchctl list 2>/dev/null | awk '/clark/ {print $3}' | head -1)

if [ -n "$LABEL" ]; then
  # launchd-managed (common case): kickstart restarts the ONE managed instance in
  # place. NEVER kill+relaunch here — that races launchd's respawn into two
  # fighting instances. The fresh boot's killAllPanes() sweeps any orphan pane.
  TARGET="gui/$(id -u)/$LABEL"
  nohup bash -c "sleep 5; launchctl kickstart -k '$TARGET'" >> "$LOG" 2>&1 < /dev/null &
  disown
  echo "Restart scheduled (launchctl kickstart -k $TARGET in 5s)."
else
  # Standalone: detached SIGTERM, then relaunch a fresh process.
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
  echo "Restart scheduled (standalone: SIGTERM $PID in 5s, then a fresh instance)."
fi

echo "This conversation will end now; the new instance sends a boot notification."
```

## Notes

- `launchctl kickstart -k` SIGTERMs the running instance then starts it fresh; the
  fresh boot's `killAllPanes()` sweeps any orphan warm pane, so clark comes back clean.
- The in-flight "restart" task can't be marked `completed` after the process exits
  and will linger as `running`; this is inherent to self-restart and harmless.
- Restarting aborts all in-flight tasks (`dispatcher.stop()`), including this one.
