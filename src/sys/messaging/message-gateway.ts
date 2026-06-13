import type EventEmitter from "eventemitter3";

import type { RunMetadata, MessageChannel } from "./message-channel";
import type { AssistantMessage, UserMessage } from "./types";

/** Event types emitted by a message gateway. */
export interface MessageGatewayEventTypes {
  "message:inbound": (message: UserMessage) => void;
  "message:recalled": (messageId: string, channelId: string) => void;
}

/**
 * A gateway that manages multiple message channels, routes outbound messages
 * to the correct channel, and emits unified inbound events.
 */
export interface MessageGateway extends EventEmitter<MessageGatewayEventTypes> {
  /** Register a message channel with the gateway. */
  registerChannel(channel: MessageChannel): void;

  /** Start the gateway and all registered channels. */
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
   * @param options - Optional settings. Pass `channelId` for command replies
   *   (`/new`, `/stop`) where the session_id may not yet exist in the DB; the
   *   gateway will route to that channel directly instead of looking up by
   *   session.
   * @returns The sent message with id assigned.
   */
  replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    options?: { streaming?: boolean; channelId?: string } & RunMetadata,
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
   * Routes to the correct channel based on session `channel_id`.
   * @param messageId - ID of the message to remove the reaction from.
   * @param sessionId - Session ID for channel routing.
   */
  removeReaction(messageId: string, sessionId: string): Promise<void>;

  /**
   * Send a plain notification message to a chat.
   * @param channelId - The channel to send through.
   * @param chatId - The chat to send the notification to.
   * @param text - The notification text.
   */
  sendNotification(channelId: string, chatId: string, text: string): Promise<void>;
}
