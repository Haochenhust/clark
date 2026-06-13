import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config, createLogger } from "@/sys";

const logger = createLogger("boot-loader");

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

class BootLoader {
  async bootstrap(): Promise<void> {
    this._verifyDirectories();
    await this._igniteKernel();
  }

  private _verifyDirectories(): void {
    const dirs = [
      config.workspaceDir,
      config.uploadsDir,
      config.logsDir,
      config.paths.store,
      config.paths.sessions,
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        logger.info(`Created directory: ${dir}`);
      }
    }
  }

  private async _igniteKernel(): Promise<void> {
    const { kernel } = await import("@/kernel");
    const logo = `
╔══════════════════════════════════════╗
║     clark — AgentOS                 ║
║     Claude Code as SuperAgent       ║
╚══════════════════════════════════════╝`;
    console.info(logo);
    await kernel.start();

    // Write PID file for external tools (skills, scripts) to send signals
    const pidFile = join(config.paths.store, "clark.pid");
    writeFileSync(pidFile, String(process.pid));

    // Reload scheduled tasks on SIGUSR1 (used by scheduled-tasks skill)
    process.on("SIGUSR1", async () => {
      logger.info("Received SIGUSR1, reloading scheduled tasks...");
      writeFileSync(pidFile, String(process.pid));
      await kernel.reloadScheduledTasks();
    });

    // Graceful shutdown on SIGTERM/SIGINT
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info(`Received ${signal}, shutting down...`);
      try { unlinkSync(pidFile); } catch {}
      await kernel.stop();
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    logger.info("clark is now running...");
  }
}

export const bootLoader = new BootLoader();
