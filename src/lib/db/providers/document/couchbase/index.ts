/**
 * Couchbase Database Provider (issue #262)
 *
 * SQL++ over the documented REST surfaces, with no native dependency: every
 * statement and every management read goes through the CouchbaseTransport seam
 * (decision 2), so this file never mentions the wire envelope and a future SDK
 * adapter would not touch it.
 *
 * Three behaviours are worth knowing before reading the code:
 *
 * - Couchbase's four-level hierarchy is flattened for the schema explorer, so a
 *   scope behaves exactly as a PostgreSQL schema does: `_default` is implicit,
 *   everything else is `scope.collection` (decision 4, see keyspace.ts).
 * - A keyspace with no usable index is REPORTED, not worked around: error 4000
 *   is re-raised carrying the runnable `CREATE PRIMARY INDEX` remedy for that
 *   exact keyspace (decision 6), because creating the index is the thing the
 *   user has to do anyway.
 * - Monitoring degrades to empty, never throws (decision 9). The system
 *   monitoring keyspaces need the "Query System Catalog" RBAC role, so a denied
 *   read is the NORMAL case for a restricted user and must not break an
 *   otherwise working connection.
 */

import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  type ActiveSession,
  type ActiveSessionDetails,
  type DatabaseConnection,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type MaintenanceResult,
  type MaintenanceType,
  type PerformanceMetrics,
  type PreparedQuery,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderOptions,
  type QueryPrepareOptions,
  type QueryResult,
  type SlowQuery,
  type SlowQueryStats,
  type StorageStats,
  type TableRelations,
  type TableSchema,
  type TableStats,
} from "@/lib/db/types";
import { formatCacheHitRatio } from "@/lib/monitoring-cache-ratio";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import { applyQueryLimit, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { CouchbaseHttpTransport } from "./http-transport";
import {
  CATALOG_TIMEOUT_MS,
  getSchemaList as introspectSchemaList,
  getSchemaRelations as introspectSchemaRelations,
  listCollections,
} from "./introspect";
import { keyspaceFromDisplayName, keyspacePath, quoteIdentifier } from "./keyspace";
import { CouchbaseError, type CouchbaseQueryResult, type CouchbaseRow, type CouchbaseTransport } from "./transport";

// ============================================================================
// Constants
// ============================================================================

const POOLS_PATH = "/pools/default";

/** Server-side timeout for a monitoring read: never stall the dashboard. */
const MONITORING_TIMEOUT_MS = 10000;

/**
 * Couchbase advertises no connection ceiling over REST - neither
 * `/pools/default` nor the bucket statistics carry the KV service's effective
 * `maxconn`. The overview divides by this number, so the documented KV default
 * is used as the denominator and the numerator stays a measured value.
 */
const KV_DEFAULT_MAX_CONNECTIONS = 65536;

/**
 * Column a SELECT RAW / SELECT VALUE scalar is wrapped in. Named like the
 * document-key column so the two synthetic columns read as a pair.
 */
const COUCHBASE_RAW_VALUE_COLUMN = "__value";

/** SQL++ codes this provider translates into a specific error class. */
const NO_INDEX_CODE = 4000;
const REQUEST_TIMEOUT_CODE = 1080;
const MISSING_CREDENTIALS_CODE = 13014;

/** HTTP codes the transport normalizes into the same numeric space. */
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;

const KEYSPACE_COUNT_SQL = [
  "SELECT COUNT(*) AS total FROM system:keyspaces AS k",
  "WHERE k.`bucket` = $1 OR (k.`bucket` IS MISSING AND k.name = $1)",
].join(" ");

const INDEX_COUNT_SQL = [
  "SELECT COUNT(*) AS total FROM system:indexes AS i",
  "WHERE i.bucket_id = $1 OR (i.bucket_id IS MISSING AND i.keyspace_id = $1)",
].join(" ");

/**
 * `bucket` and `scope` are reserved words in SQL++ and `using` is a keyword, so
 * every one of them is backtick-quoted - unquoted they fail with error 3000
 * (verified on Server 8.0.2).
 */
const INDEX_STATS_SQL = [
  "SELECT i.name AS index_name, i.scope_id AS scope_name, i.keyspace_id AS collection_name,",
  "i.index_key AS index_key, i.is_primary AS is_primary, i.`using` AS index_type",
  "FROM system:indexes AS i",
  "WHERE i.bucket_id = $1 OR (i.bucket_id IS MISSING AND i.keyspace_id = $1)",
  "ORDER BY scope_name, collection_name, index_name",
].join(" ");

/** Requests slow enough that the cluster recorded them at all. */
const SLOW_QUERY_SQL = [
  "SELECT r.requestId AS request_id, r.statement AS statement,",
  "STR_TO_DURATION(r.elapsedTime) AS elapsed_ns, r.resultCount AS result_count",
  "FROM system:completed_requests AS r",
  "ORDER BY elapsed_ns DESC",
  "LIMIT $1",
].join(" ");

const ACTIVE_REQUEST_SQL = [
  "SELECT r.requestId AS request_id, r.statement AS statement, r.users AS users,",
  "r.remoteAddr AS remote_addr, r.state AS state, STR_TO_DURATION(r.elapsedTime) AS elapsed_ns",
  "FROM system:active_requests AS r",
  "ORDER BY elapsed_ns DESC",
  "LIMIT $1",
].join(" ");

/**
 * Deferred indexes of one keyspace. The second branch matches the pre-scopes
 * bucket-level index, whose catalog row carries no `bucket_id` at all.
 */
const DEFERRED_INDEX_SQL = [
  "SELECT i.name AS index_name FROM system:indexes AS i",
  'WHERE i.state = "deferred"',
  "AND ((i.bucket_id = $1 AND i.scope_id = $2 AND i.keyspace_id = $3)",
  '  OR (i.bucket_id IS MISSING AND i.keyspace_id = $1 AND $3 = "_default"))',
].join(" ");

/**
 * The keyspace path that follows the first FROM of a statement. Both segment
 * shapes start with a distinct character and every repetition needs a literal
 * separator, so the pattern is linear - no backtracking blow-up on long input.
 */
const FROM_CLAUSE = /\bfrom\s+((?:`[^`]*`|[\w$]+)(?:\s*[.:]\s*(?:`[^`]*`|[\w$]+))*)/i;
const PATH_SEGMENT = /`([^`]*)`|([\w$]+)/g;

/** A keyspace has at most bucket.scope.collection; anything before is a namespace. */
const MAX_KEYSPACE_SEGMENTS = 3;

const NANOSECONDS_PER_MS = 1e6;

// ============================================================================
// Management payload shapes (only the fields this provider reads)
// ============================================================================

interface PoolsPayload {
  nodes?: { version?: string; uptime?: string }[];
}

interface BucketPayload {
  quota?: { ram?: number };
  basicStats?: {
    itemCount?: number;
    diskUsed?: number;
    dataUsed?: number;
    quotaPercentUsed?: number;
  };
}

type SampleSet = Record<string, unknown>;

interface BucketStatsPayload {
  op?: { samples?: SampleSet };
}

interface CatalogCounts {
  tableCount: number;
  indexCount: number;
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The empty-on-denied rule of decision 9, in one place: a source the connected
 * user cannot read yields the fallback instead of breaking the caller.
 */
async function degradeTo<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

/** Latest value of a statistics series, or null when the cluster reported none. */
function lastSample(samples: SampleSet, key: string): number | null {
  const series = samples[key];
  if (!Array.isArray(series) || series.length === 0) return null;
  const value: unknown = series[series.length - 1];
  return typeof value === "number" ? value : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function nanosecondsToMs(value: unknown): number {
  return Math.round(asNumber(value) / NANOSECONDS_PER_MS);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Column names for a wildcard projection. `SELECT *` nests whole documents
 * under the keyspace name and advertises only a wildcard signature, so the
 * columns are the union of the keys the rows actually carry, first seen first.
 */
function deriveFields(rows: CouchbaseRow[]): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) fields.add(key);
  }
  return [...fields];
}

/**
 * SELECT RAW and SELECT VALUE project bare values, so a row can be a scalar, an
 * array, or null rather than the object the grid's row contract assumes. Passed
 * through unchanged, Object.keys turns a string into one column per character
 * index and throws outright on null. Everything that is not a plain object is
 * therefore wrapped in a single named column.
 *
 * This lives at the provider boundary rather than in the transport on purpose:
 * INFER returns its flavour array as rows[0], and introspection reads that raw
 * payload (see introspect.ts). Reshaping in the transport would break it.
 */
function normalizeRow(row: CouchbaseRow): CouchbaseRow {
  if (typeof row === "object" && row !== null && !Array.isArray(row)) return row;
  return { [COUCHBASE_RAW_VALUE_COLUMN]: row };
}

/**
 * Backtick-quoted keyspace path a statement reads from, or null when it has no
 * recognizable FROM clause. A `namespace:bucket.scope.collection` path keeps
 * only its trailing three segments.
 */
function keyspaceInStatement(statement: string): string | null {
  const clause = FROM_CLAUSE.exec(statement);
  if (!clause) return null;
  const segments = [...clause[1].matchAll(PATH_SEGMENT)].map((segment) => segment[1] ?? segment[2]);
  return segments.slice(-MAX_KEYSPACE_SEGMENTS).map(quoteIdentifier).join(".");
}

/** Strip the quoting Couchbase applies to a plain index key identifier. */
function unquoteIndexKey(key: string): string {
  return key.startsWith("`") && key.endsWith("`") ? key.slice(1, -1).replaceAll("``", "`") : key;
}

function indexColumns(row: CouchbaseRow): string[] {
  if (!Array.isArray(row.index_key)) return [];
  return row.index_key.filter((key): key is string => typeof key === "string").map(unquoteIndexKey);
}

// ============================================================================
// Couchbase Provider
// ============================================================================

export class CouchbaseProvider extends BaseDatabaseProvider {
  private transport: CouchbaseTransport | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "couchbase-json",
      supportsExternalQueryLimiting: true,
      // Collections are schemaless and CREATE COLLECTION takes no columns, so a
      // column-list modal could only ever emit invalid SQL++ (decision 7).
      supportsCreateTable: false,
      // SQL++ does have `UPDATE <keyspace> SET ... WHERE ...`, but the statement the
      // shared inline row editor builds cannot address a document with it: the
      // collection-open query projects the key as `META(d).id AS __id`
      // (`src/lib/query-generators.ts`), the editor's primary-key heuristic picks
      // `__id` because it ends in `_id`, and the resulting `WHERE __id = '<key>'`
      // filters on a field no document actually has - so it would match nothing and
      // report success. Addressing a document needs `META(d).id` or `USE KEYS`, i.e.
      // per-dialect statement building, which is issue #279.
      supportsInlineRowEdit: false,
      // The HTTP query service is stateless per request; no session spans two of them.
      supportsTransactions: false,
      // SQL++ has no referential constraint: collections are schemaless, and the
      // columns this provider reports are inferred from a document sample rather than
      // declared. `getSchema()` returns `foreignKeys: []` because none are invented,
      // and this says that none could be found either (#414).
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["analyze", "reindex", "kill"],
      // All three of `dispatchMaintenance`'s cases go through `requireTarget`, so
      // every whole-bucket control here answered *"The reindex operation requires a
      // target"* rather than running anything (#U9). `UPDATE STATISTICS FOR
      // <keyspace>` and `BUILD INDEX ON <keyspace>` both name ONE collection, which
      // the collection rows can supply; there is no "every keyspace in the bucket"
      // form of either statement, so the global cards are withheld instead of
      // synthesised from a keyspace list this provider does not enumerate for
      // maintenance.
      maintenanceOperationSpecs: {
        analyze: { label: "Update Statistics", perEntity: true, global: false },
        reindex: { label: "Build Deferred Indexes", perEntity: true, global: false },
        kill: { label: "Cancel Request", perEntity: false, global: false },
      },
      supportsConnectionString: true,
      defaultPort: 8091,
      schemaRefreshPattern: "\\b(CREATE|DROP|ALTER)\\s+(COLLECTION|SCOPE|INDEX)\\b",
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Collection",
      entityNamePlural: "Collections",
      rowName: "document",
      rowNamePlural: "documents",
      selectAction: "Select Documents",
      generateAction: "Generate Query",
      analyzeAction: "Update Statistics",
      vacuumAction: "Compact",
      searchPlaceholder: "Search collections or fields...",
      analyzeGlobalLabel: "Update Statistics",
      analyzeGlobalTitle: "Update Statistics",
      analyzeGlobalDesc:
        "Runs UPDATE STATISTICS on a collection so the cost-based optimizer plans against current distributions. Enterprise Edition only.",
      vacuumGlobalLabel: "Compact",
      vacuumGlobalTitle: "Compact Storage",
      vacuumGlobalDesc: "Couchbase compacts its data files automatically; there is no manual equivalent to run here.",
      // `reindex` here is BUILD INDEX over the deferred GSI indexes of ONE keyspace
      // (`buildDeferredIndexes()`), not a table reindex, so the card's PostgreSQL
      // wording was wrong in every word (#U6).
      reindexGlobalLabel: "Build Indexes",
      reindexGlobalTitle: "Build Deferred GSI Indexes",
      reindexGlobalDesc:
        "Runs BUILD INDEX for the deferred global secondary indexes of one collection; it needs a collection, so run it from the collection rather than here.",
      // `getSlowQueries()` reads system:completed_requests, which keeps only requests
      // over the query service's own threshold - a different fact from the PostgreSQL
      // extension the panel used to advertise (#U12).
      slowQueriesEmptyState:
        "Query stats come from system:completed_requests, which keeps only requests over the query service's threshold.",
    };
  }

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const limited = applyQueryLimit(query, effectiveLimit, offset, {}, this.type);
    return { query: limited.sql, wasLimited: limited.wasLimited, limit: effectiveLimit, offset };
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  public override validate(): void {
    super.validate();
    if (!this.config.host && !this.config.connectionString) {
      throw new DatabaseConfigError("Couchbase requires a host or a connection string", this.type);
    }
    if (!this.config.database) {
      throw new DatabaseConfigError('Couchbase requires a bucket (use the "database" field)', this.type);
    }
  }

  public async connect(): Promise<void> {
    this.validate();
    const transport = new CouchbaseHttpTransport(this.transportConfig());

    try {
      // Cheapest proof that the cluster is reachable AND the credentials work:
      // /pools/default needs no RBAC role beyond cluster read.
      await transport.manage<PoolsPayload>(POOLS_PATH);
    } catch (error) {
      await transport.close();
      const failure = this.describeConnectFailure(error);
      this.setError(failure);
      throw failure;
    }

    this.transport = transport;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.setConnected(false);
  }

  /**
   * The transport takes host and port, so a connection-string-only config has
   * its hostname lifted out. The port is deliberately NOT taken from the URL: a
   * `couchbase://` URL carries the KV port, not the management port this
   * provider talks to, and port discovery handles the rest (decision 3).
   */
  private transportConfig(): DatabaseConnection {
    if (this.config.host) return this.config;
    const host = this.hostFromConnectionString();
    return host ? { ...this.config, host } : this.config;
  }

  private hostFromConnectionString(): string | null {
    try {
      return new URL(this.config.connectionString ?? "").hostname || null;
    } catch {
      return null;
    }
  }

  private describeConnectFailure(error: unknown): Error {
    const mapped = this.mapCouchbaseError(error);
    if (mapped instanceof AuthenticationError) return mapped;
    return new ConnectionError(
      `Failed to connect to Couchbase: ${mapped.message}`,
      this.type,
      this.config.host,
      this.config.port,
    );
  }

  private requireTransport(): CouchbaseTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false),
    // so a connected provider always has one.
    return this.transport!;
  }

  private get bucket(): string {
    return this.config.database ?? "";
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await transport.query(sql, { args: params, timeoutMs: this.queryTimeout });
        } catch (error) {
          throw this.mapCouchbaseError(error, sql);
        }
      });
      return this.toQueryResult(result, executionTime);
    });
  }

  /**
   * The cluster's own execution time is preferred over the round trip because
   * it excludes network latency; a source that reports none falls back to the
   * measured wall clock rather than claiming zero.
   */
  private toQueryResult(result: CouchbaseQueryResult, measuredMs: number): QueryResult {
    const reportedMs = Math.round(result.executionTimeMs);
    const rows = result.rows.map(normalizeRow);
    return {
      rows,
      fields: result.fieldNames ?? deriveFields(rows),
      // A mutation returns no rows; its row count is what it changed.
      rowCount: rows.length > 0 ? rows.length : result.mutationCount,
      executionTime: reportedMs > 0 ? reportedMs : measuredMs,
      // A statement the cluster completed can still carry advice about itself
      // (#273). The neutral warning is already `{ code, message }`, so nothing is
      // reshaped here. The field stays ABSENT for a clean run rather than
      // becoming an empty array: absence is what tells the UI to render nothing.
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  }

  /**
   * Normalized transport failure -> the provider error vocabulary. Everything
   * arrives in one numeric space (SQL++ codes and HTTP codes alike), so this is
   * a single switch rather than message sniffing.
   */
  private mapCouchbaseError(error: unknown, statement?: string): Error {
    if (!(error instanceof CouchbaseError)) return this.mapError(error, statement);

    switch (error.code) {
      case NO_INDEX_CODE:
        return new QueryError(`${error.message} ${this.primaryIndexRemedy(statement)}`, this.type, statement);
      case REQUEST_TIMEOUT_CODE:
        return new TimeoutError(error.message, this.type, this.queryTimeout, statement);
      case MISSING_CREDENTIALS_CODE:
      case HTTP_UNAUTHORIZED:
      case HTTP_FORBIDDEN:
        return new AuthenticationError(error.message, this.type);
      case HTTP_UNAVAILABLE:
        return new ConnectionError(error.message, this.type, this.config.host, this.config.port);
    }

    // Reached only for codes no case matched; a bare `default:` label is not
    // attributable in bun lcov. A retriable failure with no cluster code at all
    // is a network fault, everything else is a statement the cluster rejected.
    if (error.retriable && error.code === 0) {
      return new ConnectionError(error.message, this.type, this.config.host, this.config.port);
    }
    return new QueryError(error.message, this.type, statement);
  }

  /**
   * Decision 6: a keyspace with no usable index is reported with the statement
   * that fixes it, quoted for the exact keyspace the query read from.
   */
  private primaryIndexRemedy(statement: string | undefined): string {
    const keyspace = (statement ? keyspaceInStatement(statement) : null) ?? quoteIdentifier(this.bucket);
    return `Create one first: CREATE PRIMARY INDEX ON ${keyspace}`;
  }

  /** Run an operation whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapCouchbaseError(error);
    }
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  public async getSchemaList(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    return this.guarded(() => introspectSchemaList(transport, this.bucket));
  }

  public async getSchemaRelations(): Promise<TableRelations[]> {
    const transport = this.requireTransport();
    return this.guarded(() => introspectSchemaRelations(transport, this.bucket));
  }

  public async getSchema(): Promise<TableSchema[]> {
    const [tables, relations] = await Promise.all([this.getSchemaList(), this.getSchemaRelations()]);
    const indexes = new Map(relations.map((relation) => [relation.name, relation.indexes]));

    return tables.map((table) => ({
      name: table.name,
      columns: table.columns,
      indexes: indexes.get(table.name) ?? [],
      // Couchbase has no foreign keys and none are invented.
      foreignKeys: [],
    }));
  }

  public override async getTables(): Promise<string[]> {
    const transport = this.requireTransport();
    const collections = await this.guarded(() => listCollections(transport, this.bucket));
    return collections.map((collection) => collection.displayName);
  }

  // ==========================================================================
  // Monitoring (decision 9: every source degrades to empty, never throws)
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    const transport = this.requireTransport();

    const [pools, bucketInfo, samples, counts] = await Promise.all([
      degradeTo<PoolsPayload>(() => transport.manage(POOLS_PATH), {}),
      degradeTo<BucketPayload>(() => transport.manage(this.bucketPath()), {}),
      this.bucketSamples(transport),
      degradeTo(() => this.catalogCounts(transport), { tableCount: 0, indexCount: 0 }),
    ]);

    const node = pools.nodes?.[0] ?? {};
    const uptimeMs = (Number.parseInt(node.uptime ?? "", 10) || 0) * 1000;
    const diskUsed = bucketInfo.basicStats?.diskUsed ?? 0;

    return {
      version: node.version ?? "unknown",
      uptime: this.formatDuration(uptimeMs),
      startTime: new Date(Date.now() - uptimeMs),
      activeConnections: lastSample(samples, "curr_connections") ?? 0,
      maxConnections: KV_DEFAULT_MAX_CONNECTIONS,
      databaseSize: formatBytes(diskUsed),
      databaseSizeBytes: diskUsed,
      tableCount: counts.tableCount,
      indexCount: counts.indexCount,
    };
  }

  /**
   * Only the readings the cluster actually published.
   *
   * Every field here is optional in `PerformanceMetrics` because "not measured"
   * and "measured as zero" are different facts. This method used to erase that
   * difference three times over: a `null` miss rate became a `cacheHitRatio` of
   * 0, an absent `cmd_get`/`cmd_set` pair became 0 operations per second, and an
   * unreadable `basicStats` became 0% quota used. The cache one is the worst of
   * the three - `DEFAULT_THRESHOLDS` rates the ratio `direction: "below"` with
   * `critical: 80`, so a bucket whose statistics the connected user may not read
   * showed a red critical cache fault that nothing in the cluster reported. A
   * missing panel is honest; a populated wrong one is not (#424).
   *
   * The absences are ordinary here rather than exotic: `degradeTo` turns an RBAC
   * denial on `/pools/default/buckets/<bucket>/stats` into an empty sample set
   * (`docs/providers/couchbase.md` §3.9), and a bucket that is not a Couchbase
   * bucket publishes no `ep_*` series at all.
   *
   * A measured 0 is kept in every case: a cold cache with no misses really is at
   * 100%, an idle bucket really is doing 0 operations, and an empty bucket really
   * is using none of its quota.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    const transport = this.requireTransport();

    const [bucketInfo, samples] = await Promise.all([
      degradeTo<BucketPayload>(() => transport.manage(this.bucketPath()), {}),
      this.bucketSamples(transport),
    ]);

    // The KV engine reports a miss rate as a percentage, so the hit ratio is its
    // complement; clamped because the series is a moving average and can overshoot.
    const missRate = lastSample(samples, "ep_cache_miss_rate");
    // Sampled per-second counters. Either half may be absent on its own, so the
    // sum exists when at least one was published - and not otherwise.
    const gets = lastSample(samples, "cmd_get");
    const sets = lastSample(samples, "cmd_set");
    const operations = gets === null && sets === null ? null : (gets ?? 0) + (sets ?? 0);
    const quotaUsed = bucketInfo.basicStats?.quotaPercentUsed;

    return {
      ...(missRate === null ? {} : { cacheHitRatio: round2(Math.max(0, Math.min(100, 100 - missRate))) }),
      ...(operations === null ? {} : { queriesPerSecond: round2(operations) }),
      ...(typeof quotaUsed === "number" ? { bufferPoolUsage: round2(quotaUsed) } : {}),
    };
  }

  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    const rows = await this.monitoringRows(SLOW_QUERY_SQL, options.limit ?? 10);

    return rows.map((row) => {
      const elapsedMs = nanosecondsToMs(row.elapsed_ns);
      return {
        queryId: asString(row.request_id),
        query: asString(row.statement),
        // system:completed_requests records individual requests, not aggregates.
        calls: 1,
        totalTime: elapsedMs,
        avgTime: elapsedMs,
        rows: asNumber(row.result_count),
      };
    });
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const rows = await this.monitoringRows(ACTIVE_REQUEST_SQL, options.limit ?? 50);

    return rows.map((row) => {
      const durationMs = nanosecondsToMs(row.elapsed_ns);
      return {
        pid: asString(row.request_id),
        user: asString(row.users, "unknown"),
        database: this.bucket,
        clientAddr: asString(row.remote_addr),
        state: asString(row.state, "unknown"),
        query: asString(row.statement),
        duration: this.formatDuration(durationMs),
        durationMs,
      };
    });
  }

  /**
   * Bucket-level only: per-collection item counts need a COUNT(*) per
   * collection, which is not cheap enough to run on a monitoring poll.
   */
  public async getTableStats(): Promise<TableStats[]> {
    const transport = this.requireTransport();
    const bucketInfo = await degradeTo<BucketPayload>(() => transport.manage(this.bucketPath()), {});
    const stats = bucketInfo.basicStats;
    if (!stats) return [];

    const dataUsed = stats.dataUsed ?? 0;
    const diskUsed = stats.diskUsed ?? 0;

    return [
      {
        schemaName: this.bucket,
        tableName: this.bucket,
        rowCount: stats.itemCount ?? 0,
        tableSize: formatBytes(dataUsed),
        tableSizeBytes: dataUsed,
        totalSize: formatBytes(diskUsed),
        totalSizeBytes: diskUsed,
      },
    ];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    const transport = this.requireTransport();

    const [rows, samples] = await Promise.all([
      degradeTo(
        async () =>
          (await transport.query(INDEX_STATS_SQL, { args: [this.bucket], timeoutMs: CATALOG_TIMEOUT_MS })).rows,
        [] as CouchbaseRow[],
      ),
      // Per-index runtime statistics live under the index service's own bucket.
      // Modern servers no longer publish them there, which is exactly why a
      // missing series must not fail the listing - but it must not become a
      // reading either (see the size handling below).
      degradeTo<BucketStatsPayload>(
        () => transport.manage(`/pools/default/buckets/@index-${encodeURIComponent(this.bucket)}/stats`),
        {},
      ),
    ]);

    const indexSamples = samples.op?.samples ?? {};

    return rows.map((row) => {
      const name = asString(row.index_name, "unknown");
      const isPrimary = row.is_primary === true;
      // Absent, not zero: an index the service publishes no `data_size` for has an
      // unknown size, and "0 B" read as an empty index - which the Storage tab then
      // summed into its index total. `IndexStats.indexSizeBytes` is optional for
      // exactly this, and `indexSize` carries the absence as the repo's "N/A".
      const sizeBytes = lastSample(indexSamples, `index/${name}/data_size`);

      return {
        schemaName: asString(row.scope_name, "_default"),
        tableName: asString(row.collection_name, "unknown"),
        indexName: name,
        indexType: asString(row.index_type, "gsi"),
        columns: indexColumns(row),
        // No secondary index enforces uniqueness; only the document key is unique.
        isUnique: isPrimary,
        isPrimary,
        // "N/A" is the word every provider in this repo uses for a size it cannot
        // read (sqlite.ts, mysql.ts), so no new spelling is introduced here.
        indexSize: sizeBytes === null ? "N/A" : formatBytes(sizeBytes),
        ...(sizeBytes === null ? {} : { indexSizeBytes: sizeBytes }),
        scans: lastSample(indexSamples, `index/${name}/num_requests`) ?? 0,
      };
    });
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const transport = this.requireTransport();
    const bucketInfo = await degradeTo<BucketPayload>(() => transport.manage(this.bucketPath()), {});
    const stats = bucketInfo.basicStats;
    if (!stats) return [];

    const diskUsed = stats.diskUsed ?? 0;
    const quota = bucketInfo.quota?.ram ?? 0;

    return [
      { name: "Data", location: this.bucket, size: formatBytes(diskUsed), sizeBytes: diskUsed },
      {
        name: "RAM Quota",
        size: formatBytes(quota),
        sizeBytes: quota,
        usagePercent: round2(stats.quotaPercentUsed ?? 0),
      },
    ];
  }

  public async getHealth(): Promise<HealthInfo> {
    const [overview, performance, slowQueries, sessions] = await Promise.all([
      this.getOverview(),
      this.getPerformanceMetrics(),
      this.getSlowQueries({ limit: 5 }),
      this.getActiveSessions({ limit: 10 }),
    ]);

    const slow: SlowQuery[] = slowQueries.map((entry) => ({
      query: entry.query,
      calls: entry.calls,
      avgTime: `${Math.round(entry.avgTime)}ms`,
    }));

    const active: ActiveSession[] = sessions.map((session) => ({
      pid: session.pid,
      user: session.user,
      database: session.database,
      state: session.state,
      query: session.query,
      duration: session.duration,
    }));

    return {
      // Both DatabaseOverview.activeConnections and HealthInfo.activeConnections
      // are optional; this provider's overview never omits it, so the value just
      // passes through unchanged.
      activeConnections: overview.activeConnections,
      databaseSize: overview.databaseSize,
      cacheHitRatio: formatCacheHitRatio(performance.cacheHitRatio),
      slowQueries: slow,
      activeSessions: active,
    };
  }

  private bucketPath(): string {
    return `/pools/default/buckets/${encodeURIComponent(this.bucket)}`;
  }

  private async bucketSamples(transport: CouchbaseTransport): Promise<SampleSet> {
    const stats = await degradeTo<BucketStatsPayload>(() => transport.manage(`${this.bucketPath()}/stats`), {});
    return stats.op?.samples ?? {};
  }

  private async catalogCounts(transport: CouchbaseTransport): Promise<CatalogCounts> {
    const [keyspaces, indexes] = await Promise.all([
      transport.query(KEYSPACE_COUNT_SQL, { args: [this.bucket], timeoutMs: CATALOG_TIMEOUT_MS }),
      transport.query(INDEX_COUNT_SQL, { args: [this.bucket], timeoutMs: CATALOG_TIMEOUT_MS }),
    ]);

    return {
      tableCount: asNumber(keyspaces.rows[0]?.total),
      indexCount: asNumber(indexes.rows[0]?.total),
    };
  }

  /**
   * One monitoring keyspace read. These need the "Query System Catalog" role,
   * so a denial is ordinary and yields no rows rather than an error.
   */
  private monitoringRows(statement: string, limit: number): Promise<CouchbaseRow[]> {
    const transport = this.requireTransport();
    return degradeTo(
      async () => (await transport.query(statement, { args: [limit], timeoutMs: MONITORING_TIMEOUT_MS })).rows,
      [] as CouchbaseRow[],
    );
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    const transport = this.requireTransport();
    const { result, executionTime } = await this.measureExecution(() =>
      this.guarded(() => this.dispatchMaintenance(transport, type, target)),
    );
    return { ...result, executionTime };
  }

  private dispatchMaintenance(
    transport: CouchbaseTransport,
    type: MaintenanceType,
    target?: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    switch (type) {
      case "analyze":
        return this.updateStatistics(transport, this.requireTarget(type, target));
      case "reindex":
        return this.buildDeferredIndexes(transport, this.requireTarget(type, target));
      case "kill":
        return this.cancelRequest(transport, this.requireTarget(type, target));
    }

    // Reached only for the operations Couchbase has no equivalent for; they are
    // absent from maintenanceOperations, so the UI never offers them.
    throw new QueryError(
      `Unsupported maintenance operation for Couchbase: ${type}. Supported: analyze, reindex, kill`,
      this.type,
    );
  }

  private requireTarget(type: MaintenanceType, target?: string): string {
    if (!target) {
      throw new QueryError(`The "${type}" operation requires a target`, this.type);
    }
    return target;
  }

  private async updateStatistics(
    transport: CouchbaseTransport,
    target: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    const keyspace = keyspacePath(keyspaceFromDisplayName(this.bucket, target));

    try {
      await transport.query(`UPDATE STATISTICS FOR ${keyspace} INDEX ALL`, { timeoutMs: this.queryTimeout });
      return { success: true, message: `Updated statistics for ${target}` };
    } catch (error) {
      // UPDATE STATISTICS is Enterprise-only; a Community Edition cluster
      // answers "'Update Statistics' is an enterprise level feature." That
      // sentence is the whole explanation the user needs, so it is passed
      // through verbatim rather than swallowed or reworded.
      return { success: false, message: messageOf(error) };
    }
  }

  private async buildDeferredIndexes(
    transport: CouchbaseTransport,
    target: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    const keyspace = keyspaceFromDisplayName(this.bucket, target);
    const deferred = await transport.query(DEFERRED_INDEX_SQL, {
      args: [keyspace.bucket, keyspace.scope, keyspace.collection],
      timeoutMs: CATALOG_TIMEOUT_MS,
    });

    const names = deferred.rows
      .map((row) => row.index_name)
      .filter((name): name is string => typeof name === "string")
      .map(quoteIdentifier);

    if (names.length === 0) {
      return { success: true, message: `No deferred indexes on ${target}` };
    }

    await transport.query(`BUILD INDEX ON ${keyspacePath(keyspace)}(${names.join(", ")})`, {
      timeoutMs: this.queryTimeout,
    });
    return { success: true, message: `Building ${names.length} deferred index(es) on ${target}` };
  }

  private async cancelRequest(
    transport: CouchbaseTransport,
    target: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    await transport.query("DELETE FROM system:active_requests WHERE requestId = $1", {
      args: [target],
      timeoutMs: MONITORING_TIMEOUT_MS,
    });
    return { success: true, message: `Cancelled request ${target}` };
  }
}
