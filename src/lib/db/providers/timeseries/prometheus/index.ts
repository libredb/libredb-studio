/**
 * Prometheus provider (#1085): PromQL over the Prometheus HTTP API, with no driver of any kind.
 *
 * COMPOSITION AND DELEGATION ONLY (#1085 3.5). This file holds no wire format, no result shaping,
 * no PromQL building, no URL building of its own and no error table. Each method hands its work to
 * the module that owns it:
 *
 * - `src/lib/db/http/endpoint.ts` (#1086), shared with the other HTTP transports, validates the
 *   host and the port and builds each request URL; `sharedEndpoint` below only adapts it to the
 *   port `http-transport.ts` takes;
 * - `request.ts` sends the bytes: `fetch` for plaintext, `node:https` for TLS, redirects refused,
 *   a byte cap and a deadline on every request;
 * - `http-transport.ts` is the only module that knows the wire, and it validates the credential
 *   when it is built (#1085 S3), which is why `connect()` builds it before anything is sent;
 * - `results.ts` shapes a query's answer, `objects.ts` answers the object surface, `monitoring.ts`
 *   the monitoring surfaces, `errors.ts` turns any failure into this repository's error classes,
 *   and `concurrency.ts` holds the per-connection query slots (#1085 S6).
 *
 * What stays here is lifecycle: which transport a connection gets, the query slots every PromQL
 * evaluation it sends waits for (the editor's queries and the object surface's existence read
 * alike, #1085 S6), one `AbortController` for every query running or waiting for a slot, so that a
 * cancel or a disconnect reaches it, and the declarations (`getCapabilities`, `getLabels`,
 * `prepareQuery`).
 *
 * CANCELLATION (#1085 5.2, M1). Prometheus derives a query's evaluation context from its HTTP
 * request, and the live pass observed that aborting the request ends the evaluation on the server
 * (M1, recorded in `tests/fixtures/prometheus/README.md`), so `cancelQuery` keeps the promise its
 * name makes: it cancels the work, not only the wait for it. Both the cancel route and the query
 * route detect the method by presence, which is why it exists only because that measurement held.
 *
 * `getPoolStats` is absent: every call is one stateless request, and the pool-stats route answers
 * its own fallback for a provider that has none.
 */

import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
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
  MaintenanceType,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectSourceDocument,
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
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { createQueryLimiter, QUERY_CONCURRENCY_LIMIT, type QueryLimiter } from "./concurrency";
import { type ErrorContext, toDatabaseError } from "./errors";
import { createHttpTransport, type PrometheusEndpoint, RESPONSE_BYTE_CAP } from "./http-transport";
import { PROMETHEUS_SCHEMA_NAME, readHealth, readOverview, readStorageStats, readTableStats } from "./monitoring";
import { type ObjectsTransport, PROMETHEUS_OBJECT_KINDS, PrometheusObjects } from "./objects";
import { createSendRequest, type SendRequest, tlsMaterialFor } from "./request";
import { MATRIX_SAMPLE_BUDGET, RESULT_BYTE_BUDGET, type ShapeLimits, shapeQueryResult } from "./results";
import { type PrometheusQueryOptions, type PrometheusTransport, PrometheusTransportError } from "./transport";

/**
 * What the provider takes from outside, so a test drives the real composition with no network and
 * no global replaced (#1085 3.5, dependency inversion). Each one defaults to the real thing.
 */
export interface PrometheusProviderDeps {
  /**
   * Builds the endpoint from the connection. Default: the shared validated builder of
   * src/lib/db/http/endpoint.ts (#1086), adapted to this port; unit tests inject their own.
   */
  readonly endpoint?: (config: DatabaseConnection, secure: boolean) => PrometheusEndpoint;
  /** How a request leaves the process. Default: `createSendRequest(tlsMaterialFor(config.ssl))`. */
  readonly send?: SendRequest;
  /** The clock the inventory window is read against. Default: `Date.now`, read at each call. */
  readonly now?: () => number;
}

/** The port a stock server serves its HTTP API on, for either scheme (#1085 6.1). */
const PROMETHEUS_DEFAULT_PORT = 9090;

/** Every answer is shaped against the same three bounds (#1085 5.4). */
const SHAPE_LIMITS: ShapeLimits = {
  seriesLimit: DEFAULT_QUERY_LIMIT,
  sampleBudget: MATRIX_SAMPLE_BUDGET,
  byteBudget: RESULT_BYTE_BUDGET,
};

const EMPTY_EXPRESSION_MESSAGE =
  "The PromQL text holds no expression once its # comments and whitespace are removed, so nothing was sent to Prometheus.";
const BOUND_VALUES_MESSAGE = "PromQL has no parameter binding, so a statement with bound values cannot be sent.";
const CANCELLED_MESSAGE = "The query was cancelled.";
const DISCONNECTED_MESSAGE = "The connection was closed while the query was running or waiting to run.";

/**
 * Whether PromQL text holds anything once its comments and whitespace are removed (#1085 5.1).
 *
 * PromQL's only comment is a `#` running to the end of its line (`lexLineComment` in the v3.13.3
 * lexer, `promql/parser/lex.go`), so each line is cut at its first `#` and the text is empty when
 * every line is then blank. A `#` inside a string literal is cut too, and that can never make the
 * text blank: the literal's opening quote stands before it on the same line. So this refuses only a
 * text that holds no expression at all, and it never rewrites what is sent.
 */
function holdsExpression(text: string): boolean {
  return text.split(/\r\n|\r|\n/).some((line) => line.replace(/#.*$/, "").trim() !== "");
}

/**
 * The object surface's slice of the transport, with its one PromQL evaluation held to the
 * connection's query slots (#1085 S6).
 *
 * That evaluation is the existence read of a metric outside a capped listing,
 * `count(last_over_time(<selector>[1h]))` over the hour the listing covers (#1085 4.4), and it
 * takes one of the server's query slots as an editor query does, so it waits for one of this
 * connection's slots too. The other seven reads go to the label, series, metadata, rules,
 * scrape-pool and target endpoints, which evaluate no PromQL, so they take none.
 */
function withQuerySlots(transport: PrometheusTransport, limiter: QueryLimiter): ObjectsTransport {
  return {
    query: (expression, options) => limiter.run(() => transport.query(expression, options), options.signal),
    metricNames: (...args) => transport.metricNames(...args),
    labelNames: (...args) => transport.labelNames(...args),
    seriesLabels: (...args) => transport.seriesLabels(...args),
    metadata: (...args) => transport.metadata(...args),
    rules: (...args) => transport.rules(...args),
    scrapePools: (...args) => transport.scrapePools(...args),
    targets: (...args) => transport.targets(...args),
  };
}

/**
 * The endpoint every real connection uses: the shared validated builder the other HTTP transports
 * adopted in #1086, adapted to the narrow port `http-transport.ts` takes.
 *
 * `httpOrigin` runs once per connect, so a host or a port carrying URL syntax is refused with that
 * module's `DatabaseConfigError` in `connect()`, before any request is sent (#1085 S1), and
 * `endpointUrl` then builds each request URL and checks its hostname, port and path again before
 * handing it back. Nothing is validated here: a second copy of the rule is the drift the shared module exists
 * to end. The one adaptation is the return type, a `URL` where the shared builder answers a string.
 * The port falls back to the one this provider declares, for either scheme; no host is defaulted.
 */
function sharedEndpoint(config: DatabaseConnection, secure: boolean): PrometheusEndpoint {
  const origin = httpOrigin(secure ? "https" : "http", config.host, config.port ?? PROMETHEUS_DEFAULT_PORT);
  return { url: (pathname, query) => new URL(endpointUrl(origin, pathname, query)) };
}

export class PrometheusProvider extends BaseDatabaseProvider {
  private readonly deps: PrometheusProviderDeps;
  private readonly now: () => number;
  /** One connection's share of the server's query slots (#1085 S6): every PromQL evaluation it sends takes one. */
  private readonly limiter: QueryLimiter = createQueryLimiter(QUERY_CONCURRENCY_LIMIT);
  private transport: PrometheusTransport | null = null;
  private objects: PrometheusObjects | null = null;
  /** Every query running or waiting for a slot, so `disconnect()` reaches each one. */
  private readonly running = new Set<AbortController>();
  /** The same controllers under the caller's own name for the query, so `cancelQuery()` reaches one. */
  private readonly byQueryId = new Map<string, AbortController>();
  /** Aborted by `disconnect()`: the signal of the object surface's existence read, wherever that read is. */
  private lifetime: AbortController | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, deps: PrometheusProviderDeps = {}) {
    super(config, options);
    this.deps = deps;
    // An arrow rather than `Date.now` itself, so the clock is looked up at every call.
    this.now = deps.now ?? (() => Date.now());
    this.validate();
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      // Neither SQL nor JSON (#1085 3.2): PromQL, with no `queryDialect`, which tells kinds of
      // JSON apart and would say something false here.
      queryLanguage: "promql",
      // `/api/v1/parse_query` is experimental upstream, so no plan view is offered.
      supportsExplain: false,
      // The shared limiter writes `LIMIT n`, which is not PromQL. The series cap is this provider's
      // own: the query asks the endpoint for one series more than it, and the shaper enforces it on
      // the answer (#1085 5.4).
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      // Nothing this product offers writes to Prometheus (#1085 sections 2 and 4.5).
      supportsInlineRowEdit: false,
      // An instant query has no row offset to advance; `prepareQuery` below pins it to 0.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      // No maintenance operation runs here: compaction and statistics are the server's own, and the
      // admin API is never called. `maintenanceControl()` therefore places no control.
      supportsMaintenance: false,
      maintenanceOperations: [],
      // `http://` and `https://` already parse as ClickHouse (#1085 6.1).
      supportsConnectionString: false,
      defaultPort: PROMETHEUS_DEFAULT_PORT,
      // `;` is not PromQL, so the generators end nothing with one.
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: PROMETHEUS_OBJECT_KINDS,
      // The rule `SEARCH_SCHEMA_REFRESH_PATTERN` states for a read-only surface: name the statements
      // that can change what the tree shows. Here there are none, because the provider calls read
      // endpoints only and the metric catalogue moves with what the server scrapes, so the pattern
      // is an empty lookahead, which matches nothing, where a word could match a label value.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Metric",
      entityNamePlural: "Metrics",
      // Lower case, as every provider writes its row labels; the plural of "series" is itself.
      rowName: "series",
      rowNamePlural: "series",
      // The row click runs the metric's selector as an instant query (#1085 6.4).
      selectAction: "Run Instant Query",
      generateAction: "Generate Query",
      searchPlaceholder: "Search metrics or labels...",
      // Read by the agent's planning contract, which then asks for a statement "in PromQL".
      statementLanguage: "PromQL",
      // Both panels can only ever be empty here (#1085 6.2), and their default sentence would read
      // as "nothing is running right now".
      slowQueriesEmptyState: "Prometheus exposes no query log over its HTTP API, so there are no slow queries to read.",
      sessionsEmptyState:
        "Prometheus exposes no session list over its HTTP API: every request is a separate, stateless call.",
      // Never rendered while `supportsMaintenance` is false (`maintenanceControl()` gates every
      // placement on it first), and written true to the engine all the same.
      analyzeAction: "TSDB Statistics",
      vacuumAction: "Compact Blocks",
      analyzeGlobalLabel: "TSDB Statistics",
      analyzeGlobalTitle: "Statistics Are the Server's Own",
      analyzeGlobalDesc:
        "Prometheus maintains its TSDB statistics itself as samples are ingested, and its HTTP API offers no call that recomputes them. Nothing runs from here.",
      vacuumGlobalLabel: "Compact Blocks",
      vacuumGlobalTitle: "Compaction Is the Server's Own",
      vacuumGlobalDesc:
        "Prometheus compacts its TSDB blocks on its own schedule. Deleting series and cleaning tombstones are admin API calls this product never makes, so nothing runs from here.",
    };
  }

  /**
   * The statement untouched, bounded at this provider's own series cap, and never at an offset.
   *
   * The Redis shape: the shared limiter writes `LIMIT n`, which is not PromQL, and an instant query
   * has no row offset to advance, so `limit` reports the cap `query()` applies and `offset` is 0
   * whatever the caller asked for.
   */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  public override validate(): void {
    super.validate();
    // Named, and the value never echoed: which host is legal is the endpoint module's question (#1085 S1).
    if (!this.config.host) {
      throw new DatabaseConfigError("A Prometheus connection needs a host", this.type);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  public async connect(): Promise<void> {
    try {
      const tls = tlsMaterialFor(this.config.ssl);
      // Nothing is sent until both checks have passed: building the endpoint validates the host and
      // the port (#1085 S1), and building the transport validates the credential (#1085 S3), so a
      // value that cannot go into a URL or a header is refused here, before any request carries it.
      // The URL's scheme follows the same TLS answer as the sender, so an https URL never takes the
      // plaintext path.
      const transport = createHttpTransport(
        { user: this.config.user, password: this.config.password },
        {
          send: this.deps.send ?? createSendRequest(tls),
          endpoint: (this.deps.endpoint ?? sharedEndpoint)(this.config, tls !== null),
          requestTimeoutMs: this.queryTimeout,
          maxResponseBytes: RESPONSE_BYTE_CAP,
        },
      );
      // One read proves the server answers the API envelope at this address, with this credential.
      await transport.buildInfo();
      const lifetime = new AbortController();
      this.transport = transport;
      this.lifetime = lifetime;
      this.objects = new PrometheusObjects({
        transport: withQuerySlots(transport, this.limiter),
        now: this.now,
        capabilities: this.getCapabilities(),
        engine: { code: this.type, label: "A Prometheus", attachedSegment: "required" },
        // The existence read's bounds, and the connection's lifetime as its signal: a read still
        // waiting for a slot when the connection closes leaves the queue unsent, as a query does.
        queryOptions: () => ({
          timeoutMs: this.queryTimeout,
          seriesLimit: DEFAULT_QUERY_LIMIT,
          signal: lifetime.signal,
        }),
      });
      this.setConnected(true);
    } catch (error) {
      const failure = toDatabaseError(error, this.errorContext());
      this.logError("connect", failure);
      this.setError(failure);
      throw failure;
    }
  }

  public async disconnect(): Promise<void> {
    // Every query still running or waiting for a slot ends now, as a cancellation, rather than
    // answering into a provider that has let go of its connection. The lifetime goes first, so a
    // waiting existence read is out of the queue before the aborted queries free their slots.
    this.lifetime?.abort(new PrometheusTransportError("aborted", DISCONNECTED_MESSAGE));
    for (const controller of this.running) {
      controller.abort(new PrometheusTransportError("aborted", DISCONNECTED_MESSAGE));
    }
    this.lifetime = null;
    this.running.clear();
    this.byQueryId.clear();
    this.transport = null;
    this.objects = null;
    this.setConnected(false);
  }

  // ==========================================================================
  // Query path (#1085 5.1, 5.2, 5.4)
  // ==========================================================================

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    const transport = this.requireTransport();
    // PromQL has no binding, and dropping the values would run a different statement from the one
    // the caller built. An empty array binds nothing and is not a refusal.
    if (params !== undefined && params.length > 0) {
      throw new DatabaseConfigError(BOUND_VALUES_MESSAGE, this.type);
    }
    if (!holdsExpression(sql)) {
      throw new QueryError(EMPTY_EXPRESSION_MESSAGE, this.type, sql);
    }

    const controller = new AbortController();
    this.running.add(controller);
    if (queryId !== undefined) this.byQueryId.set(queryId, controller);
    const options: PrometheusQueryOptions = {
      timeoutMs: this.queryTimeout,
      seriesLimit: DEFAULT_QUERY_LIMIT,
      signal: controller.signal,
    };

    try {
      // The slot is held for the exchange alone, and the time is measured inside it, so a wait for
      // a slot is not reported as the engine's time.
      const { result: answer, executionTime } = await this.trackQuery(() =>
        this.limiter.run(() => this.measureExecution(() => transport.query(sql, options)), controller.signal),
      );
      const shaped = shapeQueryResult(answer, SHAPE_LIMITS);
      return {
        rows: shaped.rows,
        fields: shaped.fields,
        rowCount: shaped.rows.length,
        executionTime,
        // Absent, never empty, when the engine and the shaper reported nothing (QueryResult.warnings).
        ...(shaped.warnings.length === 0 ? {} : { warnings: shaped.warnings }),
        // #1085 5.4: a bound this provider applied is reported on the result's own `pagination`, and
        // `POST /api/db/query` carries its `wasLimited` into the response. The route reads that
        // field alone; the other four say what this answer is and advance nothing.
        ...(shaped.wasLimited
          ? {
              pagination: {
                limit: DEFAULT_QUERY_LIMIT,
                offset: 0,
                hasMore: false,
                totalReturned: shaped.rows.length,
                wasLimited: true,
              },
            }
          : {}),
      };
    } catch (error) {
      throw toDatabaseError(error, this.errorContext(sql));
    } finally {
      this.running.delete(controller);
      if (queryId !== undefined && this.byQueryId.get(queryId) === controller) this.byQueryId.delete(queryId);
    }
  }

  /**
   * Abort one query by the caller's own name for it, whether it is running or still waiting for a
   * slot; a waiting one leaves the queue without ever reaching the server. False when no query
   * carries the name, which is what the cancel route reports as nothing to cancel.
   */
  public cancelQuery(queryId: string): Promise<boolean> {
    const controller = this.byQueryId.get(queryId);
    if (controller === undefined) return Promise.resolve(false);
    controller.abort(new PrometheusTransportError("aborted", CANCELLED_MESSAGE));
    return Promise.resolve(true);
  }

  // ==========================================================================
  // Object surface (#1085 section 4), answered by `objects.ts`
  // ==========================================================================

  public listContainers(parent?: readonly string[]): Promise<Container[]> {
    return this.guarded(() => this.requireObjects().listContainers(parent));
  }

  public countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return this.guarded(() => this.requireObjects().countObjects(container));
  }

  public listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return this.guarded(() => this.requireObjects().listObjects(container, kind));
  }

  public describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return this.guarded(() => this.requireObjects().describeObject(path, kind));
  }

  public describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    return this.guarded(() => this.requireObjects().describeObjects(container, kind, limit));
  }

  public readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return this.guarded(() => this.requireObjects().readObjectSource(path, kind, limit));
  }

  // ==========================================================================
  // Monitoring (#1085 6.2), answered by `monitoring.ts`
  // ==========================================================================

  public getHealth(): Promise<HealthInfo> {
    return this.guarded(() => readHealth(this.requireTransport()));
  }

  public getOverview(): Promise<DatabaseOverview> {
    return this.guarded(() => readOverview(this.requireTransport(), (ms) => this.formatDuration(ms)));
  }

  /** No hit ratio or throughput is published as a number the API measures (#1085 6.2), so nothing is filled in. */
  public getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return Promise.resolve({});
  }

  /** Empty: the HTTP API returns no query log. `getLabels().slowQueriesEmptyState` says so in the panel. */
  public getSlowQueries(): Promise<SlowQueryStats[]> {
    return Promise.resolve([]);
  }

  /** Empty: the HTTP API publishes no session list. `getLabels().sessionsEmptyState` says so in the panel. */
  public getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return Promise.resolve([]);
  }

  /**
   * The metrics with the most series. A schema filter naming anything but `PROMETHEUS_SCHEMA_NAME`
   * is answered without a read, the search provider's rule: no metric is in a schema, so a named
   * one selects nothing, and a query that cannot match is slower and less obviously right.
   */
  public getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    if (options.schema !== undefined && options.schema !== PROMETHEUS_SCHEMA_NAME) return Promise.resolve([]);
    return this.guarded(() => readTableStats(this.requireTransport()));
  }

  /** Empty: a Prometheus TSDB has no secondary index object to describe. */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.resolve([]);
  }

  public getStorageStats(): Promise<StorageStats[]> {
    return this.guarded(() => readStorageStats(this.requireTransport()));
  }

  /**
   * Refused, as the search provider refuses it: `supportsMaintenance` is false, so no control asks,
   * and a direct call is told why rather than handed a result that did nothing.
   */
  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(
      `Prometheus has no maintenance operation this product runs, so "${type}" cannot run here. ` +
        "Compaction and statistics are the server's own, and the admin API that deletes series or cleans tombstones is never called.",
      this.type,
    );
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private requireTransport(): PrometheusTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared with setConnected(false), so a connected
    // provider always has one.
    return this.transport!;
  }

  private requireObjects(): PrometheusObjects {
    this.ensureConnected();
    return this.objects!;
  }

  /** One read of the connected server, whose failure surfaces as this repository's error class. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toDatabaseError(error, this.errorContext());
    }
  }

  private errorContext(query?: string): ErrorContext {
    return { provider: this.type, query, timeoutMs: this.queryTimeout, host: this.config.host, port: this.config.port };
  }
}
