/**
 * Apache Trino Database Provider (issue #424, Phase 2)
 *
 * Standard SQL over Trino's client protocol with no runtime dependency: every
 * statement, catalog read and metric goes through the `TrinoTransport` seam, so
 * this file never names an endpoint, a header or a page of the exchange, and
 * `seam-guard.test.ts` fails the build if it starts to. The wire lives in
 * `http-transport.ts`; the catalog and `system.runtime` reads live in
 * `introspect.ts`.
 *
 * It extends `SQLBaseProvider` rather than `BaseDatabaseProvider` because the
 * dialect is genuinely standard on the points the shared helpers care about -
 * double-quoted identifiers are correct Trino SQL, and `information_schema` is
 * spelled the ANSI way - which is the case `docs/ADDING_A_PROVIDER.md` names
 * ClickHouse for. Only `prepareQuery()` is overridden, for the one trap below.
 *
 * Six behaviours measured against a live Trino 476 on 2026-08-20 shape almost
 * everything here, and each produces a wrong answer or a hard failure if
 * forgotten:
 *
 * - `OFFSET` COMES BEFORE `LIMIT`, not after. Measured, `... LIMIT 3 OFFSET 1`
 *   answers `line 1:47: mismatched input 'OFFSET'. Expecting: <EOF>` while
 *   `... OFFSET 1 LIMIT 3` returns the rows. The shared limiter emits the other
 *   order for every page after the first, so every paged read would fail without
 *   the override below.
 * - A TRAILING SEMICOLON IS A SYNTAX ERROR. Measured, `SELECT 1;` answers
 *   `line 1:9: mismatched input ';'`. That is what `statementTerminator: "none"`
 *   declares, so `query-generators.ts` stops emitting one.
 * - TRINO DECLARES NO KEYS AND NO INDEXES, anywhere. Its `information_schema`
 *   holds eight views and neither `table_constraints` nor `key_column_usage` is
 *   among them, so `declaresForeignKeys` is false and the inline row editor - which
 *   needs a primary key to build a `WHERE` that identifies one row - is switched
 *   off rather than offered as a control that can only produce a wrong `UPDATE`.
 * - THE ENGINE'S GRAMMAR AND THE CONNECTOR'S CAPABILITIES ARE DIFFERENT THINGS.
 *   `CREATE TABLE` is in the grammar and works on the memory connector (measured);
 *   `UPDATE`/`DELETE` are in the grammar and the same connector answers
 *   `This connector does not support modifying table rows`. No statement is
 *   special-cased here, because the connector's own message names the boundary
 *   better than anything this file could substitute.
 * - CANCELLATION IS A REAL ACT, not the absence of a request. Abandoning the
 *   exchange leaves the statement running on the cluster, so `cancelQuery()` exists
 *   and the id it needs is learned while the statement is still in flight.
 * - `CALL system.runtime.kill_query` REALLY KILLS, live-verified end to end: the
 *   target's exchange then fails with `ADMINISTRATIVELY_KILLED` and carries the
 *   message. That is the one maintenance operation this engine has.
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
  type QueryWarning,
  type SlowQueryStats,
  type StorageStats,
  type TableSchema,
  type TableStats,
} from "@/lib/db/types";
import { TrinoHttpTransport } from "./http-transport";
import {
  getActiveSessions as readActiveSessions,
  getHealth as readHealth,
  getIndexStats as readIndexStats,
  getOverview as readOverview,
  getPerformanceMetrics as readPerformanceMetrics,
  getSchema as readSchema,
  getSlowQueries as readSlowQueries,
  getStorageStats as readStorageStats,
  getTableStats as readTableStats,
  trinoKillQuerySql,
} from "./introspect";
import {
  TRINO_DIALECTS,
  type TrinoDialect,
  type TrinoDialectId,
  type TrinoQueryResult,
  type TrinoTransport,
  TrinoTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The cheapest statement the coordinator will answer, sent at connect time so a
 * wrong port, a proxy in front of the cluster, a Trino UI port that is not the
 * client protocol and a refused credential all surface while the user is still
 * looking at the connection form.
 *
 * It needs no catalog, which matters: a connection may pin a catalog the cluster
 * does not have, and that is a schema-tree failure with a precise message rather
 * than a reason to refuse the connection.
 */
const CONNECT_PROBE_SQL = "SELECT 1";

/** What `kill_query` records against the statement it terminates. */
const KILL_MESSAGE = "Terminated from LibreDB Studio";

/**
 * The statements that change what the schema tree would show.
 *
 * `INSERT` is deliberately absent, unlike Druid: on Trino an insert changes rows
 * inside a table that already exists, and re-reading `information_schema` after
 * every insert would cost a full catalog read for a tree that cannot have changed.
 */
const SCHEMA_REFRESH_PATTERN = "\\b(CREATE|DROP|ALTER|COMMENT|RENAME)\\b";

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The operations whose whole effect is on a session this client does not keep.
 *
 * The engine's own `updateType` strings, verbatim, because that is the only field
 * that distinguishes them: measured, `SET SESSION` answers `updateType: "SET
 * SESSION"` with an empty column declaration and no error at all.
 */
const SESSION_SCOPED_OPERATIONS = new Set(["SET SESSION", "RESET SESSION", "USE", "PREPARE", "DEALLOCATE"]);

/** Every index at which `needle` occurs in `haystack`, left to right. */
function occurrencesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);

  return found;
}

/**
 * The neutral transport result as the grid's row contract.
 *
 * Three things this does NOT do, each deliberate:
 *
 * - No renaming of the declared columns. The seam already guarantees they are
 *   unique, which is not free: measured, `SELECT 1 AS c, 2 AS c` really declares
 *   two columns called `c`, and the transport is where the second one survives.
 * - No fallback duration. The coordinator reports its own elapsed time, and a
 *   second number measured in this process would mean something different -
 *   including the client's own page-following - so only the server's is used, and
 *   only when the server sent one.
 * - No coercion of a value. A `decimal` arrives as the string `"1.23"` and a
 *   `varbinary` as base64; parsing either into a JS number is the one place
 *   precision would be destroyed, so the wire's own encoding reaches the grid.
 */
function toQueryResult(result: TrinoQueryResult, fallbackMs: number): QueryResult {
  const columnTypes = result.columnTypes ?? {};
  const warnings = engineWarnings(result);

  return {
    rows: result.rows,
    // `fieldNames` is null only when the server never described the rows at all;
    // an EMPTY array is a real declaration of no columns, which is what a
    // `CREATE TABLE` answers, and both collapse to no fields for the grid.
    fields: result.fieldNames ?? [],
    // The rows returned, or - for a statement that returned none and changed
    // something - the rows it changed. `INSERT` reports both (measured: an
    // `updateCount` of 3 beside a one-row result set saying 3), and the result set
    // is the more specific of the two, so it wins when there is one.
    rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0),
    executionTime: result.stats.elapsedMs ?? fallbackMs,
    ...(Object.keys(columnTypes).length > 0 ? { columnTypes } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * The notices this run earned: the engine's own remarks, plus one this client owes
 * the user.
 *
 * The second one is the reason this is not a one-line map. This transport sends
 * every statement independently and keeps none of the session the coordinator
 * offers back, so `SET SESSION`, `USE`, `PREPARE` and `DEALLOCATE` all report
 * success and then have no effect on the next statement. Nothing else in the
 * answer distinguishes them from a statement that worked, so a user who sets a
 * session property and watches the next query ignore it would have no way to find
 * out why.
 */
function engineWarnings(result: TrinoQueryResult): QueryWarning[] {
  const warnings: QueryWarning[] = result.warnings.map((warning) => ({ message: warning.message }));

  if (result.operation !== null && SESSION_SCOPED_OPERATIONS.has(result.operation)) {
    warnings.push({
      message: `"${result.operation}" succeeded, but each statement is sent on its own connection, so it will not affect the next one. Qualify names in full instead.`,
    });
  }

  return warnings;
}

// ============================================================================
// Trino Provider
// ============================================================================

export class TrinoProvider extends SQLBaseProvider {
  private transport: TrinoTransport | null = null;

  /**
   * The coordinator's id for each statement this provider started, keyed by the
   * CLIENT's own tracking token.
   *
   * Two different ids, and the indirection is not avoidable: the editor generates
   * a token before it sends anything, while the coordinator's id exists only once
   * the statement has been accepted. `/api/db/cancel` can only know the first, so
   * something has to hold the pairing, and the statement's own exchange is the only
   * place the second is ever announced.
   */
  private readonly runningQueryIds = new Map<string, string>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  /** The product this connection speaks to, selected by the connection's own type-id. */
  private get dialect(): TrinoDialect {
    return TRINO_DIALECTS[this.type as TrinoDialectId];
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // `EXPLAIN (FORMAT JSON)` and nothing else. The strategy in
      // `src/lib/explain/trino-json.ts` builds it for BOTH explain modes, because the
      // two Trino forms are not two renderings of one thing: measured on 476,
      // `EXPLAIN (FORMAT JSON) INSERT …` left the table at 0 rows while
      // `EXPLAIN ANALYZE INSERT …` took it to 1. The background estimate fires on
      // every SELECT a user runs, and this engine's statements reach S3, Iceberg and
      // Hive, so an explain that executes would be a real bill.
      supportsExplain: true,
      explainFormat: "trino-json",
      supportsExternalQueryLimiting: true,
      // In the grammar and live-verified working on the memory connector. Whether it
      // works on THIS catalog is the connector's answer, not the engine's, and the
      // connector says so in its own words.
      supportsCreateTable: true,
      // Not a missing feature but a missing key. The inline editor builds
      // `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>`, and Trino declares no
      // primary key for any table in any catalog, so there is no column that
      // identifies one row - an edit would silently rewrite every row that matches.
      supportsInlineRowEdit: false,
      // No `table_constraints`, no `key_column_usage`, no foreign keys in the model at
      // all. An empty relations list is the engine's answer and not the schema's
      // (#414).
      declaresForeignKeys: false,
      supportsMaintenance: true,
      // One operation, and it is a real one: `CALL system.runtime.kill_query` was
      // verified end to end against a running statement. Nothing else in
      // `MaintenanceType` has a Trino analogue the engine itself can promise -
      // `ANALYZE` is in the grammar but every connector decides for itself whether it
      // implements it, and vacuum, reindex, optimize and check belong to storage
      // systems Trino does not own.
      maintenanceOperations: ["kill"],
      // Trino's own JDBC URL is `jdbc:trino://host:port/catalog/schema`, which the
      // shared parser in `connection-string-parser.ts` does not accept. Rather than
      // advertise a field that would reject everything a user pastes, this stays
      // false until that parser learns the scheme.
      supportsConnectionString: false,
      // The coordinator's HTTP port, and the same number for TLS: a secured
      // deployment serves on whatever port its operator chose, and inventing a
      // well-known HTTPS port would send credentials somewhere nothing is listening.
      defaultPort: this.dialect.defaultPort,
      // Declared rather than derived from the port (#424 Phase 1's lesson): 8080 is a
      // generic HTTP port and the query generators must not have to guess a dialect
      // from it. Trino quotes identifiers with `"` and a backtick is not a quote
      // character at all in its grammar.
      identifierQuoting: "double",
      // Measured: `SELECT 1;` is a syntax error. The terminator is not in the
      // grammar, so the generators must not emit one.
      statementTerminator: "none",
      schemaRefreshPattern: SCHEMA_REFRESH_PATTERN,
    };
  }

  /**
   * Table and row are already Trino's own words, so only the two maintenance
   * blurbs are rewritten.
   *
   * They must still be strings even though neither operation is offered
   * (`maintenanceOperations` holds `kill` alone), and leaving the inherited copy
   * would promise a user that this panel updates planner statistics and reclaims
   * space - neither of which Trino can do, because it owns neither the statistics
   * nor the storage.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Table Statistics",
      vacuumAction: "Reclaim Space",
      analyzeGlobalLabel: "Table Statistics",
      analyzeGlobalTitle: "Statistics Belong to the Connector",
      analyzeGlobalDesc:
        "Trino reads the statistics its connectors publish and computes none of its own. Whether a catalog supports ANALYZE is that connector's answer, so nothing runs from here.",
      vacuumGlobalLabel: "Reclaim Space",
      vacuumGlobalTitle: "Trino Owns No Storage",
      vacuumGlobalDesc:
        "Trino is a query engine: the bytes live in the systems its connectors reach, and reclaiming them is done there. Nothing runs from here.",
    };
  }

  /**
   * The inherited limiter puts the clause in the order Trino refuses.
   *
   * It appends `LIMIT n OFFSET m` for every page after the first, and measured on
   * 476, `SELECT nationkey FROM tpch.sf1.nation LIMIT 3 OFFSET 1` answers
   * `line 1:47: mismatched input 'OFFSET'. Expecting: <EOF>` - Trino's grammar is
   * `[ OFFSET count ] [ LIMIT count ]` and only that way round. The same statement
   * with the clauses swapped returns the rows.
   *
   * So the two clauses are transposed rather than rewritten from scratch: the
   * limiter already decided WHERE the clause goes, which is the hard part (it
   * places it before any trailing comment, and refuses statements whose end cannot
   * be cut), and the exact text it emitted is known here from the numbers it
   * reports.
   *
   * Which occurrence to rewrite is decided by RECONSTRUCTION rather than by
   * position, and that is not defensive: the limiter deliberately inserts the
   * clause BEFORE any trailing comment (#280), so `lastIndexOf` finds the text
   * inside the comment on a statement that quotes its own bound, and `indexOf`
   * finds a subquery's. Exactly one occurrence is the appended one, because
   * removing it - together with the single space the limiter put in front of it -
   * is what yields the original statement back.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const prepared = super.prepareQuery(query, options);
    if (!prepared.wasLimited || prepared.offset === 0) return prepared;

    const emitted = `LIMIT ${prepared.limit} OFFSET ${prepared.offset}`;
    const transposed = `OFFSET ${prepared.offset} LIMIT ${prepared.limit}`;
    const source = query.trim();
    // Non-null because the limiter built this string by inserting `emitted` into
    // `source`, so one occurrence always reconstructs it.
    const at = occurrencesOf(prepared.query, emitted).findLast(
      (index) => prepared.query.slice(0, index - 1) + prepared.query.slice(index + emitted.length) === source,
    )!;

    return {
      ...prepared,
      query: prepared.query.slice(0, at) + transposed + prepared.query.slice(at + emitted.length),
    };
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  /**
   * A host is the only requirement.
   *
   * The catalog is NOT required, deliberately. A connection with no catalog still
   * runs every fully qualified statement - `SELECT * FROM tpch.sf1.nation` needs no
   * session catalog at all - and the whole of `system.runtime`, so refusing to
   * connect without one would refuse a connection that works. What it cannot do is
   * show a schema tree, and `getSchema()` says exactly that when asked.
   */
  public override validate(): void {
    super.validate();
    if (!this.config.host) {
      throw new DatabaseConfigError(`${this.dialect.displayName} requires a host`, this.type);
    }
  }

  public async connect(): Promise<void> {
    let transport: TrinoTransport;
    try {
      // Constructed inside the guard because the constructor itself refuses one
      // configuration: a password over plain HTTP, which the coordinator rejects
      // with HTTP 401 even when authentication is switched off.
      transport = new TrinoHttpTransport(this.dialect, this.config);
      await transport.query(CONNECT_PROBE_SQL);
    } catch (error) {
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
    this.runningQueryIds.clear();
    this.setConnected(false);
  }

  private describeConnectFailure(error: unknown): Error {
    const mapped = this.mapTrinoError(error);
    // A refused credential is not a connectivity problem, and saying so would send
    // the user to check their host.
    if (mapped instanceof AuthenticationError) return mapped;

    return new ConnectionError(
      `Failed to connect to ${this.dialect.displayName}: ${mapped.message}`,
      this.type,
      this.config.host,
      this.config.port,
    );
  }

  private requireTransport(): TrinoTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false), so a
    // connected provider always has one.
    return this.transport!;
  }

  /**
   * The catalog every catalog read resolves against.
   *
   * The connection's `database` field, exactly as a PostgreSQL connection pins one
   * database. A connection that names none has no tree to show, and the reads that
   * need it refuse with that sentence rather than querying every catalog the
   * cluster has - `jmx.current` alone publishes one table per MBean, so the fan-out
   * is unbounded in practice.
   */
  private requireCatalog(): string {
    const catalog = this.config.database;
    if (catalog === undefined || catalog === "") {
      throw new DatabaseConfigError(
        `This connection pins no ${this.dialect.displayName} catalog, so there is no schema to list. Set the catalog on the connection, or qualify every name in full.`,
        this.type,
      );
    }

    return catalog;
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  /**
   * One statement.
   *
   * Positional parameters are REFUSED rather than interpolated. Trino does bind
   * them, through `PREPARE`/`EXECUTE` and a prepared-statement header the transport
   * does not send, so this is a bounded gap in the client and not a property of the
   * engine - and running the statement with its placeholders unbound, or splicing
   * the values into the SQL, are both worse than saying so.
   *
   * A write is not special-cased. Whether `INSERT`, `UPDATE` or `DELETE` reaches
   * anything depends on the connector, and its refusal already says which
   * ("This connector does not support modifying table rows"), which is more useful
   * than a message invented here.
   */
  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    const transport = this.requireTransport();
    if (params !== undefined && params.length > 0) {
      throw new QueryError(
        `${this.dialect.displayName} binds parameters through PREPARE/EXECUTE, which this client does not send, so positional parameters cannot be used here`,
        this.type,
        sql,
      );
    }

    return this.trackQuery(async () => {
      try {
        const { result, executionTime } = await this.measureExecution(() =>
          transport.query(sql, {
            // Only recorded when the caller brought a token to record it against:
            // without one there is nothing `/api/db/cancel` could name later.
            ...(queryId === undefined ? {} : { onQueryStarted: (id: string) => this.runningQueryIds.set(queryId, id) }),
          }),
        );
        return toQueryResult(result, executionTime);
      } catch (error) {
        throw this.mapTrinoError(error, sql);
      } finally {
        if (queryId !== undefined) this.runningQueryIds.delete(queryId);
      }
    });
  }

  /**
   * Terminate a statement this provider started, named by the CLIENT's token.
   *
   * `false` means one thing only: nothing was ever recorded under this token, so
   * there is nothing here to cancel. `true` means the coordinator ACCEPTED the
   * termination - not that the statement had not already finished, which is
   * unknowable: measured, the coordinator answers a cancellation for a finished
   * statement, and even for an id that never existed, with the same silent success.
   *
   * A failure is swallowed to `false` rather than thrown, matching `postgres.ts`:
   * this is called from a UI affordance whose whole purpose is to stop something,
   * and an error dialog on top of a query that is still running helps nobody.
   */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const trinoQueryId = this.runningQueryIds.get(queryId);
    if (trinoQueryId === undefined || this.transport === null) return false;

    try {
      await this.transport.cancel(trinoQueryId);
      return true;
    } catch (error) {
      this.logError("cancelQuery", error);
      return false;
    }
  }

  /**
   * Normalized transport failure -> the provider error vocabulary, keyed on the
   * CATEGORY the seam reported.
   *
   * The category and never a status code, because on this protocol the status
   * carries nothing: a failed statement is an HTTP 200 with the failure inside the
   * document (measured on a syntax error, a missing table and an unsupported DDL
   * alike). The seam has already resolved that, and has already dropped the
   * multi-kilobyte Java stack the failure document carries beside the message - 19
   * frames and 3.3 KB for the simplest possible typo - keeping only the sentence
   * that locates the fault.
   *
   * Anything that is not a transport failure goes to the shared message-based
   * mapping, exactly as `clickhouse/index.ts` does: a bug in this file's own
   * mapping is not a database error and must not be dressed as one.
   */
  private mapTrinoError(error: unknown, sql?: string): Error {
    if (!(error instanceof TrinoTransportError)) return this.mapError(error, sql);

    switch (error.category) {
      case "auth":
        return new AuthenticationError(error.message, this.type);
      case "unreachable":
        return new ConnectionError(error.message, this.type, this.config.host, this.config.port);
      case "timeout":
        return new TimeoutError(error.message, this.type, this.queryTimeout, sql);
      case "cancelled":
        return new QueryCancelledError(error.message, this.type, sql);
      default:
        // `syntax`, `unknown-object`, `unsupported`, `resources` and `engine` all
        // describe a statement the cluster read and refused, and the engine's own
        // wording is the most useful thing that can be shown for any of them.
        return new QueryError(error.message, this.type, sql);
    }
  }

  /** Run a catalog or monitoring read whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapTrinoError(error);
    }
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  /**
   * The tables of the pinned catalog, from `information_schema` alone.
   *
   * `getSchemaList` and `getSchemaRelations` are deliberately NOT implemented. The
   * split exists so a slow relationship read cannot block the table list, and Trino
   * has no relationship read at all: there are no indexes and no foreign keys in the
   * model, so a list would be byte-identical to this and a relations read would spend
   * a round trip to answer two empty arrays per table.
   */
  public async getSchema(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    const catalog = this.requireCatalog();
    return this.guarded(() => readSchema(transport, catalog));
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    const transport = this.requireTransport();
    const catalog = this.requireCatalog();
    return this.guarded(() => readOverview(transport, catalog));
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    const transport = this.requireTransport();
    return this.guarded(() => readPerformanceMetrics(transport));
  }

  public async getSlowQueries(options: { limit?: number } = {}): Promise<SlowQueryStats[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readSlowQueries(transport, options));
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readActiveSessions(transport, options));
  }

  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    const transport = this.requireTransport();
    const catalog = this.requireCatalog();
    return this.guarded(() => readTableStats(transport, catalog, options));
  }

  /**
   * Empty, and it asks the cluster nothing.
   *
   * No index object exists in any Trino catalog, so there is no statement to send
   * and no connection to require: the answer cannot vary with either. The schema
   * tree reports the same thing from the other side, with `indexes: []`.
   */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.resolve(readIndexStats());
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readStorageStats(transport));
  }

  public async getHealth(): Promise<HealthInfo> {
    const transport = this.requireTransport();
    const catalog = this.requireCatalog();
    return this.guarded(() => readHealth(transport, catalog));
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * One operation, and it is the only one the engine itself can promise.
   *
   * `kill` takes the query id the sessions panel shows. Every other
   * `MaintenanceType` is refused with the reason rather than mapped onto the
   * nearest-looking statement: `analyze` exists in the grammar but every connector
   * decides for itself whether it implements it (measured, the memory connector
   * answers `This connector does not support analyze`), and vacuum, reindex,
   * optimize and check all describe storage that belongs to a system Trino only
   * reads.
   *
   * The engine's `NOT_FOUND` for an id that no longer exists is deliberately NOT
   * swallowed here, unlike in `cancelQuery`: a user who typed a query id into a
   * maintenance panel has asked a direct question, and "that statement is not
   * running" is the answer.
   */
  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    const transport = this.requireTransport();

    if (type !== "kill") {
      throw new QueryError(
        `${this.dialect.displayName} has no "${type}" operation. It owns no storage to reclaim and computes no statistics of its own - both belong to the connector behind each catalog - so the only maintenance it can perform is terminating a running statement.`,
        this.type,
      );
    }

    if (target === undefined || target === "") {
      throw new QueryError(
        `Terminating a statement needs its query id, which the Sessions panel lists for every statement in flight.`,
        this.type,
      );
    }

    const { executionTime } = await this.measureExecution(() =>
      this.guarded(() => transport.query(trinoKillQuerySql(target, KILL_MESSAGE))),
    );

    return {
      success: true,
      executionTime,
      // "Asked the cluster to terminate", not "terminated": the procedure returns as
      // soon as the coordinator has accepted the request, and the target's own
      // exchange is what observes the `ADMINISTRATIVELY_KILLED` failure.
      message: `Asked ${this.dialect.displayName} to terminate ${target}.`,
    };
  }
}
