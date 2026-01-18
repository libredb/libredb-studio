/**
 * SQLite Database Provider
 * File-based SQLite support - Uses bun:sqlite when available
 *
 * Note: SQLite is primarily for local development. Cloud deployments
 * typically use PostgreSQL or MySQL instead.
 */

import { SQLBaseProvider } from './sql-base';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';
import { formatBytes } from '../../utils/pool-manager';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Dynamic SQLite Import (for Bun runtime compatibility)
// ============================================================================

type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
};

type SQLiteConstructor = new (path: string, options?: { create?: boolean; readwrite?: boolean }) => SQLiteDatabase;

let Database: SQLiteConstructor | null = null;
let sqliteLoadError: Error | null = null;

// Try to load bun:sqlite at runtime
async function loadSQLite(): Promise<SQLiteConstructor> {
  if (Database) return Database;
  if (sqliteLoadError) throw sqliteLoadError;

  try {
    // Dynamic import for bun:sqlite
    const sqlite = await import('bun:sqlite');
    Database = sqlite.Database as unknown as SQLiteConstructor;
    return Database;
  } catch {
    sqliteLoadError = new DatabaseConfigError(
      'SQLite is not available in this environment. SQLite requires Bun runtime. For cloud deployments, use PostgreSQL or MySQL instead.',
      'sqlite'
    );
    throw sqliteLoadError;
  }
}

// ============================================================================
// SQLite Provider
// ============================================================================

export class SQLiteProvider extends SQLBaseProvider {
  private db: SQLiteDatabase | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.database && !this.config.connectionString) {
      throw new DatabaseConfigError(
        'Database file path is required for SQLite (use "database" field or ":memory:" for in-memory)',
        'sqlite'
      );
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      // Dynamically load SQLite
      const SQLiteDB = await loadSQLite();

      const dbPath = this.getDatabasePath();

      if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new SQLiteDB(dbPath, {
        create: true,
        readwrite: true,
      });

      // Enable WAL mode and foreign keys
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));

      if (error instanceof DatabaseConfigError) {
        throw error;
      }

      throw new ConnectionError(
        `Failed to open SQLite database: ${error instanceof Error ? error.message : error}`,
        'sqlite'
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.setConnected(false);
    }
  }

  private getDatabasePath(): string {
    if (this.config.connectionString) {
      if (this.config.connectionString.startsWith('file:')) {
        return this.config.connectionString.replace('file:', '');
      }
      return this.config.connectionString;
    }
    return this.config.database || ':memory:';
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const isSelect = this.isReadOnlyQuery(sql);

          if (isSelect) {
            const stmt = this.db!.prepare(sql);
            const rows = params ? stmt.all(...params) : stmt.all();
            const fields = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            return {
              rows: (rows as unknown[]).map(row => row as Record<string, unknown>) as Record<string, unknown>[],
              fields,
              changes: 0,
            };
          } else {
            const stmt = this.db!.prepare(sql);
            const info = params ? stmt.run(...params) : stmt.run();
            return {
              rows: [],
              fields: [],
              changes: info.changes,
            };
          }
        } catch (error) {
          throw mapDatabaseError(error, 'sqlite', sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rows.length || result.changes,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `);
    const tables = tablesStmt.all() as { name: string }[];

    const schemas: TableSchema[] = [];

    for (const { name: tableName } of tables) {
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      const columnsStmt = this.db!.prepare(`PRAGMA table_info("${tableName}")`);
      const columns = columnsStmt.all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const fkStmt = this.db!.prepare(`PRAGMA foreign_key_list("${tableName}")`);
      const foreignKeys = fkStmt.all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>;

      const indexStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexStmt.all() as Array<{
        seq: number;
        name: string;
        unique: number;
      }>;

      const indexes = [];
      for (const idx of indexList) {
        if (idx.name.startsWith('sqlite_')) continue;

        const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${idx.name}")`);
        const indexCols = indexInfoStmt.all() as Array<{ seqno: number; cid: number; name: string }>;

        indexes.push({
          name: idx.name,
          columns: indexCols.map((c) => c.name),
          unique: idx.unique === 1,
        });
      }

      let sizeBytes = 0;
      try {
        const pageCountStmt = this.db!.prepare(`
          SELECT (SELECT page_count FROM pragma_page_count()) *
                 (SELECT page_size FROM pragma_page_size()) as size
        `);
        const sizeResult = pageCountStmt.get() as { size: number };
        sizeBytes = sizeResult?.size || 0;
      } catch {
        // Ignore size calculation errors
      }

      schemas.push({
        name: tableName,
        rowCount,
        size: formatBytes(sizeBytes),
        columns: columns.map((col) => ({
          name: col.name,
          type: col.type || 'TEXT',
          nullable: col.notnull === 0,
          isPrimary: col.pk === 1,
          defaultValue: col.dflt_value ?? undefined,
        })),
        indexes,
        foreignKeys: foreignKeys.map((fk) => ({
          columnName: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to,
        })),
      });
    }

    return schemas;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    let databaseSize = 'N/A';
    if (dbPath !== ':memory:') {
      try {
        const stats = fs.statSync(dbPath);
        databaseSize = formatBytes(stats.size);
      } catch {
        databaseSize = 'Unknown';
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(`
          SELECT (page_count * page_size) as size
          FROM pragma_page_count(), pragma_page_size()
        `);
        const result = sizeStmt.get() as { size: number };
        databaseSize = formatBytes(result?.size || 0);
      } catch {
        databaseSize = 'N/A';
      }
    }

    let isHealthy = true;
    try {
      const integrityStmt = this.db!.prepare('PRAGMA integrity_check');
      const integrityResult = integrityStmt.get() as { integrity_check: string };
      isHealthy = integrityResult?.integrity_check === 'ok';
    } catch {
      isHealthy = false;
    }

    let journalMode = 'unknown';
    try {
      const journalStmt = this.db!.prepare('PRAGMA journal_mode');
      const journalResult = journalStmt.get() as { journal_mode: string };
      journalMode = journalResult?.journal_mode || 'unknown';
    } catch {
      // Ignore
    }

    return {
      activeConnections: 1,
      databaseSize,
      cacheHitRatio: 'N/A',
      slowQueries: [
        {
          query: `Integrity: ${isHealthy ? 'OK' : 'FAILED'}`,
          calls: 0,
          avgTime: 'N/A',
        },
        {
          query: `Journal Mode: ${journalMode}`,
          calls: 0,
          avgTime: 'N/A',
        },
      ],
      activeSessions: [
        {
          pid: process.pid,
          user: 'sqlite',
          database: path.basename(dbPath),
          state: 'active',
          query: '',
          duration: 'N/A',
        },
      ],
    };
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(
    type: MaintenanceType,
    target?: string
  ): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      let sql = '';

      switch (type) {
        case 'vacuum':
          sql = 'VACUUM';
          break;
        case 'analyze':
          sql = target ? `ANALYZE "${target}"` : 'ANALYZE';
          break;
        case 'reindex':
          sql = target ? `REINDEX "${target}"` : 'REINDEX';
          break;
        case 'check':
          const checkStmt = this.db!.prepare('PRAGMA integrity_check');
          const checkResult = checkStmt.get() as { integrity_check: string };
          return {
            success: checkResult?.integrity_check === 'ok',
            message: checkResult?.integrity_check || 'Unknown',
          };
        default:
          throw new QueryError(`Unsupported maintenance type for SQLite: ${type}`, 'sqlite');
      }

      this.db!.exec(sql);
      return { success: true, message: `${type.toUpperCase()} completed successfully` };
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    // Get SQLite version
    const versionStmt = this.db!.prepare('SELECT sqlite_version() as version');
    const versionResult = versionStmt.get() as { version: string };
    const version = `SQLite ${versionResult?.version || 'Unknown'}`;

    // Get database size
    const dbPath = this.getDatabasePath();
    let databaseSizeBytes = 0;

    if (dbPath !== ':memory:') {
      try {
        const stats = fs.statSync(dbPath);
        databaseSizeBytes = stats.size;
      } catch {
        // File might not exist yet
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(`
          SELECT (page_count * page_size) as size
          FROM pragma_page_count(), pragma_page_size()
        `);
        const result = sizeStmt.get() as { size: number };
        databaseSizeBytes = result?.size || 0;
      } catch {
        // Ignore
      }
    }

    // Get table count
    const tableCountStmt = this.db!.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `);
    const tableCountResult = tableCountStmt.get() as { count: number };
    const tableCount = tableCountResult?.count || 0;

    // Get index count
    const indexCountStmt = this.db!.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `);
    const indexCountResult = indexCountStmt.get() as { count: number };
    const indexCount = indexCountResult?.count || 0;

    return {
      version,
      uptime: 'N/A',
      activeConnections: 1,
      maxConnections: 1,
      databaseSize: formatBytes(databaseSizeBytes),
      databaseSizeBytes,
      tableCount,
      indexCount,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    let cacheHitRatio = 99;

    try {
      // Get cache stats
      const cacheStmt = this.db!.prepare('PRAGMA cache_size');
      const cacheResult = cacheStmt.get() as { cache_size: number };

      // SQLite doesn't provide detailed cache hit stats, estimate high ratio
      if (cacheResult?.cache_size) {
        cacheHitRatio = 95; // Reasonable estimate for in-memory cache
      }
    } catch {
      // Ignore
    }

    return {
      cacheHitRatio,
      // SQLite doesn't provide these metrics
      queriesPerSecond: undefined,
      bufferPoolUsage: undefined,
      deadlocks: 0,
    };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    // SQLite doesn't have built-in query statistics
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    // SQLite is single-connection, return current session
    return [{
      pid: process.pid,
      user: 'sqlite',
      database: path.basename(dbPath),
      state: 'active',
      query: '',
      duration: 'N/A',
      durationMs: 0,
    }];
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    const tables = tablesStmt.all() as { name: string }[];

    const stats: TableStats[] = [];

    for (const { name: tableName } of tables) {
      // Get row count
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      // Estimate table size (SQLite doesn't provide per-table sizes)
      // Use page count approximation
      let tableSizeBytes = 0;
      try {
        // Rough estimate: rows * average row size
        tableSizeBytes = rowCount * 100; // Assume 100 bytes average per row
      } catch {
        // Ignore
      }

      stats.push({
        schemaName: 'main',
        tableName,
        rowCount,
        tableSize: formatBytes(tableSizeBytes),
        tableSizeBytes,
        totalSize: formatBytes(tableSizeBytes),
        totalSizeBytes: tableSizeBytes,
      });
    }

    return stats;
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    const indexesStmt = this.db!.prepare(`
      SELECT name, tbl_name FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY tbl_name, name
    `);
    const indexes = indexesStmt.all() as { name: string; tbl_name: string }[];

    const stats: IndexStats[] = [];

    for (const { name: indexName, tbl_name: tableName } of indexes) {
      // Get index info
      const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${indexName}")`);
      const indexCols = indexInfoStmt.all() as { seqno: number; cid: number; name: string }[];

      // Get index uniqueness
      const indexListStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexListStmt.all() as { name: string; unique: number }[];
      const indexMeta = indexList.find((i) => i.name === indexName);

      stats.push({
        schemaName: 'main',
        tableName,
        indexName,
        columns: indexCols.map((c) => c.name),
        isUnique: indexMeta?.unique === 1,
        isPrimary: false, // SQLite auto-creates rowid, explicit PKs are shown differently
        indexSize: 'N/A',
        indexSizeBytes: 0,
        scans: 0, // SQLite doesn't track index usage
      });
    }

    return stats;
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const stats: StorageStats[] = [];
    const dbPath = this.getDatabasePath();

    // Main database file
    let mainSizeBytes = 0;
    if (dbPath !== ':memory:') {
      try {
        const fileStats = fs.statSync(dbPath);
        mainSizeBytes = fileStats.size;
      } catch {
        // File might not exist
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(`
          SELECT (page_count * page_size) as size
          FROM pragma_page_count(), pragma_page_size()
        `);
        const result = sizeStmt.get() as { size: number };
        mainSizeBytes = result?.size || 0;
      } catch {
        // Ignore
      }
    }

    stats.push({
      name: 'Main Database',
      location: dbPath === ':memory:' ? ':memory:' : path.basename(dbPath),
      size: formatBytes(mainSizeBytes),
      sizeBytes: mainSizeBytes,
    });

    // WAL file (if exists)
    if (dbPath !== ':memory:') {
      const walPath = `${dbPath}-wal`;
      try {
        const walStats = fs.statSync(walPath);
        stats.push({
          name: 'WAL',
          location: path.basename(walPath),
          size: formatBytes(walStats.size),
          sizeBytes: walStats.size,
          walSize: formatBytes(walStats.size),
          walSizeBytes: walStats.size,
        });
      } catch {
        // WAL might not exist
      }

      // SHM file (if exists)
      const shmPath = `${dbPath}-shm`;
      try {
        const shmStats = fs.statSync(shmPath);
        stats.push({
          name: 'Shared Memory',
          location: path.basename(shmPath),
          size: formatBytes(shmStats.size),
          sizeBytes: shmStats.size,
        });
      } catch {
        // SHM might not exist
      }
    }

    return stats;
  }
}
