import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Persisted session records that track session metadata across restarts.
 *
 * Message content is still stored in `.jsonl` files — this table only
 * holds the session envelope (who, where, when).
 */
export const sessions = sqliteTable("sessions", {
  /** Unique session identifier. */
  id: text("id").primaryKey(),
  /** The agent runner type, e.g. `"claude-code"`. */
  agent_type: text("agent_type").notNull(),
  /** Working directory the session was created with. */
  cwd: text("cwd").notNull(),
  /** The channel id this session belongs to, or null for legacy sessions. */
  channel_id: text("channel_id"),
  /** The text content of the session's first inbound message. */
  first_message: text("first_message").notNull().default(""),
  /** Epoch milliseconds of the most recent message, or null if no messages yet. */
  last_message_created_at: integer("last_message_created_at"),
  /** Epoch milliseconds when the session was created. */
  created_at: integer("created_at").notNull(),
  /** Epoch milliseconds when the session was last updated. */
  updated_at: integer("updated_at").notNull(),
});

/**
 * Maps each Feishu chat to its current Claude session, so a conversation
 * resumes across messages. Replaces the per-App `session_id` that the old
 * multi-App model stored on the apps row. Subject to a TTL (see SessionManager).
 */
export const chatSessions = sqliteTable("chat_sessions", {
  /** Feishu chat id (open_id for DMs, chat_id for groups). */
  chat_id: text("chat_id").primaryKey(),
  /** The Claude session id currently bound to this chat. */
  session_id: text("session_id").notNull(),
  /** Epoch milliseconds when this mapping was last updated (for TTL expiry). */
  updated_at: integer("updated_at").notNull(),
});
