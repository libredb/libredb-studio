/**
 * Milvus provider (#424). A vector database read through a thin gRPC client of the repository's own: one database
 * level and its collections in the tree, each collection's columns, indexes and two-part Source, a console of Milvus
 * REST v2 requests that the provider lowers to typed gRPC calls, the Tables and index panels, and Load and Release
 * with their preview for an admin.
 *
 * COMPOSITION AND DELEGATION ONLY. The connection rules live in `connection-options.ts`, the wire in `grpc-client.ts`,
 * a console request's run in `execute.ts`, the object surface in `objects.ts` and `source.ts`, the monitoring reads in
 * `monitoring-reads.ts` and `monitoring.ts`, Load and Release in `maintenance.ts`, the read-only decision in
 * `write-policy.ts`, the labels in `labels.ts` and the error table in `errors.ts`. What stays here is the lifecycle,
 * the declarations, which client and context each surface receives, and the bounds every call shares: one limiter per
 * provider instance under the engine key "milvus" (4 calls in flight per provider, 16 per process, a queue of 64), one
 * run registry for `cancelQuery`, one load lock, and a deadline of 10 seconds for every call outside a console
 * request, capped by the connection's query timeout.
 *
 * The constructor validates nothing and opens nothing, because a provider is also built only for its declarations;
 * `connect()` maps the connection, builds the one client through the injected factory, and reads GetVersion, which
 * authenticates and tells which features the server has, and nothing else. Nothing here loads a collection except
 * `runMaintenance("load")`.
 *
 * `queryReadOnly` is the agent read-only profile's path: the rules of an agent request are in `metadata-request.ts`,
 * the read-only proof the server answers in `read-only-proof.ts`, and the metadata-only projection and the wording of
 * a failure in `metadata-read.ts`. No `getPoolStats`, no transaction methods and no object edit: each is detected by
 * presence, and none would do its job here.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import {
  DatabaseConfigError,
  ExecutionProfileError,
  QueryCancelledError,
  QueryError,
  RefusedBeforeSendError,
} from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  type ContainerPathShapeEngine,
  findKind,
  requireSourceKind,
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
  MaintenanceOperation,
  MaintenancePreview,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
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
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import {
  createRunRegistry,
  engineLimiter,
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { MilvusClient, MilvusClientFactory } from "./client";
import {
  buildMilvusConnectionOptions,
  MILVUS_DEFAULT_PORT,
  type MilvusConnectionOptions,
  milvusErrorConnection,
} from "./connection-options";
import { type MilvusErrorConnection, toMilvusError, toProviderError } from "./errors";
import { executeMilvusConsole } from "./execute";
import { createGrpcMilvusClient } from "./grpc-client";
import { MILVUS_LABELS } from "./labels";
import {
  abortableSleep,
  MILVUS_MAINTENANCE_OPERATIONS,
  MILVUS_MAINTENANCE_SPECS,
  MilvusLoadLock,
  previewMilvusMaintenance,
  runMilvusMaintenance,
} from "./maintenance";
import { MILVUS_METADATA_ONLY, milvusAgentFailure, milvusAgentResult, readMilvusMetadata } from "./metadata-read";
import { readMilvusAgentStatement } from "./metadata-request";
import { readMilvusHealth, readMilvusIndexStats, readMilvusOverview, readMilvusTableStats } from "./monitoring-reads";
import {
  countMilvusCollections,
  describeMilvusCollection,
  describeMilvusCollections,
  listMilvusCollectionNames,
  listMilvusCollections,
  listMilvusDatabases,
  MILVUS_CONTAINER_LEVELS,
  MILVUS_OBJECT_KINDS,
  type MilvusSurfaceContext,
  readMilvusCollectionSource,
  surfaceCall,
} from "./objects";
import { milvusAgentUser, proveMilvusReadOnly } from "./read-only-proof";
import { type MilvusVersion, readMilvusVersion } from "./versions";

const BOUND_PARAMS_MESSAGE = "Bound params are not supported: a Milvus request has no placeholders";
const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const NO_ESTIMATE = "Milvus composes no estimating plan for the agent";

/** No request of the console changes the schema, so nothing refreshes the tree after a run. */
const MILVUS_SCHEMA_REFRESH_PATTERN = "(?!)";

/** The deadline of every call outside a console request: connect, the tree, the Source, monitoring and maintenance. */
const SURFACE_DEADLINE_MS = 10_000;

const MILVUS_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: "milvus",
  label: "A Milvus",
  shapeNames: "label",
};
const OBJECT_PATH = { code: "milvus", label: "A Milvus", attachedSegment: "required" } as const;
const ENGINE = { displayName: "Milvus", type: "milvus" } as const;

/**
 * The in-flight bounds of every Milvus provider in this process: 4 per provider, 16 across them, and a FIFO queue of
 * 64 whose wait counts inside each call's deadline. The engine key keeps them apart from every other engine's.
 */
const milvusLimiter = engineLimiter("milvus", { perProvider: 4, perEngine: 16, queueDepth: 64 });

/** The one client of a connected provider and what it learned while connecting. */
interface MilvusSession {
  readonly client: MilvusClient;
  readonly options: MilvusConnectionOptions;
  readonly errors: MilvusErrorConnection;
  /** GetVersion's answer at connect, which gates the features a server has. */
  readonly version: MilvusVersion;
  /** Aborted by `disconnect()`: it ends every call in flight, a wait for the load lock and the Load's poll. */
  readonly lifetime: AbortController;
}

export class MilvusProvider extends BaseDatabaseProvider {
  private session: MilvusSession | null = null;
  private readonly limiter: ProviderLimiter = milvusLimiter();
  private readonly runs: RunRegistry = createRunRegistry();
  private readonly loadLock = new MilvusLoadLock();

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `connect()` refuse a connection that names no user and prove the user reads
   * only, and only then does `queryReadOnly` answer. The operations profile's acquisitions send no statement, so they
   * open unproved, as an editor connection does, and plan mode keeps grounding on any user.
   */
  private readonly readOnlyProfile: boolean;

  /**
   * Validates nothing and opens nothing: the connection's rules run in `connect()`, before the factory, so a provider
   * built only for its declarations touches no socket. `execution` carries the read-only mode every agent profile
   * sets, and `createClient` is the seam tests inject a client through.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly createClient: MilvusClientFactory<MilvusConnectionOptions> = createGrpcMilvusClient,
  ) {
    super(config, options);
    this.readOnlyProfile = execution.readOnly === true && execution.sendsStatements === true;
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A Milvus REST v2 request: "json" means only "not SQL", and the dialect names the grammar.
      queryLanguage: "json",
      queryDialect: "milvus",
      supportsExplain: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: [...MILVUS_MAINTENANCE_OPERATIONS],
      maintenanceOperationSpecs: MILVUS_MAINTENANCE_SPECS,
      statementTerminator: "none",
      defaultPort: MILVUS_DEFAULT_PORT,
      containerLevels: MILVUS_CONTAINER_LEVELS,
      // One level, the database, and every address names it: the shape assertContainerPathShape checks (#1147).
      containerPathShapes: "exact",
      objectKinds: MILVUS_OBJECT_KINDS,
      enforcesReadOnly: true,
      // Scalar, vector and dynamic field values are stored values: the agent's answers carry names, counts and flags.
      metadataOnly: MILVUS_METADATA_ONLY,
      schemaRefreshPattern: MILVUS_SCHEMA_REFRESH_PATTERN,
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...MILVUS_LABELS };
  }

  /** A request carries its own bounds: no limit is added, and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  public async connect(): Promise<void> {
    let client: MilvusClient | undefined;
    const lifetime = new AbortController();
    try {
      // Refused before any client exists: the endpoint, the credential, the plaintext rule, the TLS panel, the seed.
      const options = buildMilvusConnectionOptions(this.config, {
        executionReadOnly: this.execution.readOnly === true,
        queryTimeout: this.queryTimeout,
      });
      // The agent read-only profile proves a user, so a connection that names none is refused before any client.
      const agentUser = this.readOnlyProfile ? milvusAgentUser(options.auth) : undefined;
      const errors = milvusErrorConnection(options);
      client = await this.createClient(options).catch((error: unknown) => {
        throw toProviderError(error, {
          operation: "connection",
          write: false,
          connection: errors,
          secretForms: options.secretForms,
        });
      });
      const opened = client;
      const context = this.contextOf(options, errors, lifetime.signal);
      // GetVersion authenticates and tells which features the server has; connect makes no other call.
      const answer = await surfaceCall(context, "connection", { database: options.database }, (call) =>
        opened.getVersion(call),
      );
      if (agentUser !== undefined) {
        await surfaceCall(context, "connection", { database: options.database }, (call) =>
          proveMilvusReadOnly(opened, agentUser, call),
        );
      }
      this.session = { client, options, errors, version: readMilvusVersion(answer), lifetime };
    } catch (error) {
      // A client that was built holds a channel, so a connect that fails after it closes it.
      client?.close();
      this.setError(error as Error);
      throw error;
    }
    this.setConnected(true);
  }

  /** Ends everything in flight, a waiting Load and the Load's poll, then closes the one channel. */
  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    if (session === null) return;
    session.lifetime.abort(new QueryCancelledError("The connection to Milvus was closed.", this.type));
    session.client.close();
  }

  /** What every call of a surface runs under: the provider's limiter and a deadline per call. */
  private contextOf(
    options: MilvusConnectionOptions,
    errors: MilvusErrorConnection,
    lifetime: AbortSignal,
  ): MilvusSurfaceContext {
    const deadline = Math.min(SURFACE_DEADLINE_MS, this.queryTimeout);
    return {
      database: options.database,
      limiter: this.limiter,
      signal: () => AbortSignal.any([AbortSignal.timeout(deadline), lifetime]),
      errors,
      secretForms: options.secretForms,
    };
  }

  /** The session and the context of one surface call. */
  private surface(): { readonly session: MilvusSession; readonly context: MilvusSurfaceContext } {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    const session = this.session!;
    return { session, context: this.contextOf(session.options, session.errors, session.lifetime.signal) };
  }

  private requireKind(kind: string): ObjectKindSpec {
    const spec = findKind(this.getCapabilities(), kind);
    if (spec === undefined) throw new QueryError(`Milvus declares no object kind "${kind}"`, this.type);
    return spec;
  }

  // ==========================================================================
  // Query path, answered by execute.ts
  // ==========================================================================

  /**
   * One console request. The text's bound, its grammar, the request rules, the fresh describe, the permit and the run
   * registry are execute.ts's; this passes the provider's own limiter and registry, so a console run and a panel
   * share one bound and `cancelQuery` reaches the run.
   */
  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // A request has no binding, and dropping the values would run another request than the one the caller built.
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(BOUND_PARAMS_MESSAGE, this.type);
    const { session } = this.surface();
    return executeMilvusConsole(session.client, text, queryId, {
      database: session.options.database,
      version: session.version,
      limiter: this.limiter,
      runs: this.runs,
      queryTimeoutMs: this.queryTimeout,
      lifetime: session.lifetime.signal,
      errors: session.errors,
      secretForms: session.options.secretForms,
      now: () => Date.now(),
    });
  }

  /**
   * One agent request. Only on a handle opened under the agent read-only profile; the request is read by
   * `readMilvusAgentStatement` in the connection's database and refused before anything is sent when it is not a
   * metadata read. Then, under one permit and the request's own deadline, the server is asked again to prove the user
   * reads only, with no verdict kept from the open or the request before, and the route's metadata is read. Its answer
   * is the metadata-only projection, refused past the row or byte budget rather than cut, and a server refusal is
   * worded without the server's words.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    const { session } = this.surface();
    if (!this.readOnlyProfile) throw new RefusedBeforeSendError(PROFILE_REQUIRED, this.type, statement);
    assertReadOnlyBudget(budget, "milvus");
    if (mode !== "execute") throw new RefusedBeforeSendError(NO_ESTIMATE, this.type, statement);
    const reading = readMilvusAgentStatement(statement, session.options.database);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, this.type, statement);
    // The open proved this user, so it names one.
    const user = milvusAgentUser(session.options.auth);
    const started = Date.now();
    return this.trackQuery(async () => {
      const signal = AbortSignal.any([AbortSignal.timeout(budget.statementTimeoutMs), session.lifetime.signal]);
      try {
        let ticket: LimiterTicket;
        try {
          ticket = await this.limiter.acquire(signal);
        } catch (error) {
          // A full queue is refused unchanged; a wait ended by the deadline or the close sent nothing.
          throw error instanceof LimiterFullError ? error : toMilvusError(error, signal);
        }
        try {
          const call = { db: session.options.database, signal };
          await proveMilvusReadOnly(session.client, user, call);
          const rows = await readMilvusMetadata(session.client, reading.plan, call);
          return milvusAgentResult(rows, budget, statement, Date.now() - started);
        } finally {
          ticket.release();
        }
      } catch (error) {
        if (error instanceof ExecutionProfileError || error instanceof QueryError) throw error;
        throw (
          milvusAgentFailure(error, budget, statement) ??
          toProviderError(error, {
            operation: `${reading.plan.op} request`,
            write: false,
            database: reading.plan.db,
            connection: { ...session.errors, timeoutMs: budget.statementTimeoutMs },
            secretForms: session.options.secretForms,
          })
        );
      }
    });
  }

  /** Stops a running or queued run by its id and answers true; an id that names no run answers false. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface, answered by objects.ts
  // ==========================================================================

  /** The databases; nothing nests under one, which answers with no call. */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const { session, context } = this.surface();
    if (parent !== undefined && parent.length > 0) return [];
    return listMilvusDatabases(session.client, context);
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    assertContainerPathShape(this.getCapabilities(), container, MILVUS_CONTAINER_PATH_ENGINE);
    const { session, context } = this.surface();
    return countMilvusCollections(session.client, context, container[0]);
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    assertContainerPathShape(this.getCapabilities(), container, MILVUS_CONTAINER_PATH_ENGINE);
    this.requireKind(kind);
    const { session, context } = this.surface();
    return listMilvusCollections(session.client, context, container[0]);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    assertObjectPathShape(this.getCapabilities(), this.requireKind(kind), kind, path, OBJECT_PATH);
    const { session, context } = this.surface();
    return describeMilvusCollection(session.client, context, path[0], path[1]);
  }

  /** One listing, then the bulk describe: fields only, the caller's limit applied before any describe call. */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    assertContainerPathShape(this.getCapabilities(), container, MILVUS_CONTAINER_PATH_ENGINE);
    this.requireKind(kind);
    const { session, context } = this.surface();
    const names = await listMilvusCollectionNames(session.client, context, container[0]);
    return describeMilvusCollections(session.client, context, container[0], names, limit);
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const spec = requireSourceKind(this.getCapabilities(), kind, ENGINE);
    assertObjectPathShape(this.getCapabilities(), spec, kind, path, OBJECT_PATH);
    const { session, context } = this.surface();
    return readMilvusCollectionSource(session.client, context, path[0], path[1], limit);
  }

  // ==========================================================================
  // Monitoring, answered by monitoring-reads.ts
  // ==========================================================================

  /** CheckHealth, which Test Connection reads after a good connect. */
  public async getHealth(): Promise<HealthInfo> {
    const { session, context } = this.surface();
    return readMilvusHealth(session.client, context);
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const { session, context } = this.surface();
    return readMilvusOverview(session.client, context, context.database, session.version);
  }

  /** The collections of the selected database, the connection's own when the panel names none. */
  public async getTableStats(options?: { schema?: string }): Promise<TableStats[]> {
    const { session, context } = this.surface();
    return readMilvusTableStats(session.client, context, options?.schema ?? context.database);
  }

  public async getIndexStats(options?: { schema?: string }): Promise<IndexStats[]> {
    const { session, context } = this.surface();
    return readMilvusIndexStats(session.client, context, options?.schema ?? context.database);
  }

  /** Every metric is optional, so an empty object is the honest answer: Milvus's API reports none here. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: Milvus keeps these on its management port, which Studio does not dial. The label says so in the panel. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty, for the same reason as the slow queries. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: no size is measured through this API, and an unmeasured figure is absent. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  // ==========================================================================
  // Maintenance, answered by maintenance.ts
  // ==========================================================================

  /** Load and Release for one collection: `target` is the collection and `container` its database. */
  public async runMaintenance(
    type: MaintenanceOperation,
    target?: string,
    container?: string,
  ): Promise<MaintenanceResult> {
    const { session, context } = this.surface();
    const { readOnly } = session.options;
    return runMilvusMaintenance(
      session.client,
      {
        ...context,
        ...(readOnly === undefined ? {} : { readOnly }),
        lock: this.loadLock,
        lifetime: session.lifetime.signal,
        now: () => Date.now(),
        sleep: abortableSleep,
      },
      type,
      target,
      container,
    );
  }

  /** What a Load or a Release will do, read calls only; refused, as the run is, on a read-only connection. */
  public async previewMaintenance(type: MaintenanceOperation, path: readonly string[]): Promise<MaintenancePreview> {
    const { session, context } = this.surface();
    const { readOnly } = session.options;
    return previewMilvusMaintenance(
      session.client,
      { ...context, ...(readOnly === undefined ? {} : { readOnly }) },
      type,
      path,
    );
  }

  /** The Milvus principal an audit row names: a user name (a `user:password` token's too) or the word "token", never any part of a secret. */
  public engineUser(): string | undefined {
    return this.session?.options.principal;
  }
}
