/**
 * InfluxDB 3 (SQL) provider (InfluxDB spec 5.2, 6.2, 6.3, 7): InfluxDB 3 Core and Enterprise over
 * `/api/v3/query_sql`, read-only, one session database per connection (R1) whose tables are top-level objects (R16).
 *
 * COMPOSITION AND DELEGATION ONLY (spec 3.5). The wire lives in `client.ts` and `routes.ts`, the connection rules in
 * `connection-options.ts`, the version in `versions.ts`, the read policy in `sql-policy.ts`, the session database in
 * `run-database.ts`, the answer's shape in `sql-results.ts`, the catalog reads in `sql-objects.ts`, the monitoring
 * mappings in `monitoring.ts`, the labels in `labels.ts` and every sentence of a failure in `errors.ts`. What stays
 * here is the lifecycle, the declarations, the connect sequence of spec 6.2, and each call's permit, deadline and
 * error context. The one module it imports from outside this directory's layers is `sql-base` (R15), for the
 * inherited `prepareQuery`, which appends the preview's `LIMIT` and `OFFSET` under the DataFusion grammar row (I19).
 *
 * The closed route table and the 3.x planner are the boundary here (I8); the read policy runs on every text this
 * provider sends all the same, its own catalog texts included (E6, E17), and what it refuses sends nothing.
 *
 * One limiter covers every client call (E16): the connect reads, the tree, monitoring and the runs, each taking one
 * permit of the engine key `influxdb3` per request in flight. A run's signal carries its deadline (the connection's
 * query timeout) and its cancel (`createRunRegistry`); every other read carries the surface deadline. A cancel or a
 * disconnect drops the socket, which frees the server's work (spec 5.6).
 */
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { callerBoundTruncationReason, findKind } from "@/lib/db/object-kinds";
import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseConnection,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  PerformanceMetrics,
  PreviewTimeWindow,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import {
  createRunRegistry,
  engineLimiter,
  type ProviderLimiter,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import {
  createInfluxClient,
  type InfluxAnswer,
  type InfluxClient,
  type InfluxClientFactory,
  type InfluxRequest,
  type InfluxSend,
} from "./client";
import {
  buildInfluxConnectionOptions,
  INFLUX_CELL_BUDGET,
  INFLUX_LIMITER_OPTIONS,
  INFLUX_ROW_CUT,
  type InfluxConnectionOptions,
  type InfluxShapeLimits,
  type InfluxType,
  INFLUXDB3_DEFAULT_PORT,
} from "./connection-options";
import { INFLUX_ERROR_SENTENCES, InfluxAnswerError, type InfluxErrorContext, toInfluxError } from "./errors";
import { INFLUXDB3_LABELS } from "./labels";
import { toInfluxHealth, toInfluxOverview } from "./monitoring";
import { SQL_ROUTES, type SqlRouteId } from "./routes";
import { resolveSessionDatabase } from "./run-database";
import {
  countInfluxdb3Tables,
  describeInfluxdb3Table,
  type Influxdb3SurfaceContext,
  INFLUXDB3_OBJECT_KINDS,
  listInfluxdb3Tables,
  readInfluxdb3Databases,
} from "./sql-objects";
import { evaluateInfluxSql } from "./sql-policy";
import { shapeJsonlBody } from "./sql-results";
import {
  GENERATION_TRAITS,
  type InfluxGeneration,
  type InfluxServerVersion,
  pingNeedsHealth,
  readPing,
} from "./versions";

const INFLUXDB3: InfluxType = "influxdb3";

const influxdb3Limiter = engineLimiter("influxdb3", INFLUX_LIMITER_OPTIONS);

/** A run's bounds (spec 5.5): the row cut and the cell budget, reported on `pagination.wasLimited`. */
const SHAPE_LIMITS: InfluxShapeLimits = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET };
/** The connect check of a Database the token cannot list (spec 6.2 step 3): one row is all it reads. */
const CHECK_LIMITS: InfluxShapeLimits = { rowCut: 1, cellBudget: INFLUX_CELL_BUDGET };
const DATABASE_CHECK = "SELECT 1";

/**
 * Spec 6.6 (I20, K1 measured by T14): one hour succeeds on the default file limit and on the limit-1 fixture, where
 * six hours and wider meet the file-limit error. `{table}` and `{column}` are filled by the generators.
 */
const PREVIEW_TIME_WINDOW: PreviewTimeWindow = Object.freeze({
  column: "time",
  since: "now() - INTERVAL '1 hour'",
  note: "Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.",
  examples: Object.freeze([
    "A wider window: WHERE \"time\" >= now() - INTERVAL '1 day'",
    "One row per minute: SELECT date_bin(INTERVAL '1 minute', \"time\") AS minute, avg({column}) FROM {table} WHERE \"time\" >= now() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 1",
    "Timestamps are UTC with no zone suffix; time AT TIME ZONE 'UTC' shows a Z.",
  ]),
});

/** One sentence of `INFLUX_ERROR_SENTENCES`, read by key; a renamed or reshaped key fails when the module loads. */
function sentenceText(key: string): string {
  const sentence = INFLUX_ERROR_SENTENCES[key];
  if (typeof sentence !== "string") throw new TypeError(`INFLUX_ERROR_SENTENCES.${key} is not a sentence.`);
  return sentence;
}

/** One sentence template of `INFLUX_ERROR_SENTENCES`, read by key, checked as `sentenceText` is. */
function sentenceTemplate(key: string): (...parts: string[]) => string {
  const template = INFLUX_ERROR_SENTENCES[key];
  if (typeof template !== "function") throw new TypeError(`INFLUX_ERROR_SENTENCES.${key} is not a template.`);
  return template;
}

/** The connect refusals errors.ts leaves to this provider (spec 5.9, the connect table; R48). */
const SENTENCES = Object.freeze({
  noSqlOnVersion: sentenceTemplate("noSqlOnVersion"),
  pingForbiddenNoDatabase: sentenceText("pingForbiddenNoDatabase"),
  sqlDatabaseNotFound: sentenceTemplate("sqlDatabaseNotFound"),
});

const NO_HOST = "An InfluxDB 3 connection needs a host.";
/** Spec 5.2 step 1, the sentence of the InfluxQL pipeline (R28): `SQL_ROUTES` has no `params` key. */
const BOUND_PARAMETERS = "Studio does not send bound parameters; write the value in the statement.";
const NO_MAINTENANCE =
  "InfluxDB 3 has no maintenance operation in Studio, and the connection is read-only, so nothing was sent.";
/** What `describeObjects` says when the listing it describes stopped at its cap. */
const LISTING_CAP_REASON = "the table listing reads at most 2,000 tables";
/**
 * The statuses with which the server refuses a read (spec 7: "a read the server refuses yields its empty answer"):
 * a credential it does not accept, one without the grant, and a route it does not serve.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
/** What 3.x says in the 404 of a read whose `db` it does not have (R48): an answer, never a refused read. */
const DATABASE_NOT_FOUND = "database not found: ";
/** What a timeout says while a call waits for a permit, in the shared transport's words. */
const WAIT_TIMEOUT = "The request did not finish within its time limit";
/** The media types the SQL routes answer with: `json` for the listing, `jsonl` for a query. */
const SQL_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/json", "application/jsonl"]);

/** What a `/ping` 403 means on this type (I10): a resource token, of a server that serves SQL, version unread. */
const RESOURCE_TOKEN_VERSION: InfluxServerVersion = Object.freeze({ generation: "v3", reported: null, build: null });

/**
 * A connection is one session database, so the only container path is the empty one (R16, the Qdrant shape): the
 * type declares no `containerPathShapes`, so the check is its own, not `assertContainerPathShape`.
 */
function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) {
    throw new QueryError(
      `An InfluxDB 3 connection has no container level; received ${JSON.stringify(container)}`,
      INFLUXDB3,
    );
  }
}

/** A permit wait the deadline ended rejects with the signal's own reason; worded as the transport words a timeout. */
function waitFailure(error: unknown): unknown {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? new TransportError("timeout", WAIT_TIMEOUT)
    : error;
}

/** The answer's text when it is a 200 of JSON or jsonl; otherwise the answer is raised for errors.ts to word. */
function acceptedText(answer: InfluxAnswer): string {
  const media = (answer.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (answer.status !== 200 || !SQL_MEDIA_TYPES.has(media)) throw new InfluxAnswerError(answer, SQL_ROUTES.query.path);
  return answer.text;
}

/** "InfluxDB 1.13.1", "InfluxDB 2.9.1": how the mis-pick sentence names a server that has no SQL endpoint. */
function serverName(reported: string): string {
  return `InfluxDB ${reported.replace(/^v/, "")}`;
}

/** The one client of a connected provider and what it learned while connecting. */
interface Influxdb3Session {
  readonly client: InfluxClient<SqlRouteId>;
  readonly options: InfluxConnectionOptions;
  readonly version: InfluxServerVersion;
  /** The one database every read of this connection sends as `db` (R1). */
  readonly database: string;
}

export class InfluxDB3Provider extends SQLBaseProvider {
  private session: Influxdb3Session | null = null;
  private readonly limiter: ProviderLimiter = influxdb3Limiter();
  private readonly runs: RunRegistry = createRunRegistry();

  /** Validates nothing and opens nothing: the connection's rules run in `connect()`, before the factory. */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createClient: InfluxClientFactory = createInfluxClient,
  ) {
    super(config, options);
  }

  // ==========================================================================
  // Declarations (spec 6.3)
  // ==========================================================================

  /** Every member written out: the base's defaults are a writable SQL engine's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // No DataFusion EXPLAIN strategy in v1 (I25); a typed EXPLAIN returns rows.
      supportsExplain: false,
      // The inherited limiter's LIMIT and OFFSET are standard SQL here (I19, K17).
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: true,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // The route table plus the engine (I8).
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      // `http://` and `https://` already parse as ClickHouse; Host takes the URI.
      supportsConnectionString: false,
      defaultPort: INFLUXDB3_DEFAULT_PORT,
      // R41: every name double-quoted, so `time` and a `$` inside a name are never bare.
      identifierQuoting: "double-always",
      statementTerminator: "none",
      previewTimeWindow: PREVIEW_TIME_WINDOW,
      objectKinds: INFLUXDB3_OBJECT_KINDS,
      // No statement Studio runs changes the catalog, so the pattern matches nothing.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...INFLUXDB3_LABELS };
  }

  /** Refuses an empty Host by name, as the Prometheus provider does; which host is legal is the options' question. */
  public override validate(): void {
    super.validate();
    if (!this.config.host) throw new DatabaseConfigError(NO_HOST, this.type);
  }

  // ==========================================================================
  // Lifecycle (spec 6.2)
  // ==========================================================================

  /**
   * After the options' checks: the version from `/ping` (and `/health` when `/ping` names none), refusing a 1.x or
   * 2.x server before any `/api/v3` call; the databases the token lists; the session database from the field and the
   * listing, checked with `SELECT 1` when the listing was refused. Every read shares the surface deadline; a failure
   * closes the client and is worded with the phase `connect`.
   */
  public async connect(): Promise<void> {
    let options: InfluxConnectionOptions | undefined;
    let client: InfluxClient<SqlRouteId> | undefined;
    let generation: InfluxGeneration = "unknown";
    try {
      this.validate();
      options = buildInfluxConnectionOptions(this.config, { type: INFLUXDB3, queryTimeout: this.queryTimeout });
      const opened = this.createClient(options, SQL_ROUTES);
      client = opened;
      const signal = AbortSignal.timeout(options.surfaceTimeoutMs);
      const send: InfluxSend<SqlRouteId> = (request, read) => this.send(opened, request, read);
      const version = await this.readVersion(send, options, signal);
      generation = version.generation;
      const visible = await this.readListing(send, signal);
      const session = resolveSessionDatabase({
        connection: options.database,
        visible,
        internalDatabase: GENERATION_TRAITS[generation].internalDatabase,
      });
      if ("refused" in session) throw new DatabaseConfigError(session.refused, this.type);
      // The listing was refused, so nothing has shown the field names a database this token reads (I10).
      if (visible === undefined) await this.checkDatabase(send, session.database, signal);
      // R48: a readable listing without the field is the answer; the server matches names exactly, and so does this.
      else if (!visible.includes(session.database)) {
        throw new ConnectionError(
          SENTENCES.sqlDatabaseNotFound(session.database),
          this.type,
          options.endpoint.host,
          options.endpoint.port,
        );
      }
      const previous = this.session;
      this.session = { client: opened, options, version, database: session.database };
      // A second connect replaces the session; the first one's client is closed, not left open.
      previous?.client.close();
    } catch (error) {
      client?.close();
      const failure =
        options === undefined
          ? (error as Error)
          : toInfluxError(error, this.errorContext(options, "connect", generation));
      this.setError(failure);
      throw failure;
    }
    this.setConnected(true);
  }

  /**
   * Spec 6.2 step 2. A 403 is a resource token (I10): generation `v3`, version unknown, and Database required. A 1.x
   * or 2.x version, which only `/health` reports, has no SQL endpoint; a server that names no version is left to the
   * listing, whose answer decides.
   */
  private async readVersion(
    send: InfluxSend<SqlRouteId>,
    options: InfluxConnectionOptions,
    signal: AbortSignal,
  ): Promise<InfluxServerVersion> {
    const ping = await send({ route: "ping", values: {} }, signal);
    if (ping.status === 403) {
      if (options.database === undefined) throw new DatabaseConfigError(SENTENCES.pingForbiddenNoDatabase, this.type);
      return RESOURCE_TOKEN_VERSION;
    }
    if (ping.status !== 200 && ping.status !== 204) throw new InfluxAnswerError(ping, SQL_ROUTES.ping.path);
    const health = pingNeedsHealth(ping) ? await send({ route: "health", values: {} }, signal) : undefined;
    const version = readPing(ping, health);
    if (version.reported !== null && !GENERATION_TRAITS[version.generation].servesSql) {
      throw new ConnectionError(
        SENTENCES.noSqlOnVersion(serverName(version.reported)),
        this.type,
        options.endpoint.host,
        options.endpoint.port,
      );
    }
    return version;
  }

  /** The databases the token lists, `_internal` removed; undefined when the server refuses the listing (403). */
  private async readListing(send: InfluxSend<SqlRouteId>, signal: AbortSignal): Promise<readonly string[] | undefined> {
    try {
      return await readInfluxdb3Databases(send, signal);
    } catch (error) {
      if (error instanceof InfluxAnswerError && error.answer.status === 403) return undefined;
      throw error;
    }
  }

  /** `SELECT 1` against the session database under the surface deadline, reading one row (spec 6.2 step 3). */
  private async checkDatabase(send: InfluxSend<SqlRouteId>, database: string, signal: AbortSignal): Promise<void> {
    const answer = await send({ route: "query", values: { db: database, q: DATABASE_CHECK } }, signal);
    shapeJsonlBody(acceptedText(answer), CHECK_LIMITS);
  }

  /** Closes the client, which stops every request in flight (spec 5.6). */
  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    session?.client.close();
  }

  private requireSession(): Influxdb3Session {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session!;
  }

  /** One request under its own limiter permit, released when it settles. */
  private async send(
    client: InfluxClient<SqlRouteId>,
    request: InfluxRequest<SqlRouteId>,
    signal: AbortSignal,
  ): Promise<InfluxAnswer> {
    let ticket: Awaited<ReturnType<ProviderLimiter["acquire"]>>;
    try {
      ticket = await this.limiter.acquire(signal);
    } catch (error) {
      throw waitFailure(error);
    }
    try {
      return await client.send(request, signal);
    } finally {
      ticket.release();
    }
  }

  /** What errors.ts needs to word a failure of one call. */
  private errorContext(
    options: InfluxConnectionOptions,
    phase: InfluxErrorContext["phase"],
    generation: InfluxGeneration,
    database: string | undefined = options.database,
    timeoutMs: number = options.surfaceTimeoutMs,
  ): InfluxErrorContext {
    return {
      type: INFLUXDB3,
      phase,
      endpoint: options.endpoint,
      generation,
      hasUser: options.hasUser,
      database,
      timeoutMs,
      responseCapBytes: options.responseCapBytes,
      secretForms: options.secretForms,
    };
  }

  // ==========================================================================
  // Query path (spec 5.2), after the route's inherited `prepareQuery`
  // ==========================================================================

  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // `SQL_ROUTES` has no `params` key; an empty list binds nothing.
    if (params !== undefined && params.length > 0) throw new QueryError(BOUND_PARAMETERS, this.type);
    const session = this.requireSession();
    const { options, version, database } = session;
    // The byte cap (E10) is the policy's first rule, counted before the text is read.
    const verdict = evaluateInfluxSql(text);
    if (!verdict.allowed) throw new QueryError(verdict.message, this.type);
    const context = this.errorContext(options, "query", version.generation, database, options.callTimeoutMs);
    const handle = this.runs.begin(queryId, AbortSignal.timeout(options.callTimeoutMs));
    try {
      const { result: answer, executionTime } = await this.trackQuery(() =>
        this.measureExecution(() =>
          this.send(session.client, { route: "query", values: { db: database, q: text } }, handle.signal),
        ),
      );
      const shaped = shapeJsonlBody(acceptedText(answer), SHAPE_LIMITS);
      return {
        fields: [...shaped.fields],
        rows: [...shaped.rows],
        rowCount: shaped.rows.length,
        executionTime,
        // Absent, never empty, when the server sent no notice (R26).
        ...(shaped.warnings.length === 0 ? {} : { warnings: [...shaped.warnings] }),
        // A cut this provider applied is reported on `pagination`, whose `wasLimited` the query route carries.
        ...(shaped.cut
          ? {
              pagination: {
                limit: INFLUX_ROW_CUT,
                offset: 0,
                hasMore: false,
                totalReturned: shaped.rows.length,
                wasLimited: true,
              },
            }
          : {}),
      };
    } catch (error) {
      throw toInfluxError(error, context);
    } finally {
      handle.end();
    }
  }

  /** Aborts a running or waiting run by its id and answers true; an unknown id answers false (spec 5.6). */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface (spec 4, R16), answered by sql-objects.ts
  // ==========================================================================

  /** One surface call: its reads under one surface deadline, each with its own permit, and its failure worded. */
  private async surface<T>(read: (context: Influxdb3SurfaceContext) => Promise<T>): Promise<T> {
    const session = this.requireSession();
    const { client, options, version, database } = session;
    try {
      return await read({
        send: (request, signal) => this.send(client, request, signal),
        signal: AbortSignal.timeout(options.surfaceTimeoutMs),
        sessionDatabase: database,
      });
    } catch (error) {
      throw toInfluxError(error, this.errorContext(options, "surface", version.generation, database));
    }
  }

  private requireKind(kind: string): void {
    if (findKind(this.getCapabilities(), kind) === undefined) {
      throw new QueryError(`InfluxDB 3 declares no object kind "${kind}"`, this.type);
    }
  }

  /** None: the session database has no container node; the overview names it (spec 7). */
  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    requireRoot(container);
    const table = await this.surface((context) => countInfluxdb3Tables(context));
    return { table };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    requireRoot(container);
    return this.surface(async (context) => [...(await listInfluxdb3Tables(context)).tables]);
  }

  /** A path that is not one segment is refused by `describeInfluxdb3Table` before any request. */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.requireKind(kind);
    return this.surface((context) => describeInfluxdb3Table(context, path));
  }

  /**
   * The bounded fallback the Qdrant provider set: one listing, then one schema read per table, one after another. A
   * caller's `limit` and the listing's own cap are each reported on `truncated`.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.requireKind(kind);
    requireRoot(container);
    return this.surface(async (context) => {
      const { tables, truncated } = await listInfluxdb3Tables(context);
      const callerCut = limit !== undefined && tables.length > limit;
      const described = callerCut ? tables.slice(0, limit) : tables;
      const details: ObjectDetail[] = [];
      for (const table of described) {
        // oxlint-disable-next-line no-await-in-loop -- one table at a time keeps one call's reads to one permit.
        details.push(await describeInfluxdb3Table(context, table.path));
      }
      if (callerCut) return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
      if (truncated) return { details, truncated: { limit: tables.length, reason: LISTING_CAP_REASON } };
      return { details };
    });
  }

  // ==========================================================================
  // Monitoring (spec 7), mapped by monitoring.ts
  // ==========================================================================

  /** `GET /ping`: reachability only, never evidence of what the token may read; a non-refusal failure throws. */
  public async getHealth(): Promise<HealthInfo> {
    const { client, options, version } = this.requireSession();
    try {
      const ping = await this.send(
        client,
        { route: "ping", values: {} },
        AbortSignal.timeout(options.surfaceTimeoutMs),
      );
      // Any 2xx is reachability, and so is a refusal (spec 7); a 5xx is a server that answers but does not work.
      const failed = (ping.status < 200 || ping.status > 299) && !REFUSAL_STATUSES.has(ping.status);
      if (failed) throw new InfluxAnswerError(ping, SQL_ROUTES.ping.path);
    } catch (error) {
      throw toInfluxError(error, this.errorContext(options, "surface", version.generation));
    }
    return toInfluxHealth();
  }

  /**
   * The version, the session database and its tables (R24), the listing capped; a listing the server refuses (a
   * 401, 403 or 404) counts none, never a throw (spec 7); any other failure is thrown, worded, and so is the 404 that
   * says the session database is not found (R48), as the tree throws it.
   */
  public async getOverview(): Promise<DatabaseOverview> {
    const session = this.requireSession();
    return this.surface(async (context) => {
      let count: KindCount = { count: 0 };
      try {
        count = await countInfluxdb3Tables(context);
      } catch (error) {
        const refused =
          error instanceof InfluxAnswerError &&
          REFUSAL_STATUSES.has(error.answer.status) &&
          !(error.answer.status === 404 && error.answer.text.includes(DATABASE_NOT_FOUND));
        if (!refused) throw error;
      }
      // The reader answers `{ count }` or a floor with `sampledFrom` past the cap; `unavailable` is not its answer.
      if ("unavailable" in count) throw new TypeError(`The table count answered unavailable: ${count.unavailable}`);
      return toInfluxOverview({
        version: session.version,
        sessionDatabase: session.database,
        objectCount: count.count,
        objectCountCut: "sampledFrom" in count,
        objects: "tables",
      });
    });
  }

  /** Every metric is optional, and no route this provider reads reports one. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: `getLabels().slowQueriesEmptyState` says why. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: every request stands alone; `getLabels().sessionsEmptyState` says so. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: no route reports a row count or a size Studio can state honestly. */
  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: a table has no index object to describe. */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: no route reports a size on disk. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  /** `supportsMaintenance` is false (I1): refused with no request. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(NO_MAINTENANCE, this.type);
  }
}
