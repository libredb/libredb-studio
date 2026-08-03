/**
 * Apache Druid Database Provider (issue #265)
 *
 * SQL over Druid's HTTP query endpoint with no runtime dependency: every
 * statement, catalog read and metric goes through the DruidTransport seam, so
 * this file never names a request field, a header row or an envelope field, and
 * `seam-guard.test.ts` fails the build if it starts to. The wire lives in
 * `http-transport.ts`; the catalog and `sys` reads live in `introspect.ts`.
 *
 * It extends `SQLBaseProvider` rather than `BaseDatabaseProvider` because the
 * dialect really is standard on the points the shared helpers care about -
 * double-quoted identifiers and `LIMIT n OFFSET m` are both correct Druid SQL
 * (live-verified on 37.0.0) - which is the case `docs/ADDING_A_PROVIDER.md` names
 * ClickHouse for. Only `prepareQuery()` is overridden, for the one trap below.
 *
 * Five live-verified behaviours shape almost everything here, and each one
 * produces a wrong answer or a hard failure if forgotten:
 *
 * - `OFFSET n` with no `LIMIT` is the one statement the shared limiter breaks:
 *   `... OFFSET 2 LIMIT 3` is a 400, "'OFFSET start LIMIT count' is not allowed
 *   under the current SQL conformance level". Such a statement is left alone.
 * - The HTTP status misclassifies, in BOTH directions. `SELECT 1/0` is a 500 for
 *   an ordinary typo, so failures are classified by the CATEGORY Druid reports
 *   and never by the status.
 * - Druid SQL has no statement that mutates: `UPDATE` and `DELETE` are not in the
 *   grammar and `INSERT`/`REPLACE` need the MSQ task engine. None of them is
 *   special-cased - the server's own message already names the alternative.
 * - There is no maintenance operation SQL can reach, and no `sys.queries` catalog
 *   to read a cancellable query id from, so `supportsMaintenance` is false.
 * - Positional parameters really execute, unlike ClickHouse (#264), so
 *   `query(sql, params)` binds them rather than refusing them.
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
  type SlowQueryStats,
  type StorageStats,
  type TableSchema,
  type TableStats,
} from "@/lib/db/types";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { DruidHttpTransport } from "./http-transport";
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
} from "./introspect";
import {
  DRUID_CLIENT_DEADLINE_GRACE_MS,
  DRUID_TRANSPORT_FAILURE,
  type DruidQueryResult,
  type DruidTransport,
  DruidTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The cheapest statement Druid will answer, used to prove the cluster at connect
 * time rather than at the user's first query.
 *
 * Live-verified as valid: Druid plans it against a one-row inline datasource and
 * names the column `EXPR$0`. It needs no datasource, so it also succeeds on a
 * cluster that has not ingested anything yet.
 */
const CONNECT_PROBE_SQL = "SELECT 1";

/**
 * How much longer the client waits than the deadline it asked the server to
 * honour.
 *
 * The two deadlines are not duplicates (the #264 lesson): the server-side one is
 * what actually frees the cluster's resources, but it only starts counting once
 * the statement was accepted, so it cannot bound a stalled connect, a TLS
 * handshake, or a response body that stops arriving part-way. The client one is
 * therefore deliberately the LATER of the two - a client that gave up first would
 * abandon a query that is still running and report a bare abort instead of the
 * 504 Druid was about to send, with its category and its message.
 *
 * Re-exported from the seam rather than declared here: the introspection reads set
 * the same pair of deadlines and once used the same value for both, which lost that
 * race on every slow catalog read. One definition is what keeps them in step.
 */
const CLIENT_DEADLINE_GRACE_MS = DRUID_CLIENT_DEADLINE_GRACE_MS;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The neutral transport result as the grid's row contract.
 *
 * Three things this does NOT do, each deliberate:
 *
 * - No mutation count to fall back on. Druid SQL has no statement that mutates,
 *   so the row count is the number of rows returned and a second number would
 *   always be zero - which reads as "nothing changed" rather than "impossible".
 * - No fallback duration. The endpoint reports no timing whatsoever (no field in
 *   the body, nothing in the response metadata), so the transport's measurement
 *   of the exchange is the only number in existence; there is no server-reported
 *   value it could be preferred over.
 * - No renaming of the declared columns. They arrive already unique, so a
 *   duplicated output name reaches the grid as `name` and `name (2)` instead of
 *   overwriting - which is exactly what the wire format was chosen for.
 */
function toQueryResult(result: DruidQueryResult): QueryResult {
  return {
    rows: result.rows,
    fields: result.fieldNames ?? [],
    rowCount: result.rows.length,
    executionTime: Math.round(result.executionTimeMs),
  };
}

// ============================================================================
// Druid Provider
// ============================================================================

export class DruidProvider extends SQLBaseProvider {
  private transport: DruidTransport | null = null;

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
      explainFormat: "druid-native",
      supportsExternalQueryLimiting: true,
      // Not merely unimplemented: CREATE is not in Druid's grammar at all.
      // Live-verified, `CREATE TABLE t (id BIGINT)` answers 400 "Incorrect syntax
      // near the keyword 'CREATE' at line 1, column 1" and the parser lists the
      // statements it expected, with no form of CREATE among them. A datasource
      // comes into existence by being ingested into.
      supportsCreateTable: false,
      // Nothing in MaintenanceType has a Druid analogue reachable from SQL:
      // compaction and retention are Coordinator and task concerns, and `kill` is
      // impossible for a second reason - there is no `sys.queries` catalog, so
      // there is nowhere honest for a user to read a cancellable query id from.
      supportsMaintenance: false,
      maintenanceOperations: [],
      // Druid's SQL endpoint has no URI convention (its JDBC driver addresses
      // Avatica instead), and `http://` / `https://` are already claimed by
      // ClickHouse in the shared parser. There is nothing for a user to paste.
      supportsConnectionString: false,
      // The Router's port. The Broker on 8082 serves the identical endpoint and
      // needs no different configuration (live-verified); the Router is the
      // default only because it also fronts the console.
      defaultPort: 8888,
      // The only two statements that can change a datasource. The native engine
      // rejects both, so in practice a query never refreshes the schema - which is
      // correct: a Druid schema changes through ingestion, not through the editor.
      schemaRefreshPattern: "\\b(INSERT|REPLACE)\\b",
    };
  }

  /**
   * Datasource is the Druid word for a table, and the sidebar is where a user
   * meets it.
   *
   * Everything else is inherited on purpose. A Druid row IS a row, so renaming it
   * would only make the grid speak a dialect the cluster does not. The maintenance
   * labels barely matter here - `supportsMaintenance` is false, so the Maintenance
   * panel offers nothing - and they must still be strings, so they stay as they are
   * rather than naming operations that do not exist.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      entityName: "Datasource",
      entityNamePlural: "Datasources",
    };
  }

  /**
   * The inherited limiter is right for every statement but one.
   *
   * It appends `LIMIT n` at the very END, and Druid rejects `OFFSET n LIMIT n`
   * outright: live-verified, `SELECT id FROM libredb_demo OFFSET 2 LIMIT 3`
   * answers 400 "'OFFSET start LIMIT count' is not allowed under the current SQL
   * conformance level". So a statement that ends in an OFFSET with no LIMIT is
   * returned untouched, and the bias has to be "do not rewrite" for the same
   * reason as ClickHouse's trailing-clause case: rewriting wrongly fails the
   * query outright, while leaving it alone only returns more rows than asked for.
   *
   * `analyzeQuery` rather than a regex of this file's own: it already strips a
   * trailing semicolon, and it already distinguishes the OFFSET that follows a
   * LIMIT (which is the ordinary paginated form, and which the limiter leaves
   * alone anyway) from the OFFSET that stands alone.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const prepared = super.prepareQuery(query, options);
    const parsed = analyzeQuery(query);
    if (!parsed.hasOffset || parsed.hasLimit) return prepared;

    return { ...prepared, query, wasLimited: false };
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  /**
   * A host is the only requirement.
   *
   * No database is asked for, and the field is ignored even when the connection
   * form sets one: `INFORMATION_SCHEMA.SCHEMATA` reports exactly one catalog,
   * always named `druid`, so there is nothing to select. No connection string is
   * accepted either - see `supportsConnectionString`.
   */
  public override validate(): void {
    super.validate();
    if (!this.config.host) {
      throw new DatabaseConfigError("Druid requires a host", this.type);
    }
  }

  public async connect(): Promise<void> {
    const transport = new DruidHttpTransport(this.config);

    try {
      // The cheapest statement there is, sent here so a wrong port, a proxy in
      // front of the Broker, a Druid process that is not the query endpoint and a
      // rejected credential all surface while the user is still looking at the
      // connection form rather than at their first query.
      await transport.query(CONNECT_PROBE_SQL, this.deadlines());
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
    const mapped = this.mapDruidError(error);
    // A rejected credential is not a connectivity problem, and saying so would
    // send the user to check their host.
    if (mapped instanceof AuthenticationError) return mapped;

    return new ConnectionError(
      `Failed to connect to Druid: ${mapped.message}`,
      this.type,
      this.config.host,
      this.config.port,
    );
  }

  private requireTransport(): DruidTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false),
    // so a connected provider always has one.
    return this.transport!;
  }

  /**
   * Both halves of the deadline the provider advertises, for one statement.
   *
   * Set together everywhere, because either alone leaves a real hang unbounded:
   * without the server's own deadline an abandoned query keeps burning cluster
   * resources, and without the client's the body read is unbounded no matter what
   * the server promised.
   */
  private deadlines(): { timeoutMs: number; clientDeadlineMs: number } {
    return {
      timeoutMs: this.queryTimeout,
      clientDeadlineMs: this.queryTimeout + CLIENT_DEADLINE_GRACE_MS,
    };
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  /**
   * One statement, with its parameters bound.
   *
   * Unlike ClickHouse (#264), whose HTTP interface binds named parameters only
   * and whose provider therefore refuses positional ones, `?` placeholders really
   * execute on Druid (live-verified), so a parameterized statement is a
   * first-class case here. An unmappable value is refused by the transport before
   * anything leaves the process - sending something the server would misread is
   * worse than failing.
   *
   * A write is not special-cased. `UPDATE` and `DELETE` are not in Druid's
   * grammar and `INSERT`/`REPLACE` are rejected by the native engine, and in each
   * case the server's own message names both the reason and the alternative
   * ("consider using MSQ"), which is more useful than anything substituted here.
   */
  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();

    return this.trackQuery(async () => {
      try {
        const result = await transport.query(sql, { ...this.deadlines(), parameters: params ?? [] });
        return toQueryResult(result);
      } catch (error) {
        throw this.mapDruidError(error, sql);
      }
    });
  }

  /**
   * Normalized transport failure -> the provider error vocabulary, keyed on the
   * CATEGORY Druid reported.
   *
   * The category rather than the HTTP status, because the status misclassifies in
   * both directions (live-verified): `SELECT 1/0` is a 500 for a user's own typo,
   * so reading 5xx as "the cluster is broken" would tell them something false. The
   * category is present in both envelopes Druid uses and is a closed enum, which
   * makes it the only discrete thing there is to branch on.
   *
   * The stand-in category means "nothing classified this" - a refused socket, an
   * abort, a proxy's HTML page, a body that stopped arriving, a parameter refused
   * before the request left. It is deliberately NOT read as "the cluster is
   * unreachable": several of those are the user's own doing, so the shared
   * message-based mapping decides, exactly as `clickhouse/index.ts` does when the
   * server named no exception code.
   */
  private mapDruidError(error: unknown, sql?: string): Error {
    if (!(error instanceof DruidTransportError) || error.category === DRUID_TRANSPORT_FAILURE) {
      return this.mapError(error, sql);
    }

    if (error.is("UNAUTHORIZED") || error.is("FORBIDDEN")) {
      return new AuthenticationError(error.message, this.type);
    }
    if (error.is("TIMEOUT")) {
      return new TimeoutError(error.message, this.type, this.queryTimeout, sql);
    }
    if (error.is("CANCELED")) {
      return new QueryCancelledError(error.message, this.type, sql);
    }

    // Every remaining category describes a statement the cluster rejected -
    // INVALID_INPUT, UNSUPPORTED, NOT_FOUND, UNCATEGORIZED, RUNTIME_FAILURE - and
    // Druid's own message is the most useful thing that can be shown for it.
    return new QueryError(error.message, this.type, sql);
  }

  /** Run a catalog or monitoring read whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapDruidError(error);
    }
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  /**
   * The datasources and their columns, from `INFORMATION_SCHEMA` alone.
   *
   * `getSchemaList` and `getSchemaRelations` are deliberately NOT implemented.
   * Both are optional and the client falls back to this method, and the split
   * exists to keep a slow relationship read from blocking the table list - which
   * Druid has neither half of: there are no user-defined indexes and no foreign
   * keys, so a list would be byte-identical to this and a relations read would
   * spend a round trip to answer two empty arrays per datasource.
   */
  public async getSchema(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readSchema(transport));
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    const transport = this.requireTransport();
    return this.guarded(() => readOverview(transport));
  }

  /**
   * Zeroed, and it asks the cluster nothing.
   *
   * Druid's cache and query metrics reach a metrics emitter - statsd, Kafka, an
   * HTTP endpoint, the log - and none of them reaches a SQL-readable table, so
   * there is no statement to send and no connection to require: the answer cannot
   * vary with either. The same is true of the two reads below.
   */
  public getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return Promise.resolve(readPerformanceMetrics());
  }

  /** Empty: Druid keeps no query log anywhere, so a row cap has nothing to cap. */
  public getSlowQueries(): Promise<SlowQueryStats[]> {
    return Promise.resolve(readSlowQueries());
  }

  /** Empty: every dimension is indexed inside its segment, so no index OBJECT exists. */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.resolve(readIndexStats());
  }

  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readActiveSessions(transport, options));
  }

  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readTableStats(transport, options));
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readStorageStats(transport));
  }

  public async getHealth(): Promise<HealthInfo> {
    const transport = this.requireTransport();
    return this.guarded(() => readHealth(transport));
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * Refused, with the reason.
   *
   * This exists because the interface obliges every provider to implement it, and
   * it is reached only by a programmatic caller of the package: `/api/db/maintenance`
   * checks `supportsMaintenance` and answers 400 before it would call this, so no
   * HTTP request gets here. (The monitoring Tables tab does still render Analyze /
   * Vacuum / Reindex per row for every provider - it never reads capabilities - so
   * those buttons hit that 400. Pre-existing and shared with `libredb.ts`; see
   * docs/providers/druid.md section 8.)
   *
   * Compaction and retention are Coordinator and task concerns, out of scope for
   * #265, and a query cannot be killed through SQL at all because there is no
   * catalog listing running queries to name one from.
   */
  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(
      `Druid has no SQL-reachable maintenance operation, so "${type}" cannot run here. ` +
        "Compaction and retention are Coordinator and task concerns, and Druid publishes no catalog of running queries to cancel one from.",
      this.type,
    );
  }
}
