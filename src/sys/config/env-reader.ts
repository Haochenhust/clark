import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as paths from "./paths";

let _envCache: Record<string, string> | null = null;

export function readEnvFile(): Record<string, string> {
  if (_envCache) return _envCache;
  const envPath = join(paths.root, ".env");
  if (!existsSync(envPath)) {
    _envCache = {};
    return _envCache;
  }
  const raw = readFileSync(envPath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    result[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
  }
  _envCache = result;
  return _envCache;
}

export function getEnv(key: string, defaultValue?: string): string {
  const env = readEnvFile();
  return env[key] ?? Bun.env[key] ?? defaultValue ?? "";
}
