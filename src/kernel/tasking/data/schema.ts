import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted task records that mirror the bunqueue job lifecycle
 * but survive process restarts.
 *
 * The `id` column matches the bunqueue job ID so the two can be correlated.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    /** Unique identifier, same as the bunqueue job ID. */
    id: text("id").primaryKey(),
    /** The session that owns this task. */
    session_id: text("session_id").notNull(),
    /** The task payload type, e.g. `"inbound_message"` or `"scheduled_task"`. */
    type: text("type").notNull(),
    /** Current lifecycle status: pending → running → completed | failed. */
    status: text("status").notNull().default("pending"),
    /** The full task payload serialised as JSON. */
    payload: text("payload", { mode: "json" }).notNull(),
    /** Epoch milliseconds when the task was created. */
    created_at: integer("created_at").notNull(),
    /** Epoch milliseconds when the task was last updated. */
    updated_at: integer("updated_at").notNull(),
  },
  (table) => [index("idx_tasks_session_id").on(table.session_id)],
);

/**
 * Persisted scheduled task definitions that survive process restarts.
 * On startup, the {@link TaskDispatcher} reloads all rows and re-registers
 * them with bunqueue's job scheduler.
 */
export const scheduledTasks = sqliteTable("scheduled_tasks", {
  /** Scheduler ID — a unique identifier for this scheduled task. */
  id: text("id").primaryKey(),
  /**
   * The session that owns this scheduled task.
   * When `null`, each trigger creates a fresh session (independent mode).
   * When set, all triggers share the same session (contextual mode).
   */
  session_id: text("session_id"),
  /** Feishu chat_id where results should be delivered. */
  chat_id: text("chat_id"),
  /** The instruction string sent to the agent. */
  instruction: text("instruction").notNull(),
  /** The schedule configuration serialised as JSON ({@link TaskSchedule}). */
  schedule: text("schedule", { mode: "json" }).notNull(),
  /** Epoch milliseconds when the scheduled task was created. */
  created_at: integer("created_at").notNull(),
  /** Epoch milliseconds when the scheduled task was last updated. */
  updated_at: integer("updated_at").notNull(),
});
