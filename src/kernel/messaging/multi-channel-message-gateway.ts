import EventEmitter from "eventemitter3";

import type {
  AssistantMessage,
  MessageChannel,
  MessageGateway,
  MessageGatewayEventTypes,
  RunMetadata,
  UserMessage,
} from "@/sys";
import { createLogger } from "@/sys";

import { FeishuMessageChannel } from "@/providers/feishu";
import type { Card } from "@/providers/feishu/messaging/types";

/**
 * Message gateway backed by a single message channel.
 *
 * This instance serves exactly one Feishu bot, so there is no channel routing:
 * every inbound/outbound message flows through the one registered channel. The
 * gateway re-emits the channel's inbound and recall events as unified events.
 */
export class MultiChannelMessageGateway
  extends EventEmitter<MessageGatewayEventTypes>
  implements MessageGateway
{
  private _logger = createLogger("message-gateway");
  private _channel: MessageChannel | undefined;

  /**
   * Register the single message channel with the gateway.
   * Subscribes to the channel's inbound and recall events and re-emits them.
   * @param channel - The message channel to register.
   */
  registerChannel(channel: MessageChannel): void {
    if (this._channel) {
      throw new Error(
        `A channel ("${this._channel.id}") is already registered; this gateway serves a single channel.`,
      );
    }
    this._channel = channel;
    channel.on("message:inbound", (message: UserMessage) => {
      this._handleInboundMessage(channel.id, message);
    });
    channel.on("message:recalled", (messageId: string, channelId: string) => {
      this.emit("message:recalled", messageId, channelId);
    });
    this._logger.info(`Registered channel: ${channel.id}`);
  }

  /**
   * Start the gateway and the registered channel.
   */
  async start(): Promise<void> {
    const channel = this._requireChannel();
    this._logger.info(`Starting channel: ${channel.id}`);
    await channel.start();
    this._logger.info("Message gateway started");
  }

  /**
   * Stop the gateway. Removes all event listeners from the channel.
   */
  stop(): void {
    if (this._channel) {
      this._channel.removeAllListeners();
      this._logger.info(`Stopped channel: ${this._channel.id}`);
    }
    this.removeAllListeners();
    this._logger.info("Message gateway stopped");
  }

  /**
   * Post a new assistant message without replying to an existing message.
   * @param message - The assistant message to post (without id).
   * @returns The posted message with id assigned.
   */
  async postMessage(
    message: Omit<AssistantMessage, "id">,
  ): Promise<AssistantMessage> {
    return this._requireChannel().postMessage(message);
  }

  /**
   * Reply to an existing message.
   * @param messageId - ID of the message to reply to.
   * @param message - The assistant message to send (without id).
   * @param options - Optional settings (e.g. streaming mode). `channelId` is
   *   accepted for API compatibility but ignored, since there is one channel.
   * @returns The sent message with id assigned.
   */
  async replyMessage(
    messageId: string,
    message: Omit<AssistantMessage, "id">,
    options?: { streaming?: boolean; channelId?: string } & RunMetadata,
  ): Promise<AssistantMessage> {
    return this._requireChannel().replyMessage(messageId, message, options);
  }

  /**
   * Update the content of an existing message.
   * @param message - The assistant message with updated content.
   * @param options - Optional settings (e.g. streaming mode).
   */
  async updateMessageContent(
    message: AssistantMessage,
    options?: { streaming?: boolean } & RunMetadata,
  ): Promise<void> {
    await this._requireChannel().updateMessageContent(message, options);
  }

  /**
   * Post a pre-built live streaming card (reply).
   * Only Feishu channels implement this; other channels will throw.
   */
  async postLiveCard(
    _sessionId: string,
    parentMessageId: string,
    card: Card,
  ): Promise<string> {
    const channel = this._requireChannel();
    if (!(channel instanceof FeishuMessageChannel)) {
      throw new Error(
        `Channel "${channel.id}" does not support live cards (not Feishu).`,
      );
    }
    return channel.postLiveCard(parentMessageId, card);
  }

  /** Patch an existing live card. See FeishuMessageChannel.patchLiveCard for error semantics. */
  async patchLiveCard(
    _sessionId: string,
    messageId: string,
    card: Card,
    opts: { throwOnFailure?: boolean } = {},
  ): Promise<boolean> {
    const channel = this._requireChannel();
    if (!(channel instanceof FeishuMessageChannel)) return false;
    return channel.patchLiveCard(messageId, card, opts);
  }

  /** True once the live card has been marked dead (e.g. PATCH 400). */
  isLiveCardDead(_sessionId: string, messageId: string): boolean {
    const channel = this._requireChannel();
    if (!(channel instanceof FeishuMessageChannel)) return false;
    return channel.isLiveCardDead(messageId);
  }

  /**
   * Finalize a live card using the full Feishu rendering pipeline (image
   * upload / chart extract / table split / attachments). Throws on PATCH
   * failure so the kernel can fall back to a fresh reply.
   */
  async patchFinalLiveCard(
    _sessionId: string,
    messageId: string,
    message: AssistantMessage,
    opts: {
      progressLines: string[];
      elapsedMs: number;
      state: "done" | "error";
      runResult?: RunMetadata["runResult"];
      effortLevel?: string;
    },
  ): Promise<void> {
    const channel = this._requireChannel();
    if (!(channel instanceof FeishuMessageChannel)) {
      throw new Error(
        `Channel "${channel.id}" does not support live cards (not Feishu).`,
      );
    }
    await channel.patchFinalLiveCard(messageId, message, opts);
  }

  async removeReaction(messageId: string, _sessionId: string): Promise<void> {
    await this._requireChannel().removeReaction(messageId);
  }

  async sendNotification(
    _channelId: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    await this._requireChannel().sendNotification(chatId, text);
  }

  /**
   * Handles an inbound message from the channel.
   * Tags the message with the channel id for downstream consumers.
   */
  private _handleInboundMessage(
    channelId: string,
    message: UserMessage,
  ): void {
    message.channel_id = channelId;
    this.emit("message:inbound", message);
  }

  /**
   * Returns the registered channel.
   * @throws If no channel has been registered yet.
   */
  private _requireChannel(): MessageChannel {
    if (!this._channel) {
      throw new Error("No channel registered with the gateway.");
    }
    return this._channel;
  }
}
