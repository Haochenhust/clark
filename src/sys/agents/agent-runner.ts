import { z } from "zod";

import type {
  AssistantMessage,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from "../messaging";

/**
 * The result of a completed agent run (model, cost, token usage).
 * Yielded as the final item in the stream after all messages.
 */
export interface RunResult {
  type: "run_result";
  model: string;
  cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  /** Model's max context window size (tokens), reported by the agent runner. */
  context_window?: number;
  /** Last assistant turn's context size (input + cache_read + cache_creation). */
  context_used?: number;
  /** Effort level the pane's `claude` was actually launched with (`--effort`). */
  effort?: string;
}

/**
 * The options for the agent runner.
 */
export const AgentRunOptions = z.object({
  /**
   * Whether to start a new session.
   */
  isNewSession: z.boolean(),

  /**
   * The current working directory.
   */
  cwd: z.string(),

  /**
   * The Feishu chat_id this session belongs to.
   * Injected as FEISHU_CHAT_ID so lark-cli can target the correct conversation.
   */
  chatId: z.string().optional(),

  /**
   * Abort signal for cancelling the running task.
   * When aborted, the agent runner should kill any spawned subprocesses.
   */
  signal: z.instanceof(AbortSignal).optional(),
});
export interface AgentRunOptions extends z.infer<typeof AgentRunOptions> {}

/**
 * A wrapper of the real agent behind.
 * Used to interact with Agent, supporting streaming output
 */
export interface AgentRunner {
  /**
   * The type of the agent runner.
   */
  readonly type: string;

  /**
   * Streams the chunking messages from the agent.
   */
  stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage | RunResult>;
}
