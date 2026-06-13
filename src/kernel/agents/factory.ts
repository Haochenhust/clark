import { TmuxClaudeAgentRunner } from "@/providers/claude";
import type { AgentRunner } from "@/sys";

export function createAgentRunner(_type?: string): AgentRunner {
  return new TmuxClaudeAgentRunner();
}
