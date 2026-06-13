import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { config, createLogger } from "@/sys";
import type { Message } from "@/sys";

import { formatFileLine } from "./session-writer-utils";

const logger = createLogger("daily-log-writer");

/**
 * Appends messages to the daily log file.
 * Cross-session. Uses synchronous writes for reliability.
 */
export class SessionDailyLogWriter {
  write(message: Message): void {
    try {
      const path = config.paths.resolveDailyLogFilePath(new Date(), config.logsDir);
      const line = formatFileLine(message);
      if (!line) return;

      if (!existsSync(path)) {
        const dir = dirname(path);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, "", "utf-8");
      }
      appendFileSync(path, `${line}\n\n`, "utf-8");
    } catch (err) {
      logger.error({ err }, "Failed to write daily log");
    }
  }
}
