import { join } from "node:path";

import { Database as SQLiteDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { Logger } from "@/sys";
import { config, createLogger } from "@/sys";

/** The Drizzle db instance type returned by {@link DataConnection.db}. */
export type DrizzleDB<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = ReturnType<typeof drizzle<TSchema>>;

/**
 * Central SQLite database for clark.
 *
 * Wraps `bun:sqlite` + Drizzle ORM. The caller injects table schemas so that
 * this module has no dependency on the kernel layer.
 *
 * Migrations are managed by `drizzle-kit generate` and applied automatically
 * on startup via `drizzle-orm/bun-sqlite/migrator`.
 *
 * @typeParam TSchema - The merged Drizzle schema object.
 */
export class DataConnection<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  private _sqlite: SQLiteDatabase;
  private _db: DrizzleDB<TSchema>;
  private _logger: Logger;

  constructor(schemas: TSchema) {
    this._logger = createLogger("database");

    const dbPath = config.paths.resolveDataFilePath("clark.db");
    this._sqlite = new SQLiteDatabase(dbPath, { create: true });
    this._sqlite.run("PRAGMA journal_mode = WAL");
    this._sqlite.run("PRAGMA foreign_keys = ON");

    this._db = drizzle(this._sqlite, { schema: schemas });

    const migrationsFolder = join(import.meta.dir, "..", "..", "drizzle");
    migrate(this._db, { migrationsFolder });

    this._logger.info(`Database "${dbPath}" opened`);
  }

  /** The Drizzle database instance for executing typed queries. */
  get db(): DrizzleDB<TSchema> {
    return this._db;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this._sqlite.close();
    this._logger.info("database closed");
  }
}
