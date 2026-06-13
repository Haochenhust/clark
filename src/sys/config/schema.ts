import { z } from "zod";

export const AgentConfig = z.object({
  type: z.string().default("claude"),
  model: z.string().default("claude-sonnet-4-6"),
});
export interface AgentConfig extends z.infer<typeof AgentConfig> {}

export const AgentsConfig = z.object({ default: AgentConfig });
export interface AgentsConfig extends z.infer<typeof AgentsConfig> {}

export const TaskingConfig = z.object({
  max_retries: z.number().int().positive().default(1),
  concurrency: z.number().int().positive().default(4),
});
export interface TaskingConfig extends z.infer<typeof TaskingConfig> {}

export interface FeishuBotConfig {
  channelId: string;
  name: string;
  appId: string;
  appSecret: string;
  larkCliConfigDir: string;
}

export const AppConfig = z.object({
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  agents: AgentsConfig,
  tasking: TaskingConfig,
});
export interface AppConfig extends z.infer<typeof AppConfig> {}
