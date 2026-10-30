/**
 * Qdrant provider (vector-family spec 6). Read-only REST access to a Qdrant server: its collections in the tree with
 * their vectors, payload indexes and sampled payload keys, a closed console of 17 read routes in the editor, and
 * the overview, Tables and index panels.
 *
 * COMPOSITION AND DELEGATION ONLY (spec 3.13). The wire lives in `rest-client.ts`, the connection rules in
 * `connection-options.ts`, the version in `versions.ts`, the error table in `errors.ts`, a console request's run in
 * `execute.ts`, the object surface and the Source in `objects.ts`, `schema.ts`, `sample.ts` and `source.ts`, the
 * monitoring reads in `monitoring-reads.ts` and `monitoring.ts`, and the labels in `labels.ts`. What stays here is
 * the lifecycle, the declarations, the connect sequence of spec 6.2, and each surface call's permit, deadline and
 * error context.
 *
 * One limiter covers every client call (spec 3.6): the two connect requests, the tree, the Source, monitoring and
 * the console. A surface takes one permit per read it has in flight; a console request takes its own in
 * `execute.ts`. No transaction method and no maintenance operation: each is detected by presence, and none exists
 * for Qdrant in this version. `queryReadOnly` is the agent read-only profile's path: the rules of an agent request
 * are in `metadata-request.ts`, the read-only proof, the metadata-only projection and the wording of a failure in
 * `metadata-read.ts`.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import {
  DatabaseConfigError,
  ExecutionProfileError,
  QueryError,
  RefusedBeforeSendError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
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
  ObjectSourceDocument,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
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
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type {
  QdrantAnswer,
  QdrantClient,
  QdrantOp,
  QdrantProbe,
  QdrantRequest,
  QdrantRouteTemplate,
  QdrantRouteTemplates,
  QdrantSend,
} from "./client";
import {
  buildQdrantConnectionOptions,
  QDRANT_DEFAULT_PORT,
  QDRANT_MAX_IN_FLIGHT,
  type QdrantConnectionOptions,
} from "./connection-options";
import { answerFailure, expectOk, type QdrantErrorContext, toProviderError } from "./errors";
import { executeQdrant, type QdrantFailure, qdrantDeadlineMs } from "./execute";
import { QDRANT_LABELS } from "./labels";
import {
  keylessAgentRefusal,
  proveQdrantReadOnly,
  QDRANT_METADATA_ONLY,
  type QdrantProofWire,
  qdrantAgentFailure,
  shapeQdrantAgentAnswer,
} from "./metadata-read";
import { readQdrantAgentStatement } from "./metadata-request";
import { readQdrantHealth, readQdrantIndexStats, readQdrantOverview, readQdrantTableStats } from "./monitoring-reads";
import {
  countQdrantObjects,
  describeQdrantObject,
  describeQdrantObjects,
  listQdrantObjects,
  QDRANT_OBJECT_KINDS,
  QDRANT_SURFACE_TIMEOUT_MS,
  type QdrantSurfaceContext,
  readQdrantConsoleFacts,
  readQdrantObjectSource,
} from "./objects";
import { createRestQdrantClient } from "./rest-client";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "./routes";
import { type QdrantVersion, readQdrantVersion, versionGateRefusal } from "./versions";

/** The in-flight bounds of spec 6.6: four per provider, the transport's sockets, sixteen per process, a queue of 64. */
export const QDRANT_LIMITER_OPTIONS = { perProvider: QDRANT_MAX_IN_FLIGHT, perEngine: 16, queueDepth: 64 } as const;

const qdrantLimiter = engineLimiter("qdrant", QDRANT_LIMITER_OPTIONS);

/**
 * The route table as the client takes it (part A's seam): each route's method, its path under the dialect's `/`
 * prefix, and its query keys, so the client builds exactly the paths the console parses.
 */
function routeTemplates(): QdrantRouteTemplates {
  const templates: Partial<Record<QdrantOp, QdrantRouteTemplate>> = {};
  for (const route of QDRANT_ROUTES) {
    templates[route.op] = {
      method: route.method as QdrantRouteTemplate["method"],
      path: `${QDRANT_CONSOLE.pathPrefix}${route.template}`,
      query: Object.keys(route.query),
    };
  }
  return templates as QdrantRouteTemplates;
}

export const QDRANT_ROUTE_TEMPLATES: QdrantRouteTemplates = routeTemplates();

/** What builds the provider's one client: `createRestQdrantClient` by default, a recording client in a test. */
export type QdrantClientFactory = (options: QdrantConnectionOptions, routes: QdrantRouteTemplates) => QdrantClient;

const BOUND_PARAMS_MESSAGE = "Bound params are not supported: a Qdrant request has no placeholders";
const NO_MAINTENANCE = "Qdrant has no maintenance operation in this version of Studio, so nothing was sent.";
const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const NO_ESTIMATE = "Qdrant composes no estimating plan for the agent";

/** A connection is one flat namespace of collections (spec 6.3), so every object is addressed at the root. */
function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) {
    throw new QueryError(`A Qdrant connection has no container level; received ${JSON.stringify(container)}`, "qdrant");
  }
}

/** What errors.ts needs to word a failure of one request. */
function errorContext(
  options: QdrantConnectionOptions,
  phase: QdrantErrorContext["phase"],
  op: QdrantOp,
  timeoutMs: number,
): QdrantErrorContext {
  return {
    phase,
    op,
    endpoint: options.endpoint,
    responseCapBytes: options.responseCapBytes,
    timeoutMs,
    secretForms: options.secretForms,
  };
}

/** The one client of a connected provider and what it learned while connecting. */
interface QdrantSession {
  readonly client: QdrantClient;
  readonly options: QdrantConnectionOptions;
  readonly version: QdrantVersion;
}

export class QdrantProvider extends BaseDatabaseProvider {
  private session: QdrantSession | null = null;
  private readonly limiter: ProviderLimiter = qdrantLimiter();
  private readonly runs: RunRegistry = createRunRegistry();

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `connect()` refuse a connection with no key and prove the key reads only, and
   * only then does `queryReadOnly` answer. The operations profile's acquisitions send no statement, so they open
   * unproved, as an editor connection does, and plan mode keeps grounding on any key.
   */
  private readonly readOnlyProfile: boolean;

  /**
   * Validates nothing and opens nothing (spec 3.13): the connection's rules run in `connect()`, before the factory,
   * so a provider built only for its declarations touches no socket.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly createClient: QdrantClientFactory = createRestQdrantClient,
  ) {
    super(config, options);
    this.readOnlyProfile = execution.readOnly === true && execution.sendsStatements === true;
  }

  // ==========================================================================
  // Declarations (spec 6.7)
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision (spec 6.7). */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A `METHOD /path` line and one JSON body; "json" means only "not SQL", and the dialect says which JSON.
      queryLanguage: "json",
      queryDialect: "qdrant",
      supportsExplain: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      statementTerminator: "none",
      defaultPort: QDRANT_DEFAULT_PORT,
      containerLevels: [],
      objectKinds: QDRANT_OBJECT_KINDS,
      enforcesReadOnly: true,
      // The secret alone signs in, so the agent's own key is `agentPassword` alone; a user is refused here as it is
      // on the connection.
      agentCredential: "token",
      // Payloads and vectors are stored values: the agent's answers carry names, counts and flags.
      metadataOnly: QDRANT_METADATA_ONLY,
      // A Qdrant request changes no collection, so no request refreshes the schema.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...QDRANT_LABELS };
  }

  /** The request carries its own bounds (spec 6.5): no limit is added, and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle (spec 6.2)
  // ==========================================================================

  /**
   * After connection-options.ts's checks, exactly two requests: `GET /` for the version the gates read, which
   * proves reachability only, then `GET /collections`, the authenticated read every credential may make. A 2xx
   * body of the second is dropped; nothing is retried, and a client that was built is closed on a failure.
   *
   * Opened for the agent read-only profile, a connection with no key is refused before any client is built, and after
   * those two reads the server is asked to refuse an empty alias update and an empty point delete on every collection
   * the key lists (`metadata-read.ts`).
   */
  public async connect(): Promise<void> {
    let client: QdrantClient | undefined;
    try {
      const options = buildQdrantConnectionOptions(this.config, {
        executionReadOnly: this.execution.readOnly === true,
        queryTimeout: this.queryTimeout,
      });
      if (this.readOnlyProfile && !Object.hasOwn(options.headers, "api-key")) throw keylessAgentRefusal();
      client = this.createClient(options, QDRANT_ROUTE_TEMPLATES);
      const send = this.sendFor(client, options, "connect");
      const signal = this.surfaceSignal();
      const root = await send({ op: "root", params: {}, query: {} }, signal);
      await send({ op: "get_collections", params: {}, query: {} }, signal);
      if (this.readOnlyProfile) await proveQdrantReadOnly(this.proofWire(client, options, "connect"), signal);
      this.session = { client, options, version: readQdrantVersion(root.text) };
    } catch (error) {
      client?.close();
      // Every failure above is an Error: the mapping throws DatabaseConfigError, and every request's failure is
      // worded by errors.ts, which answers an Error for any thrown value.
      this.setError(error as Error);
      throw error;
    }
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    session?.client.close();
  }

  private requireSession(): QdrantSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session!;
  }

  /** A surface call's deadline: 10 s, and never past the connection's query timeout (spec 6.6). */
  private surfaceSignal(): AbortSignal {
    return AbortSignal.timeout(Math.min(QDRANT_SURFACE_TIMEOUT_MS, this.queryTimeout));
  }

  /**
   * One read under its own limiter permit, released when the read settles; a failed request or a non-2xx answer
   * raised in errors.ts's words, with the phase that words a 403 (spec 6.2, 6.10).
   */
  private sendFor(
    client: QdrantClient,
    options: QdrantConnectionOptions,
    phase: QdrantErrorContext["phase"],
  ): QdrantSend<QdrantOp> {
    return async (request: QdrantRequest, signal: AbortSignal) => {
      const context = errorContext(options, phase, request.op, Math.min(QDRANT_SURFACE_TIMEOUT_MS, this.queryTimeout));
      let answer: Awaited<ReturnType<QdrantClient["send"]>>;
      try {
        const ticket = await this.limiter.acquire(signal);
        try {
          answer = await client.send(request, signal);
        } finally {
          ticket.release();
        }
      } catch (error) {
        throw toProviderError(error, context);
      }
      return expectOk(answer, context);
    };
  }

  /**
   * One request under its own limiter permit, answered whatever its status. A request still waiting when its deadline
   * fires is a TimeoutError, as a console request's is in `execute.ts`; any other failure is worded by errors.ts.
   */
  private answered(
    options: QdrantConnectionOptions,
    phase: QdrantErrorContext["phase"],
    op: QdrantOp,
    signal: AbortSignal,
    sent: () => Promise<QdrantAnswer>,
  ): Promise<QdrantAnswer> {
    return (async () => {
      try {
        const ticket = await this.limiter.acquire(signal);
        try {
          return await sent();
        } finally {
          ticket.release();
        }
      } catch (error) {
        const unreachable = error instanceof TransportError && error.kind === "unreachable";
        if (signal.aborted && !unreachable) {
          throw new TimeoutError("The read-only proof did not finish within its deadline.", this.type);
        }
        throw toProviderError(
          error,
          errorContext(options, phase, op, Math.min(QDRANT_SURFACE_TIMEOUT_MS, this.queryTimeout)),
        );
      }
    })();
  }

  /**
   * What the read-only proof sends through `client`: its two probes and the collection list, each under a permit of
   * its own. A probe's failure is worded as the alias route's, the console route nearest to what it writes.
   */
  private proofWire(
    client: QdrantClient,
    options: QdrantConnectionOptions,
    phase: QdrantErrorContext["phase"],
  ): QdrantProofWire {
    return {
      probe: (probe: QdrantProbe, signal: AbortSignal) =>
        this.answered(options, phase, "get_collections_aliases", signal, () => client.probe(probe, signal)),
      listCollections: (signal: AbortSignal) =>
        this.answered(options, phase, "get_collections", signal, () =>
          client.send({ op: "get_collections", params: {}, query: {} }, signal),
        ),
    };
  }

  /** One surface call's reads, deadline and facts (spec 3.13). */
  private surface(): QdrantSurfaceContext<QdrantOp> {
    const session = this.requireSession();
    return {
      send: this.sendFor(session.client, session.options, "request"),
      signal: this.surfaceSignal(),
      sliceSupported: versionGateRefusal("slice", session.version) === undefined,
      scoped: session.options.secretForms.length > 0,
    };
  }

  // ==========================================================================
  // Query path (spec 6.4 to 6.6), answered by execute.ts
  // ==========================================================================

  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // A Qdrant request has no binding, and dropping the values would run another request than the one the caller
    // built. An empty list binds nothing and is not a refusal.
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(BOUND_PARAMS_MESSAGE, this.type);
    const session = this.requireSession();
    const { client, options } = session;
    return executeQdrant(text, queryId, {
      send: (request, signal) => client.send(request, signal),
      limiter: this.limiter,
      runs: this.runs,
      version: session.version.reported,
      factsOf: readQdrantConsoleFacts,
      // The request's own deadline words a timeout, as execute.ts set it for the operation (spec 6.6).
      fail: (failure: QdrantFailure) => {
        const context = errorContext(options, "request", failure.op, qdrantDeadlineMs(failure.op, this.queryTimeout));
        if (failure.kind === "answer") return toProviderError(answerFailure(failure.answer), context);
        return toProviderError(
          failure.error,
          failure.body === undefined ? context : { ...context, requestBody: failure.body },
        );
      },
      queryTimeoutMs: this.queryTimeout,
    });
  }

  /**
   * One agent request. Only on a handle opened under the agent read-only profile; the request is read by
   * `readQdrantAgentStatement` and refused before anything is sent when it is not a metadata read. Then, under the
   * request's own deadline, the server is asked again to refuse the proof's no-op writes, with no verdict kept from the
   * open or the request before, and the request runs as the console runs it. Its answer is the metadata-only projection
   * of its route, refused past the row or byte budget rather than cut, and a server refusal is worded without the
   * server's words.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    const session = this.requireSession();
    if (!this.readOnlyProfile) throw new RefusedBeforeSendError(PROFILE_REQUIRED, this.type, statement);
    assertReadOnlyBudget(budget, "qdrant");
    if (mode !== "execute") throw new RefusedBeforeSendError(NO_ESTIMATE, this.type, statement);
    const reading = readQdrantAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, this.type, statement);
    const { client, options } = session;
    const signal = AbortSignal.timeout(budget.statementTimeoutMs);
    return this.trackQuery(async () => {
      try {
        await proveQdrantReadOnly(this.proofWire(client, options, "request"), signal);
        return await executeQdrant(statement, undefined, {
          send: (request, read) => client.send(request, read),
          limiter: this.limiter,
          runs: this.runs,
          version: session.version.reported,
          factsOf: readQdrantConsoleFacts,
          // Worded in qdrantAgentFailure below, never by the server's own text.
          fail: (failure: QdrantFailure) =>
            (failure.kind === "answer" ? answerFailure(failure.answer) : failure.error) as Error,
          queryTimeoutMs: budget.statementTimeoutMs,
          deadline: () => signal,
          answered: (answer) => shapeQdrantAgentAnswer(answer, budget, statement),
        });
      } catch (error) {
        if (error instanceof ExecutionProfileError) throw error;
        throw (
          qdrantAgentFailure(error, budget, statement) ??
          toProviderError(error, errorContext(options, "request", reading.plan.route.op, budget.statementTimeoutMs))
        );
      }
    });
  }

  /** Aborts a running or queued request by its id and answers true; an unknown id answers false (spec QE15). */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface (spec 6.3), answered by objects.ts
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    requireRoot(container);
    return countQdrantObjects(this.surface());
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    requireRoot(container);
    return listQdrantObjects(this.surface(), kind);
  }

  /** The description and the payload sample: two reads, one for a collection that reports no points. */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeQdrantObject(this.surface(), path, kind);
  }

  /** The bounded fallback of spec 6.3: one listing, then one description per collection, four in flight. */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    requireRoot(container);
    return describeQdrantObjects(this.surface(), kind, limit);
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return readQdrantObjectSource(this.surface(), path, kind, limit);
  }

  // ==========================================================================
  // Monitoring (spec 6.8), answered by monitoring-reads.ts
  // ==========================================================================

  /** `GET /`: reachability only, never evidence of the credential. */
  public async getHealth(): Promise<HealthInfo> {
    return readQdrantHealth(this.surface());
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return readQdrantOverview(this.surface());
  }

  /** One row per collection, the first 200, read when the panel opens. */
  public async getTableStats(): Promise<TableStats[]> {
    return readQdrantTableStats(this.surface());
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return readQdrantIndexStats(this.surface());
  }

  /** Every metric is optional, and Qdrant's read routes report none: an empty object is the honest answer. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: Studio never reads Qdrant's slow-request log. `getLabels().slowQueriesEmptyState` says why. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: Qdrant reports no client sessions. `getLabels().sessionsEmptyState` says so. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: no read route reports a size on disk. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Qdrant has no maintenance operation in this version (`supportsMaintenance` false): refused with no request. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(NO_MAINTENANCE, this.type);
  }
}
