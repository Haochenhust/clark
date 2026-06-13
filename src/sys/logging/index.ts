import pino from "pino";

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

function parseLevel(): pino.Level {
  const raw = process.env.CLARK_LOG_LEVEL?.toLowerCase();
  if (raw && VALID_LEVELS.includes(raw as (typeof VALID_LEVELS)[number])) {
    return raw as pino.Level;
  }
  return "info";
}

const isProd = process.env.NODE_ENV === "production";

const rootOptions: pino.LoggerOptions = {
  level: parseLevel(),
  ...{
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: isProd ? "SYS:MM-DD HH:MM:ss" : "SYS:HH:MM:ss",
        ignore: "hostname,pid,topic",
      },
    },
  },
};

const rootLogger = pino(rootOptions);

/** Default logger with topic "clark" (no topic shown in output). */
export const logger = rootLogger.child({ topic: "clark" });

/**
 * Creates a child logger with the given topic. Use for session-scoped or
 * context-specific logging.
 *
 * @param topic - Topic string (e.g. `session-${sessionId}`).
 * @returns A Pino child logger with topic binding.
 */
export function createLogger(topic: string): pino.Logger {
  return rootLogger.child({
    topic,
    ...(topic !== "clark" && { name: topic }),
  });
}

export type { Logger } from "pino";
