/**
 * TmuxClaudeAgentRunner — the AgentRunner adapter over the single warm `claude`
 * pane. createAgentRunner() builds a fresh runner per turn, so all pane state and
 * the turn lifecycle live in the `warmPane` singleton (see warm-pane-manager.ts);
 * this class is a thin pass-through that keeps the AgentRunner contract (same four
 * yielded shapes) so no consumer (Session.stream, live card, kernel) changes.
 */
import type {
  AgentRunOptions,
  AgentRunner,
  AssistantMessage,
  RunResult,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from "@/sys";

import { warmPane } from "./warm-pane-manager";

export { AgentAbortError } from "./warm-pane-manager";

export class TmuxClaudeAgentRunner implements AgentRunner {
  readonly type = "claude";

  async *stream(
    userMessage: UserMessage,
    options: AgentRunOptions,
  ): AsyncIterableIterator<SystemMessage | AssistantMessage | ToolMessage | RunResult> {
    yield* warmPane.stream(userMessage, options);
  }
}
