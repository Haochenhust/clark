import { z } from "zod";

import { TaskPayload } from "./payload";

/**
 * Possible states of a persisted task.
 */
export const TaskStatus = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * A persisted task record that mirrors the bunqueue job lifecycle
 * but survives process restarts.
 *
 * The {@link id} matches the bunqueue job ID so the two can be correlated.
 */
export const Task = z.object({
  /** Unique identifier, same as the bunqueue job ID. */
  id: z.string(),
  /** The session that owns this task. */
  session_id: z.string(),
  /** The task payload type, e.g. `"inbound_message"` or `"scheduled_task"`. */
  type: z.string(),
  /** Current lifecycle status. */
  status: TaskStatus,
  /** The full task payload. */
  payload: TaskPayload,
  /** Epoch milliseconds when the task was created. */
  created_at: z.number(),
  /** Epoch milliseconds when the task was last updated. */
  updated_at: z.number(),
});
export interface Task extends z.infer<typeof Task> {}
