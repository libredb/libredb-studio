/**
 * Database Provider Types & Interfaces
 * Strategy Pattern implementation for multi-database support
 */

// Re-export common types from main types file
export type {
  DatabaseType,
  DatabaseConnection,
  TableSchema,
  TableRelations,
  ColumnSchema,
  QueryResult,
  QueryWarning,
} from "../types";

import type { DatabaseType, DatabaseConnection, TableSchema, TableRelations, QueryResult } from "../types";

// ============================================================================
// Pool Configuration
// ============================================================================

export interface PoolConfig {
  /** Minimum number of connections in pool (default: 2) */
  min: number;
  /** Maximum number of connections in pool (default: 10) */
  max: number;
  /** Close idle connections after this time in ms (default: 30000) */
  idleTimeout: number;
  /** Wait for connection timeout in ms (default: 60000) */
  acquireTimeout: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 2,
  max: 10,
  idleTimeout: 30000,
  acquireTimeout: 60000,
};

/** Query timeout in milliseconds (default: 60 seconds) */
export const DEFAULT_QUERY_TIMEOUT = 60000;

// ============================================================================
// Health Information
// ============================================================================

export interface SlowQuery {
  query: string;
  calls: number;
  avgTime: string;
}

export interface ActiveSession {
  pid: number | string;
  user: string;
  database: string;
  state: string;
  query: string;
  duration: string;
}

export interface HealthInfo {
  activeConnections: number;
  databaseSize: string;
  cacheHitRatio: string;
  slowQueries: SlowQuery[];
  activeSessions: ActiveSession[];
}

// ============================================================================
// Maintenance Operations
// ============================================================================

export type MaintenanceType = "vacuum" | "analyze" | "reindex" | "kill" | "optimize" | "check";

export interface MaintenanceResult {
  success: boolean;
  executionTime: number;
  message: string;
}

// ============================================================================
// Provider Capabilities & Labels
// ============================================================================

/**
 * Dialect discriminant for client-side EXPLAIN handling (issue #194).
 * Each id selects one strategy module in `src/lib/explain`. Extended per
 * provider as explain support lands.
 */
export type ExplainFormat =
  | "postgres-json"
  | "mysql-json"
  | "sqlite-queryplan"
  | "couchbase-json"
  | "clickhouse-json"
  | "druid-native"
  | "trino-json";

export interface ProviderCapabilities {
  queryLanguage: "sql" | "json";
  /**
   * Optional client-side query dialect. `queryLanguage` only says SQL vs JSON;
   * for non-SQL providers the query generators otherwise assume MongoDB syntax.
   * A provider sets `queryDialect` to opt its tables into a custom client-side
   * generator (see `query-generators.ts`), and it is checked BEFORE
   * `queryLanguage` everywhere. Left undefined by SQL and MongoDB, so their
   * generation is unchanged; Redis declares `"redis"` because it too says
   * `queryLanguage: "json"` while speaking neither MongoDB JSON nor SQL, and
   * silently got MongoDB commands its own driver rejected (#427).
   */
  queryDialect?: "libredb" | "redis";
  supportsExplain: boolean;
  /**
   * Present iff supportsExplain is true (enforced by provider tests).
   * Undefined = no explain support; the UI hides the Explain button and tab.
   */
  explainFormat?: ExplainFormat;
  supportsExternalQueryLimiting: boolean;
  supportsCreateTable: boolean;
  /**
   * Whether this engine accepts the single-table row update the results grid's
   * inline editor builds — `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>`
   * (`src/hooks/use-inline-editing.ts`). False hides the editing affordance
   * entirely rather than offering a control that can only produce an error
   * (issue #269): ClickHouse spells a row mutation `ALTER TABLE ... UPDATE`,
   * Druid SQL has no row-level DML, and the JSON-language providers have no
   * `UPDATE` statement at all.
   *
   * Optional because this interface is published (`src/exports/types.ts`) and a
   * required field added after the fact stops every external implementer from
   * compiling. Every provider in this repo declares it; the UI gates on
   * `=== true`, so an absent flag reads as unsupported rather than inheriting a
   * permissive default.
   */
  supportsInlineRowEdit?: boolean;
  /**
   * Whether THIS PROVIDER implements the interactive transaction session that
   * `POST /api/db/transaction` drives — `beginTransaction()` / `commitTransaction()`
   * / `rollbackTransaction()` over one held connection. It is a statement about the
   * provider's surface, not about whether the engine has a transaction concept
   * somewhere: SQLite has `BEGIN`, and this provider still declares `false`, because
   * it holds no session for one and the route refuses the call.
   *
   * It exists because the route's own gate is `isTransactionProvider(provider)`, a
   * runtime shape check no client can read. `Studio.tsx` therefore supplied
   * BEGIN/COMMIT/ROLLBACK — and SANDBOX, which auto-rolls-back through the same
   * route — on every connection. Measured 2026-08-19 on OpenSearch: HTTP 400,
   * "Transaction control is not supported for this database type", for both `begin`
   * and `rollback`. Elasticsearch, Druid, Couchbase, MongoDB, Redis, Trino,
   * Cassandra, SQLite and LibreDB were all in that position.
   *
   * Optional for the same published-interface reason as `supportsInlineRowEdit`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Every provider in this repo declares it, and the
   * UI gates on `=== true`, so an absent flag — and an unresolved `metadata` — reads
   * as no transactions rather than inheriting a permissive default.
   */
  supportsTransactions?: boolean;
  /**
   * Whether this engine has foreign keys to declare at all — not whether any
   * particular schema declares one, and not whether the current role can see them.
   *
   * It exists because an empty `TableSchema.foreignKeys` means two different things
   * and the reader cannot tell them apart. On PostgreSQL an empty list means this
   * schema declares none, or that the role this connection reads with cannot see the
   * ones it declares — an empty read cannot tell those two apart, which is why the
   * agent's relations block reports neither of them as fact; on MongoDB, Redis, LibreDB, Druid, ClickHouse and Couchbase it means the
   * engine has no such constraint in its model, so no reading of any kind could ever
   * return one. A consumer that hedges between "the schema is like that" and "the
   * application enforces them" is wrong in BOTH branches on those six, and #414 hit
   * that when grounding reached them. Reading `connection.type` at the consumer was
   * the alternative and is forbidden by `CLAUDE.md`: engine behaviour is declared by
   * the provider that has it.
   *
   * Optional for the same published-interface reason as `supportsInlineRowEdit`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Consumers therefore gate on `=== false`, so an
   * absent flag reads as "this engine may declare foreign keys" — the weaker claim,
   * which keeps the existing hedge rather than asserting an absence nobody declared.
   */
  declaresForeignKeys?: boolean;
  /**
   * Whether the rows of this provider's `getSchema()` are objects the engine holds,
   * or groupings this server derived from a bounded scan of what it found.
   *
   * True on Redis and LibreDB and nowhere else. Neither engine has a schema to read:
   * `getSchema()` scans a bounded slice of the keyspace — 1000 keys on Redis, 10000 on
   * LibreDB — and collapses the real key names it found into one row per common
   * prefix. So a row named `user:*` is not a key, was never named by anybody, and no
   * command can be given it; and the set of rows is what that one scan happened to
   * reach rather than everything the database holds.
   *
   * It exists because a consumer cannot tell the two apart from the inventory itself,
   * and #414 measured what that costs: plan mode, grounded on a seeded Redis with 17
   * real prefixes, drafted `KEYS user:*` and `ZCARD user:*` against rows it had been
   * handed under the word "table". Both name a key that does not exist. The model was
   * not wrong to treat them as addressable — nothing it was shown said they were not,
   * and only this server knows, because the grouping is this server's own.
   *
   * Optional for the same published-interface reason as `declaresForeignKeys`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Consumers therefore gate on `=== true`, so an
   * absent flag reads as "these rows are real objects" — the ordinary case, and the
   * one every SQL engine and every document engine is in. Reading `connection.type` at
   * the consumer was the alternative and is forbidden by `CLAUDE.md` for the reason
   * this pair of engines demonstrates: the two that answer true are not the two a
   * reader would guess, and a third would be added to a provider and forgotten here.
   */
  tablesAreDerivedGroupings?: boolean;
  supportsMaintenance: boolean;
  maintenanceOperations: MaintenanceType[];
  supportsConnectionString: boolean;
  defaultPort: number | null;
  /**
   * How this engine quotes an identifier, when the port cannot say.
   *
   * `src/lib/query-generators.ts` has always derived the dialect from
   * `defaultPort`, which worked only because every engine had a distinct one. That
   * assumption broke with #424 Phase 1: Elasticsearch and OpenSearch BOTH ship on
   * 9200 and they disagree about the quote character, so one port had to answer for
   * two dialects. The consequence was measured, and it is the worst kind: on
   * OpenSearch 3.8.0 a double-quoted identifier is a STRING LITERAL, so
   * `SELECT customer FROM probe_orders WHERE "customer" = 'acme'` answers HTTP 200
   * with `total: 0` - a generated query silently returning no rows instead of
   * failing. Backticks return the row.
   *
   * Absent means "keep deriving it from the port", so no existing provider changes
   * and nothing about the old behaviour moves. A provider sets this when the port
   * is not a faithful proxy for its dialect - which is any engine that shares a
   * default port with a differently-quoting one.
   */
  identifierQuoting?: "double" | "backtick";
  /**
   * Whether a statement this product runs may end with `;`.
   *
   * Absent means it may, which is every engine that shipped before #424 Phase 1 and
   * is what `src/lib/query-generators.ts` has always emitted. `"none"` says the
   * terminator is not in the grammar at all.
   *
   * Measured 2026-08-19 on Elasticsearch 9.1.4: the generator's own
   * `SELECT * FROM orders LIMIT 50;` - the query behind "Select Top 50 Documents",
   * the first thing a user clicks on an index - answered `parsing_exception`,
   * "line 1:30: extraneous input ';' expecting <EOF>". The same shape without the
   * `;` returns the rows. OpenSearch 3.8.0 accepts both spellings, so the two
   * products need no separate answer: omitting it runs everywhere, and declaring it
   * here keeps `query-generators.ts` from having to know which engine it is
   * generating for.
   *
   * This bounds the GENERATORS only. A user who types a `;` still has it stripped
   * by the editor's statement reader before the statement is sent, and the raw API
   * passes text through untouched - neither of those is this field's business.
   */
  statementTerminator?: "none";
  schemaRefreshPattern: string;
}

export interface ProviderLabels {
  entityName: string;
  entityNamePlural: string;
  rowName: string;
  rowNamePlural: string;
  selectAction: string;
  generateAction: string;
  analyzeAction: string;
  vacuumAction: string;
  searchPlaceholder: string;
  analyzeGlobalLabel: string;
  analyzeGlobalTitle: string;
  analyzeGlobalDesc: string;
  vacuumGlobalLabel: string;
  vacuumGlobalTitle: string;
  vacuumGlobalDesc: string;
  /**
   * The Operations tab's global Reindex card, in this engine's own terms.
   *
   * The analyze and vacuum cards have carried per-provider wording since #427; the
   * reindex card stayed hardcoded to PostgreSQL's "Run Reindex" / "Rebuild Indexes" /
   * "Reconstructs all indexes in the database." Three providers declare the `reindex`
   * maintenance operation — Postgres, SQLite and Couchbase — and on Couchbase that
   * copy is wrong the way the analyze copy was wrong for Redis: its reindex builds
   * deferred GSI indexes, which is not a table reindex.
   *
   * Optional, unlike the `analyzeGlobal*` and `vacuumGlobal*` triads above, because
   * `ProviderLabels` is published (`src/exports/types.ts`) and a required field added
   * after the fact stops every external implementer compiling — the rule
   * `supportsInlineRowEdit` records, and the one the newer `statementLanguage` and
   * `slowQueriesEmptyState` follow. `OperationsTab` keeps the hardcoded strings as
   * its fallback, which it needs anyway: `metadata` may carry capabilities with no
   * labels at all.
   */
  reindexGlobalLabel?: string;
  reindexGlobalTitle?: string;
  reindexGlobalDesc?: string;
  /**
   * What a statement for this engine is WRITTEN IN, named for a model rather than
   * for a person, and declared only where the engine's own name misleads one.
   *
   * Read by the agent's plan contract (`src/lib/agent/investigation.ts`). Every
   * other engine leaves it absent: a connection stamped `postgres` needs nobody to
   * add that its statements are PostgreSQL SQL, and a sentence saying so would spend
   * prompt on a fact the dialect line already carries.
   *
   * It exists because `queryLanguage: "sql"` is not always believable from outside.
   * Measured 2026-08-19: a plan run on an OpenSearch connection, asked for one
   * runnable statement, produced a native aggregation body - correct for the
   * product, unrunnable through a SQL endpoint - and the two search engines are the
   * only shipped engines whose names carry a stronger prior than their capability.
   * A provider sets this when a model asked for "a statement" would reasonably write
   * the wrong language.
   */
  statementLanguage?: string;
  /**
   * Why the monitoring Queries tab's "Slowest Queries" panel is empty on this
   * engine, in that engine's own terms.
   *
   * Read by `QueriesTab`, which defaults to PostgreSQL's "Enable
   * pg_stat_statements extension to see query stats." — the sentence it hardcoded
   * for every engine until #U12, measured 2026-08-19 in Chrome telling an
   * OpenSearch cluster to install a PostgreSQL extension. `postgres` therefore
   * declares nothing, and so does any engine whose statement store really is an
   * extension away.
   *
   * A provider sets this when the Postgres sentence is actively false for it:
   * either the engine keeps no aggregate of finished statements at all, or the
   * one it keeps is switched on somewhere else entirely. One field, not one per
   * sentence — the panel's badge names an extension rather than a category, so it
   * is dropped where this label is set instead of being re-worded from it.
   */
  slowQueriesEmptyState?: string;
}

/**
 * Enforcement caps for a single statement executed through an agent read-only
 * execution profile (#328). The timeout is enforced database-side
 * (transaction-local), the row/byte caps result-side after the statement
 * returns. Every field must be a positive integer — queryReadOnly refuses the
 * whole call otherwise (fail closed).
 */
export interface ReadOnlyStatementBudget {
  statementTimeoutMs: number;
  maxResultRows: number;
  maxResultBytes: number;
}

export interface PreparedQuery {
  query: string;
  wasLimited: boolean;
  limit: number;
  offset: number;
}

export interface QueryPrepareOptions {
  limit?: number;
  offset?: number;
  unlimited?: boolean;
}

// ============================================================================
// Provider Interface (Strategy Pattern)
// ============================================================================

export interface DatabaseProvider {
  /** Database type identifier */
  readonly type: DatabaseType;

  /** Connection configuration */
  readonly config: DatabaseConnection;

  /**
   * Initialize connection pool or single connection
   */
  connect(): Promise<void>;

  /**
   * Close all connections and cleanup resources
   */
  disconnect(): Promise<void>;

  /**
   * Check if provider is currently connected
   */
  isConnected(): boolean;

  /**
   * Execute a SQL query
   * @param sql - SQL query string
   * @param params - Optional query parameters for prepared statements
   * @returns Query result with rows, fields, and execution time
   */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  /**
   * Execute exactly one statement under the DATABASE's own read-only
   * enforcement (#328): the engine, not a parser, rejects writes through this
   * path. Optional on purpose — only providers with a verified database-native
   * boundary implement it, and execution-profile acquisition
   * (`acquireExecutionProfileProvider` in factory.ts) refuses provider types
   * that lack it rather than falling back to `query()` (fail closed).
   */
  queryReadOnly?(sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult>;

  /**
   * Get full database schema
   * @returns Array of table schemas with columns, indexes, and foreign keys
   */
  getSchema(): Promise<TableSchema[]>;

  /**
   * Fast structural schema (tables + columns + PKs), excluding the expensive
   * foreign-key/index introspection. Optional: providers that don't implement
   * it fall back to getSchema(). Pairs with getSchemaRelations().
   */
  getSchemaList?(): Promise<TableSchema[]>;

  /**
   * Heavy relationship/index data (foreign keys + indexes) keyed by table
   * display name, for async merge into getSchemaList() results. Optional.
   */
  getSchemaRelations?(): Promise<TableRelations[]>;

  /**
   * Get list of table names
   */
  getTables(): Promise<string[]>;

  /**
   * Get health and performance metrics
   */
  getHealth(): Promise<HealthInfo>;

  /**
   * Get comprehensive monitoring data
   * @param options - What to include in the monitoring data
   */
  getMonitoringData(options?: MonitoringOptions): Promise<MonitoringData>;

  /**
   * Get database overview metrics
   */
  getOverview(): Promise<DatabaseOverview>;

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): Promise<PerformanceMetrics>;

  /**
   * Get slow query statistics
   * @param options - Query options (limit)
   */
  getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]>;

  /**
   * Get active sessions with details
   * @param options - Query options (limit)
   */
  getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]>;

  /**
   * Get table statistics
   * @param options - Query options (schema filter)
   */
  getTableStats(options?: { schema?: string }): Promise<TableStats[]>;

  /**
   * Get index statistics
   * @param options - Query options (schema filter)
   */
  getIndexStats(options?: { schema?: string }): Promise<IndexStats[]>;

  /**
   * Get storage/tablespace statistics
   */
  getStorageStats(): Promise<StorageStats[]>;

  /**
   * Run maintenance operations
   * @param type - Type of maintenance operation
   * @param target - Optional target (table name or process ID)
   */
  runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult>;

  /**
   * Validate provider configuration
   * @throws DatabaseConfigError if configuration is invalid
   */
  validate(): void;

  /**
   * Get provider capabilities (query language, supported features, etc.)
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Get UI labels for this provider (entity names, action labels, etc.)
   */
  getLabels(): ProviderLabels;

  /**
   * Prepare a query for execution (apply limits, analyze query type, etc.)
   */
  prepareQuery(query: string, options?: QueryPrepareOptions): PreparedQuery;
}

// ============================================================================
// Provider Configuration Options
// ============================================================================

export interface ProviderOptions {
  /** Connection pool configuration */
  pool?: Partial<PoolConfig>;
  /** Query timeout in milliseconds */
  queryTimeout?: number;
  /** Enable SSL/TLS connection */
  ssl?: boolean | { rejectUnauthorized: boolean };
  /** Connection timezone */
  timezone?: string;
}

/**
 * Server-injected construction context for an execution-profile provider
 * (#328). Deliberately NOT a member of `ProviderOptions`: that object is
 * caller-supplied and flows all the way into `getOrCreateProvider`, so a
 * profile flag living there could be set — or cleared — by whoever builds the
 * options for a request. Only `acquireExecutionProfileProvider` passes this.
 */
export interface ProviderExecutionContext {
  /**
   * Open the connection under the database's own read-only enforcement.
   * Only providers whose read-only boundary is established at OPEN time read
   * this (SQLite); PostgreSQL establishes it per transaction inside
   * `queryReadOnly` instead, so its provider ignores the context.
   */
  readOnly?: boolean;
}

// ============================================================================
// Internal Types
// ============================================================================

export interface ConnectionState {
  connected: boolean;
  lastConnected?: Date;
  lastError?: Error;
  activeQueries: number;
}

// ============================================================================
// Monitoring Types (Extended)
// ============================================================================

/**
 * Database overview metrics
 */
export interface DatabaseOverview {
  version: string;
  uptime: string;
  startTime?: Date;
  activeConnections: number;
  maxConnections: number;
  databaseSize: string;
  /**
   * Total on-disk size in bytes, or absent when the engine publishes no byte figure
   * at all.
   *
   * Optional because absence and zero are different facts: a 0 is a measurement, and
   * the Storage tab formats whatever it is given. Apache Cassandra is the case - its
   * `system_views.disk_usage` reports whole mebibytes (measured: "1 MiB" for a
   * 19,476-byte table), so it omits this field rather than send a zero that renders
   * as "0 B" and a 0.0% breakdown (#424).
   */
  databaseSizeBytes?: number;
  tableCount: number;
  indexCount: number;
}

/**
 * Performance metrics for the database
 */
export interface PerformanceMetrics {
  /**
   * Cache hit ratio as percentage (0-100), or absent when the engine does not
   * measure one.
   *
   * Optional because "not measured" and "measured as zero" are different facts
   * and only one of them should raise an alarm. `DEFAULT_THRESHOLDS` treats this
   * metric as `direction: "below"` with `critical: 80`, so a provider that has no
   * ratio to report and substitutes a neutral-looking `0` makes every healthy
   * cluster show a red critical cache fault. Apache Druid is that case - its cache
   * statistics reach a metrics emitter and never a SQL-readable table - and the
   * monitoring tabs already read this field as optional, defaulting the THRESHOLD
   * to a healthy 100 when it is absent.
   */
  cacheHitRatio?: number;
  /** Transactions per second */
  transactionsPerSecond?: number;
  /** Queries per second */
  queriesPerSecond?: number;
  /** Buffer pool usage as percentage (0-100) */
  bufferPoolUsage?: number;
  /** Number of deadlocks */
  deadlocks?: number;
  /** Checkpoint write time */
  checkpointWriteTime?: string;
}

/**
 * Slow query with detailed statistics
 */
export interface SlowQueryStats {
  queryId?: string;
  query: string;
  calls: number;
  totalTime: number;
  avgTime: number;
  minTime?: number;
  maxTime?: number;
  rows: number;
  sharedBlksHit?: number;
  sharedBlksRead?: number;
}

/**
 * Active session with detailed information
 */
export interface ActiveSessionDetails {
  pid: number | string;
  user: string;
  database: string;
  applicationName?: string;
  clientAddr?: string;
  state: string;
  query: string;
  queryStart?: Date;
  duration: string;
  durationMs: number;
  waitEventType?: string;
  waitEvent?: string;
  blocked?: boolean;
}

/**
 * Table statistics
 */
export interface TableStats {
  schemaName: string;
  tableName: string;
  rowCount: number;
  liveRowCount?: number;
  deadRowCount?: number;
  tableSize: string;
  tableSizeBytes: number;
  indexSize?: string;
  indexSizeBytes?: number;
  totalSize: string;
  totalSizeBytes: number;
  lastVacuum?: Date;
  lastAnalyze?: Date;
  bloatRatio?: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexType?: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  indexSize: string;
  /**
   * Omitted when the engine publishes no size for this index. MySQL keeps per-index sizes in
   * `mysql.innodb_index_stats`, which a restricted user cannot read and which holds no row for a
   * MyISAM table, so a `0` there would be a fabricated measurement rather than a small index.
   */
  indexSizeBytes?: number;
  scans: number;
  usageRatio?: number;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  name: string;
  location?: string;
  size: string;
  sizeBytes: number;
  usagePercent?: number;
  walSize?: string;
  walSizeBytes?: number;
}

/**
 * Comprehensive monitoring data combining all metrics
 */
export interface MonitoringData {
  timestamp: Date;
  overview: DatabaseOverview;
  performance: PerformanceMetrics;
  slowQueries: SlowQueryStats[];
  activeSessions: ActiveSessionDetails[];
  tables?: TableStats[];
  indexes?: IndexStats[];
  storage?: StorageStats[];
}

/**
 * Options for monitoring queries
 */
export interface MonitoringOptions {
  /** Include table statistics */
  includeTables?: boolean;
  /** Include index statistics */
  includeIndexes?: boolean;
  /** Include storage/tablespace info */
  includeStorage?: boolean;
  /** Limit for slow queries (default: 10) */
  slowQueryLimit?: number;
  /** Limit for active sessions (default: 50) */
  sessionLimit?: number;
  /** Schema filter (default: 'public' for PostgreSQL) */
  schemaFilter?: string;
}
