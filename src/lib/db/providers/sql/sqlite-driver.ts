/**
 * SQLite driver adapter for the SQLite DB provider.
 *
 * Selects the embedded SQLite driver by runtime so sqlite connections work
 * both under Bun (standalone dev, Docker image) and under plain Node
 * (npx / brew / deb installs running `node server.js`):
 *
 * - Bun runtime  -> `bun:sqlite` (Bun built-in)
 * - Node runtime -> `node:sqlite` (Node built-in: unflagged from 22.13,
 *   stable on the recommended Node 24 LTS; `better-sqlite3` is not used here
 *   because Bun refuses to load it at all and its native binding must match
 *   the installing runtime's ABI, while `node:sqlite` needs no native
 *   dependency)
 *
 * Set LIBREDB_SQLITE_DRIVER=bun|node to force a driver (deterministic tests).
 * Both drivers load lazily via dynamic import, so neither is required unless
 * a sqlite connection is actually used. This module is internal to the SQLite
 * provider — other code must not depend on it.
 */

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

// Minimal structural view of node:sqlite (kept local so the adapter and its
// tests never need the real module, which Bun does not implement).
type NodeStatementLike = {
  all(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
};
export type NodeDatabaseSyncLike = {
  exec(sql: string): void;
  prepare(sql: string): NodeStatementLike;
  close(): void;
};
export type NodeSQLiteModule = { DatabaseSync: new (path: string) => NodeDatabaseSyncLike };

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

/**
 * Adapts node:sqlite's DatabaseSync to the bun:sqlite-shaped surface above.
 * The two APIs are nearly identical (synchronous exec/prepare/all/get/run);
 * the bridges below keep behaviour byte-compatible with bun:sqlite:
 * - node:sqlite opens read-write and creates missing files by default,
 *   matching the `{ create: true, readwrite: true }` options the provider
 *   passes to bun:sqlite, so open options are accepted and ignored.
 * - `get()` returns `undefined` on a miss where bun:sqlite returns `null`.
 * - `run()` reports `changes` as `number | bigint`; normalize to `number`.
 *
 * Exported (with the injectable ctor) so the adapter semantics are unit-testable
 * in-process under Bun, where node:sqlite itself cannot be imported.
 */
export function createNodeSQLiteDriver(DatabaseSyncCtor: NodeSQLiteModule["DatabaseSync"]): SQLiteConstructor {
  class NodeSQLiteDatabase implements SQLiteDatabase {
    private readonly db: NodeDatabaseSyncLike;

    constructor(dbPath: string, _options?: SQLiteOpenOptions) {
      this.db = new DatabaseSyncCtor(dbPath);
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare(sql: string): SQLiteStatement {
      const stmt = this.db.prepare(sql);
      return {
        all: (...params: unknown[]): unknown[] => stmt.all(...params) as unknown[],
        get: (...params: unknown[]): unknown => stmt.get(...params) ?? null,
        run: (...params: unknown[]): { changes: number } => {
          const info = stmt.run(...params);
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

async function importNodeSQLite(): Promise<NodeSQLiteModule> {
  return (await import("node:sqlite")) as unknown as NodeSQLiteModule;
}

/**
 * Load the node:sqlite-backed driver. The module import is injectable so the
 * success path is unit-testable under Bun (which lacks node:sqlite); callers
 * outside tests use the default importer.
 */
export async function loadNodeSQLiteDriver(
  importModule: () => Promise<NodeSQLiteModule> = importNodeSQLite,
): Promise<SQLiteConstructor> {
  const sqlite = await importModule();
  return createNodeSQLiteDriver(sqlite.DatabaseSync);
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
    const driver = name === "bun" ? await loadBunDriver() : await loadNodeSQLiteDriver();
    loadedDrivers.set(name, driver);
    return driver;
  } catch (error) {
    const loadError = new DatabaseConfigError(
      `SQLite driver "${name}" is not available in this environment: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The "bun" driver requires the Bun runtime (bun:sqlite); ' +
        'the "node" driver requires Node.js with the built-in node:sqlite module (Node 22.13+; Node 24 LTS recommended).',
      "sqlite",
    );
    driverLoadErrors.set(name, loadError);
    throw loadError;
  }
}
