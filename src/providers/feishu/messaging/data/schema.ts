import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Maps Feishu thread IDs to clark session IDs.
 *
 * Each row represents a single Feishu message thread that has been
 * associated with a session. The in-memory cache in
 * {@link FeishuMessageChannel} is the hot path; this table is the
 * durable fallback that survives restarts.
 */
export const feishuThreads = sqliteTable("feishu_threads", {
  /** The Feishu thread identifier (unique per conversation thread). */
  thread_id: text("thread_id").primaryKey(),
  /** The clark session identifier. */
  session_id: text("session_id").notNull(),
  /** Epoch milliseconds when the mapping was created. */
  created_at: integer("created_at").notNull(),
});

/**
 * Tracks Feishu event_ids that have already been processed by this clark
 * instance, to prevent duplicate consumption from gateway re-deliveries.
 *
 * Feishu's WebSocket gateway re-delivers an event on the same connection
 * when it does not receive an ACK within ~19-20 seconds. Since the SDK only
 * sends the ACK after `_handleMessageReceive` finishes, any handler that
 * exceeds the window triggers a re-delivery. This table makes the inbound
 * pipeline idempotent at the entry point.
 *
 * The primary-key constraint on `event_id` provides the guarantee:
 * `INSERT ... ON CONFLICT DO NOTHING ... RETURNING *` returns the inserted
 * row on success and `undefined` on conflict, which the application uses
 * to detect duplicates. Old rows are cleaned up on clark startup with a
 * 7-day TTL.
 */
export const feishuProcessedEvents = sqliteTable("feishu_processed_events", {
  /** The Feishu event_id (re-deliveries of the same event keep the same id). */
  event_id: text("event_id").primaryKey(),
  /** Epoch milliseconds when the event was first processed. */
  processed_at: integer("processed_at").notNull(),
});
