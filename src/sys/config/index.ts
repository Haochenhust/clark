import fs from "node:fs";
import { join, resolve } from "node:path";
import * as paths from "./paths";
import { getEnv } from "./env-reader";
import type { FeishuBotConfig } from "./schema";

function _resolveWorkspaceDir(): string {
  const raw = getEnv("WORKSPACE_DIR");
  return raw ? resolve(raw) : paths.defaultWorkspace;
}

/**
 * Read model/effort from the workspace's own `.claude/settings.json` (what the
 * interactive `claude` running in that cwd uses), falling back to the user's
 * global `~/.claude/settings.json`, then to hardcoded defaults.
 */
function _readClaudeSettings(): Record<string, unknown> {
  const candidates = [
    join(_resolveWorkspaceDir(), ".claude", "settings.json"),
    join(process.env.HOME ?? "", ".claude", "settings.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      // try next candidate
    }
  }
  return {};
}

export { getEnv, readEnvFile } from "./env-reader";
export type { AgentConfig, AgentsConfig, AppConfig, FeishuBotConfig, TaskingConfig } from "./schema";

export interface Config {
  timezone: string;
  agents: { default: { type: string; model: string; effortLevel: string } };
  tasking: { max_retries: number; concurrency: number };
  paths: typeof paths;
  assistantName: string;
  /** The single workspace dir that every chat's claude session runs in. */
  workspaceDir: string;
  /** Where inbound Feishu attachments are downloaded. */
  uploadsDir: string;
  /** Where daily conversation logs are written. */
  logsDir: string;
  /** Chat to send the boot/restart notification to (open_id or chat_id), if any. */
  notifyChatId: string | undefined;
  /** The single Feishu bot this instance serves. */
  feishu: FeishuBotConfig;
}

function _buildFeishuBot(): FeishuBotConfig {
  const appId = getEnv("FEISHU_APP_ID");
  return {
    channelId: "feishu",
    name: getEnv("ASSISTANT_NAME", "clark"),
    appId,
    appSecret: getEnv("FEISHU_APP_SECRET"),
    larkCliConfigDir:
      getEnv("LARKSUITE_CLI_CONFIG_DIR") || join(paths.store, "lark-cli", appId || "default"),
  };
}

export const config: Config = {
  get timezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  },
  agents: {
    default: {
      get type() {
        return "claude";
      },
      get model() {
        return (_readClaudeSettings().model as string) ?? "claude-sonnet-4-6";
      },
      get effortLevel() {
        // Default must be a value `claude --effort` accepts (low/medium/high/
        // xhigh/max); "normal" is NOT one of them and would fail pane spawn.
        return (_readClaudeSettings().effortLevel as string) ?? "high";
      },
    },
  },
  tasking: {
    get max_retries() {
      return 1;
    },
    // v2 warm-pane model is strictly serial: one warm pane, one turn at a time.
    get concurrency() {
      return parseInt(getEnv("MAX_CONCURRENT_AGENTS", "1"));
    },
  },
  paths,
  get assistantName() {
    return getEnv("ASSISTANT_NAME", "clark");
  },
  get workspaceDir() {
    return _resolveWorkspaceDir();
  },
  get uploadsDir() {
    return join(_resolveWorkspaceDir(), "uploads");
  },
  get logsDir() {
    return join(_resolveWorkspaceDir(), "logs");
  },
  get notifyChatId() {
    const v = getEnv("NOTIFY_CHAT_ID");
    return v || undefined;
  },
  get feishu() {
    return _buildFeishuBot();
  },
};
