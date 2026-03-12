/**
 * SQLite Server Storage Provider
 * Uses better-sqlite3 (Node.js compatible, works in production runner).
 * WAL mode enabled for concurrent read performance.
 */

import type { ServerStorageProvider, StorageCollection, StorageData } from '../types';
import { STORAGE_COLLECTIONS } from '../types';
import type BetterSqlite3 from 'better-sqlite3';
import { logger } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any;

export class SQLiteStorageProvider implements ServerStorageProvider {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || process.env.STORAGE_SQLITE_PATH || './data/libredb-storage.db';
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import to avoid requiring better-sqlite3 when not needed
      if (!Database) {
        const mod = await import('better-sqlite3');
        Database = mod.default;
      }

      // Ensure directory exists
      const path = await import('path');
      const fs = await import('fs');
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath) as BetterSqlite3.Database;

      // Enable WAL mode for better concurrent read performance
      this.db!.pragma('journal_mode = WAL');

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
      logger.error('SQLite storage initialization failed', error, { provider: 'sqlite', path: this.dbPath });
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensureDb();
    const stmt = this.db!.prepare(
      'SELECT collection, data FROM user_storage WHERE user_id = ?'
    );
    const rows = stmt.all(userId) as { collection: string; data: string }[];

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(row.data);
      } catch {
        logger.warn('Skipping corrupted storage data', { provider: 'sqlite', collection: row.collection });
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(
    userId: string,
    collection: K
  ): Promise<StorageData[K] | null> {
    this.ensureDb();
    const stmt = this.db!.prepare(
      'SELECT data FROM user_storage WHERE user_id = ? AND collection = ?'
    );
    const row = stmt.get(userId, collection) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as StorageData[K];
    } catch {
      logger.warn('Corrupted data in storage collection', { provider: 'sqlite', collection });
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(
    userId: string,
    collection: K,
    data: StorageData[K]
  ): Promise<void> {
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
      const result = this.db!.prepare('SELECT 1 as ok').get() as { ok: number };
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
      throw new Error('SQLite storage not initialized. Call initialize() first.');
    }
  }
}
