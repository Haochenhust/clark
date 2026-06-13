import { z } from "zod";

/**
 * A text message content.
 */
export const TextMessageContent = z.object({
  type: z.literal("text"),
  /**
   * The text content of the message.
   */
  text: z.string(),
});
export interface TextMessageContent extends z.infer<typeof TextMessageContent> {}

export const ThinkingMessageContent = z.object({
  type: z.literal("thinking"),
  /**
   * The thinking content of the message.
   */
  thinking: z.string(),
});
export interface ThinkingMessageContent extends z.infer<typeof ThinkingMessageContent> {}

/**
 * An image URL message content.
 */
export const ImageUrlMessageContent = z.object({
  type: z.literal("image_url"),
  /**
   * The image URL content of the message.
   */
  image_url: z.string(),
});
export interface ImageUrlMessageContent extends z.infer<typeof ImageUrlMessageContent> {}

/**
 * The tool use message content.
 */
export const ToolUseMessageContent = z.object({
  type: z.literal("tool_use"),
  /**
   * The name of the tool to use.
   */
  name: z.string(),
  /**
   * The identifier of the tool use.
   */
  id: z.string(),
  /**
   * The input parameters to pass to the tool.
   */
  input: z.record(z.string(), z.any()),
});
export interface ToolUseMessageContent extends z.infer<typeof ToolUseMessageContent> {}

/**
 * The task tool use message content.
 */
export const ToolResultMessageContent = z.object({
  type: z.literal("tool_result"),
  /**
   * The identifier of the tool use.
   */
  tool_use_id: z.string(),
  /**
   * The result of the tool.
   */
  content: z.string(),
});
export interface ToolResultMessageContent extends z.infer<typeof ToolResultMessageContent> {}

export const MessageContent = z.discriminatedUnion("type", [
  TextMessageContent,
  ThinkingMessageContent,
  ImageUrlMessageContent,
  ToolUseMessageContent,
  ToolResultMessageContent,
]);
export type MessageContent =
  | TextMessageContent
  | ThinkingMessageContent
  | ImageUrlMessageContent
  | ToolUseMessageContent
  | ToolResultMessageContent;
