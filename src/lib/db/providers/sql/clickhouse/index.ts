/**
 * ClickHouse Database Provider (issue #264)
 *
 * SQL over ClickHouse's HTTP interface with no native dependency: every
 * statement, catalog read and metric goes through the ClickHouseTransport seam,
 * so this file never names a header, a request parameter or an envelope field,
 * and `seam-guard.test.ts` fails the build if it starts to.
 *
 * It extends `SQLBaseProvider` rather than `BaseDatabaseProvider` because the
 * dialect really is standard on the points the shared helpers care about -
 * double-quoted identifiers and `LIMIT n OFFSET m` are both correct here
 * (live-verified) - which is exactly the case `docs/ADDING_A_PROVIDER.md` names
 * ClickHouse for. Only `prepareQuery()` is overridden, for the trailing-clause
 * trap below.
 *
 * Four live-verified behaviours shape almost everything here, and each one
 * silently produces wrong output if forgotten:
 *
 * - `FORMAT` and `SETTINGS` are TRAILING clauses, so the inherited limiter -
 *   which appends `LIMIT n` at the very end - turns a working statement into a
 *   syntax error. `prepareQuery()` refuses to rewrite such a statement.
 * - A permission denial arrives as HTTP 500, not 403, so failures are DETECTED
 *   by status (inside the transport) and CLASSIFIED by exception code (here).
 *   The 497 message says "Not enough privileges", which contains neither
 *   "access denied" nor "permission denied", so message sniffing would miss it.
 * - Monitoring surfaces are permission-gated and `query_log` is switched off on
 *   some deployments, so every monitoring read degrades to an empty or zeroed
 *   panel on those two codes - and only those two, because an empty panel that
 *   hides a real error hides it forever.
 * - A write reports its row count in a header, and for `ALTER TABLE ... UPDATE`
 *   and a lightweight `DELETE` that count is zero even though the mutation
 *   applied. The number the server gave is the number reported.
 */

import { SQLBaseProvider } from "../sql-base";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
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
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { ClickHouseHttpTransport } from "./http-transport";
import {
  CLICKHOUSE_SYSTEM_DATABASES,
  getSchema as introspectSchema,
  getSchemaList as introspectSchemaList,
  getSchemaRelations as introspectSchemaRelations,
} from "./introspect";
import {
  type ClickHouseQueryResult,
  type ClickHouseRow,
  type ClickHouseTransport,
  ClickHouseTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/** The database a connection that names none lands in, and an ordinary one. */
const DEFAULT_DATABASE = "default";

const CONNECT_PROBE_SQL = "SELECT 1";

const UNKNOWN_VERSION = "unknown";

/**
 * Column a result in a format the user chose is handed back in.
 *
 * An explicit `FORMAT` in the user's own SQL beats the format the transport asks
 * for (live-verified), so the body is genuinely TSV, CSV or Pretty text. The
 * grid's row contract needs an object, and the double underscore marks the
 * column as synthesized rather than projected - the same convention the
 * Couchbase provider uses for a scalar projection.
 */
const RAW_TEXT_COLUMN = "__text";

const MILLISECONDS_PER_SECOND = 1000;

/** Server-side deadline for a monitoring read, in `max_execution_time`'s unit. */
const MONITORING_TIMEOUT_SECONDS = 10;

/**
 * The same deadline as a client-side one. A monitoring panel that hangs on a
 * stalled socket is worse than an empty one, and `max_execution_time` cannot bound
 * a connection that never gets as far as executing anything.
 */
const MONITORING_TIMEOUT_MS = MONITORING_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND;

const DEFAULT_SLOW_QUERY_LIMIT = 10;
const DEFAULT_SESSION_LIMIT = 50;

/**
 * Every row of `system.processes` is a statement the server is executing right
 * now: ClickHouse has no idle-in-transaction equivalent to distinguish, so the
 * state is a constant rather than a column.
 */
const RUNNING_STATE = "active";

const UNKNOWN_USER = "unknown";

/** The scheme that makes the transport speak TLS and default to the https port. */
const TLS_SCHEME = "https:";

/** The scheme that explicitly asks for plaintext, as opposed to not saying. */
const PLAINTEXT_SCHEME = "http:";

/**
 * Codes this file branches on that the shared table does not carry, because
 * nothing but the error mapping below needs them.
 *
 * Read back from the live server's own numbering rather than transcribed from
 * documentation (`SELECT number, errorCodeToName(toUInt32(number)) FROM
 * numbers(1500)` on 26.7.1.1315).
 */
const CLICKHOUSE_FAILURE_CODES = Object.freeze({
  TIMEOUT_EXCEEDED: 159,
  SOCKET_TIMEOUT: 209,
  NETWORK_ERROR: 210,
  QUERY_WAS_CANCELLED: 394,
  /**
   * No server exception at all: the request never reached ClickHouse, never came
   * back, or came back rewritten. There is no code to classify by, so the shared
   * message-based mapping takes over.
   */
  NO_SERVER_CODE: 0,
} as const);

const TIMEOUT_CODES: readonly number[] = [
  CLICKHOUSE_FAILURE_CODES.TIMEOUT_EXCEEDED,
  CLICKHOUSE_FAILURE_CODES.SOCKET_TIMEOUT,
];

// ============================================================================
// Trailing-clause detection (the prepareQuery override)
// ----------------------------------------------------------------------------
// Both patterns are anchored at the END of the statement, which is what keeps
// them off a statement that merely mentions the words. Live-verified traps:
// `SELECT * FROM t WHERE note = 'format'` and `SELECT name FROM system.settings`
// are ordinary statements that must still be limited, while
// `... FORMAT TSV LIMIT 1` and `... SETTINGS max_threads=1 LIMIT 1` are both
// 400 / code 62. Anchoring is what spares the ordinary forms: a string literal
// ends in a quote, so `= 'FORMAT TSV'` cannot reach the anchor, and the settings
// TABLE is not followed by an assignment.
//
// One accepted false positive remains, and it is deliberate rather than missed:
// a statement ending in a string literal that itself contains an assignment,
// `... WHERE note = 'SETTINGS foo = 1'`, is read as carrying a trailing clause.
// Ruling it out needs a string-literal-aware tokenizer, and the cost of being
// wrong here is only that no row limit is injected - the statement still runs and
// still returns correct rows. Mis-detecting in the other direction would produce
// a hard syntax error, so the bias is on purpose.
// ============================================================================

/** `FORMAT <Name>` as the last thing in the statement. */
const TRAILING_FORMAT = /\bFORMAT\s+[A-Za-z][A-Za-z0-9_]*\s*$/i;

/** `SETTINGS name = value` (one or many) as the last thing in the statement. */
const TRAILING_SETTINGS = /\bSETTINGS\s+[A-Za-z_][A-Za-z0-9_]*\s*=[\s\S]*$/i;

// ============================================================================
// Monitoring SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope and joined from single lines rather than written as
// multi-line template literals in the method bodies: bun's coverage instruments
// the interior lines of a template literal inside a function body as 0-hit in
// any process that imports this file without executing that method, which the
// merged lcov then reports as uncovered SQL. The same reason `postgres.ts`
// hoists its own.
//
// The overview is five separate reads on purpose. Live-verified with a
// restricted user: `system.tables` is pre-filtered to what the user may see and
// answers 200, `uptime()` and `version()` need no grant at all, while
// `system.metrics`, `system.parts` and `system.data_skipping_indices` each
// answer 500 / code 497 without their own grant. Combining them into one
// statement would throw away the panels a restricted user CAN see.
// ============================================================================

const OVERVIEW_IDENTITY_SQL = "SELECT version() AS version, toUInt64(uptime()) AS uptimeSeconds";

const OVERVIEW_CONNECTIONS_SQL = [
  "SELECT",
  "(SELECT sum(value) FROM system.metrics",
  " WHERE metric IN ('TCPConnection', 'HTTPConnection', 'MySQLConnection', 'PostgreSQLConnection')) AS connections,",
  "(SELECT toUInt64(value) FROM system.server_settings WHERE name = 'max_connections') AS maxConnections",
].join(" ");

const OVERVIEW_SIZE_SQL = [
  "SELECT sum(bytes_on_disk) AS databaseSizeBytes",
  "FROM system.parts",
  "WHERE active AND database = currentDatabase()",
].join(" ");

const OVERVIEW_TABLE_COUNT_SQL = "SELECT count() AS tableCount FROM system.tables WHERE database = currentDatabase()";

const OVERVIEW_INDEX_COUNT_SQL = [
  "SELECT count() AS indexCount",
  "FROM system.data_skipping_indices",
  "WHERE database = currentDatabase()",
].join(" ");

/**
 * The mark cache is ClickHouse's nearest equivalent of a buffer cache, and
 * `system.events` counts its hits and misses since start-up. `Query` is a
 * lifetime counter too, so dividing it by the uptime read alongside it gives an
 * average rather than an instantaneous rate - which is the honest reading of a
 * counter that is never sampled twice.
 */
const PERFORMANCE_EVENTS_SQL = [
  "SELECT",
  "sumIf(value, event = 'MarkCacheHits') AS cacheHits,",
  "sumIf(value, event = 'MarkCacheMisses') AS cacheMisses,",
  "sumIf(value, event = 'Query') AS queryCount,",
  "toUInt64(uptime()) AS uptimeSeconds",
  "FROM system.events",
].join(" ");

/** Float64 here, so these two arrive as JSON numbers where a UInt64 arrives quoted. */
const PERFORMANCE_MEMORY_SQL = [
  "SELECT",
  "sumIf(value, metric = 'MemoryResident') AS memoryBytes,",
  "sumIf(value, metric = 'OSMemoryTotal') AS memoryTotalBytes",
  "FROM system.asynchronous_metrics",
].join(" ");

/**
 * Grouped by `normalized_query_hash` so one entry is one statement SHAPE with
 * its call count and its min/max, the way `pg_stat_statements` reports it -
 * ungrouped, the panel would be a list of individual executions of the same
 * statement. `query_log` is flushed asynchronously, so a statement that just ran
 * may be absent for a few seconds.
 */
const SLOW_QUERY_SQL = [
  "SELECT toString(normalized_query_hash) AS queryId, any(query) AS query, count() AS calls,",
  "sum(query_duration_ms) AS totalMs, avg(query_duration_ms) AS avgMs,",
  "min(query_duration_ms) AS minMs, max(query_duration_ms) AS maxMs, sum(result_rows) AS resultRows",
  "FROM system.query_log",
  "WHERE type = 'QueryFinish' AND current_database = currentDatabase()",
  "GROUP BY normalized_query_hash",
  "ORDER BY totalMs DESC",
].join(" ");

/**
 * The read excludes itself: this statement is in `system.processes` while it
 * runs, and reporting it as a session would make the panel describe the act of
 * looking. Same trick `postgres.ts` applies to `pg_stat_activity`.
 */
const ACTIVE_SESSION_SQL = [
  "SELECT query_id AS queryId, user AS user, current_database AS database,",
  "toString(address) AS clientAddr, elapsed AS elapsedSeconds, query AS query",
  "FROM system.processes",
  "WHERE query NOT LIKE '%system.processes%'",
  "ORDER BY elapsed DESC",
].join(" ");

/**
 * Only ACTIVE parts count: an inactive part is a merge input the server has not
 * finished dropping yet, so including it would double-count both rows and bytes.
 */
const TABLE_STATS_SELECT_SQL = [
  "SELECT database, table, sum(rows) AS rowCount, sum(data_compressed_bytes) AS dataBytes,",
  "sum(marks_bytes + primary_key_bytes_in_memory) AS indexBytes, sum(bytes_on_disk) AS totalBytes",
  "FROM system.parts",
  "WHERE active AND",
].join(" ");

const TABLE_STATS_GROUP_SQL = "GROUP BY database, table ORDER BY totalBytes DESC";

const INDEX_STATS_SELECT_SQL = [
  "SELECT database, table, name AS indexName, type AS indexType, expr,",
  "data_compressed_bytes AS indexSizeBytes",
  "FROM system.data_skipping_indices",
  "WHERE",
].join(" ");

const INDEX_STATS_ORDER_SQL = "ORDER BY database, table, indexName";

const STORAGE_SQL = [
  "SELECT name, path, total_space AS totalBytes, free_space AS freeBytes",
  "FROM system.disks",
  "ORDER BY name",
].join(" ");

/** Part statistics of one table, which is what `analyze` reports (see below). */
const PART_SUMMARY_SELECT_SQL = [
  "SELECT count() AS partCount, sum(rows) AS rowCount, sum(bytes_on_disk) AS totalBytes",
  "FROM system.parts",
  "WHERE active AND",
].join(" ");

/** Names are compile-time constants, so inlining them as literals is safe. */
const NON_SYSTEM_DATABASE = `database NOT IN (${CLICKHOUSE_SYSTEM_DATABASES.map((name) => `'${name}'`).join(", ")})`;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * A counter the server reported, or 0 when it reported nothing usable.
 *
 * Both encodings are real and both appear in the same panel: the transport asks
 * for 64-bit quoting so nothing rounds through `JSON.parse`, which turns every
 * `UInt64` into a decimal STRING, while `system.asynchronous_metrics` is
 * `Float64` and stays an unquoted number. A null - what a scalar subquery over
 * no rows produces - is neither.
 */
function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return typeof value === "string" && value !== "" && Number.isFinite(parsed) ? parsed : 0;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A percentage, or 0 when there is nothing to divide by. Zero rather than a
 * flattering 100: a denied or absent source must not look like a healthy one.
 */
function percentOf(part: number, whole: number): number {
  return whole > 0 ? round2((part / whole) * 100) : 0;
}

/** A row cap that is always a positive integer, so it can be inlined into SQL. */
function rowLimit(limit: number | undefined, fallback: number): number {
  const requested = Math.trunc(limit ?? fallback);
  return requested > 0 ? requested : fallback;
}

/**
 * A value as a ClickHouse string literal. The backslash escape has to be applied
 * as well as the doubled quote: ClickHouse honours both inside a literal
 * (live-verified), so escaping only the quote would leave `\'` as a way out.
 */
function literal(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * `database.table` when the target names one, otherwise the pinned database.
 * The same rule `postgres.ts` applies to `public`, and the same limitation: a
 * dot inside a name cannot be told apart from the separator.
 */
function splitTarget(target: string, pinnedDatabase: string): [database: string, table: string] {
  const separator = target.indexOf(".");
  if (separator === -1) return [pinnedDatabase, target];
  return [target.slice(0, separator), target.slice(separator + 1)];
}

/**
 * Whether the statement ends in a clause that `LIMIT` may not follow.
 *
 * Both patterns are anchored at the end of the STATEMENT, which the shared reader
 * delimits: the terminating semicolon and any trailing comment are outside it. A
 * hand-rolled semicolon strip used to stand in for that, so `... FORMAT TSV
 * -- note` read as carrying no trailing clause. That was harmless only while the
 * inherited bound landed inside the same comment; now that the limiter places it
 * before the comment, missing the clause would emit `... FORMAT TSV LIMIT n
 * -- note` and turn a working statement into the 400 / code 62 this override
 * exists to prevent (#280).
 */
function hasTrailingClause(sql: string, grammar: SqlGrammar): boolean {
  const statement = sql.slice(0, readStatementEnd(sql, grammar).end);
  return TRAILING_FORMAT.test(statement) || TRAILING_SETTINGS.test(statement);
}

function parseUrl(connectionString: string | undefined): URL | null {
  if (connectionString === undefined || connectionString === "") return null;
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

/**
 * A hand-typed connection string lifted into the fields the transport takes.
 *
 * This is not optional politeness: the URI tab clears host, port, user and
 * password when it submits, so for a connection typed there the URL is the only
 * place any of them exist. A pasted URL takes the other path - the shared parser
 * fills the fields and stores no connection string - so this runs only for the
 * hand-typed case. Each component still falls back to its field, which is what
 * keeps an unparsable string from emptying a working connection.
 */
function resolveConnection(config: DatabaseConnection): DatabaseConnection {
  const url = parseUrl(config.connectionString);
  if (url === null) return config;

  return {
    ...config,
    host: url.hostname || config.host,
    // Left undefined when the URL names no port, so the transport picks the
    // default for the scheme instead of the plain-HTTP port for an https URL.
    port: url.port === "" ? config.port : Number(url.port),
    user: decodeURIComponent(url.username) || config.user,
    password: decodeURIComponent(url.password) || config.password,
    database: decodeURIComponent(url.pathname.slice(1)) || config.database,
    ssl: sslForScheme(url, config.ssl),
  };
}

/**
 * TLS as the URL's scheme states it, falling back to the connection's own setting
 * only when the scheme does not say.
 *
 * The scheme is the more specific statement: it names the transport, while `ssl` is
 * a separate field that can be left over from an earlier edit. So an explicit
 * `http://` has to be able to turn TLS OFF - deferring would send HTTPS to a
 * plaintext endpoint and fail with a bare "fetch failed" - while `clickhouse://`
 * names no transport and is the one scheme that must defer.
 */
function sslForScheme(url: URL, configured: DatabaseConnection["ssl"]): DatabaseConnection["ssl"] {
  if (url.protocol === TLS_SCHEME) return { mode: "require" };
  if (url.protocol === PLAINTEXT_SCHEME) return undefined;
  return configured;
}

/**
 * The neutral transport result as the grid's row contract.
 *
 * The server's own duration is preferred over the round trip because it excludes
 * network latency, and the measured wall clock is the fallback rather than a
 * claimed zero.
 */
function toQueryResult(result: ClickHouseQueryResult, measuredMs: number): QueryResult {
  const textual = result.rawText !== null;
  const rows = textual ? [{ [RAW_TEXT_COLUMN]: result.rawText }] : result.rows;
  const reportedMs = Math.round(result.executionTimeMs);
  // Declared types travel with the result (#273), verbatim wrappers included:
  // `Nullable(String)` is what tells the user the column accepts nulls, and for a
  // computed column like `count()` this is the ONLY source - the schema tree has
  // no catalog entry for it. An empty map means the envelope described no
  // columns (a write, or a format the user chose), which stays absent rather than
  // shipping a `{}` the grid would have to check.
  const columnTypes = result.columnTypes ?? {};

  return {
    rows,
    fields: textual ? [RAW_TEXT_COLUMN] : (result.fieldNames ?? []),
    // A write returns no rows, so its row count is what the server says it
    // changed - verbatim, including the zero a queued mutation reports.
    rowCount: rows.length > 0 ? rows.length : result.mutationCount,
    executionTime: reportedMs > 0 ? reportedMs : measuredMs,
    ...(Object.keys(columnTypes).length > 0 ? { columnTypes } : {}),
  };
}

// ============================================================================
// ClickHouse Provider
// ============================================================================

export class ClickHouseProvider extends SQLBaseProvider {
  private transport: ClickHouseTransport | null = null;

  /** The configuration with a hand-typed connection string already resolved. */
  private readonly connection: DatabaseConnection;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
    this.connection = resolveConnection(config);
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "clickhouse-json",
      supportsExternalQueryLimiting: true,
      // Live-verified, and deliberate rather than an oversight: `CREATE TABLE t
      // (id Int32, name String)` succeeds on 26.x, but what CreateTableModal
      // EMITS does not. Its default column is `id SERIAL PRIMARY KEY` (code 50,
      // unknown data type family SERIAL) and its UNIQUE checkbox emits `UNIQUE`
      // (code 62, syntax error), so the modal's default state produces invalid
      // SQL and it offers no ClickHouse type list. A control that can only
      // produce invalid input is not a supported capability. DDL typed into the
      // editor works normally, which is how a ClickHouse user creates a table.
      supportsCreateTable: false,
      // Live-verified against 26.7.1 and the reason issue #269 exists: a bare
      // `UPDATE ... SET`, which is what the inline row editor builds, answers code
      // 48 NOT_IMPLEMENTED (HTTP 501). ClickHouse spells a row mutation
      // `ALTER TABLE t UPDATE c = v WHERE ...`, an asynchronous mutation rather
      // than a statement the shared hook can emit, so the control is hidden here.
      supportsInlineRowEdit: false,
      // Reached over stateless HTTP, and ClickHouse has no general transaction anyway.
      supportsTransactions: false,
      // ClickHouse parses REFERENCES in a column definition and enforces nothing by
      // it, and `system.*` holds no constraint catalog to read one back from. So
      // there is no declared foreign key here in any sense a reader could use (#414).
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["optimize", "analyze", "kill"],
      supportsConnectionString: true,
      defaultPort: 8123,
      schemaRefreshPattern: "\\b(CREATE|DROP|ALTER|RENAME|TRUNCATE|ATTACH|DETACH)\\b",
    };
  }

  /**
   * Tables and rows are the right words here, so only the maintenance labels
   * change: ClickHouse has no VACUUM and no ANALYZE, and offering either by name
   * would describe an operation that does not exist.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Table Statistics",
      vacuumAction: "Optimize Table",
      analyzeGlobalLabel: "Table Statistics",
      analyzeGlobalTitle: "Table Statistics",
      analyzeGlobalDesc:
        "ClickHouse has no ANALYZE: a MergeTree's statistics are its parts and are always current, so this reports them rather than computing anything.",
      vacuumGlobalLabel: "Optimize",
      vacuumGlobalTitle: "Merge Parts",
      vacuumGlobalDesc:
        "Runs OPTIMIZE TABLE ... FINAL, which merges a table's parts and applies pending mutations. ClickHouse reclaims space by merging, so there is no VACUUM equivalent.",
      // `getSlowQueries()` reads system.query_log, which records nothing while
      // `log_queries` is off - a different fact from the PostgreSQL extension the panel
      // used to advertise (#U12).
      slowQueriesEmptyState: "Query stats come from system.query_log, which records nothing while log_queries is off.",
    };
  }

  /**
   * The inherited limiter appends `LIMIT n` at the very END of the statement,
   * and ClickHouse allows `FORMAT x` and `SETTINGS ...` as TRAILING clauses, so
   * on either of those the inherited behaviour produces a hard syntax error
   * (live-verified: 400 / code 62 for both). Such a statement is returned
   * untouched: a user who wrote either clause is expressing intent the editor
   * must not silently rewrite, and the bias has to be "do not rewrite" because
   * rewriting wrongly fails the query outright while leaving it alone only
   * returns more rows.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const prepared = super.prepareQuery(query, options);
    if (!hasTrailingClause(query, resolveSqlGrammar(this.type))) return prepared;

    return { ...prepared, query, wasLimited: false };
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  /**
   * A database is deliberately NOT required: `default` always exists, and a
   * connection that names none resolves against it, which is what a stock local
   * install expects.
   */
  public override validate(): void {
    super.validate();
    if (!this.config.host && !this.config.connectionString) {
      throw new DatabaseConfigError("ClickHouse requires a host or a connection string", this.type);
    }
  }

  public async connect(): Promise<void> {
    const transport = new ClickHouseHttpTransport(this.connection);

    try {
      // The `database` parameter is not checked when the connection is made -
      // live-verified, a non-existent one fails 404 / code 81 on the FIRST
      // statement - so the cheapest possible statement proves the server, the
      // credentials and the database together, here, where the user is looking.
      await transport.query(CONNECT_PROBE_SQL, { timeoutMs: this.queryTimeout });
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

  private describeConnectFailure(error: unknown): Error {
    const mapped = this.mapClickHouseError(error);
    if (mapped instanceof AuthenticationError) return mapped;

    return new ConnectionError(
      `Failed to connect to ClickHouse: ${mapped.message}`,
      this.type,
      this.connection.host,
      this.connection.port,
    );
  }

  private requireTransport(): ClickHouseTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false),
    // so a connected provider always has one.
    return this.transport!;
  }

  private get pinnedDatabase(): string {
    return this.connection.database ?? DEFAULT_DATABASE;
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();
    if (params !== undefined && params.length > 0) {
      // The HTTP interface binds named `{name:Type}` parameters only, so there
      // is nowhere to put a positional value. Failing loudly beats running the
      // statement with its placeholders unbound.
      throw new QueryError(
        "ClickHouse binds named parameters only, so positional parameters cannot be sent",
        this.type,
        sql,
      );
    }

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          // Both halves of the same promise: max_execution_time bounds the server
          // once it has accepted the statement, timeoutMs bounds everything before
          // and after that - connect, handshake, and the body still arriving.
          return await transport.query(sql, {
            settings: { max_execution_time: this.deadlineSeconds() },
            timeoutMs: this.queryTimeout,
          });
        } catch (error) {
          throw this.mapClickHouseError(error, sql);
        }
      });

      return toQueryResult(result, executionTime);
    });
  }

  /**
   * The statement deadline the server enforces, in seconds. A URL setting is
   * overridden by a `SETTINGS` clause in the statement itself, so a user who
   * asks for longer still gets it.
   */
  private deadlineSeconds(): number {
    return Math.ceil(this.queryTimeout / MILLISECONDS_PER_SECOND);
  }

  /**
   * Normalized transport failure -> the provider error vocabulary, keyed on the
   * numeric exception code.
   *
   * The code rather than the message, and the code rather than the HTTP status:
   * a denial arrives as 500 (so status reads as a server fault) and its message
   * says "Not enough privileges" (so sniffing for "access denied" misses it).
   * The code is the only discrete thing the server reports.
   */
  private mapClickHouseError(error: unknown, sql?: string): Error {
    if (!(error instanceof ClickHouseTransportError)) return this.mapError(error, sql);

    if (error.is("AUTHENTICATION_FAILED") || error.is("ACCESS_DENIED")) {
      return new AuthenticationError(error.message, this.type);
    }
    if (TIMEOUT_CODES.includes(error.code)) {
      return new TimeoutError(error.message, this.type, this.queryTimeout, sql);
    }
    if (error.code === CLICKHOUSE_FAILURE_CODES.QUERY_WAS_CANCELLED) {
      return new QueryCancelledError(error.message, this.type, sql);
    }
    if (error.code === CLICKHOUSE_FAILURE_CODES.NETWORK_ERROR) {
      return new ConnectionError(error.message, this.type, this.connection.host, this.connection.port);
    }
    if (error.code === CLICKHOUSE_FAILURE_CODES.NO_SERVER_CODE) {
      // Nothing below the SQL layer answered, so there is no code to key on and
      // the shared message-based mapping - which recognises a refused socket and
      // a timeout - is the best classification available.
      return this.mapError(error, sql);
    }

    // Reached only for a code no branch matched: the server named an exception
    // for a statement it rejected.
    return new QueryError(error.message, this.type, sql);
  }

  /** Run an operation whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapClickHouseError(error);
    }
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  public async getSchema(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    return this.guarded(() => introspectSchema(transport, this.pinnedDatabase));
  }

  public async getSchemaList(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    return this.guarded(() => introspectSchemaList(transport, this.pinnedDatabase));
  }

  public async getSchemaRelations(): Promise<TableRelations[]> {
    const transport = this.requireTransport();
    return this.guarded(() => introspectSchemaRelations(transport, this.pinnedDatabase));
  }

  // ==========================================================================
  // Monitoring (every source degrades to empty or zeroed, never throws)
  // ==========================================================================

  /**
   * One monitoring read.
   *
   * `ACCESS_DENIED` and `UNKNOWN_TABLE` are the two codes that mean "this
   * surface does not exist for this user or this deployment", and both are
   * ordinary: the system tables need their own grants, and `query_log` is
   * switched off on plenty of servers. Every OTHER failure propagates, because
   * an empty panel in place of a real error hides it forever.
   */
  private async monitoringRows(sql: string): Promise<ClickHouseRow[]> {
    const transport = this.requireTransport();

    try {
      const result = await transport.query(sql, {
        settings: { max_execution_time: MONITORING_TIMEOUT_SECONDS },
        timeoutMs: MONITORING_TIMEOUT_MS,
      });
      return result.rows;
    } catch (error) {
      if (error instanceof ClickHouseTransportError && error.isMonitoringUnavailable()) return [];
      throw this.mapClickHouseError(error, sql);
    }
  }

  private async monitoringRow(sql: string): Promise<ClickHouseRow | null> {
    const rows = await this.monitoringRows(sql);
    return rows[0] ?? null;
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const [identity, connections, size, tables, indexes] = await Promise.all([
      this.monitoringRow(OVERVIEW_IDENTITY_SQL),
      this.monitoringRow(OVERVIEW_CONNECTIONS_SQL),
      this.monitoringRow(OVERVIEW_SIZE_SQL),
      this.monitoringRow(OVERVIEW_TABLE_COUNT_SQL),
      this.monitoringRow(OVERVIEW_INDEX_COUNT_SQL),
    ]);

    const uptimeMs = asNumber(identity?.uptimeSeconds) * MILLISECONDS_PER_SECOND;
    const sizeBytes = asNumber(size?.databaseSizeBytes);

    return {
      version: asText(identity?.version, UNKNOWN_VERSION),
      uptime: this.formatDuration(uptimeMs),
      // Left undefined when the identity read failed: a start time derived from
      // a zero uptime would claim the server booted this instant.
      startTime: identity === null ? undefined : new Date(Date.now() - uptimeMs),
      activeConnections: asNumber(connections?.connections),
      maxConnections: asNumber(connections?.maxConnections),
      databaseSize: formatBytes(sizeBytes),
      databaseSizeBytes: sizeBytes,
      tableCount: asNumber(tables?.tableCount),
      indexCount: asNumber(indexes?.indexCount),
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    const [events, memory] = await Promise.all([
      this.monitoringRow(PERFORMANCE_EVENTS_SQL),
      this.monitoringRow(PERFORMANCE_MEMORY_SQL),
    ]);

    const cacheHits = asNumber(events?.cacheHits);
    const lookups = cacheHits + asNumber(events?.cacheMisses);
    const uptimeSeconds = asNumber(events?.uptimeSeconds);

    return {
      cacheHitRatio: percentOf(cacheHits, lookups),
      queriesPerSecond: uptimeSeconds > 0 ? round2(asNumber(events?.queryCount) / uptimeSeconds) : 0,
      // The server's resident memory against the machine's, which is the closest
      // ClickHouse gets to a buffer pool: its caches are many and separately
      // configured, and the mark cache alone is near-empty on a healthy server.
      bufferPoolUsage: percentOf(asNumber(memory?.memoryBytes), asNumber(memory?.memoryTotalBytes)),
    };
  }

  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    const limit = rowLimit(options.limit, DEFAULT_SLOW_QUERY_LIMIT);
    const rows = await this.monitoringRows(`${SLOW_QUERY_SQL} LIMIT ${limit}`);

    return rows.map((row) => ({
      queryId: asText(row.queryId),
      query: asText(row.query),
      calls: asNumber(row.calls),
      totalTime: asNumber(row.totalMs),
      avgTime: round2(asNumber(row.avgMs)),
      minTime: asNumber(row.minMs),
      maxTime: asNumber(row.maxMs),
      rows: asNumber(row.resultRows),
    }));
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const limit = rowLimit(options.limit, DEFAULT_SESSION_LIMIT);
    const rows = await this.monitoringRows(`${ACTIVE_SESSION_SQL} LIMIT ${limit}`);

    return rows.map((row) => {
      const durationMs = Math.round(asNumber(row.elapsedSeconds) * MILLISECONDS_PER_SECOND);
      return {
        pid: asText(row.queryId),
        user: asText(row.user, UNKNOWN_USER),
        database: asText(row.database),
        clientAddr: asText(row.clientAddr),
        state: RUNNING_STATE,
        query: asText(row.query),
        duration: this.formatDuration(durationMs),
        durationMs,
      };
    });
  }

  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    const filter = this.databaseFilter(options.schema);
    const rows = await this.monitoringRows(`${TABLE_STATS_SELECT_SQL} ${filter} ${TABLE_STATS_GROUP_SQL}`);

    return rows.map((row) => {
      const tableSizeBytes = asNumber(row.dataBytes);
      const indexSizeBytes = asNumber(row.indexBytes);
      const totalSizeBytes = asNumber(row.totalBytes);

      return {
        schemaName: asText(row.database),
        tableName: asText(row.table),
        rowCount: asNumber(row.rowCount),
        tableSize: formatBytes(tableSizeBytes),
        tableSizeBytes,
        indexSize: formatBytes(indexSizeBytes),
        indexSizeBytes,
        totalSize: formatBytes(totalSizeBytes),
        totalSizeBytes,
      };
    });
  }

  /**
   * The data-skipping indexes, which are the only index OBJECTS ClickHouse has.
   *
   * The sparse primary index is deliberately absent here even though the schema
   * tree reports it: it is part of the table rather than a separate object, so it
   * has no name, no size and no statistics of its own to fill this row with.
   * `scans` is zero for the same reason - ClickHouse publishes no per-index usage
   * counter anywhere, and a guessed number is worse than an obvious zero.
   */
  public async getIndexStats(options: { schema?: string } = {}): Promise<IndexStats[]> {
    const filter = this.databaseFilter(options.schema);
    const rows = await this.monitoringRows(`${INDEX_STATS_SELECT_SQL} ${filter} ${INDEX_STATS_ORDER_SQL}`);

    return rows.map((row) => {
      const indexSizeBytes = asNumber(row.indexSizeBytes);

      return {
        schemaName: asText(row.database),
        tableName: asText(row.table),
        indexName: asText(row.indexName),
        indexType: asText(row.indexType),
        // One entry, verbatim: a data-skipping index is declared over an
        // EXPRESSION rather than a column list, and splitting `cityHash64(a, b)`
        // on its commas would invent two columns that do not exist.
        columns: [asText(row.expr)],
        // Neither a data-skipping index nor the primary key enforces uniqueness
        // (live-verified: three identical values were accepted into a table
        // declared PRIMARY KEY (a)), so no index ClickHouse reports is unique.
        isUnique: false,
        isPrimary: false,
        indexSize: formatBytes(indexSizeBytes),
        indexSizeBytes,
        scans: 0,
      };
    });
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const rows = await this.monitoringRows(STORAGE_SQL);

    return rows.map((row) => {
      const sizeBytes = asNumber(row.totalBytes);
      return {
        name: asText(row.name),
        location: asText(row.path),
        size: formatBytes(sizeBytes),
        sizeBytes,
        usagePercent: percentOf(sizeBytes - asNumber(row.freeBytes), sizeBytes),
      };
    });
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

  /** One database when the caller named one, every user database otherwise. */
  private databaseFilter(schema: string | undefined): string {
    return schema === undefined ? NON_SYSTEM_DATABASE : `database = ${literal(schema)}`;
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
    transport: ClickHouseTransport,
    type: MaintenanceType,
    target?: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    switch (type) {
      case "optimize":
        return this.optimizeTable(transport, this.requireTarget(type, target));
      // No target is legitimate here, unlike optimize: MaintenanceModal's global
      // Analyze button sends none, and a database's parts are as well defined as a
      // table's. Demanding one made a control the UI always offers always fail.
      case "analyze":
        return this.describeParts(transport, target);
      case "kill":
        return this.cancelQueryById(transport, this.requireTarget(type, target));
    }

    // Reached only for the operations ClickHouse has no equivalent for; they are
    // absent from maintenanceOperations, so the UI never offers them.
    throw new QueryError(
      `Unsupported maintenance operation for ClickHouse: ${type}. Supported: optimize, analyze, kill`,
      this.type,
    );
  }

  private requireTarget(type: MaintenanceType, target?: string): string {
    if (!target) {
      throw new QueryError(`The "${type}" operation requires a target`, this.type);
    }
    return target;
  }

  private qualify(target: string): string {
    const [database, table] = splitTarget(target, this.pinnedDatabase);
    return `${this.escapeIdentifier(database)}.${this.escapeIdentifier(table)}`;
  }

  /**
   * FINAL merges the table down to one part per partition and applies pending
   * mutations, which is the operation a ClickHouse user reaches for where
   * another engine would vacuum.
   */
  private async optimizeTable(
    transport: ClickHouseTransport,
    target: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    await transport.query(`OPTIMIZE TABLE ${this.qualify(target)} FINAL`);
    return { success: true, message: `Optimized ${target}` };
  }

  /**
   * ClickHouse has no ANALYZE, and it needs none: a MergeTree's statistics ARE
   * its parts, and they are current by construction. So the honest equivalent of
   * the operation is to report them rather than to pretend something was
   * recomputed.
   */
  private async describeParts(
    transport: ClickHouseTransport,
    target?: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    // Without a target the scope is the whole pinned database, which is what the
    // global Analyze button asks for.
    const [database, table] = target ? splitTarget(target, this.pinnedDatabase) : [this.pinnedDatabase, undefined];
    const scope = target ?? database;
    const where = table
      ? `database = ${literal(database)} AND table = ${literal(table)}`
      : `database = ${literal(database)}`;
    const result = await transport.query(`${PART_SUMMARY_SELECT_SQL} ${where}`, {
      settings: { max_execution_time: MONITORING_TIMEOUT_SECONDS },
      timeoutMs: MONITORING_TIMEOUT_MS,
    });
    const row = result.rows[0];
    const parts = asNumber(row?.partCount);

    if (parts === 0) {
      return {
        success: true,
        message: `${scope}: no active parts (a view or a non-MergeTree engine keeps none)`,
      };
    }

    const rowCount = asNumber(row?.rowCount);
    const onDisk = formatBytes(asNumber(row?.totalBytes));
    return { success: true, message: `${scope}: ${parts} active parts, ${rowCount} rows, ${onDisk} on disk` };
  }

  /**
   * SYNC so the result is reported after the query has actually stopped rather
   * than after the kill was queued.
   */
  private async cancelQueryById(
    transport: ClickHouseTransport,
    target: string,
  ): Promise<Omit<MaintenanceResult, "executionTime">> {
    await transport.query(`KILL QUERY WHERE query_id = ${literal(target)} SYNC`);
    return { success: true, message: `Cancelled query ${target}` };
  }
}
