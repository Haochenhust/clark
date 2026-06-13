import { join } from "node:path";

import dayjs from "dayjs";

/** Repo root (three levels up from src/sys/config). */
export const root = join(import.meta.dir, "..", "..", "..");
export const store = join(root, "store");
export const sessions = join(store, "sessions");
/** Default single workspace dir; overridable via WORKSPACE_DIR (see config). */
export const defaultWorkspace = join(root, "workspace");

export function resolveSessionFilePath(sessionId: string): string {
  return join(sessions, `${sessionId}.jsonl`);
}

export function resolveDailyLogFilePath(date: Date, logsDir: string): string {
  return join(logsDir, `${dayjs(date).format("YYYY-MM-DD")}.md`);
}

export function resolveDataFilePath(filename: string): string {
  return join(store, filename);
}
