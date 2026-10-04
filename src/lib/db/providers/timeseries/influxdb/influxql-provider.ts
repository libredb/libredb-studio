/**
 * InfluxDB (InfluxQL) provider (InfluxDB spec 5.1, 6.2, 6.3, 7): every line, 1.x, 2.x and 3.x, over the v1 `/query`
 * API, read-only.
 *
 * COMPOSITION AND DELEGATION ONLY (spec 3.5). The wire lives in `client.ts` and `routes.ts`, the connection rules in
 * `connection-options.ts`, the version in `versions.ts`, the read policy in `influxql-policy.ts`, the run database in
 * `run-database.ts`, the answer's shape in `influxql-results.ts`, the catalog reads in `influxql-objects.ts`, the
 * monitoring mappings in `monitoring.ts`, the labels in `labels.ts` and every sentence of a failure in `errors.ts`.
 * What stays here is the lifecycle, the declarations, the connect sequence of spec 6.2, and each call's permit,
 * deadline and error context.
 *
 * On 1.x and 2.x the read policy is the only boundary before `DROP DATABASE`, so it runs on every text this provider
 * sends, its own catalog texts included (E6), and what it refuses sends nothing (E2). The generation `/ping` reports
 * decides only whether `_internal` is browsed; it never changes a verdict of the policy (E7).
 *
 * One limiter covers every client call (E16): the connect reads, the tree, monitoring and the runs, each taking one
 * permit of the engine key `influxdb` per request in flight. A run's signal carries its deadline (the connection's
 * query timeout) and its cancel (`createRunRegistry`); every other call carries one surface deadline, which all of
 * its reads share (R43). No `KILL QUERY` is ever sent: a cancel or a disconnect drops the socket, which stops the
 * server's work (spec 5.6).
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  type ContainerPathShapeEngine,
  callerBoundTruncationReason,
  findKind,
  type ObjectPathShapeEngine,
} from "@/lib/db/object-kinds";
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
  ObjectKindSpec,
  PerformanceMetrics,
  PreparedQuery,
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
} from "./client";
import {
  buildInfluxConnectionOptions,
  INFLUX_CELL_BUDGET,
  INFLUX_LIMITER_OPTIONS,
  INFLUX_LIST_CAP,
  INFLUX_ROW_CUT,
  type InfluxConnectionOptions,
  type InfluxShapeLimits,
  type InfluxType,
  INFLUXDB_DEFAULT_PORT,
} from "./connection-options";
import { InfluxAnswerError, InfluxAnswerShapeError, type InfluxErrorContext, toInfluxError } from "./errors";
import { lexInfluxql } from "./influxql-lexer";
import {
  countInfluxqlMeasurements,
  describeInfluxqlMeasurement,
  INFLUX_CONTAINER_LEVELS,
  INFLUXQL_OBJECT_KINDS,
  type InfluxqlCatalogContext,
  listInfluxqlMeasurements,
  readInfluxqlDatabaseListing,
  readInfluxqlDatabases,
} from "./influxql-objects";
import { evaluateInfluxql, INFLUXQL_MAX_TEXT_BYTES, INFLUXQL_POLICY_SENTENCES } from "./influxql-policy";
import { InfluxqlQuoteError } from "./influxql-quote";
import { shapeInfluxqlBody } from "./influxql-results";
import { INFLUXQL_LABELS } from "./labels";
import { toInfluxHealth, toInfluxOverview } from "./monitoring";
import { INFLUXQL_ROUTES, type InfluxqlRouteId } from "./routes";
import { resolveRunDatabase } from "./run-database";
import {
  GENERATION_TRAITS,
  type InfluxGeneration,
  type InfluxServerVersion,
  pingNeedsHealth,
  readPing,
} from "./versions";

const INFLUXDB: InfluxType = "influxdb";

const influxdbLimiter = engineLimiter("influxdb", INFLUX_LIMITER_OPTIONS);

/** A run's bounds (spec 5.5): the row cut and the cell budget, reported on `pagination.wasLimited`. */
const SHAPE_LIMITS: InfluxShapeLimits = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET };

const NO_HOST = "An InfluxDB connection needs a host.";
const NO_MAINTENANCE =
  "InfluxDB has no maintenance operation in Studio, and the connection is read-only, so nothing was sent.";
/** What `describeObjects` says when the listing it describes stopped at its cap. */
const LISTING_CAP_REASON = "the measurement listing reads at most 2,000 measurements";
/**
 * The statuses with which the server refuses a read (spec 7: "a read the server refuses yields its empty answer"),
 * as the error table reads them: a credential it does not accept, one without the grant, and a route it does not serve.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
/** What a timeout says while a call waits for a permit, in the shared transport's words. */
const WAIT_TIMEOUT = "The request did not finish within its time limit";

/**
 * The statements that read no database, as their leading keywords: `SHOW DATABASES` (spec 5.8) and the server-wide
 * `SHOW` forms R44 names, each of which 1.13.1 answered as admin with no `db` (measured live, E1B-fix).
 */
const SERVER_WIDE_STATEMENTS: readonly (readonly string[])[] = [
  ["SHOW", "DATABASES"],
  ["SHOW", "USERS"],
  ["SHOW", "GRANTS", "FOR"],
  ["SHOW", "QUERIES"],
  ["SHOW", "STATS"],
  ["SHOW", "DIAGNOSTICS"],
  ["SHOW", "SHARDS"],
  ["SHOW", "SHARD", "GROUPS"],
  ["SHOW", "SUBSCRIPTIONS"],
  ["SHOW", "CONTINUOUS", "QUERIES"],
];
const SERVER_WIDE_WORDS = Math.max(...SERVER_WIDE_STATEMENTS.map((statement) => statement.length));
const INSIGNIFICANT: ReadonlySet<string> = new Set(["whitespace", "line-comment", "block-comment"]);

const CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: INFLUXDB,
  label: "An InfluxDB",
  shapeNames: "label",
};

const OBJECT_PATH_ENGINE: ObjectPathShapeEngine = {
  code: INFLUXDB,
  label: "An InfluxDB",
  attachedSegment: "required",
};

/** False exactly for a server-wide statement, which is sent with no `db` (spec 5.8, R44); read from its tokens. */
function needsDatabase(text: string): boolean {
  const words = lexInfluxql(text)
    .filter((token) => !INSIGNIFICANT.has(token.kind))
    .slice(0, SERVER_WIDE_WORDS);
  return !SERVER_WIDE_STATEMENTS.some((statement) =>
    statement.every((word, index) => words[index]?.kind === "keyword" && words[index].value === word),
  );
}

/** A permit wait the deadline ended rejects with the signal's own reason; worded as the transport words a timeout. */
function waitFailure(error: unknown): unknown {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? new TransportError("timeout", WAIT_TIMEOUT)
    : error;
}

/** A refusal in spec 7's sense: a refusal status, or a statement the server answered with its error. */
function isRefusal(error: unknown): boolean {
  if (error instanceof InfluxAnswerError) return REFUSAL_STATUSES.has(error.answer.status);
  return error instanceof InfluxAnswerShapeError && error.fault === "statement-error";
}

/** The one client of a connected provider and what it learned while connecting. */
interface InfluxqlSession {
  readonly client: InfluxClient<InfluxqlRouteId>;
  readonly options: InfluxConnectionOptions;
  readonly version: InfluxServerVersion;
  /** The databases `SHOW DATABASES` listed at connect, `_internal` left out where the generation hides it, capped. */
  readonly visible: readonly string[];
  /** The listing held more than `INFLUX_LIST_CAP` databases, so a count over `visible` is a floor (R43). */
  readonly visibleCut: boolean;
}

export class InfluxDBProvider extends BaseDatabaseProvider {
  private session: InfluxqlSession | null = null;
  private readonly limiter: ProviderLimiter = influxdbLimiter();
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

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision (spec 6.3). */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "influxql",
      supportsExplain: false,
      // InfluxQL's LIMIT acts per series, so the shared limiter's LIMIT would not bound a result (I19).
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      // `prepareQuery` applies no offset, so there is no page two.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      // A measurement is addressable by its name.
      tablesAreDerivedGroupings: false,
      // On 1.x and 2.x the read policy is the boundary (I8).
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      // `http://` and `https://` already parse as ClickHouse; Host takes the URI.
      supportsConnectionString: false,
      defaultPort: INFLUXDB_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: INFLUX_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: INFLUXQL_OBJECT_KINDS,
      // No statement Studio runs changes the catalog, so the pattern matches nothing.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...INFLUXQL_LABELS };
  }

  /**
   * The text carries its own bounds (I19): nothing is added, whatever limit or offset the caller asked for, and there
   * is no page two. The base's answer with no options is that, at the default limit; `query-limiter.ts` is not a module
   * this layer imports (contract section 1), and the unit test holds the limit equal to `DEFAULT_QUERY_LIMIT`.
   */
  public override prepareQuery(query: string): PreparedQuery {
    return super.prepareQuery(query);
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
   * After the options' checks, `/ping` (and `/health` when `/ping` names no version) for the generation, then the
   * authenticated read `SHOW DATABASES`, whose listing is cached for the run database's only-visible step. All three
   * share the surface deadline; a failure closes the client and is worded with the phase `connect`.
   */
  public async connect(): Promise<void> {
    let options: InfluxConnectionOptions | undefined;
    let client: InfluxClient<InfluxqlRouteId> | undefined;
    let generation: InfluxGeneration = "unknown";
    try {
      this.validate();
      options = buildInfluxConnectionOptions(this.config, { type: INFLUXDB, queryTimeout: this.queryTimeout });
      const opened = this.createClient(options, INFLUXQL_ROUTES);
      client = opened;
      const signal = AbortSignal.timeout(options.surfaceTimeoutMs);
      const ping = await this.send(opened, { route: "ping", values: {} }, signal);
      if (ping.status !== 200 && ping.status !== 204) throw new InfluxAnswerError(ping, INFLUXQL_ROUTES.ping.path);
      const health = pingNeedsHealth(ping)
        ? await this.send(opened, { route: "health", values: {} }, signal)
        : undefined;
      const version = readPing(ping, health);
      generation = version.generation;
      const listing = await readInfluxqlDatabaseListing(
        { send: (request, read) => this.send(opened, request, read), signal: () => signal, generation },
        options.database,
      );
      const previous = this.session;
      this.session = {
        client: opened,
        options,
        version,
        visible: listing.containers.map((container) => container.name),
        visibleCut: listing.cut,
      };
      // A second connect replaces the session; the first one's client is closed, not left open.
      previous?.client.close();
    } catch (error) {
      client?.close();
      const failure =
        options === undefined
          ? (error as Error)
          : this.failure(error, this.errorContext(options, "connect", generation));
      this.setError(failure);
      throw failure;
    }
    this.setConnected(true);
  }

  /** Closes the client, which stops every request in flight (spec 5.6). */
  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    session?.client.close();
  }

  private requireSession(): InfluxqlSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session!;
  }

  /** One request under its own limiter permit, released when it settles. */
  private async send(
    client: InfluxClient<InfluxqlRouteId>,
    request: InfluxRequest<InfluxqlRouteId>,
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
      type: INFLUXDB,
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

  /**
   * A failure in the error table's words. The quoter's refusal extends plain `Error`, which errors.ts may not import
   * (seam rule 3) and would word as unrecognised, so it is the statement refusal it is, here.
   */
  private failure(error: unknown, context: InfluxErrorContext): Error {
    if (error instanceof InfluxqlQuoteError) return new QueryError(error.message, this.type);
    return toInfluxError(error, context);
  }

  // ==========================================================================
  // Query path (spec 5.1)
  // ==========================================================================

  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // A bound parameter can supply a regex the policy never read (J1 2); an empty list binds nothing.
    if (params !== undefined && params.length > 0) {
      throw new QueryError(INFLUXQL_POLICY_SENTENCES.boundParameter, this.type);
    }
    const session = this.requireSession();
    const { options, version } = session;
    // Counted before the text is lexed (E10); the policy applies the same count, so the browser agrees.
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > INFLUXQL_MAX_TEXT_BYTES) throw new QueryError(INFLUXQL_POLICY_SENTENCES.tooLong(bytes), this.type);
    const verdict = evaluateInfluxql(text);
    if (!verdict.allowed) throw new QueryError(verdict.message, this.type);
    const run = resolveRunDatabase({
      namedDatabases: verdict.namedDatabases,
      needsDatabase: needsDatabase(text),
      connection: options.database,
      visible: session.visible,
      internalDatabase: GENERATION_TRAITS[version.generation].internalDatabase,
    });
    if ("refused" in run) throw new QueryError(run.refused, this.type);
    const values: Readonly<Record<string, string>> =
      run.database === undefined ? { q: text } : { q: text, db: run.database };
    const context = this.errorContext(options, "query", version.generation, run.database, options.callTimeoutMs);
    const handle = this.runs.begin(queryId, AbortSignal.timeout(options.callTimeoutMs));
    try {
      const { result: answer, executionTime } = await this.trackQuery(() =>
        this.measureExecution(() => this.send(session.client, { route: "query", values }, handle.signal)),
      );
      if (answer.status !== 200) throw new InfluxAnswerError(answer, INFLUXQL_ROUTES.query.path);
      const shaped = shapeInfluxqlBody(answer.text, SHAPE_LIMITS);
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
      throw this.failure(error, context);
    } finally {
      handle.end();
    }
  }

  /** Aborts a running or waiting run by its id and answers true; an unknown id answers false (spec 5.6). */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface (spec 4), answered by influxql-objects.ts
  // ==========================================================================

  /**
   * One surface call: every read of the call under the call's one surface deadline (R43), so a listing of many
   * databases or measurements cannot stretch it read by read; each read has its own permit; the failure is worded.
   */
  private async surface<T>(read: (context: InfluxqlCatalogContext) => Promise<T>): Promise<T> {
    const session = this.requireSession();
    const { client, options, version } = session;
    const deadline = AbortSignal.timeout(options.surfaceTimeoutMs);
    try {
      return await read({
        send: (request, signal) => this.send(client, request, signal),
        signal: () => deadline,
        generation: version.generation,
      });
    } catch (error) {
      throw this.failure(error, this.errorContext(options, "surface", version.generation));
    }
  }

  /** The one database a container path names, refused unless it is `[database]` (the Cassandra declaration). */
  private containerDatabase(container: readonly string[]): string {
    assertContainerPathShape(this.getCapabilities(), container, CONTAINER_PATH_ENGINE);
    return container[0];
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`InfluxDB declares no object kind "${kind}"`, this.type);
    return spec;
  }

  /** The databases the credential lists; the connection's database marks `isSessionDefault` and filters nothing. */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const session = this.requireSession();
    if (parent !== undefined && parent.length > 0) return [];
    return this.surface((context) => readInfluxqlDatabases(context, session.options.database));
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const database = this.containerDatabase(container);
    return this.surface((context) => countInfluxqlMeasurements(context, database));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.requireKind(kind);
    const database = this.containerDatabase(container);
    return this.surface((context) => listInfluxqlMeasurements(context, database));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    assertObjectPathShape(this.getCapabilities(), this.requireKind(kind), kind, path, OBJECT_PATH_ENGINE);
    return this.surface((context) => describeInfluxqlMeasurement(context, path[0], path[1]));
  }

  /**
   * InfluxQL has no read that describes every measurement at once, so this is the bounded fallback the Qdrant
   * provider set: one listing, then two key reads per measurement, one after another. A caller's `limit` and the
   * listing's own cap are each reported on `truncated`.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.requireKind(kind);
    const database = this.containerDatabase(container);
    return this.surface(async (context) => {
      const objects = await listInfluxqlMeasurements(context, database);
      // Read before the key reads: the listing trims its `LIMIT 2001` read to 2,000, so a full listing is asked again.
      const listingCut = objects.length === INFLUX_LIST_CAP && (await this.listingWasCut(context, database));
      const callerCut = limit !== undefined && objects.length > limit;
      const described = callerCut ? objects.slice(0, limit) : objects;
      const details: ObjectDetail[] = [];
      for (const object of described) {
        // oxlint-disable-next-line no-await-in-loop -- one measurement at a time keeps one call's reads to one permit.
        details.push(await describeInfluxqlMeasurement(context, database, object.name));
      }
      if (callerCut) return { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } };
      if (listingCut) {
        return { details, truncated: { limit: INFLUX_LIST_CAP, reason: LISTING_CAP_REASON } };
      }
      return { details };
    });
  }

  /** Whether `database` holds more than `INFLUX_LIST_CAP` measurements, from the count read's floor. */
  private async listingWasCut(context: InfluxqlCatalogContext, database: string): Promise<boolean> {
    const count = (await countInfluxqlMeasurements(context, database)).measurement;
    return "sampledFrom" in count;
  }

  // ==========================================================================
  // Monitoring (spec 7), mapped by monitoring.ts
  // ==========================================================================

  /** `GET /ping`: reachability only, never evidence of what the credential may read; a non-refusal failure throws. */
  public async getHealth(): Promise<HealthInfo> {
    const session = this.requireSession();
    const { client, options, version } = session;
    try {
      const ping = await this.send(
        client,
        { route: "ping", values: {} },
        AbortSignal.timeout(options.surfaceTimeoutMs),
      );
      // Any 2xx is reachability, and so is a refusal (spec 7); a 5xx is a server that answers but does not work.
      const failed = (ping.status < 200 || ping.status > 299) && !REFUSAL_STATUSES.has(ping.status);
      if (failed) throw new InfluxAnswerError(ping, INFLUXQL_ROUTES.ping.path);
    } catch (error) {
      throw this.failure(error, this.errorContext(options, "surface", version.generation));
    }
    return toInfluxHealth();
  }

  /**
   * The version and the measurements of every database listed at connect (R24), each listing capped, and a floor
   * when the database listing itself was capped (R43); all under the call's one deadline. A database
   * whose listing the server refuses (a 401, 403 or 404, or a statement error) counts none, never a throw (spec 7);
   * any other failure, a 5xx or a lexer disagreement (C5) among them, is thrown, worded.
   */
  public async getOverview(): Promise<DatabaseOverview> {
    const session = this.requireSession();
    return this.surface(async (context) => {
      let objectCount = 0;
      let objectCountCut = session.visibleCut;
      for (const database of session.visible) {
        let count: KindCount;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one database at a time keeps one call's reads to one permit.
          count = (await countInfluxqlMeasurements(context, database)).measurement;
        } catch (error) {
          if (isRefusal(error)) continue;
          throw error;
        }
        // A count the reader could not give makes the total a floor, as a cut does.
        objectCount += "count" in count ? count.count : 0;
        objectCountCut ||= !("count" in count) || "sampledFrom" in count;
      }
      return toInfluxOverview({ version: session.version, objectCount, objectCountCut, objects: "measurements" });
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

  /** Empty: a measurement has no index object to describe. */
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
