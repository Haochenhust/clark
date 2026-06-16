import fs from "node:fs";
import nodePath from "node:path";

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { lt } from "drizzle-orm";
import EventEmitter from "eventemitter3";

import type { DrizzleDB } from "@/data";
import type { Logger, TextMessageContent } from "@/sys";
import {
  config,
  createLogger,
  getEnv,
  type AssistantMessage,
  type MessageChannel,
  type MessageChannelEventTypes,
  type RunMetadata,
  type UserMessage,
} from "@/sys";

import { feishuProcessedEvents } from "./data";
import { decorateFinalLiveCard, type LiveCardState } from "./live-card-renderer";
import { renderMessageCard, splitMarkdownBySize, splitMarkdownByTables } from "./message-renderer";
import type { Card } from "./types";
import type { MessageReceiveEventData } from "./types";
import { convertPostToMarkdown } from "./utils";

function _isFeishuBadRequestError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const candidate = err as {
    status?: number;
    code?: number | string;
    response?: {
      status?: number;
      data?: {
        code?: number | string;
      };
    };
  };

  return (
    candidate.status === 400 ||
    candidate.code === 400 ||
    candidate.response?.status === 400 ||
    candidate.response?.data?.code === 400
  );
}

/** Options for rendering a finalized live card (steps panel + run footer). */
interface FinalLiveCardOpts {
  progressLines: string[];
  elapsedMs: number;
  state: Exclude<LiveCardState, "running">;
  runResult?: import("@/sys").RunResult;
  effortLevel?: string;
}

/** Message channel implementation for Feishu (Lark) chat platform. */
export class FeishuMessageChannel
  extends EventEmitter<MessageChannelEventTypes>
  implements MessageChannel
{
  readonly type = "feishu";
  readonly id: string;

  private _inboundClient: WSClient;
  private _client: Client;
  private _db: DrizzleDB;
  private _failedCardUpdateMessages = new Set<string>();
  private _pendingReactions = new Map<string, string>();
  private _inThreadMessages = new Set<string>();
  private _messageChatIds = new Map<string, string>();
  private _logger: Logger;

  private readonly _appId: string;
  private readonly _appSecret: string;

  /**
   * Create a Feishu message channel for the single configured bot.
   * Credentials are read from `config.feishu` unless explicitly provided.
   * @param id - Channel registration id used for routing (defaults to the bot's channelId).
   * @param db - Drizzle database instance for persisting dedup/idempotency state.
   * @param creds - Optional override for the bot credentials (defaults to `config.feishu`).
   */
  constructor(
    db: DrizzleDB,
    id: string = config.feishu.channelId,
    creds: { appId: string; appSecret: string } = config.feishu,
  ) {
    super();
    this.id = id;
    if (!creds.appId || !creds.appSecret) {
      throw new Error("Feishu app ID and secret are required");
    }
    this._appId = creds.appId;
    this._appSecret = creds.appSecret;
    this._db = db;
    this._logger = createLogger("feishu-message-channel");
    this._inboundClient = new WSClient({
      appId: this._appId,
      appSecret: this._appSecret,
    });
    this._client = new Client({
      appId: this._appId,
      appSecret: this._appSecret,
    });
    // The Lark SDK's default axios instance ships with NO request timeout
    // (verified: defaults.timeout === 0), so a stalled Feishu call would hang the
    // caller forever — a deadlock on the strictly-serial turn queue. Add a hard
    // request timeout to the EXISTING instance (NOT a replacement, which would
    // drop the SDK's response-unwrap interceptor); axios then aborts the socket
    // and rejects, and the existing try/catch fallbacks treat it as a normal
    // failure (mark card dead → plain reply, etc.).
    const httpTimeoutMs = parseInt(getEnv("CLARK_FEISHU_HTTP_TIMEOUT_MS", "20000"), 10);
    const outboundHttp = this._client.httpInstance as unknown as {
      defaults?: { timeout?: number };
    };
    if (outboundHttp?.defaults) {
      outboundHttp.defaults.timeout = httpTimeoutMs;
    } else {
      this._logger.warn("could not set Feishu HTTP timeout — SDK httpInstance has no axios defaults");
    }

    // Clean up dedup table rows older than 7 days on startup, so the
    // feishu_processed_events table cannot grow unbounded.
    this._db
      .delete(feishuProcessedEvents)
      .where(lt(feishuProcessedEvents.processed_at, Date.now() - 7 * 86400_000))
      .run();
  }

  /** Start listening for inbound messages via WebSocket. */
  async start() {
    await this._inboundClient.start({
      eventDispatcher: new EventDispatcher({}).register({
        "im.message.receive_v1": this._handleMessageReceive,
        "im.message.recalled_v1": this._handleMessageRecall,
      }),
    });
  }

  /** Reply to a message in a Feishu chat. Replies in-thread only if the original message was in a thread. */
  async replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    { streaming = true, runResult, effortLevel }: { streaming?: boolean } & RunMetadata = {},
  ): Promise<AssistantMessage> {
    const inThread = this._inThreadMessages.has(messageId);
    this._inThreadMessages.delete(messageId);

    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
      runResult,
      effortLevel,
      sessionId: message.session_id,
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    let replyMessageData: { message_id?: string; thread_id?: string };
    if (inThread) {
      const { data } = await this._client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      });
      if (!data) throw new Error("Failed to reply message");
      replyMessageData = data;
    } else {
      const { data } = await this._client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
      if (!data) throw new Error("Failed to reply message");
      replyMessageData = data;
    }

    await this._sendRemainingChunks(replyMessageData.message_id!, remainingChunks, inThread, message.session_id);

    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = replyMessageData.message_id!;

    if (inThread) {
      this._inThreadMessages.add(assistantMessage.id);
    }

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(
          assistantMessage.id,
          lastText.text,
          inThread,
        );
      }
    }

    return assistantMessage;
  }

  async postMessage(
    message: Omit<AssistantMessage, "id">,
  ): Promise<AssistantMessage> {
    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      false,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming: false,
      uploadImage: this.uploadImage.bind(this),
      sessionId: message.session_id,
    });
    this._logOutboundMessage(message.session_id, message.content);
    const { data } = await this._client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id:
          ((message as Record<string, unknown>)._feishu_chat_id as string) ||
          config.notifyChatId ||
          "",
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    if (!data) {
      throw new Error("Failed to post message");
    }
    const { message_id: messageId } = data;
    const assistantMessage = message as AssistantMessage;
    assistantMessage.id = messageId!;

    await this._sendRemainingChunks(assistantMessage.id, remainingChunks, false, message.session_id);

    const lastText = message.content.filter((c) => c.type === "text").pop();
    if (lastText?.type === "text") {
      await this._sendLocalFileAttachments(assistantMessage.id, lastText.text, false);
    }

    return assistantMessage;
  }

  /**
   * Post a pre-built interactive card as a reply to an existing message.
   * Used by the live-streaming card path where the card JSON is built externally
   * (see live-card-renderer.ts). Returns the created message's ID.
   */
  async postLiveCard(
    parentMessageId: string,
    card: Card,
  ): Promise<string> {
    const inThread = this._inThreadMessages.has(parentMessageId);
    const { data } = await this._client.im.message.reply({
      path: { message_id: parentMessageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
        ...(inThread ? { reply_in_thread: true } : {}),
      },
    });
    if (!data?.message_id) throw new Error("Failed to post live card");
    if (inThread) {
      this._inThreadMessages.add(data.message_id);
    }
    this._messageChatIds.set(data.message_id, this._messageChatIds.get(parentMessageId) ?? "");
    return data.message_id;
  }

  /**
   * Patch an existing live card. Intermediate PATCHes silently swallow errors
   * so the next tick can retry; for the FINAL patch the caller should pass
   * `throwOnFailure: true` so that a last-moment 400/429/network hiccup is
   * surfaced and the caller can fall back to posting the content as a fresh
   * message (otherwise the user would be stuck watching a "processing" card).
   *
   * Returns `true` iff the PATCH round-tripped to Feishu successfully.
   */
  async patchLiveCard(
    messageId: string,
    card: Card,
    opts: { throwOnFailure?: boolean } = {},
  ): Promise<boolean> {
    const { throwOnFailure = false } = opts;
    if (this._failedCardUpdateMessages.has(messageId)) {
      if (throwOnFailure) {
        throw new Error(`Live card ${messageId} was previously marked dead.`);
      }
      return false;
    }
    try {
      await this._client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      return true;
    } catch (err) {
      if (_isFeishuBadRequestError(err)) {
        this._failedCardUpdateMessages.add(messageId);
        this._logger.warn(
          { err, message_id: messageId },
          "Feishu live card PATCH rejected with 400; marking dead",
        );
      } else {
        this._logger.warn(
          { err, message_id: messageId },
          "Feishu live card PATCH failed",
        );
      }
      if (throwOnFailure) throw err;
      return false;
    }
  }

  /** True once a live card has been marked dead (400); caller should fall back. */
  isLiveCardDead(messageId: string): boolean {
    return this._failedCardUpdateMessages.has(messageId);
  }

  /**
   * Finalize a live card with the full assistant message:
   *   - runs the same _prepareMessageContent / renderMessageCard pipeline as
   *     regular non-streaming replies, so images are uploaded, chart blocks are
   *     extracted, and markdown with too many tables is split across cards
   *   - decorates the card with live-card chrome (header + progress panel)
   *   - sends any overflow chunks as additional replies
   *   - uploads + replies with local file attachments referenced in the final text
   *
   * Throws on PATCH failure (400/429/network) so the kernel can fall back to a
   * fresh reply with the full content — otherwise the user would be stuck on
   * the "processing" card state.
   */
  /**
   * Render a finalized live card (first chunk in the card + any overflow
   * chunks to send as follow-ups). Shared by patch (update existing) and post
   * (fresh reply). Applies the ~28KB Feishu card-size guard.
   */
  private async _buildFinalCard(message: AssistantMessage, opts: FinalLiveCardOpts) {
    let { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      false,
    );

    const renderOpts = {
      streaming: false,
      uploadImage: this.uploadImage.bind(this),
      runResult: opts.runResult,
      effortLevel: opts.effortLevel,
      sessionId: message.session_id,
    };

    let renderedCard = await renderMessageCard(firstMessageContent, renderOpts);

    let finalCard = decorateFinalLiveCard(renderedCard, {
      progressLines: opts.progressLines,
      elapsedMs: opts.elapsedMs,
      state: opts.state,
    });

    // Guard: if the card JSON exceeds Feishu's ~28KB limit, re-split the
    // markdown portion into smaller chunks and keep only the first in the card.
    const MAX_CARD_BYTES = 25_000;
    if (Buffer.byteLength(JSON.stringify(finalCard), "utf-8") > MAX_CARD_BYTES) {
      const lastText = firstMessageContent.findLast((c) => c.type === "text");
      if (lastText && lastText.type === "text") {
        const sizeChunks = splitMarkdownBySize(lastText.text, 8_000);
        firstMessageContent = firstMessageContent.map((c) =>
          c.type === "text" ? { ...c, text: sizeChunks[0] } : c,
        ) as typeof firstMessageContent;
        remainingChunks = [...sizeChunks.slice(1), ...remainingChunks];
        renderedCard = await renderMessageCard(firstMessageContent, renderOpts);
        finalCard = decorateFinalLiveCard(renderedCard, {
          progressLines: opts.progressLines,
          elapsedMs: opts.elapsedMs,
          state: opts.state,
        });
      }
    }

    return { finalCard, remainingChunks };
  }

  async patchFinalLiveCard(
    messageId: string,
    message: AssistantMessage,
    opts: FinalLiveCardOpts,
  ): Promise<void> {
    if (this._failedCardUpdateMessages.has(messageId)) {
      throw new Error(`Live card ${messageId} was previously marked dead.`);
    }

    const { finalCard, remainingChunks } = await this._buildFinalCard(message, opts);

    this._logOutboundMessage(message.session_id, message.content);

    try {
      await this._client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(finalCard) },
      });
    } catch (err) {
      if (_isFeishuBadRequestError(err)) {
        this._failedCardUpdateMessages.add(messageId);
      }
      this._logger.warn(
        { err, message_id: messageId, session_id: message.session_id },
        "Feishu final live card PATCH failed",
      );
      throw err;
    }

    const inThread = this._inThreadMessages.has(messageId);
    await this._sendRemainingChunks(messageId, remainingChunks, inThread, message.session_id);

    const lastText = message.content.findLast((c) => c.type === "text");
    if (lastText && lastText.type === "text") {
      await this._sendLocalFileAttachments(messageId, lastText.text, inThread);
    }
    this._inThreadMessages.delete(messageId);
  }

  /** Update the content of an existing Feishu message. */
  async updateMessageContent(
    message: AssistantMessage,
    { streaming = true, runResult, effortLevel }: { streaming?: boolean } & RunMetadata = {},
  ): Promise<void> {
    if (this._failedCardUpdateMessages.has(message.id)) {
      return;
    }

    const { firstMessageContent, remainingChunks } = this._prepareMessageContent(
      message.content,
      streaming,
    );

    const card = await renderMessageCard(firstMessageContent, {
      streaming,
      uploadImage: this.uploadImage.bind(this),
      runResult,
      effortLevel,
      sessionId: message.session_id,
    });
    if (!streaming) {
      this._logOutboundMessage(message.session_id, message.content);
    }
    try {
      await this._client.im.message.patch({
        path: {
          message_id: message.id,
        },
        data: {
          content: JSON.stringify(card),
        },
      });
    } catch (err) {
      if (_isFeishuBadRequestError(err)) {
        this._failedCardUpdateMessages.add(message.id);
        this._logger.warn(
          { err, message_id: message.id, session_id: message.session_id },
          "Feishu card update failed with 400; sending content as new reply",
        );
        const inThread = this._inThreadMessages.has(message.id);
        await this._sendContentAsNewReply(message.id, message.content, runResult, effortLevel, inThread, message.session_id);
        return;
      }
      throw err;
    }

    const inThread = this._inThreadMessages.has(message.id);
    await this._sendRemainingChunks(message.id, remainingChunks, inThread, message.session_id);

    if (!streaming) {
      const lastText = message.content.filter((c) => c.type === "text").pop();
      if (lastText?.type === "text") {
        await this._sendLocalFileAttachments(message.id, lastText.text, inThread);
      }
      this._inThreadMessages.delete(message.id);
    }
  }

  /**
   * Uploads an image to Feishu. Returns the key of the uploaded image.
   * @param path - The path to the image to upload.
   * @returns The key of the uploaded image.
   */
  async uploadImage(path: string): Promise<string> {
    const absPath = nodePath.join(config.workspaceDir, path);
    const file = fs.readFileSync(absPath);
    this._logger.info(`Uploading image ${absPath}`);
    const res = await this._client.im.v1.image.create({
      data: {
        image_type: "message",
        image: file,
      },
    });
    this._logger.info(
      `Uploaded image ${absPath} -> ${res?.image_key || "failed"}`,
    );
    if (res?.image_key) {
      return res.image_key;
    } else {
      throw new Error("Failed to upload image");
    }
  }

  /**
   * Uploads a file to Feishu. Returns the key of the uploaded file.
   * @param filePath - The path to the file relative to the root directory.
   * @returns The key of the uploaded file.
   */
  async uploadFile(filePath: string): Promise<string> {
    const absPath = nodePath.join(config.workspaceDir, filePath);
    const file = fs.createReadStream(absPath);
    const fileName = nodePath.basename(absPath);
    const ext = nodePath.extname(absPath).slice(1).toLowerCase();
    const fileTypeMap: Record<
      string,
      "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"
    > = {
      opus: "opus",
      mp4: "mp4",
      pdf: "pdf",
      doc: "doc",
      docx: "doc",
      xls: "xls",
      xlsx: "xls",
      ppt: "ppt",
      pptx: "ppt",
    };
    const fileType = fileTypeMap[ext] ?? "stream";
    this._logger.info(`Uploading file ${absPath} (type: ${fileType})`);
    const res = await this._client.im.v1.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file,
      },
    });
    this._logger.info(
      `Uploaded file ${absPath} -> ${res?.file_key || "failed"}`,
    );
    if (res?.file_key) {
      return res.file_key;
    } else {
      throw new Error("Failed to upload file");
    }
  }

  async removeReaction(messageId: string): Promise<void> {
    const reactionId = this._pendingReactions.get(messageId);
    if (!reactionId) return;
    this._pendingReactions.delete(messageId);
    try {
      await this._client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch { /* Non-critical, ignore */ }
  }

  async sendNotification(chatId: string, text: string): Promise<void> {
    const card = {
      schema: "2.0",
      config: { enable_forward: true, width_mode: "fill" },
      body: {
        elements: [{ tag: "markdown", content: text }],
      },
    };
    await this._client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }

  /**
   * Downloads an image or a file from a message into the shared uploads dir.
   * @param messageId - The ID of the message to download the resource from.
   * @param file_key - The key of the file to download.
   * @param file_name - The name of the file to download. If not provided, the file name will be inferred from the file key.
   * @returns The downloaded file path, relative to the workspace dir (the agent's cwd).
   */
  async downloadMessageResource(
    messageId: string,
    file_key: string,
    file_name?: string,
  ): Promise<string> {
    const { writeFile, headers } = await this._client.im.v1.messageResource.get(
      {
        path: {
          message_id: messageId,
          file_key,
        },
        params: {
          type: "file",
        },
      },
    );
    const metadata = JSON.parse(
      headers.get("inner_file_data_meta") as string,
    ) as {
      FileName: string;
      Mime: string;
    };
    const isImage = metadata.Mime.startsWith("image/");
    let dir = config.uploadsDir;
    if (isImage) {
      dir = nodePath.join(dir, "images");
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let filename: string;
    if (file_name) {
      filename = file_name;
    } else {
      filename = metadata.FileName === "image" ? file_key : metadata.FileName;
      if (metadata.Mime.startsWith("image/")) {
        filename += "." + metadata.Mime.split("/")[1];
      } else if (metadata.Mime === "audio/octet-stream") {
        filename += ".ogg";
      } else {
        filename += `.${metadata.Mime.split("/")[1]}`;
      }
    }
    const extname = nodePath.extname(filename);
    filename = filename.substring(0, filename.length - extname.length);
    if (fs.existsSync(nodePath.join(dir, filename + extname))) {
      let i = 1;
      while (fs.existsSync(nodePath.join(dir, filename + `-${i}` + extname))) {
        i++;
      }
      filename += `-${i}`;
    }
    filename += extname;
    await writeFile(nodePath.join(dir, filename));
    return nodePath.relative(config.workspaceDir, nodePath.join(dir, filename));
  }

  /**
   * Prepare message content for sending, splitting if necessary due to table limits.
   * @param content - Original message content.
   * @param streaming - Whether the message is being streamed (skip splitting if true).
   * @returns First chunk content and remaining chunks to send as follow-ups.
   */
  private _prepareMessageContent(
    content: AssistantMessage["content"],
    streaming: boolean,
  ): {
    firstMessageContent: AssistantMessage["content"];
    remainingChunks: string[];
  } {
    const lastTextContent = content.findLast((c) => c.type === "text");
    const markdownChunks = lastTextContent
      ? splitMarkdownByTables(lastTextContent.text)
      : [];
    const needsSplit = !streaming && markdownChunks.length > 1;

    const firstMessageContent = needsSplit
      ? (content.map((c) =>
          c.type === "text" ? { ...c, text: markdownChunks[0] } : c,
        ) as AssistantMessage["content"])
      : content;

    const remainingChunks = needsSplit ? markdownChunks.slice(1) : [];

    return { firstMessageContent, remainingChunks };
  }

  /**
   * Send remaining markdown chunks as follow-up reply messages.
   * @param messageId - The message ID to reply to.
   * @param chunks - Array of markdown strings to send.
   */
  private async _sendRemainingChunks(
    messageId: string,
    chunks: string[],
    inThread: boolean,
    sessionId?: string,
  ): Promise<void> {
    for (const chunkText of chunks) {
      const chunkCard = await renderMessageCard(
        [{ type: "text", text: chunkText }],
        {
          streaming: false,
          uploadImage: this.uploadImage.bind(this),
          sessionId,
        },
      );
      await this._client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(chunkCard),
          reply_in_thread: inThread,
        },
      });
    }
  }

  /** Extract local file paths from markdown link syntax [text](path) in text. */
  private _extractLocalFilePaths(text: string): string[] {
    const linkRegex = /(?<!!)\[.*?\]\(([^)]+)\)/g;
    const paths: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(text)) !== null) {
      const filePath = match[1];
      if (
        filePath &&
        !filePath.includes("://") &&
        fs.existsSync(nodePath.join(config.workspaceDir, filePath))
      ) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  /** Upload local files referenced in text and send them as Feishu file message replies. */
  private async _sendLocalFileAttachments(
    messageId: string,
    text: string,
    inThread: boolean,
  ): Promise<void> {
    const filePaths = this._extractLocalFilePaths(text);
    const seen = new Set<string>();
    for (const filePath of filePaths) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      try {
        const fileKey = await this.uploadFile(filePath);
        await this._client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "file",
            content: JSON.stringify({ file_key: fileKey }),
            reply_in_thread: inThread,
          },
        });
        this._logger.info(`Sent file ${filePath} as Feishu attachment`);
      } catch (err) {
        this._logger.warn(
          { err },
          `Failed to send file attachment: ${filePath}`,
        );
      }
    }
  }

  /**
   * When a card update fails (e.g. element count exceeds Feishu limit), send the
   * response text and footer as a new reply instead of showing an error.
   * Steps are already visible in the streaming card, so we only need the text portion.
   */
  private async _sendContentAsNewReply(
    messageId: string,
    content: AssistantMessage["content"],
    runResult?: RunMetadata["runResult"],
    effortLevel?: RunMetadata["effortLevel"],
    inThread: boolean = false,
    sessionId?: string,
  ): Promise<void> {
    const textContent = content.filter((c) => c.type === "text") as AssistantMessage["content"];
    if (textContent.length === 0) return;
    try {
      const card = await renderMessageCard(textContent, {
        streaming: false,
        uploadImage: this.uploadImage.bind(this),
        runResult,
        effortLevel,
        sessionId,
      });
      await this._client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: inThread,
        },
      });
    } catch (err) {
      this._logger.warn(
        { err, message_id: messageId },
        "Failed to send content as new reply after card update error",
      );
    }
  }

  private _logOutboundMessage(
    sessionId: string,
    content: AssistantMessage["content"],
  ) {
    const lastText = content.filter((item) => item.type === "text").pop();
    const finalText = lastText?.type === "text" ? lastText.text : null;
    this._logger.info([sessionId, finalText], "Final Feishu outbound content");
  }

  private _handleMessageReceive = async (data: MessageReceiveEventData) => {
    this._logger.info({ event_data: JSON.stringify(data).slice(0, 200) }, "Raw inbound event received");
    const { message: receivedMessage } = data;
    const { message_id: messageId, thread_id: threadId } = receivedMessage;

    // Idempotency gate: drop re-deliveries from the Feishu gateway.
    //
    // The gateway re-delivers an event on the same WebSocket connection when
    // it does not receive an ACK within ~19-20s. The SDK only ACKs after this
    // handler returns, so any handler that exceeds the window triggers a
    // duplicate. We dedup on event_id (the gateway's delivery unit, identical
    // across re-sends), falling back to message_id when event_id is absent
    // (it is typed as optional in MessageReceiveEventData).
    //
    // This MUST run before any side effect (resource downloads, emoji
    // reactions, the message:inbound emit) so the duplicate is fully
    // short-circuited.
    const dedupKey = data.event_id ?? messageId;
    const inserted = this._db
      .insert(feishuProcessedEvents)
      .values({ event_id: dedupKey, processed_at: Date.now() })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!inserted) {
      this._logger.warn(
        { event_id: dedupKey, message_id: messageId },
        "Duplicate inbound event dropped",
      );
      return;
    }

    if (threadId) {
      this._inThreadMessages.add(messageId);
    }
    if (receivedMessage.chat_id) {
      this._messageChatIds.set(messageId, receivedMessage.chat_id);
    }
    const session_id = "";

    const userMessage: UserMessage = {
      id: messageId,
      session_id,
      role: "user",
      // channel_id is set by the gateway, not here
      content: [
        await this._parseMessageContent(
          messageId,
          receivedMessage.message_type,
          receivedMessage.content,
        ),
      ],
    };

    // Attach the source Feishu chat so outbound replies can be routed back
    // to the originating chat (separate from channel_id routing).
    const ext = userMessage as UserMessage & {
      _feishu_chat_id?: string;
      _feishu_chat_type?: string;
    };
    ext._feishu_chat_id = receivedMessage.chat_id;
    ext._feishu_chat_type = receivedMessage.chat_type;

    // Add a reaction to acknowledge message receipt (non-critical)
    try {
      const res = await this._client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "Typing" } },
      });
      const reactionId = res?.data?.reaction_id;
      if (reactionId) {
        this._pendingReactions.set(messageId, reactionId);
      }
    } catch { /* Non-critical, ignore */ }

    this.emit("message:inbound", userMessage);
  };

  private _handleMessageRecall = async (data: {
    message_id?: string;
    chat_id?: string;
    recall_time?: string;
    recall_type?: string;
  }) => {
    if (!data.message_id) return;
    this._logger.info({ message_id: data.message_id }, "message recalled");
    this.emit("message:recalled", data.message_id, this.id);
  };


  private async _parseMessageContent(
    messageId: string,
    type: string,
    content: string,
  ): Promise<TextMessageContent> {
    const json = JSON.parse(content);
    if (type === "text") {
      return {
        type: "text",
        text: json.text,
      };
    } else if (type === "post") {
      const downloadFn = (file_key: string) =>
        this.downloadMessageResource(messageId, file_key);
      const markdown = await convertPostToMarkdown(json, downloadFn);
      return {
        type: "text",
        text: markdown,
      };
    } else if (type === "image") {
      const file_key = json.image_key as string;
      const path = await this.downloadMessageResource(messageId, file_key);
      // Plain text (NOT `![](…)` markdown): a line starting with `!` is treated
      // as a bash command by the interactive `claude` TUI the runner drives.
      return {
        type: "text",
        text: `The user sent an image. Read \`${path}\` to view it, then respond.`,
      };
    } else if (type === "file") {
      const file_key = json.file_key as string;
      const file_name = json.file_name as string;
      const path = await this.downloadMessageResource(
        messageId,
        file_key,
        file_name,
      );
      return {
        type: "text",
        text: `A new file message uploaded to \`${path}\``,
      };
    } else {
      this._logger.error(`Unsupported message type: ${type}`);
      return { type: "text", text: "Unsupported message type" + type };
    }
  }
}
