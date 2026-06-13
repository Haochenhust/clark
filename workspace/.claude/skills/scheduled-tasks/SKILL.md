---
name: scheduled-tasks
description: >
  Create, list, update, or delete recurring scheduled tasks — triggered by phrases
  like "add a cronjob", "schedule a task", "定时任务", "remind me in 10 minutes",
  "list my scheduled tasks", "remove cronjob", "update the schedule", etc.
---

# Scheduled Tasks

Manage clark's scheduled tasks: create, query, modify, cancel. When a task fires,
clark turns it into a message into the owning chat's session and posts the result.

## Database + chat

clark injects absolute paths and the current chat id into the agent environment:

```bash
DB="$CLARK_DB"             # <repo>/store/clark.db
PID_FILE="$CLARK_PID"      # <repo>/store/clark.pid
CHAT_ID="$FEISHU_CHAT_ID"  # the chat the scheduled result is delivered to
```

## Create a scheduled task

When the user describes a need in natural language:

1. Determine the `instruction` (what the agent should do) and the `schedule`.
2. Decide the `session_id` mode (see below).
3. **Confirm** the parsed params (instruction, schedule, session mode) with the
   user before executing.
4. Run the SQL `INSERT`.
5. `kill -SIGUSR1 $(cat "$PID_FILE")` so clark reloads its scheduler.

### session_id: independent vs contextual

- **Independent** (default): `session_id = NULL`. Each trigger creates a fresh
  session with no memory of prior runs. Right for almost all tasks.
- **Contextual**: `session_id = <fixed uuid>`. All triggers share one session and
  see the full prior conversation. Only when cross-trigger continuity is needed.

| Task | Mode |
|---|---|
| "Summarize HN top stories every morning" | Independent |
| "Health-check the service hourly" | Independent |
| "Remind me about the meeting in 10 min" | Independent (one-shot) |
| "Track project progress daily, compare to yesterday" | **Contextual** |
| "Weekly review against last week's goals" | **Contextual** |

When unsure, ask: "independent each run, or share the prior conversation?"

### Schedule JSON

| Kind | JSON | Example |
|---|---|---|
| Cron | `{"pattern":"<cron>"}` | `{"pattern":"0 9 * * 1-5"}` = weekdays 9am |
| Interval | `{"every":<ms>}` | `{"every":3600000}` = hourly |
| One-shot | `{"at":<epoch ms>}` or `{"delay":<ms>}` | `{"delay":60000}` = once in 60s |

Optional: `"limit": N` (run at most N times), `"immediately": true` (run once on
register).

### Cron reference

```
┌─ minute (0-59)
│ ┌─ hour (0-23)
│ │ ┌─ day of month (1-31)
│ │ │ ┌─ month (1-12)
│ │ │ │ ┌─ day of week (0-7, 0/7 = Sunday)
* * * * *
```

Common: `0 9 * * *` (daily 9am) · `0 9 * * 1-5` (weekdays 9am) · `*/30 * * * *`
(every 30 min) · `0 0 * * 0` (Sunday midnight). Cron uses the system timezone.

### Natural language → schedule

| User says | Maps to |
|---|---|
| "in 10 minutes" / "in half an hour" | `{"delay": 600000}` / `{"delay": 1800000}` |
| "every morning at 9" | `{"pattern": "0 9 * * *"}` |
| "weekdays at 9am" | `{"pattern": "0 9 * * 1-5"}` |
| "every 30 min" / "hourly" | `{"every": 1800000}` / `{"every": 3600000}` |
| "only 5 times" | add `"limit": 5` |
| "run once now too" | add `"immediately": true` |
| an absolute time | compute epoch ms: `python3 -c "import datetime; print(int(datetime.datetime(2026,4,5,14,0).timestamp()*1000))"` → `{"at": <result>}` |

ms cheatsheet: 1 min = 60000, 10 min = 600000, 30 min = 1800000, 1 h = 3600000, 1 day = 86400000.

### INSERT (independent — most cases)

```bash
TASK_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
NOW_MS=$(date +%s000)
sqlite3 "$DB" "INSERT INTO scheduled_tasks (id, session_id, chat_id, instruction, schedule, created_at, updated_at) VALUES ('$TASK_ID', NULL, '$CHAT_ID', '<instruction>', '<schedule_json>', $NOW_MS, $NOW_MS)"
kill -SIGUSR1 $(cat "$PID_FILE")
```

### INSERT (contextual — shared session)

```bash
TASK_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
NOW_MS=$(date +%s000)
sqlite3 "$DB" "INSERT INTO scheduled_tasks (id, session_id, chat_id, instruction, schedule, created_at, updated_at) VALUES ('$TASK_ID', '$SESSION_ID', '$CHAT_ID', '<instruction>', '<schedule_json>', $NOW_MS, $NOW_MS)"
kill -SIGUSR1 $(cat "$PID_FILE")
```

> Confirm `sqlite3` printed no error before sending SIGUSR1.

## Modify

**Recurring** tasks (`pattern`/`every`) can be `UPDATE`d in place (reload uses an
idempotent `upsertJobScheduler`):

```bash
NOW_MS=$(date +%s000)
sqlite3 "$DB" "UPDATE scheduled_tasks SET instruction = '<new>', schedule = '<new_json>', updated_at = $NOW_MS WHERE id = '<task_id>'"
kill -SIGUSR1 $(cat "$PID_FILE")
```

**One-shot** tasks (`at`/`delay`) must be DELETE + INSERT (an already-enqueued job
can't be edited from the shell):

```bash
sqlite3 "$DB" "DELETE FROM scheduled_tasks WHERE id = '<old_task_id>'"
# then INSERT a new one (see above)
kill -SIGUSR1 $(cat "$PID_FILE")
```

## Query

```bash
sqlite3 -header -column "$DB" "SELECT id, instruction, schedule, datetime(created_at/1000, 'unixepoch', 'localtime') AS created FROM scheduled_tasks WHERE chat_id = '$CHAT_ID'"
```

Present results in natural language, not raw SQL output.

## Cancel

```bash
sqlite3 "$DB" "DELETE FROM scheduled_tasks WHERE id = '<task_id>'"
kill -SIGUSR1 $(cat "$PID_FILE")
```

After any change, send SIGUSR1 so clark reloads (stale bunqueue schedulers are
cleaned up on the next reload).
