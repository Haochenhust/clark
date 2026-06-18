import type EventEmitter from "eventemitter3";

import type { RunResult } from "../agents";
import type { AssistantMessage, UserMessage } from "./types";

/** Metadata from a completed agent run, shown in the card footer. */
export interface RunMetadata {
  runResult?: RunResult;
}

/** Event types emitted by a message channel. */
export interface MessageChannelEventTypes {
  "message:inbound": (message: UserMessage) => void;
  "message:recalled": (messageId: string, channelId: string) => void;
}

/** Abstract message channel for sending and receiving messages. */
export interface MessageChannel extends EventEmitter {
  /** Channel ID. */
  readonly id: string;

  /** Channel type identifier (e.g. "feishu"). */
  readonly type: string;

  /** Start the channel and begin listening for inbound messages. */
  start(): Promise<void>;

  /**
   * Post a new assistant message without replying to an existing message.
   * @param message - The assistant message to post (without id).
   * @returns The posted message with id assigned.
   */
  postMessage(message: Omit<AssistantMessage, "id">): Promise<AssistantMessage>;

  /**
   * Reply to an existing message.
   * @param messageId - ID of the message to reply to.
   * @param message - The assistant message to send (without id).
   * @param options - Optional settings (e.g. streaming mode).
   * @returns The sent message with id assigned.
   */
  replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    options?: { streaming?: boolean } & RunMetadata,
  ): Promise<AssistantMessage>;

  /**
   * Update the content of an existing message.
   * @param message - The assistant message with updated content.
   * @param options - Optional settings (e.g. streaming mode).
   */
  updateMessageContent(
    message: AssistantMessage,
    options?: { streaming?: boolean } & RunMetadata,
  ): Promise<void>;

  /**
   * Remove a previously added reaction from a message.
   * @param messageId - ID of the message to remove the reaction from.
   */
  removeReaction(messageId: string): Promise<void>;

  /**
   * Send a plain notification message to a chat.
   * @param chatId - The chat to send the notification to.
   * @param text - The notification text.
   */
  sendNotification(chatId: string, text: string): Promise<void>;
}
