/**
 * SQLite driver adapter for the SQLite DB provider.
 *
 * Selects the embedded SQLite driver by runtime so sqlite connections work
 * both under Bun (standalone dev, Docker image) and under plain Node
 * (npx / brew / deb installs running `node server.js`):
 *
 * - Bun runtime  -> `bun:sqlite` (Bun built-in)
 * - Node runtime -> `node:sqlite` (Node built-in, stable for the package's
 *   Node >= 24 target; `better-sqlite3` is not used here because Bun refuses
 *   to load it at all and its native binding must match the installing
 *   runtime's ABI, while `node:sqlite` needs no native dependency)
 *
 * Set LIBREDB_SQLITE_DRIVER=bun|node to force a driver (deterministic tests).
 * Both drivers load lazily via dynamic import, so neither is required unless
 * a sqlite connection is actually used. This module is internal to the SQLite
 * provider — other code must not depend on it.
 */

import type { DatabaseSync } from "node:sqlite";
import { DatabaseConfigError } from "../../errors";

// The exact driver surface the SQLite provider uses (bun:sqlite-shaped).
export type SQLiteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
};

export type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
};

export type SQLiteOpenOptions = { create?: boolean; readwrite?: boolean };

export type SQLiteConstructor = new (path: string, options?: SQLiteOpenOptions) => SQLiteDatabase;

export type SQLiteDriverName = "bun" | "node";

const loadedDrivers = new Map<SQLiteDriverName, SQLiteConstructor>();
const driverLoadErrors = new Map<SQLiteDriverName, Error>();

/**
 * Resolve which driver to use: the LIBREDB_SQLITE_DRIVER override wins,
 * otherwise pick by the current runtime.
 */
export function resolveSQLiteDriverName(): SQLiteDriverName {
  const override = process.env.LIBREDB_SQLITE_DRIVER;
  if (override === "bun" || override === "node") {
    return override;
  }
  return typeof Bun === "undefined" ? "node" : "bun";
}

async function loadBunDriver(): Promise<SQLiteConstructor> {
  const sqlite = await import("bun:sqlite");
  return sqlite.Database as unknown as SQLiteConstructor;
}

async function loadNodeDriver(): Promise<SQLiteConstructor> {
  const sqlite = await import("node:sqlite");

  /**
   * Adapts node:sqlite's DatabaseSync to the bun:sqlite-shaped surface above.
   * The two APIs are nearly identical (synchronous exec/prepare/all/get/run);
   * the bridges below keep behaviour byte-compatible with bun:sqlite:
   * - node:sqlite opens read-write and creates missing files by default,
   *   matching the `{ create: true, readwrite: true }` options the provider
   *   passes to bun:sqlite, so open options are accepted and ignored.
   * - `get()` returns `undefined` on a miss where bun:sqlite returns `null`.
   * - `run()` reports `changes` as `number | bigint`; normalize to `number`.
   */
  class NodeSQLiteDatabase implements SQLiteDatabase {
    private readonly db: DatabaseSync;

    constructor(dbPath: string, _options?: SQLiteOpenOptions) {
      this.db = new sqlite.DatabaseSync(dbPath);
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare(sql: string): SQLiteStatement {
      const stmt = this.db.prepare(sql);
      type BindParams = Parameters<typeof stmt.all>;
      return {
        all: (...params: unknown[]): unknown[] => stmt.all(...(params as BindParams)) as unknown[],
        get: (...params: unknown[]): unknown => stmt.get(...(params as BindParams)) ?? null,
        run: (...params: unknown[]): { changes: number } => {
          const info = stmt.run(...(params as BindParams));
          return { changes: Number(info.changes) };
        },
      };
    }

    close(): void {
      this.db.close();
    }
  }

  return NodeSQLiteDatabase;
}

/**
 * Load the runtime-appropriate SQLite driver (lazily, cached per driver).
 */
export async function loadSQLiteDriver(): Promise<SQLiteConstructor> {
  const name = resolveSQLiteDriverName();

  const cached = loadedDrivers.get(name);
  if (cached) {
    return cached;
  }
  const cachedError = driverLoadErrors.get(name);
  if (cachedError) {
    throw cachedError;
  }

  try {
    const driver = name === "bun" ? await loadBunDriver() : await loadNodeDriver();
    loadedDrivers.set(name, driver);
    return driver;
  } catch (error) {
    const loadError = new DatabaseConfigError(
      `SQLite driver "${name}" is not available in this environment: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The "bun" driver requires the Bun runtime (bun:sqlite); ' +
        'the "node" driver requires Node.js with the built-in node:sqlite module (Node >= 24).',
      "sqlite",
    );
    driverLoadErrors.set(name, loadError);
    throw loadError;
  }
}
