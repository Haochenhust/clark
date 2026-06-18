import { existsSync, unlinkSync } from "node:fs";

import { and, desc, eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import { config, createLogger, extractTextContent, uuid } from "@/sys";
import type { Session as SessionEntity, UserMessage } from "@/sys";

import { chatSessions, sessions } from "./data";
import { Session } from "./session";
import {
  SessionDailyLogWriter,
  SessionJSONLWriter,
  SessionLogWriter,
} from "./writers";

/**
 * Options for resolving, creating, or resuming a session.
 * Defaults come from config where applicable.
 */
export interface SessionResolveOptions {
  /**
   * The type of agent runner (e.g. "claude-code").
   * Defaults to `config.agents.default.type`.
   */
  agentType?: string;

  /**
   * The current working directory for the session.
   * Defaults to `config.workspaceDir`.
   */
  cwd?: string;

  /**
   * The channel id this session belongs to.
   */
  channelId?: string;

  /**
   * The first message of the session.
   */
  firstMessage?: UserMessage;

  /**
   * Feishu chat_id to inject into the agent environment.
   */
  chatId?: string;
}

/**
 * Time-to-live for a chat→session binding. In the v2 warm-pane model the binding
 * (like the warm pane itself) persists until the user explicitly runs `/new`, so
 * there is no idle expiry — the conversation stays continuous indefinitely.
 */
const CHAT_SESSION_TTL_MS = Number.POSITIVE_INFINITY;

/**
 * Creates or resumes Session instances. Session metadata is stored in the
 * database; message content is still appended to `.jsonl` files on disk.
 */
export class SessionManager {
  private readonly _diaryWriter = new SessionDailyLogWriter();
  private readonly _logger = createLogger("session-manager");
  private readonly _db: DrizzleDB;

  constructor(db: DrizzleDB) {
    this._db = db;
  }

  /**
   * Start the session manager.
   */
  async start() {
    this._logger.info("Session manager started");
  }

  /**
   * Get a session entity from the database by id.
   * @param sessionId - The session identifier.
   * @returns The session entity or null if not found.
   */
  getSession(sessionId: string): SessionEntity | null {
    const row = this._db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return (row as SessionEntity) ?? null;
  }

  /**
   * Returns whether a session with the given id exists in the database.
   * @param sessionId - The session identifier.
   * @returns true if a row exists, false otherwise.
   */
  existsSession(sessionId: string): boolean {
    const row = this._db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row !== undefined;
  }

  /**
   * Resolves session by database existence: creates if missing, resumes if exists.
   * @param sessionId - The session identifier.
   * @param options - Optional agent_type and cwd (default from config).
   * @returns A Session instance.
   */
  async resolveSession(
    sessionId: string,
    options?: SessionResolveOptions,
  ): Promise<Session> {
    if (this.existsSession(sessionId)) {
      return this.resumeSession(sessionId, options);
    }
    return this.createSession(sessionId, options);
  }

  /**
   * Creates a new session and inserts a row into the database.
   * @param sessionId - The session identifier.
   * @param options - Optional agent_type and cwd (default from config).
   * @returns A Session instance with isNewSession: true.
   * @throws SessionAlreadyExistsError if the session already exists.
   */
  async createSession(
    sessionId = uuid(),
    options?: SessionResolveOptions,
  ): Promise<Session> {
    if (this.existsSession(sessionId)) {
      throw new SessionAlreadyExistsError(sessionId);
    }

    const agentType = options?.agentType ?? config.agents.default.type;
    const cwd = options?.cwd ?? config.workspaceDir;
    const channelId = options?.channelId ?? null;
    const now = Date.now();

    this._db
      .insert(sessions)
      .values({
        id: sessionId,
        agent_type: agentType,
        cwd,
        channel_id: channelId,
        last_message_created_at: null,
        created_at: now,
        updated_at: now,
      })
      .run();

    if (options?.firstMessage) {
      this._updateFirstMessage(
        sessionId,
        extractTextContent(options.firstMessage),
      );
    }

    this._logger.info(`Creating session: ${sessionId}`);
    const session = new Session(sessionId, agentType, {
      isNewSession: true,
      cwd,
      chatId: options?.chatId,
    });
    this._attachWriter(session, sessionId);

    return session;
  }

  /**
   * Resumes an existing session by reading its metadata from the database.
   * @param sessionId - The session identifier.
   * @param options - Optional overrides for agent_type and cwd.
   * @returns A Session instance with isNewSession: false.
   * @throws SessionNotFoundError if the session does not exist.
   */
  async resumeSession(
    sessionId: string,
    options?: Omit<SessionResolveOptions, "firstMessage">,
  ): Promise<Session> {
    const row = this._db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();

    if (!row) {
      throw new SessionNotFoundError(sessionId);
    }

    this._logger.info(`Resuming session: ${sessionId}`);
    const session = new Session(
      sessionId,
      options?.agentType ?? row.agent_type,
      {
        isNewSession: false,
        cwd: options?.cwd ?? row.cwd,
        chatId: options?.chatId,
      },
    );
    this._attachWriter(session, sessionId);
    return session;
  }

  /**
   * Returns sessions ordered by `updated_at` descending.
   * @param limit - Maximum number of sessions to return (default 50).
   * @returns An array of session entities.
   */
  querySessions({ limit = 50 }: { limit?: number } = {}): SessionEntity[] {
    return this._db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updated_at))
      .limit(limit)
      .all();
  }

  /**
   * Removes a session: deletes the database record and the associated JSONL file.
   * @param sessionId - The session identifier.
   * @throws SessionNotFoundError if the session does not exist.
   */
  removeSession(sessionId: string): void {
    if (!this.existsSession(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
    this._db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    const filePath = config.paths.resolveSessionFilePath(sessionId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    this._logger.info(`Removed session: ${sessionId}`);
  }

  /**
   * Updates the `last_message_created_at` and `updated_at` timestamps for a session.
   * @param sessionId - The session identifier.
   */
  private _updateLastMessageCreatedAt(sessionId: string): void {
    const now = Date.now();
    this._db
      .update(sessions)
      .set({ last_message_created_at: now, updated_at: now })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  /**
   * Sets the `first_message` for a session if it is still empty (write-once semantics).
   * @param sessionId - The session identifier.
   * @param firstMessage - The text content of the first inbound message.
   */
  private _updateFirstMessage(sessionId: string, firstMessage: string): void {
    this._db
      .update(sessions)
      .set({
        first_message: firstMessage,
        last_message_created_at: Date.now(),
        updated_at: Date.now(),
      })
      .where(and(eq(sessions.id, sessionId), eq(sessions.first_message, "")))
      .run();
  }

  private _attachWriter(session: Session, sessionId: string): void {
    const fileWriter = new SessionJSONLWriter(sessionId);
    const logWriter = new SessionLogWriter(sessionId);
    session.on("message", (message) => {
      logWriter.write(message);
      fileWriter.write(message);
      this._diaryWriter.write(message);
      this._updateLastMessageCreatedAt(sessionId);
    });
  }

  /**
   * Returns the Claude session id currently bound to a chat, or null if there
   * is no binding or the binding is older than {@link CHAT_SESSION_TTL_MS}.
   * @param chatId - The Feishu chat id (open_id for DMs, chat_id for groups).
   * @returns The bound session id, or null if absent or expired.
   */
  getChatSession(chatId: string): string | null {
    const row = this._db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.chat_id, chatId))
      .get();
    if (!row) {
      return null;
    }
    if (Date.now() - row.updated_at > CHAT_SESSION_TTL_MS) {
      return null;
    }
    return row.session_id;
  }

  /**
   * Reverse of {@link getChatSession}: the Feishu chat currently bound to a
   * session id, or null if none. Used to deliver an autonomous turn (one clark
   * did not initiate) back to the conversation it belongs to.
   * @param sessionId - The Claude session id.
   * @returns The bound chat id, or null if no chat is bound to this session.
   */
  getSessionChat(sessionId: string): string | null {
    const row = this._db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.session_id, sessionId))
      .get();
    return row?.chat_id ?? null;
  }

  /**
   * Binds a chat to a session, creating the mapping or updating an existing one,
   * and bumps `updated_at` so the TTL window restarts.
   * @param chatId - The Feishu chat id (open_id for DMs, chat_id for groups).
   * @param sessionId - The Claude session id to bind to this chat.
   */
  bindChatSession(chatId: string, sessionId: string): void {
    const now = Date.now();
    this._db
      .insert(chatSessions)
      .values({ chat_id: chatId, session_id: sessionId, updated_at: now })
      .onConflictDoUpdate({
        target: chatSessions.chat_id,
        set: { session_id: sessionId, updated_at: now },
      })
      .run();
  }

  /**
   * Removes the chat→session binding for a chat, if any. Used by `/new` to
   * force the next message to start a fresh session.
   * @param chatId - The Feishu chat id (open_id for DMs, chat_id for groups).
   */
  clearChatSession(chatId: string): void {
    this._db
      .delete(chatSessions)
      .where(eq(chatSessions.chat_id, chatId))
      .run();
  }
}

/**
 * Error thrown when attempting to create a session that already exists.
 */
export class SessionAlreadyExistsError extends Error {
  constructor(
    public readonly sessionId: string,
    message?: string,
  ) {
    super(message ?? `Session already exists: ${sessionId}`);
    this.name = "SessionAlreadyExistsError";
  }
}

/**
 * Error thrown when attempting to resume a session that does not exist.
 */
export class SessionNotFoundError extends Error {
  constructor(
    public readonly sessionId: string,
    message?: string,
  ) {
    super(message ?? `Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}
