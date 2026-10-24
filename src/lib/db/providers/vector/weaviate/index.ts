/**
 * Weaviate provider (#1566). Read-only REST access to a Weaviate server: its collections in the tree with their
 * properties and vectors, a closed console of 17 read routes in the editor whose searches run over REST or GraphQL
 * as the server's version decides, and the overview, Tables and index panels.
 *
 * COMPOSITION AND DELEGATION ONLY (spec 3.1). The wire lives in `rest-client.ts`, the connection rules in
 * `connection-options.ts`, the version and the path table in `versions.ts`, the error table in `errors.ts`, a
 * console request's run in `execute.ts`, the object surface and the Source in `objects.ts`, `schema.ts` and
 * `source.ts`, the monitoring reads in `monitoring-reads.ts` and `monitoring.ts`, and the labels in `labels.ts`.
 * What stays here is the lifecycle, the declarations, the connect read, and each surface call's permit, deadline
 * and error context.
 *
 * One limiter covers every client call. No `queryReadOnly`, no transaction method and no maintenance operation:
 * each is detected by presence, and none exists for Weaviate in this version.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
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
import type { QueryWarning } from "@/lib/types";
import type { WeaviateClient, WeaviateOp, WeaviateRequest, WeaviateRouteTemplates, WeaviateSend } from "./client";
import {
  buildWeaviateConnectionOptions,
  WEAVIATE_DEFAULT_PORT,
  WEAVIATE_MAX_IN_FLIGHT,
  type WeaviateConnectionOptions,
} from "./connection-options";
import { answerFailure, expectOk, graphqlFailure, toProviderError, type WeaviateErrorContext } from "./errors";
import { executeWeaviate, type WeaviateFailure, type WeaviatePathState } from "./execute";
import { WEAVIATE_LABELS } from "./labels";
import {
  readWeaviateHealth,
  readWeaviateIndexStats,
  readWeaviateOverview,
  readWeaviateTableStats,
} from "./monitoring-reads";
import {
  countWeaviateObjects,
  describeWeaviateObject,
  describeWeaviateObjects,
  listWeaviateObjects,
  readWeaviateObjectSource,
  WEAVIATE_OBJECT_KINDS,
  WEAVIATE_SURFACE_TIMEOUT_MS,
  type WeaviateSurfaceContext,
} from "./objects";
import { createRestWeaviateClient } from "./rest-client";
import { WEAVIATE_BOUNDS, WEAVIATE_CLIENT_ROUTES } from "./routes";
import {
  belowFloorWarning,
  readWeaviateVersion,
  type WeaviatePath,
  type WeaviatePathKind,
  type WeaviateVersion,
} from "./versions";

/** The in-flight bounds: four per provider, the transport's sockets, sixteen per process, a queue of 64. */
export const WEAVIATE_LIMITER_OPTIONS = { perProvider: WEAVIATE_MAX_IN_FLIGHT, perEngine: 16, queueDepth: 64 } as const;

const weaviateLimiter = engineLimiter("weaviate", WEAVIATE_LIMITER_OPTIONS);

/** The route table as the client takes it: each operation's method, path and query keys. */
export const WEAVIATE_ROUTE_TEMPLATES: WeaviateRouteTemplates = WEAVIATE_CLIENT_ROUTES;

/** What builds the provider's one client: `createRestWeaviateClient` by default, a recording client in a test. */
export type WeaviateClientFactory = (
  options: WeaviateConnectionOptions,
  routes: WeaviateRouteTemplates,
) => WeaviateClient;

const BOUND_PARAMS_MESSAGE = "Bound params are not supported: a Weaviate request has no placeholders";
const NO_MAINTENANCE = "Weaviate has no maintenance operation in this version of Studio, so nothing was sent.";

function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) {
    throw new QueryError(
      `A Weaviate connection has no container level; received ${JSON.stringify(container)}`,
      "weaviate",
    );
  }
}

function errorContext(
  options: WeaviateConnectionOptions,
  phase: WeaviateErrorContext["phase"],
  op: WeaviateOp,
  timeoutMs: number,
): WeaviateErrorContext {
  return {
    phase,
    op,
    endpoint: options.endpoint,
    responseCapBytes: options.responseCapBytes,
    timeoutMs,
    secretForms: options.secretForms,
  };
}

/** The session's memory of which path answered a search, per kind (spec 3.3); never stored with the connection. */
function pathState(): WeaviatePathState {
  const known = new Map<WeaviatePathKind, WeaviatePath>();
  return {
    get: (kind) => known.get(kind),
    set: (kind, path) => {
      known.set(kind, path);
    },
  };
}

interface WeaviateSession {
  readonly client: WeaviateClient;
  readonly options: WeaviateConnectionOptions;
  readonly version: WeaviateVersion;
  readonly paths: WeaviatePathState;
}

export class WeaviateProvider extends BaseDatabaseProvider {
  private session: WeaviateSession | null = null;
  private readonly limiter: ProviderLimiter = weaviateLimiter();
  private readonly runs: RunRegistry = createRunRegistry();

  /** Validates nothing and opens nothing: the connection's rules run in `connect()`, before the factory. */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly createClient: WeaviateClientFactory = createRestWeaviateClient,
  ) {
    super(config, options);
  }

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision (spec 6.2). */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A `METHOD /v1/path` line and one JSON body; "json" means only "not SQL", and the dialect says which JSON.
      queryLanguage: "json",
      queryDialect: "weaviate",
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
      defaultPort: WEAVIATE_DEFAULT_PORT,
      containerLevels: [],
      objectKinds: WEAVIATE_OBJECT_KINDS,
      enforcesReadOnly: true,
      // A Weaviate request changes no collection, so no request refreshes the schema.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...WEAVIATE_LABELS };
  }

  /** The request carries its own bounds: no limit is added, and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  /**
   * After connection-options.ts's checks, exactly one request: `GET /v1/meta`, which authenticates (anonymous access
   * off answers 401 without a key) and gives the version the path table reads. Nothing is retried, and a client that
   * was built is closed on a failure.
   */
  public async connect(): Promise<void> {
    let client: WeaviateClient | undefined;
    try {
      const options = buildWeaviateConnectionOptions(this.config, {
        executionReadOnly: this.execution.readOnly === true,
        queryTimeout: this.queryTimeout,
      });
      client = this.createClient(options, WEAVIATE_ROUTE_TEMPLATES);
      const send = this.sendFor(client, options, "connect");
      const meta = await send({ op: "meta", params: {}, query: {} }, this.surfaceSignal());
      this.session = { client, options, version: readWeaviateVersion(meta.text), paths: pathState() };
    } catch (error) {
      client?.close();
      this.setError(error as Error);
      throw error;
    }
    this.setConnected(true);
  }

  /** A server older than the supported floor connects, with this one warning (spec 3.1). */
  public connectWarnings(): QueryWarning[] {
    const version = this.session?.version;
    const warning = version === undefined ? undefined : belowFloorWarning(version);
    return warning === undefined ? [] : [{ message: warning }];
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.setConnected(false);
    session?.client.close();
  }

  private requireSession(): WeaviateSession {
    this.ensureConnected();
    return this.session!;
  }

  /** A surface call's deadline: 10 s, and never past the connection's query timeout. */
  private surfaceSignal(): AbortSignal {
    return AbortSignal.timeout(Math.min(WEAVIATE_SURFACE_TIMEOUT_MS, this.queryTimeout));
  }

  /** One read under its own limiter permit; a failed request or a failed answer raised in errors.ts's words. */
  private sendFor(
    client: WeaviateClient,
    options: WeaviateConnectionOptions,
    phase: WeaviateErrorContext["phase"],
  ): WeaviateSend<WeaviateOp> {
    return async (request: WeaviateRequest, signal: AbortSignal) => {
      const context = errorContext(
        options,
        phase,
        request.op,
        Math.min(WEAVIATE_SURFACE_TIMEOUT_MS, this.queryTimeout),
      );
      let answer: Awaited<ReturnType<WeaviateClient["send"]>>;
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

  private surface(): WeaviateSurfaceContext<WeaviateOp> {
    const session = this.requireSession();
    return {
      send: this.sendFor(session.client, session.options, "request"),
      signal: this.surfaceSignal(),
      version: session.version,
      paths: session.paths,
      scoped: session.options.secretForms.length > 0,
    };
  }

  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    // A Weaviate request has no binding, and dropping the values would run another request than the one built.
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(BOUND_PARAMS_MESSAGE, this.type);
    const session = this.requireSession();
    const { client, options } = session;
    return executeWeaviate(text, queryId, {
      send: (request, signal) => client.send(request, signal),
      limiter: this.limiter,
      runs: this.runs,
      version: session.version,
      paths: session.paths,
      fail: (failure: WeaviateFailure) => {
        const context = errorContext(
          options,
          "request",
          failure.op,
          Math.min(WEAVIATE_BOUNDS.searchDeadlineMs, this.queryTimeout),
        );
        if (failure.kind === "thrown") return toProviderError(failure.error, context);
        const answered = failure.op === "graphql" ? graphqlFailure(failure.answer) : answerFailure(failure.answer);
        return toProviderError(answered, context);
      },
      queryTimeoutMs: this.queryTimeout,
    });
  }

  /** Aborts a running or queued request by its id and answers true; an unknown id answers false. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    requireRoot(container);
    return countWeaviateObjects(this.surface());
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    requireRoot(container);
    return listWeaviateObjects(this.surface(), kind);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeWeaviateObject(this.surface(), path, kind);
  }

  /** One schema read for every collection's columns: the one-round-trip contract (spec 4.2). */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    requireRoot(container);
    return describeWeaviateObjects(this.surface(), kind, limit);
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return readWeaviateObjectSource(this.surface(), path, kind, limit);
  }

  /** `/v1/.well-known/ready`: readiness only, never evidence of the credential. */
  public async getHealth(): Promise<HealthInfo> {
    return readWeaviateHealth(this.surface());
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return readWeaviateOverview(this.surface());
  }

  public async getTableStats(): Promise<TableStats[]> {
    return readWeaviateTableStats(this.surface());
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return readWeaviateIndexStats(this.surface());
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(NO_MAINTENANCE, this.type);
  }
}
