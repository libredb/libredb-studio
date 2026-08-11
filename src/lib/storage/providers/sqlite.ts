/**
 * SQLite Server Storage Provider
 * Uses better-sqlite3 (Node.js compatible, works in production runner).
 * WAL mode enabled for concurrent read performance.
 */

import type { ServerStorageProvider, StorageCollection, StorageData } from "../types";
import { STORAGE_COLLECTIONS } from "../types";
import type BetterSqlite3 from "better-sqlite3";
import { logger } from "@/lib/logger";
import { DEFAULT_STORAGE_SQLITE_PATH } from "@/lib/data-dir";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any;

/**
 * better-sqlite3 has shipped N-API prebuilds since v13, so its binding is no
 * longer tied to the ABI of the Node that installed it and this guard should
 * not fire through a normal install. It stays for the cases that still can:
 * a pinned older better-sqlite3 (v12 and earlier compiled per Node ABI), or a
 * node_modules assembled from mixed installs. Either way the raw failure reads
 * like an installation bug - translate it into an actionable message.
 *
 * Only the NODE_MODULE_VERSION text (emitted by Node's module-register
 * check) is treated as an ABI mismatch. A bare ERR_DLOPEN_FAILED is NOT
 * enough: missing shared libraries, a libc mismatch, or a corrupted file
 * also surface as ERR_DLOPEN_FAILED - on any Node version - and must keep
 * their original error rather than a misleading ABI claim.
 */
function isNodeAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message);
}

export class SQLiteStorageProvider implements ServerStorageProvider {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH;
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import to avoid requiring better-sqlite3 when not needed
      if (!Database) {
        const mod = await import("better-sqlite3");
        Database = mod.default;
      }

      // Ensure directory exists
      const path = await import("path");
      const fs = await import("fs");
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath) as BetterSqlite3.Database;

      // Enable WAL mode for better concurrent read performance
      this.db!.pragma("journal_mode = WAL");

      // Create table
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS user_storage (
          user_id    TEXT NOT NULL,
          collection TEXT NOT NULL,
          data       TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, collection)
        )
      `);
    } catch (error) {
      logger.error("SQLite storage initialization failed", error, { provider: "sqlite", path: this.dbPath });
      if (isNodeAbiMismatch(error)) {
        throw new Error(
          // Deliberately NOT phrased as a floor ("Node 24 or newer"): a native
          // binding loads only on the exact ABI it was built against, so a
          // NEWER Node fails here too and would read such a message as already
          // satisfied.
          `Server-side SQLite storage (STORAGE_PROVIDER=sqlite) cannot start on Node ${process.versions.node}: the better-sqlite3 native module in this install was built for a different Node ABI and cannot load here. ` +
            "better-sqlite3 13 ships N-API prebuilds that work across Node majors, so this normally means a pinned older better-sqlite3 or an incomplete node_modules - reinstall dependencies, or use STORAGE_PROVIDER=postgres or STORAGE_PROVIDER=local instead. " +
            `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensureDb();
    const stmt = this.db!.prepare("SELECT collection, data FROM user_storage WHERE user_id = ?");
    const rows = stmt.all(userId) as { collection: string; data: string }[];

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(row.data);
      } catch {
        logger.warn("Skipping corrupted storage data", { provider: "sqlite", collection: row.collection });
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> {
    this.ensureDb();
    const stmt = this.db!.prepare("SELECT data FROM user_storage WHERE user_id = ? AND collection = ?");
    const row = stmt.get(userId, collection) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as StorageData[K];
    } catch {
      logger.warn("Corrupted data in storage collection", { provider: "sqlite", collection });
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT INTO user_storage (user_id, collection, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, collection)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    stmt.run(userId, collection, JSON.stringify(data));
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    this.ensureDb();
    const stmt = this.db!.prepare(`
      INSERT INTO user_storage (user_id, collection, data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, collection)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);

    const tx = this.db!.transaction(() => {
      for (const collection of STORAGE_COLLECTIONS) {
        const collectionData = (data as Record<string, unknown>)[collection];
        if (collectionData !== undefined) {
          stmt.run(userId, collection, JSON.stringify(collectionData));
        }
      }
    });
    tx();
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensureDb();
      const result = this.db!.prepare("SELECT 1 as ok").get() as { ok: number };
      return result?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): void {
    if (!this.db) {
      throw new Error("SQLite storage not initialized. Call initialize() first.");
    }
  }
}
