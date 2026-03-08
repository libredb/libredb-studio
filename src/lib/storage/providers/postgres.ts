/**
 * PostgreSQL Server Storage Provider
 * Uses the existing `pg` package (already a project dependency).
 */

import type { ServerStorageProvider, StorageCollection, StorageData } from '../types';
import { STORAGE_COLLECTIONS } from '../types';

let Pool: typeof import('pg').Pool;

export class PostgresStorageProvider implements ServerStorageProvider {
  private pool: InstanceType<typeof import('pg').Pool> | null = null;
  private connectionString: string;

  constructor(connectionString?: string) {
    this.connectionString =
      connectionString || process.env.STORAGE_POSTGRES_URL || '';
  }

  async initialize(): Promise<void> {
    if (!this.connectionString) {
      throw new Error(
        'STORAGE_POSTGRES_URL is required when STORAGE_PROVIDER=postgres'
      );
    }

    // Dynamic import to avoid requiring pg when not needed
    if (!Pool) {
      const pg = await import('pg');
      Pool = pg.Pool;
    }

    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      ssl: this.buildSSLConfig(),
    });

    // Create table
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS user_storage (
          user_id    TEXT NOT NULL,
          collection TEXT NOT NULL,
          data       TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, collection)
        )
      `);
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not support SSL')) {
        throw new Error(
          'PostgreSQL storage connection failed: server does not support SSL. Add ?sslmode=disable to STORAGE_POSTGRES_URL for local PostgreSQL.',
          { cause: error }
        );
      }
      throw error;
    }
  }

  async getAllData(userId: string): Promise<Partial<StorageData>> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      'SELECT collection, data FROM user_storage WHERE user_id = $1',
      [userId]
    );

    const result: Partial<StorageData> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.collection] = JSON.parse(
          row.data
        );
      } catch {
        // Skip corrupted data
      }
    }
    return result;
  }

  async getCollection<K extends StorageCollection>(
    userId: string,
    collection: K
  ): Promise<StorageData[K] | null> {
    this.ensurePool();
    const { rows } = await this.pool!.query(
      'SELECT data FROM user_storage WHERE user_id = $1 AND collection = $2',
      [userId, collection]
    );
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].data) as StorageData[K];
    } catch {
      return null;
    }
  }

  async setCollection<K extends StorageCollection>(
    userId: string,
    collection: K,
    data: StorageData[K]
  ): Promise<void> {
    this.ensurePool();
    await this.pool!.query(
      `INSERT INTO user_storage (user_id, collection, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, collection)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [userId, collection, JSON.stringify(data)]
    );
  }

  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> {
    this.ensurePool();
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const collection of STORAGE_COLLECTIONS) {
        const collectionData = (data as Record<string, unknown>)[collection];
        if (collectionData !== undefined) {
          await client.query(
            `INSERT INTO user_storage (user_id, collection, data, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id, collection)
             DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [userId, collection, JSON.stringify(collectionData)]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.ensurePool();
      const { rows } = await this.pool!.query('SELECT 1 as ok');
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensurePool(): void {
    if (!this.pool) {
      throw new Error(
        'PostgreSQL storage not initialized. Call initialize() first.'
      );
    }
  }

  private buildSSLConfig(): boolean | { rejectUnauthorized: boolean } {
    const { host, searchParams } = this.parseConnectionString(this.connectionString);

    const sslMode = searchParams.get('sslmode')?.toLowerCase();
    if (sslMode === 'disable') return false;
    if (
      sslMode === 'require' ||
      sslMode === 'prefer' ||
      sslMode === 'verify-ca' ||
      sslMode === 'verify-full'
    ) {
      return { rejectUnauthorized: false };
    }

    const sslParam = searchParams.get('ssl')?.toLowerCase();
    if (sslParam === 'false' || sslParam === '0' || sslParam === 'no') {
      return false;
    }
    if (sslParam === 'true' || sslParam === '1' || sslParam === 'yes') {
      return { rejectUnauthorized: false };
    }

    if (this.isLocalHost(host)) return false;
    if (this.isCloudHost(host)) return { rejectUnauthorized: false };
    return false;
  }

  private parseConnectionString(connectionString: string): {
    host: string;
    searchParams: URLSearchParams;
  } {
    try {
      const parsed = new URL(connectionString);
      return {
        host: parsed.hostname.toLowerCase(),
        searchParams: parsed.searchParams,
      };
    } catch {
      return {
        host: '',
        searchParams: new URLSearchParams(),
      };
    }
  }

  private isLocalHost(host: string): boolean {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  private isCloudHost(host: string): boolean {
    const cloudHints = [
      'supabase',
      'render',
      'neon',
      'planetscale',
      'amazonaws.com',
      'azure',
      'gcp',
      'googleapis.com',
      'cloud',
      'aiven',
      'railway',
      'elephantsql',
    ];
    return cloudHints.some((hint) => host.includes(hint));
  }
}
