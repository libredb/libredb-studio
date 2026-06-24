/**
 * LibreDB Embedded Provider
 *
 * Opens a local `.libredb` file in-process via the embedded `@libredb/libredb`
 * package (the SQLite embedded pattern). LibreDB has no server or wire protocol;
 * the file path travels in `config.database`, like SQLite. The on-disk format is
 * raw ordered key-value bytes, so this provider presents keys grouped by their
 * `:`-prefix as pseudo-"tables" (the Redis pattern) and exposes a small
 * get/put/delete/prefix/range command grammar over the kv lens.
 *
 * The package API is synchronous; calls are wrapped to satisfy the async
 * provider contract. The import is lazy and dynamic so the package never enters
 * a client bundle and `build:lib` (tsup) can externalize it.
 */
import { BaseDatabaseProvider } from '../../base-provider';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type PreparedQuery,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../../types';
import { DatabaseConfigError, ConnectionError, QueryError } from '../../errors';
import { formatBytes } from '../../utils/pool-manager';
import * as fs from 'fs';

// ============================================================================
// Lazy package loader (mirrors sqlite.ts loading bun:sqlite)
// ============================================================================

type LibreDBModule = typeof import('@libredb/libredb');
type LibreDatabase = import('@libredb/libredb').Database;
type LibreKv = import('@libredb/libredb').Kv;

let libredbModule: LibreDBModule | null = null;
let libredbLoadError: Error | null = null;

async function loadLibreDB(): Promise<LibreDBModule> {
  if (libredbModule) return libredbModule;
  if (libredbLoadError) throw libredbLoadError;
  try {
    libredbModule = await import('@libredb/libredb');
    return libredbModule;
  } catch {
    libredbLoadError = new DatabaseConfigError(
      'LibreDB package (@libredb/libredb) is not available in this environment. Install it with: bun add @libredb/libredb',
      'libredb'
    );
    throw libredbLoadError;
  }
}

// ============================================================================
// LibreDB Provider
// ============================================================================

export class LibreDBProvider extends BaseDatabaseProvider {
  protected db: LibreDatabase | null = null;
  protected kv: LibreKv | null = null;
  protected dbVersion = 'unknown';

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: 'json',
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      schemaRefreshPattern: '\\b(put|delete)\\b',
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: 'Key Prefix',
      entityNamePlural: 'Key Prefixes',
      rowName: 'key',
      rowNamePlural: 'keys',
      selectAction: 'Scan Keys',
      generateAction: 'Generate Command',
      analyzeAction: 'Key Info',
      vacuumAction: 'Compact',
      searchPlaceholder: 'Search keys...',
      analyzeGlobalLabel: 'Info',
      analyzeGlobalTitle: 'Database Info',
      analyzeGlobalDesc: 'Show LibreDB file information and key statistics.',
      vacuumGlobalLabel: 'Compact',
      vacuumGlobalTitle: 'Compact',
      vacuumGlobalDesc: 'Not supported for LibreDB in this version.',
    };
  }

  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 500, offset: 0 };
  }

  // --------------------------------------------------------------------------
  // Validation & lifecycle
  // --------------------------------------------------------------------------

  public override validate(): void {
    super.validate();
    if (!this.config.database) {
      throw new DatabaseConfigError(
        'LibreDB requires a file path (use the "database" field, e.g. /data/app.libredb)',
        'libredb'
      );
    }
  }

  public async connect(): Promise<void> {
    this.validate(); // throws DatabaseConfigError if database path is missing
    const lib = await loadLibreDB(); // DatabaseConfigError propagates if unavailable
    try {
      this.db = lib.open({ path: this.config.database! });
      this.kv = lib.kv(this.db);
      this.dbVersion = lib.version;
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to open LibreDB file: ${error instanceof Error ? error.message : String(error)}`,
        'libredb'
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      try { this.db.close(); } catch { /* close is idempotent; ignore */ }
      this.db = null;
      this.kv = null;
    }
    this.setConnected(false);
  }

  // --------------------------------------------------------------------------
  // Schema & query (filled in Tasks 3-4)
  // --------------------------------------------------------------------------

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();
    return [];
  }

  public async query(_input: string): Promise<QueryResult> {
    this.ensureConnected();
    throw new QueryError('LibreDB query support is not implemented yet', 'libredb');
  }

  // --------------------------------------------------------------------------
  // Monitoring (filled in Task 5; honest minimal defaults for now)
  // --------------------------------------------------------------------------

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();
    return { activeConnections: 1, databaseSize: this.fileSizeHuman(), cacheHitRatio: '100.0', slowQueries: [], activeSessions: [] };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();
    return {
      version: this.dbVersion,
      uptime: '-',
      activeConnections: 1,
      maxConnections: 1,
      databaseSize: this.fileSizeHuman(),
      databaseSizeBytes: this.fileSizeBytes(),
      tableCount: 0,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return { cacheHitRatio: 100 };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> { return []; }
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> { return []; }
  public async getTableStats(): Promise<TableStats[]> { return []; }
  public async getIndexStats(): Promise<IndexStats[]> { return []; }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [{ name: 'File', location: this.config.database ?? '', size: this.fileSizeHuman(), sizeBytes: this.fileSizeBytes() }];
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(`Maintenance operation "${type}" is not supported for LibreDB`, 'libredb');
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private fileSizeBytes(): number {
    try { return fs.statSync(this.config.database!).size; } catch { return 0; }
  }

  private fileSizeHuman(): string {
    return formatBytes(this.fileSizeBytes());
  }
}
