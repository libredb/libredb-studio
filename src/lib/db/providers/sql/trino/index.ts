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
import { callerBoundTruncationReason, containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import {
  type ActiveSessionDetails,
  type ColumnSchema,
  type Container,
  type DatabaseConnection,
  type DatabaseObject,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type KindCount,
  type MaintenanceResult,
  type MaintenanceType,
  type ObjectDetail,
  type ObjectDetailBatch,
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
  TRINO_CATALOG_LIST_SQL,
  TRINO_UNKNOWN_TEXT,
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
  TRINO_FUNCTION_COLUMNS,
  TRINO_FUNCTION_KIND,
  TRINO_MATERIALIZED_VIEW_KIND,
  type KindCountRow,
  type TrinoContainer,
  applyKindCounts,
  comparePaths,
  objectDetailFromRows,
  objectKey,
  trinoBulkColumnsSql,
  trinoObjectTargetSql,
  containerRead,
  functionSegment,
  listedObject,
  objectRead,
  readIdentifier as readObjectIdentifier,
  seedZeroCounts,
  trinoFunctionListSql,
  trinoMaterializedViewListSql,
  trinoObjectColumnsSql,
  trinoObjectCountsSql,
  trinoRelationListSql,
  trinoSchemaListSql,
} from "./objects";
import {
  TRINO_DIALECTS,
  type TrinoDialect,
  type TrinoDialectId,
  type TrinoQueryResult,
  type TrinoRow,
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
      message: `"${result.operation}" succeeded, but each statement is sent on its own connection, so it will not affect the next one. Set Catalog Name and Schema Name on the Trino connection for a persistent namespace, or qualify names in full.`,
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
      // Trino has START TRANSACTION, but a transaction lives in an HTTP session
      // header this provider does not carry between statements.
      supportsTransactions: false,
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
      // Trino owns no storage and computes no statistics, so the only operation it
      // has is terminating a statement - and that needs the query id the Sessions
      // panel lists, which is neither a table nor a whole database (#496).
      maintenanceOperationSpecs: {
        kill: { label: "Terminate Query", perEntity: false, global: false },
      },
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
      // TWO levels, and the outer one is not a database (#789). A Trino CATALOG is a
      // named CONNECTOR CONFIGURATION: `iceberg.properties` makes the catalog `iceberg`,
      // and the same cluster reaches an Iceberg lake, a PostgreSQL server and a generated
      // `tpch` dataset side by side, each holding schemas holding objects. The engine's own
      // word for the outer level is "catalog" and for the inner one "schema", which is what
      // the labels say. `information_schema` is PER CATALOG here, so a read against one
      // catalog's copy says nothing whatsoever about another's.
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
      // Four kinds (`objects.ts`), and the two connector-gated ones are declared because
      // the ENGINE has them rather than because every catalog does.
      //
      // NO trigger, NO stored procedure and NO index, because Trino has none of the three
      // anywhere in its model: `information_schema` holds eight views and neither
      // `table_constraints` nor `key_column_usage` is among them, and there is no index
      // catalog at all (#414). A declared kind draws a folder, and a folder for something
      // the engine cannot have is a lie its zero badge makes look like a fact.
      objectKinds: [
        // A row write reaches whatever the CONNECTOR allows - measured on 476, an INSERT
        // into `memory.app.customers` succeeds while `tpch` answers that its connector does
        // not support modifying table rows. The declaration is about the engine's model, and
        // the connector's own refusal is the better message for the case it cannot.
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
        // No `acceptsRowWrites` on either view kind, measured on 476: an INSERT answers
        // "Inserting into views is not supported" and "Inserting into materialized views is
        // not supported" respectively, on every connector.
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
        // Supported by SOME connectors only, Iceberg among them, and declared anyway: the
        // kind exists in the engine's model and `system.metadata.materialized_views` is an
        // engine-level catalog, so a catalog holding none answers an honest 0 rather than a
        // folder for something that cannot exist. The two facts are different and #789's
        // `KindCount` keeps them apart.
        {
          id: "materialized_view",
          role: "relation",
          label: "Materialized View",
          labelPlural: "Materialized Views",
        },
        // Catalog-stored SQL functions, from release 431 and on the Hive and Memory
        // connectors only. Declared because it was CONFIRMED on the build
        // `database-compose.yml` runs: measured on 476, `CREATE FUNCTION
        // memory.app.plus_one(x bigint) RETURNS bigint RETURN x + 1` succeeds and
        // `SHOW FUNCTIONS FROM memory.app` lists it. Leaving the kind out would make a
        // function somebody wrote invisible in the tree, which is a worse absence than an
        // empty folder.
        { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
      ],
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
      // `getSlowQueries()` reads system.runtime.queries, which is the coordinator's own
      // bounded history rather than a persisted store - a different fact from the
      // PostgreSQL extension the panel used to advertise (#463).
      slowQueriesEmptyState:
        "Query stats come from system.runtime.queries, which holds only what this coordinator still remembers.",
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
        `This connection pins no ${this.dialect.displayName} catalog, so there is no schema to list. Set the catalog on the connection to list its tables. Set a session schema as well to use unqualified table names in queries and Create Table.`,
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
  // The object surface (#789)
  // ==========================================================================

  /** One catalog read, with Trino's own refusal mapped and the statement carried with it. */
  private async runObjectRows(sql: string): Promise<TrinoRow[]> {
    try {
      const result = await this.requireTransport().query(sql);
      return result.rows;
    } catch (error) {
      throw this.mapTrinoError(error, sql);
    }
  }

  /**
   * Why a function count or listing cannot be answered for a whole catalog.
   *
   * Carried as one sentence because both methods owe the same explanation, and because it
   * is a fact about the ENGINE rather than about this connection: `SHOW FUNCTIONS` takes a
   * schema, and measured on 476 it cannot be wrapped in a subquery, so there is nothing to
   * aggregate over a catalog without one full exchange per schema in it.
   */
  private functionScopeRefusal(): string {
    return `${this.dialect.displayName} lists catalog functions only with SHOW FUNCTIONS FROM <catalog>.<schema>, which takes one schema and cannot be aggregated, so a whole catalog has no function count. Open a schema to see its functions.`;
  }

  /**
   * The containers at `parent`: every catalog the coordinator can reach, or one catalog's
   * schemas.
   *
   * The top level is the CLUSTER's catalog list and not the connection's pinned catalog,
   * which is the whole point of the level here: a Trino catalog is a named connector
   * configuration, so one session addresses an Iceberg lake, a PostgreSQL server and a
   * generated dataset side by side. `requireCatalog()` deliberately does not guard this -
   * a connection that pins no catalog still has a tree, it just has no marked row in it.
   *
   * `system` and `jmx` are listed rather than filtered. Trino publishes no flag that would
   * separate a plumbing catalog from a data one, both are genuinely queryable, and a name
   * denylist is a boundary this repo has already found unmaintainable (#424).
   *
   * Below the last declared level the answer is `[]` rather than a refusal, because
   * "nothing nests under a schema" is a true statement about Trino and not a caller
   * mistake. The depth is `containerDepth()` for the reason standing ruling 5g gives.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const capabilities = this.getCapabilities();
    const parentPath = parent ?? [];
    // `Container.level` is the index into `containerLevels`, so a container listed under a
    // parent of depth d sits at level d. Derived from the parent rather than written twice
    // as a literal 0 and 1.
    const level = parentPath.length;

    if (level === 0) {
      const rows = await this.runObjectRows(TRINO_CATALOG_LIST_SQL);
      return rows.flatMap((row) => {
        const name = readObjectIdentifier(row.catalogName);
        if (name === null) return [];
        return [{ path: [name], name, level, isSessionDefault: name === this.config.database }];
      });
    }
    if (level >= containerDepth(capabilities)) return [];

    const { catalog } = containerRead(capabilities, parentPath);
    const rows = await this.runObjectRows(trinoSchemaListSql(catalog));
    return rows.flatMap((row) => {
      const name = readObjectIdentifier(row.schemaName);
      if (name === null) return [];
      return [
        {
          path: [...parentPath, name],
          name,
          level,
          // Marked at THIS level too, not only at the catalog. Standing ruling 5a2 (#789):
          // first paint walks the chain to the session default at the DEEPEST declared
          // level, so a two-level engine that marked only its catalogs would open a catalog
          // and stop, having read no counts at all.
          //
          // BOTH halves of the predicate are load-bearing. The connection's schema names a
          // schema in the connection's catalog, so comparing the schema alone would mark a
          // same-named schema in every catalog on the cluster - and on Trino `default` is a
          // schema name several connectors create, so that is the ordinary case rather than
          // an exotic one.
          isSessionDefault: catalog === this.config.database && name === this.config.schema,
        },
      ];
    });
  }

  /**
   * How many objects of each declared kind one container holds.
   *
   * Two reads rather than one, and they are caught SEPARATELY. The relation kinds come from
   * a `UNION ALL` over `information_schema.tables` and `system.metadata.materialized_views`;
   * the functions come from `SHOW FUNCTIONS`, which is a statement rather than a relation
   * and cannot join the union. Their failure modes are independent - one is the
   * coordinator's own metadata, the other is a per-connector feature - so a refusal of one
   * must not erase the other's honest answer.
   *
   * Three outcomes, and `KindCount` keeps all three apart. A kind the statement answered for
   * carries its count; a kind it did not carries `{ count: 0 }`, because every declared kind
   * is seeded before the read; a kind whose read was refused carries the engine's own
   * sentence, so the object browser can say why a folder has no number instead of showing a
   * zero nobody measured.
   *
   * A FOURTH outcome is not a `KindCount` at all: this method RAISES when a row names a kind
   * the declaration does not hold. That is a defect in this provider rather than an answer
   * about a container, and the three states above have no spelling for it.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const capabilities = this.getCapabilities();
    const read = containerRead(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);

    const relationKinds = declared.filter((kind) => kind.id !== TRINO_FUNCTION_KIND);
    if (relationKinds.length > 0) {
      const sql = trinoObjectCountsSql(read, findKind(capabilities, TRINO_MATERIALIZED_VIEW_KIND) !== undefined);
      // The catch wraps the READ and nothing else. `applyKindCounts` is deliberately outside
      // it, because its raise is the guard behind TRINO_TABLE_TYPE_KINDS and it must reach
      // the caller as itself: a spelling this provider has no kind for is a DECLARATION
      // defect, and rewriting it as `{ unavailable }` filed that defect in a folder badge
      // and told the reader the engine had refused a read it answered perfectly.
      //
      // It also erased more than it touched. Every relation kind was blanked, so one
      // unmodelled `table_type` from `information_schema` also wiped the materialized-view
      // count, which comes from `system.metadata.materialized_views` on the other arm of the
      // `UNION ALL`. Only the statement failing genuinely loses every relation kind, and
      // that is the one case still caught here.
      let rows: KindCountRow[] | undefined;
      try {
        rows = (await this.runObjectRows(sql)) as unknown as KindCountRow[];
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const kind of relationKinds) counts[kind.id] = { unavailable: reason };
      }
      if (rows !== undefined) applyKindCounts(counts, rows);
    }

    if (findKind(capabilities, TRINO_FUNCTION_KIND) !== undefined) {
      counts[TRINO_FUNCTION_KIND] = await this.countFunctions(read);
    }
    return counts;
  }

  /** One schema's function count, or the engine's reason there is no catalog-wide one. */
  private async countFunctions(read: TrinoContainer): Promise<KindCount> {
    if (read.schema === undefined) return { unavailable: this.functionScopeRefusal() };
    try {
      return { count: (await this.runObjectRows(trinoFunctionListSql(read.catalog, read.schema))).length };
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The objects of one kind in one container, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, so one rule covers four kinds read
   * from three different sources: `information_schema.tables`, `system.metadata` and a
   * `SHOW` statement cannot be given one comparable sort clause, and a code-point sort over
   * the produced PATH is what keeps a catalog-level listing grouped by schema.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const capabilities = this.getCapabilities();
    const read = containerRead(capabilities, container);
    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a statement exists would make the two methods
    // disagree, and would report "declares no object kind" about a kind `objectKinds` does
    // declare.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`${this.dialect.displayName} declares no object kind "${kind}"`, this.type);
    }

    const objects =
      kind === TRINO_FUNCTION_KIND
        ? await this.listFunctions(capabilities, read)
        : await this.listRelations(capabilities, read, kind);

    return objects.sort((left, right) => comparePaths(left.path, right.path));
  }

  /** Every relation of one kind, from whichever catalog publishes that kind. */
  private async listRelations(
    capabilities: ProviderCapabilities,
    read: TrinoContainer,
    kind: string,
  ): Promise<DatabaseObject[]> {
    const sql =
      kind === TRINO_MATERIALIZED_VIEW_KIND ? trinoMaterializedViewListSql(read) : trinoRelationListSql(read, kind);
    const rows = await this.runObjectRows(sql);
    return rows.flatMap((row) => {
      const schema = readObjectIdentifier(row.schemaName);
      const name = readObjectIdentifier(row.objectName);
      if (schema === null || name === null) return [];
      return [listedObject(capabilities, read.catalog, kind, schema, name, name)];
    });
  }

  /**
   * One schema's catalog-stored functions, each addressed by name AND argument types.
   *
   * A catalog-level call is REFUSED rather than fanned out over the catalog's schemas: the
   * fan-out is one full HTTP exchange per schema, unbounded on a Hive or Iceberg catalog,
   * and `SHOW FUNCTIONS` is the only surface there is - `information_schema` holds no
   * routine catalog on this engine and `system.jdbc.procedures` answers zero rows for a
   * schema holding three functions (measured on 476).
   */
  private async listFunctions(capabilities: ProviderCapabilities, read: TrinoContainer): Promise<DatabaseObject[]> {
    if (read.schema === undefined) throw new QueryError(this.functionScopeRefusal(), this.type);

    const schema = read.schema;
    const rows = await this.runObjectRows(trinoFunctionListSql(read.catalog, schema));
    return rows.flatMap((row) => {
      const name = readObjectIdentifier(row[TRINO_FUNCTION_COLUMNS.name]);
      const argumentTypes = row[TRINO_FUNCTION_COLUMNS.argumentTypes];
      if (name === null || typeof argumentTypes !== "string") return [];
      // `path` addresses and `name` labels, and here they differ: the segment carries the
      // overload's argument types and the label stays the bare name a person reads.
      return [
        listedObject(
          capabilities,
          read.catalog,
          TRINO_FUNCTION_KIND,
          schema,
          functionSegment(name, argumentTypes),
          name,
        ),
      ];
    });
  }

  /**
   * Columns for one object of one KIND, and two empty arrays that are facts rather than
   * failed reads.
   *
   * There are NO indexes and NO foreign keys to read, in any catalog of any connector:
   * Trino's `information_schema` holds eight views and neither `table_constraints` nor
   * `key_column_usage` is among them, which is the same measurement `declaresForeignKeys:
   * false` rests on (#414).
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. A function answers three empty arrays without a round trip, which is true of
   * the kind rather than of the object: a routine legitimately has no columns.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`${this.dialect.displayName} declares no object kind "${kind}"`, this.type);
    }

    const read = objectRead(capabilities, spec, path);
    if (spec.role !== "relation") return { path: [...path], columns: [], indexes: [], foreignKeys: [] };

    const sql = trinoObjectColumnsSql(read.catalog, read.schema, read.name);
    const rows = await this.runObjectRows(sql);
    if (rows.length === 0) {
      // Measured: `CREATE TABLE t ()` is a parser error on this engine, so a relation with
      // no column row is a relation that is not there. Answering `{ columns: [] }` would
      // render a dropped table as a table with no columns.
      throw new QueryError(`No column row for ${path.join(".")}`, this.type, sql);
    }

    return objectDetailFromRows(path, rows);
  }

  /**
   * Columns for EVERY object of one kind in one container (#789).
   *
   * TWO round trips for a whole folder, constant in the number of objects: the target read
   * plus the column read, which is `describeObject()`'s own statement with the
   * schema-and-name equality replaced by a join against the target. The caller's alternative
   * was one `describeObject` per object, which is one statement each.
   *
   * The four guards are asked in the same order the reference implementation asks them:
   *   1. a kind Trino does not declare RAISES, naming the engine and the kind. An empty
   *      batch would be a claim about the container; an undeclared kind is a fact about the
   *      engine.
   *   2. the container path goes through `containerRead`, the same reader `listObjects`
   *      uses, so the depth and the segment-to-level mapping come from the declaration and
   *      never from a position (standing ruling 5g).
   *   3. a `limit` that is not a positive whole number raises rather than clamping. Here that
   *      guard also protects the STATEMENT: the value is interpolated into a `LIMIT` clause,
   *      because this transport sends text and has no parameter channel at all.
   *   4. a kind with no columns answers `{ details: [] }` with NO round trip. On this engine
   *      that is `function` alone, the one non-relation kind, and it answers so at EITHER
   *      container depth - `listObjects` refuses a catalog-level function read because
   *      `SHOW FUNCTIONS` would have to be fanned out per schema, and there is no fan-out
   *      here because a routine has no columns to read.
   *
   * The bound is the CALLER's. `limit + 1` reaches the target's `LIMIT`, the extra object is
   * dropped and `truncated` carries the caller's own limit; an unbounded call can never
   * report truncation, and nothing here caps the columns of an object.
   *
   * MEMBERSHIP comes from the target read and never from the column read, which is what lets
   * an object the column read answered nothing for come back with an empty list rather than
   * missing. It is also why this read does not repeat the single read's zero-column throw:
   * there an empty answer means the object is not there under that name, here the listing
   * has just said it is.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`${this.dialect.displayName} declares no object kind "${kind}"`, this.type);
    }
    const read = containerRead(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A Trino bulk column read limit must be a positive whole number, received ${limit}`,
        this.type,
      );
    }
    if (spec.role !== "relation") return { details: [] };

    // One row more than the bound, so the read itself says whether it stopped short.
    const bound = limit === undefined ? undefined : limit + 1;
    const targetRows = await this.runObjectRows(trinoObjectTargetSql(read, kind, bound));
    const targets = targetRows.flatMap((row) => {
      const schema = readObjectIdentifier(row.schemaName);
      const name = readObjectIdentifier(row.objectName);
      return schema === null || name === null ? [] : [{ schema, name }];
    });
    const truncated = limit !== undefined && targets.length > limit;
    // The extra object the `limit + 1` bound brought back is dropped here, so its rows in
    // the grouping below are simply never read.
    const described = truncated ? targets.slice(0, limit) : targets;

    const columnRows = await this.runObjectRows(trinoBulkColumnsSql(read, kind, bound));
    const grouped = new Map<string, TrinoRow[]>();
    for (const row of columnRows) {
      // A column row with no usable address is not guarded away, it is keyed away: the empty
      // string is a key no TARGET can produce, because a target is only kept when both its
      // segments read as non-empty identifiers. So such a row lands in a group nothing asks
      // for, and the alternative - an explicit `continue` - would be a line no data can
      // reach while raw lcov reports it as covered (standing ruling 5b).
      const key = objectKey(readObjectIdentifier(row.schemaName) ?? "", readObjectIdentifier(row.objectName) ?? "");
      const existing = grouped.get(key);
      if (existing === undefined) grouped.set(key, [row]);
      else existing.push(row);
    }

    const details = described
      .map((target) =>
        objectDetailFromRows(
          listedObject(capabilities, read.catalog, kind, target.schema, target.name, target.name).path,
          grouped.get(objectKey(target.schema, target.name)) ?? [],
        ),
      )
      // Sorted by PATH, which is what every caller joins the two answers on, and not by the
      // name the statement ordered by: that order is the cluster's and decides only which
      // objects a bound keeps.
      .sort((left, right) => comparePaths(left.path, right.path));

    return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
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

  /**
   * The tables that published statistics, or an ABSENT panel with the reason.
   *
   * An empty array here has four causes and only one of them is a measurement (see
   * `TrinoTableStatsReading`). Two of the other three used to render as an empty table,
   * which claims the engine answered "no tables" - measured 2026-08-25 against Trino 476,
   * the jmx catalog holds 379 tables in schema `current` and a 20-table random sample
   * of them answered SHOW STATS with an empty row_count (0 of 20 non-null; the jmx
   * connector supplies no statistics at all), so that panel reported nothing about a
   * catalog full of data.
   *
   * The fourth (#515) used to render as something worse than an empty table: a scope
   * holding more tables than one pass describes was silently CUT to the first 25, and
   * `TableStats[]` has no field in which the cut could have been declared, so the panel
   * and the agent's curated reading both published 25 as the count. It is now refused
   * with the number of tables the scope really holds.
   */
  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    const transport = this.requireTransport();
    const catalog = this.requireCatalog();
    const reading = await this.guarded(() => readTableStats(transport, catalog, options));
    if (reading.refusal !== undefined) throw new QueryError(reading.refusal, this.type);

    return reading.tables;
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
