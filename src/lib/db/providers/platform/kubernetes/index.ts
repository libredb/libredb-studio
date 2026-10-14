/**
 * Kubernetes provider: a read-only browser for one cluster over the API server's REST API, through Studio's shared
 * node transport. Namespaces and the `Cluster` pseudo-container in the tree, each kind's objects under them, a YAML
 * view of every built-in object, and a kubectl-subset console.
 *
 * COMPOSITION AND DELEGATION ONLY. The connection rules are `connection-options.ts`, every request passes
 * `request-policy.ts` inside `client.ts`, discovery and its cache `discovery.ts`, the tree `objects.ts`, the YAML view
 * `source.ts`, health and the overview `monitoring.ts`, Test Connection's warnings `connect-warnings.ts`, and every
 * failure sentence `errors.ts`. What stays here is the session's lifecycle, the declarations and the one call shape
 * every module reads through.
 *
 * Read-only whatever `readOnly` says: no request path writes, and no maintenance is offered. `queryReadOnly` and
 * the curated `readClusterUsage` and `readWorkloadProfile` (`agent-readings.ts`) serve the agent under the read-only
 * profile (`machine-read.ts`, `machine-redaction.ts`); MCP is not offered (`MCP_EXPOSABLE.kubernetes`). The clock,
 * the randomness and the transport factory are seams.
 *
 * The console is `console/`: `query()` runs one statement through `console/run.ts` under the run registry, so a
 * cancel stops it, and `prepareQuery` pages only the list form of a single-type get (`console/paging.ts`).
 */
import { getAppVersion } from "@/lib/app-version";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { ConnectionError, DatabaseConfigError, QueryCancelledError, QueryError } from "@/lib/db/errors";
import type {
  ActiveSessionDetails,
  ClusterUsageInput,
  ClusterUsageReading,
  Container,
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
  QueryPrepareOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
  WorkloadProfileInput,
  WorkloadProfileReading,
} from "@/lib/db/types";
import { createRunRegistry, type RunRegistry } from "@/lib/db/utils/bounded-limiter";
import type { DatabaseConnection, QueryWarning, WithTunnelFarEnd } from "@/lib/types";
import { readClusterUsage, readWorkloadProfile } from "./agent-readings";
import { createKubernetesClient, DEFAULT_KUBERNETES_SEAMS, type KubernetesCall, type KubernetesSeams } from "./client";
import { kubernetesConnectWarnings } from "./connect-warnings";
import { ExplainCache, resultOf, statementCall } from "./console/context";
import { EXPLAIN_CACHE_ENTRIES } from "./console/explain";
import { prepareKubectlQuery } from "./console/paging";
import { runKubectl } from "./console/run";
import { type ClusterEndpoint, readClusterEndpoint } from "./connection-options";
import { DiscoveryCache, readDiscovery, requireSupportedServer } from "./discovery";
import { CLUSTER_CONTAINER, KUBERNETES_OBJECT_KINDS, KUBERNETES_ROW_ACTIONS } from "./kinds";
import { KUBERNETES_LABELS } from "./labels";
import { KUBERNETES_DEFAULT_PORT, KUBERNETES_TYPE } from "./limits";
import { type MachineOptions, type MachineSession, readKubectlForMachine, withMachineContext } from "./machine-read";
import { kubernetesHealth, kubernetesOverview } from "./monitoring";
import {
  countKubernetesObjects,
  describeKubernetesObject,
  describeKubernetesObjects,
  KUBERNETES_CONTAINER_LEVELS,
  type KubernetesSurface,
  listKubernetesContainers,
  listKubernetesObjects,
} from "./objects";
import { readKubernetesSource } from "./source";

/** What a connect or a health check still opening answers once a disconnect or a newer connect closed its session. */
export const KUBERNETES_CLOSED_WHILE_OPENING =
  "The connection was closed while Studio was still opening it, so nothing was kept; connect again to use it.";

/** One connected session: the endpoint, the surface every module reads through and its lifetime. */
interface KubernetesSession {
  readonly endpoint: ClusterEndpoint;
  readonly surface: KubernetesSurface;
  /** Aborted at disconnect, so no request outlives its session. */
  readonly lifetime: AbortController;
  /** The OpenAPI group documents `explain` read, kept for this session only. */
  readonly explainCache: ExplainCache;
}

/** Aborts every request of a session and closes its transport; a second call changes nothing. */
function closeSession(session: KubernetesSession): void {
  // Aborted and closed go together, so an aborted session is already closed.
  if (session.lifetime.signal.aborted) return;
  session.lifetime.abort();
  session.surface.client.close();
}

/** Refuses to go on with a session a disconnect or a newer connect closed while it was being opened. */
function requireOpen(session: KubernetesSession): void {
  if (session.lifetime.signal.aborted) throw new ConnectionError(KUBERNETES_CLOSED_WHILE_OPENING, KUBERNETES_TYPE);
}

export class KubernetesProvider extends BaseDatabaseProvider {
  private session: KubernetesSession | null = null;
  /** Sessions a connect or a health check is still opening: a disconnect closes them too. */
  private readonly opening = new Set<KubernetesSession>();
  private warnings: QueryWarning[] = [];
  private readonly seams: KubernetesSeams;
  private readonly runs: RunRegistry = createRunRegistry();
  /** Whether this provider was opened under the agent read-only profile; only then does `queryReadOnly` answer. */
  private readonly readOnlyProfile: boolean;

  /**
   * Validates nothing and opens nothing: the connection rules run in `connect()`, so a provider built only for its
   * declarations (the factory's census, `POST /api/db/provider-meta`) touches no socket. The execution context is
   * kept for `queryReadOnly` alone: every other path is read-only whatever a profile asks.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    seams: Partial<KubernetesSeams> = {},
    execution: ProviderExecutionContext = {},
  ) {
    super(config, options);
    this.seams = { ...DEFAULT_KUBERNETES_SEAMS, ...seams };
    this.readOnlyProfile = execution.readOnly === true;
  }

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A kubectl statement, declared as etcd and Oxia declare their command lines: "json" means only "not SQL".
      queryLanguage: "json",
      queryDialect: "kubectl",
      supportsExplain: false,
      // The list form of a single-type get is paged by a clause the provider owns (console/paging.ts).
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: true,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Read-only whatever the flag says: the request policy admits GET and the three self reviews only.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: KUBERNETES_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: KUBERNETES_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: KUBERNETES_OBJECT_KINDS,
      rowActions: KUBERNETES_ROW_ACTIONS,
      // The containers answer their own kinds: Cluster holds the cluster-scoped kinds, a namespace the namespaced ones.
      containersNameKinds: true,
      // Plan mode reads the session's namespace and Cluster, not every namespace of a large cluster.
      agentWalkScope: { mode: "session-default", alsoWalk: [[CLUSTER_CONTAINER]] },
      // The agent's identity is its own ServiceAccount token when `agentPassword` is set, else the connection's token.
      agentCredential: "token",
      // The agent's reads mask every Secret name its output carries, so the withheld kind holds on `queryReadOnly` too.
      machineRedaction: { maskedNameKinds: ["secrets"] },
      // Container usage against requests and limits (`readClusterUsage`) and a namespace's workload profile
      // (`readWorkloadProfile`), each read in one call for the agent.
      agentReadings: ["usage", "workloads"],
      // Nothing a statement runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...KUBERNETES_LABELS };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * The endpoint, the client, discovery (which also proves the credential), the 1.28 floor, then Test Connection's
   * warnings. A session still being opened, by an earlier connect or a health check, is closed first, and a disconnect
   * before the reads end closes this one: it is then not kept, and nothing more is sent on it.
   */
  public async connect(): Promise<void> {
    await this.disconnect();
    const session = this.openSession();
    this.opening.add(session);
    let warnings: QueryWarning[];
    try {
      const index = await session.surface.discovery.refresh();
      requireOpen(session);
      requireSupportedServer(index);
      warnings = await kubernetesConnectWarnings(session.surface, index);
      requireOpen(session);
    } catch (error) {
      this.opening.delete(session);
      closeSession(session);
      throw error;
    }
    this.opening.delete(session);
    // A health check may have kept a session while this one was opening: the connect's replaces it.
    if (this.session !== null) closeSession(this.session);
    this.session = session;
    this.warnings = warnings;
    this.setConnected(true);
  }

  /** The endpoint, the client and the surface, with no request: connect and health's connect-if-needed share it. */
  private openSession(): KubernetesSession {
    const endpoint = readClusterEndpoint(this.config as DatabaseConnection & WithTunnelFarEnd, {
      queryTimeout: this.queryTimeout,
    });
    const client = createKubernetesClient(endpoint, this.seams);
    const lifetime = new AbortController();
    const call = (): KubernetesCall => ({ signal: lifetime.signal, timeoutMs: endpoint.callTimeoutMs });
    const discovery = new DiscoveryCache(() => readDiscovery(client, call()), this.seams.now);
    return {
      endpoint,
      surface: { client, discovery, endpoint, call },
      lifetime,
      explainCache: new ExplainCache(EXPLAIN_CACHE_ENTRIES),
    };
  }

  public async disconnect(): Promise<void> {
    const sessions = [...this.opening, ...(this.session === null ? [] : [this.session])];
    this.opening.clear();
    this.session = null;
    this.warnings = [];
    this.setConnected(false);
    for (const session of sessions) closeSession(session);
  }

  /** The warnings the last `connect()` computed, for Test Connection. */
  public connectWarnings(): QueryWarning[] {
    return [...this.warnings];
  }

  private requireSession(): KubernetesSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as KubernetesSession;
  }

  // ==========================================================================
  // Query path
  // ==========================================================================

  /** The list form of a single-type get gains the provider's paging clause; every other statement goes untouched. */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    return prepareKubectlQuery(query, options);
  }

  /**
   * One kubectl statement, under the run registry: a cancel aborts its requests and answers the cancel sentence.
   * The connection's query timeout bounds the whole statement: it is one deadline taken at the start, and each
   * request gets the time left before it, so pages, reads and log streams chained by one statement share it.
   */
  public async query(statement: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0)
      throw new DatabaseConfigError(
        "kubectl statements take no parameters: write the values in the statement.",
        KUBERNETES_TYPE,
      );
    const session = this.requireSession();
    const run = this.runs.begin(queryId, session.lifetime.signal);
    const started = this.seams.now();
    try {
      const grid = await runKubectl(
        {
          surface: session.surface,
          call: statementCall(run.signal, started + session.endpoint.callTimeoutMs, this.seams.now),
          now: this.seams.now,
          explainCache: session.explainCache,
          queryTimeoutMs: session.endpoint.callTimeoutMs,
          appVersion: getAppVersion(),
        },
        statement,
      );
      return resultOf(grid, this.seams.now() - started);
    } catch (error) {
      // A cancelled run answers the cancel, whatever the aborted request raised.
      if (run.signal.aborted && run.signal.reason instanceof QueryCancelledError) throw run.signal.reason;
      throw error;
    } finally {
      run.end();
    }
  }

  /**
   * One kubectl statement for the agent: under the read-only profile, bounded by the agent budget (discovery
   * included), refused rather than truncated past its rows or bytes, and masked on its output projection. The
   * boundary is the request allowlist on the final method and path and the identity's RBAC, not the reader
   * (`kubectl.query.read`). `query()` is the editor's and is never masked.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode?: ReadOnlyStatementMode,
  ): Promise<QueryResult> {
    const session = this.requireSession();
    return readKubectlForMachine(this.machineSession(session), statement, budget, mode, this.machineOptions());
  }

  /** Container usage against requests and limits for the agent (`cluster.usage.read`), in the machine context. */
  public async readClusterUsage(
    input: ClusterUsageInput,
    budget: ReadOnlyStatementBudget,
  ): Promise<ClusterUsageReading> {
    const session = this.requireSession();
    return withMachineContext(this.machineSession(session), budget, this.machineOptions(), (context) =>
      readClusterUsage(context, input),
    );
  }

  /** A namespace's workload profile for the agent (`cluster.workloads.read`), in the machine context. */
  public async readWorkloadProfile(
    input: WorkloadProfileInput,
    budget: ReadOnlyStatementBudget,
  ): Promise<WorkloadProfileReading> {
    const session = this.requireSession();
    return withMachineContext(this.machineSession(session), budget, this.machineOptions(), (context) =>
      readWorkloadProfile(context, input),
    );
  }

  /** The session as the agent's reads see it: its surface, its explain cache and its lifetime. */
  private machineSession(session: KubernetesSession): MachineSession {
    return { surface: session.surface, explainCache: session.explainCache, lifetime: session.lifetime.signal };
  }

  /** What every agent read is held to: the read-only profile, the clock and sleep seams, and the version it reports. */
  private machineOptions(): MachineOptions {
    return { readOnly: this.readOnlyProfile, seams: this.seams, appVersion: getAppVersion() };
  }

  /** Stops a running statement by its id and answers true; an id that names no run answers false. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface, answered by objects.ts and source.ts
  // ==========================================================================

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    return listKubernetesContainers(this.requireSession().surface, parent);
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return countKubernetesObjects(this.requireSession().surface, container);
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return listKubernetesObjects(this.requireSession().surface, container, kind);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeKubernetesObject(path, kind);
  }

  public async describeObjects(container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    return describeKubernetesObjects(container, kind);
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return readKubernetesSource(this.requireSession().surface, path, kind, limit);
  }

  // ==========================================================================
  // Monitoring, answered by monitoring.ts
  // ==========================================================================

  /**
   * Connects if needed, without the connect reads; a session opened here is kept when health answers, unless a
   * disconnect or a connect closed it meanwhile, or a connect or another health check kept one first, in which case
   * this one is closed.
   */
  public async getHealth(): Promise<HealthInfo> {
    if (this.session !== null) return kubernetesHealth(this.session.surface);
    const session = this.openSession();
    this.opening.add(session);
    try {
      const health = await kubernetesHealth(session.surface);
      requireOpen(session);
      this.opening.delete(session);
      if (this.session !== null) closeSession(session);
      else {
        this.session = session;
        this.setConnected(true);
      }
      return health;
    } catch (error) {
      this.opening.delete(session);
      closeSession(session);
      throw error;
    }
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return kubernetesOverview(this.requireSession().surface);
  }

  /** Nothing is measured, so every optional figure is absent. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return {};
  }

  /** Kubernetes keeps no query log. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }

  /** Kubernetes does not list client sessions. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }

  /** Kubernetes has no tables; `tableStatsCaption` says where its objects are. */
  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  /** `supportsMaintenance: false`: nothing sends maintenance, and a direct call is refused in the label's words. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(KUBERNETES_LABELS.vacuumGlobalDesc, KUBERNETES_TYPE);
  }
}
