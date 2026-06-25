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
 * Since `@libredb/libredb` 0.0.2 the file also carries a persisted CATALOG: the
 * lenses record, under a reserved key prefix, which lens (`document` /
 * `relational`) each namespace belongs to and — for a relational table — its
 * column schema. `getSchema()` reads `catalog(db)` to present faithful per-kind
 * views (real columns for relational tables, a document view for collections)
 * while uncataloged namespaces fall back to the raw key-prefix grouping. The
 * reserved catalog keys are themselves internal metadata and are excluded from
 * every user-facing view.
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
type LibreCatalogEntry = import('@libredb/libredb').CatalogEntry;
type LibreCatalogRegistry = import('@libredb/libredb').CatalogRegistry;

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
      queryDialect: 'libredb',
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
      try { this.db.close(); } catch { /* the null-guard above runs close() at most once; ignore any error */ }
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
    const lib = await loadLibreDB();
    // The catalog (since 0.0.2) tells us which namespaces are real document
    // collections / relational tables and, for tables, their column schema. Raw
    // kv keys are not cataloged, so anything outside the catalog falls back to
    // key-prefix grouping below.
    const registry: LibreCatalogRegistry = lib.catalog(this.db!);

    // Count keys per scanned group, excluding the reserved catalog namespace.
    const groupCounts = new Map<string, number>();
    let scanned = 0;
    const MAX_SCAN = 10000;
    // Empty-string start encodes to the lowest bytes; '\u{10FFFF}' encodes above
    // any UTF-8 text key the lenses produce, so [start, end) covers the keyspace.
    // (kv.prefix cannot be used here — it rejects an empty prefix.)
    for (const { key } of this.kv!.range('', '\u{10FFFF}')) {
      if (scanned >= MAX_SCAN) break;
      // Skip the database's reserved internal namespace — it is not user data.
      if (this.isReserved(key)) continue;
      scanned++;
      const name = this.groupName(key);
      groupCounts.set(name, (groupCounts.get(name) ?? 0) + 1);
    }

    // A cataloged namespace owns keys "<name>:..." (its rows live under that
    // colon-prefix), so it is the scanned group "<name>:*". Reconcile the two so
    // a cataloged table/collection always appears even if its group name differs
    // and is rendered with the richer catalog-aware columns.
    const schemas: TableSchema[] = [];
    for (const [name, rowCount] of groupCounts) {
      const entry = this.catalogEntryFor(name, registry);
      schemas.push(this.schemaForGroup(name, rowCount, entry));
    }
    // Surface cataloged namespaces that exist but have no scanned rows yet (an
    // empty table/collection), so the catalog view is complete.
    for (const [catalogName, entry] of registry) {
      if (entry.kind === 'kv') continue; // kv is the raw layer, never cataloged as a table
      const groupName = `${catalogName}:*`;
      if (groupCounts.has(groupName)) continue;
      schemas.push(this.schemaForGroup(groupName, 0, entry));
    }

    return schemas.sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
  }

  /** Group key "user:1" under "user:*"; a key with no ":" is its own group. */
  private groupName(key: string): string {
    const colon = key.indexOf(':');
    return colon > 0 ? `${key.slice(0, colon)}:*` : key;
  }

  /**
   * True if `key` is in the database's reserved internal namespace (catalog
   * metadata and any future reserved sub-namespace). Uses the package's pinned
   * `isReservedKey` predicate — which tests the U+0000 marker, not a specific
   * prefix — instead of a hardcoded string, so the database can evolve its
   * internal key layout without Studio silently leaking it. Safe to hide: the
   * database forbids user namespace names from starting with the marker
   * (assertUserName), so the predicate can never hide user data. The package
   * module is loaded by connect() before any scan, so the cache is populated.
   */
  private isReserved(key: string): boolean {
    return libredbModule!.isReservedKey(key);
  }

  /** The catalog entry that owns a scanned group, if any. A catalog entry named
   * "users" owns the keys "users:..." which group as "users:*", so strip the
   * trailing ":*" to recover the namespace name and look it up. */
  private catalogEntryFor(
    groupName: string,
    registry: LibreCatalogRegistry
  ): LibreCatalogEntry | undefined {
    const namespace = groupName.endsWith(':*') ? groupName.slice(0, -2) : groupName;
    return registry.get(namespace);
  }

  /**
   * Build the TableSchema for a group, made catalog-aware:
   * - relational: the table's real columns + types (primary key marked), so the
   *   view reflects the declared schema rather than raw key/value.
   * - document: a generic id + document column pair (documents are schemaless).
   * - uncataloged (raw kv): the historical key (primary) + value columns.
   *
   * Studio's TableSchema has no dedicated "kind" field, so the kind is signalled
   * by the columns themselves (real columns => relational; id/document =>
   * document; key/value => raw kv).
   */
  private schemaForGroup(
    name: string,
    rowCount: number,
    entry: LibreCatalogEntry | undefined
  ): TableSchema {
    if (entry?.kind === 'relational' && entry.schema) {
      const { primaryKey, columns } = entry.schema;
      const cols = Object.entries(columns).map(([colName, colType]) => ({
        name: colName,
        type: colType, // string | number | boolean | object (database ColumnType)
        nullable: false, // v1 relational columns are all required
        isPrimary: colName === primaryKey,
      }));
      return { name, columns: cols, indexes: [], rowCount };
    }
    if (entry?.kind === 'document') {
      return {
        name,
        columns: [
          { name: 'id', type: 'string', nullable: false, isPrimary: true },
          { name: 'document', type: 'object', nullable: true, isPrimary: false },
        ],
        indexes: [],
        rowCount,
      };
    }
    // Uncataloged raw kv namespace — keep the historical key/value view.
    return {
      name,
      columns: [
        { name: 'key', type: 'string', nullable: false, isPrimary: true },
        { name: 'value', type: 'string', nullable: true, isPrimary: false },
      ],
      indexes: [],
      rowCount,
    };
  }

  public async query(input: string): Promise<QueryResult> {
    this.ensureConnected();
    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => this.runCommand(input));
      return { ...result, executionTime };
    });
  }

  private runCommand(input: string): Omit<QueryResult, 'executionTime'> {
    const line = this.firstCommandLine(input);
    if (line === '') {
      throw new QueryError('No command to run (only comments or blank lines)', 'libredb');
    }
    const parts = this.tokenize(line);
    if (parts.length === 0) throw new QueryError('Empty command', 'libredb');
    const kv = this.kv!;
    const verb = parts[0].toLowerCase();

    switch (verb) {
      case 'get': {
        if (parts.length < 2) throw new QueryError('Usage: get <key>', 'libredb');
        const value = kv.get(parts[1]);
        if (value === undefined) return { rows: [], fields: ['key', 'value'], rowCount: 0 };
        return { rows: [{ key: parts[1], value: this.renderValue(value) }], fields: ['key', 'value'], rowCount: 1 };
      }
      case 'put': {
        if (parts.length < 3) throw new QueryError('Usage: put <key> <value>', 'libredb');
        const { changed } = kv.set(parts[1], parts.slice(2).join(' '));
        return { rows: [{ changed }], fields: ['changed'], rowCount: changed };
      }
      case 'delete': {
        if (parts.length < 2) throw new QueryError('Usage: delete <key>', 'libredb');
        const { changed } = kv.delete(parts[1]);
        return { rows: [{ changed }], fields: ['changed'], rowCount: changed };
      }
      case 'prefix': {
        if (parts.length < 2) throw new QueryError('Usage: prefix <p>', 'libredb');
        return this.toRows(kv.prefix(parts[1]));
      }
      case 'range': {
        if (parts.length < 3) throw new QueryError('Usage: range <start> <end>', 'libredb');
        return this.toRows(kv.range(parts[1], parts[2]));
      }
      default:
        throw new QueryError(`Unknown command "${verb}". Supported: get, put, delete, prefix, range`, 'libredb');
    }
  }

  /**
   * Pick the first runnable command, skipping blank lines and `#` comment lines.
   * This lets the schema-explorer "Generate Command" cheatsheet — a commented,
   * multi-line template — run directly: a selected command line runs as-is, and
   * running the whole buffer runs its first real command. A line is a comment
   * only when it *starts* with `#` (after trimming), so `#` inside a key or value
   * is never mistaken for one. Returns `''` when nothing runnable remains.
   */
  private firstCommandLine(input: string): string {
    for (const raw of input.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      return line;
    }
    return '';
  }

  /**
   * Split on whitespace, honoring single/double quotes (Redis-style).
   *
   * Note: consecutive whitespace outside quotes is collapsed to a single
   * token boundary (unquoted `put key hello  world` stores `"hello world"`).
   * To preserve exact spacing, wrap the value in quotes: `put key "hello  world"`.
   */
  private tokenize(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let sawToken = false;
    for (const ch of input) {
      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true; quoteChar = ch; sawToken = true;
      } else if (inQuote && ch === quoteChar) {
        inQuote = false;
      } else if (!inQuote && /\s/.test(ch)) {
        if (sawToken) { parts.push(current); current = ''; sawToken = false; }
      } else {
        current += ch; sawToken = true;
      }
    }
    if (sawToken) parts.push(current);
    if (inQuote) {
      throw new QueryError('Unmatched quote in command', 'libredb');
    }
    return parts;
  }

  /** Pretty-print a JSON value; leave non-JSON strings as-is. */
  private renderValue(value: string): string {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }

  private toRows(scan: Iterable<{ key: string; value: string }>): Omit<QueryResult, 'executionTime'> {
    const rows: Record<string, unknown>[] = [];
    for (const { key, value } of scan) {
      // Never surface the database's reserved internal namespace in query results.
      if (this.isReserved(key)) continue;
      rows.push({ key, value: this.renderValue(value) });
    }
    return { rows, fields: ['key', 'value'], rowCount: rows.length };
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
      tableCount: (await this.getSchema()).length,
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
