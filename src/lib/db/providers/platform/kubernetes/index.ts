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
 * Read-only whatever `readOnly` says: no request path writes, and no maintenance is offered. No `queryReadOnly`, so
 * no agent statement execution and no MCP read. The clock, the randomness and the transport factory are seams.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type {
  ActiveSessionDetails,
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
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { DatabaseConnection, QueryWarning, WithTunnelFarEnd } from "@/lib/types";
import { createKubernetesClient, DEFAULT_KUBERNETES_SEAMS, type KubernetesCall, type KubernetesSeams } from "./client";
import { kubernetesConnectWarnings } from "./connect-warnings";
import { type ClusterEndpoint, readClusterEndpoint } from "./connection-options";
import { DiscoveryCache, readDiscovery, requireSupportedServer } from "./discovery";
import { CLUSTER_CONTAINER, KUBERNETES_OBJECT_KINDS, KUBERNETES_ROW_ACTIONS } from "./kinds";
import { KUBERNETES_LABELS } from "./labels";
import { KUBERNETES_DEFAULT_PORT, KUBERNETES_TYPE } from "./limits";
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

/** Until the console lands, a statement is refused before any request. */
export const KUBERNETES_CONSOLE_PENDING =
  "The kubectl console is not part of this build yet: the tree and the YAML view read this cluster, and no statement is sent.";

/** One connected session: the endpoint, the surface every module reads through and its lifetime. */
interface KubernetesSession {
  readonly endpoint: ClusterEndpoint;
  readonly surface: KubernetesSurface;
  /** Aborted at disconnect, so no request outlives its session. */
  readonly lifetime: AbortController;
}

export class KubernetesProvider extends BaseDatabaseProvider {
  private session: KubernetesSession | null = null;
  private warnings: QueryWarning[] = [];
  private readonly seams: KubernetesSeams;

  /**
   * Validates nothing and opens nothing: the connection rules run in `connect()`, so a provider built only for its
   * declarations (the factory's census, `POST /api/db/provider-meta`) touches no socket. No execution context is
   * taken: the provider is read-only whatever a profile asks, as Neo4j's is.
   */
  constructor(config: DatabaseConnection, options: ProviderOptions = {}, seams: Partial<KubernetesSeams> = {}) {
    super(config, options);
    this.seams = { ...DEFAULT_KUBERNETES_SEAMS, ...seams };
  }

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A kubectl statement, declared as etcd and Oxia declare their command lines: "json" means only "not SQL".
      queryLanguage: "json",
      queryDialect: "kubectl",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
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
   * warnings.
   */
  public async connect(): Promise<void> {
    if (this.session !== null) await this.disconnect();
    const session = this.openSession();
    try {
      const index = await session.surface.discovery.refresh();
      requireSupportedServer(index);
      this.warnings = await kubernetesConnectWarnings(session.surface, index);
    } catch (error) {
      session.lifetime.abort();
      session.surface.client.close();
      throw error;
    }
    this.session = session;
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
    return { endpoint, surface: { client, discovery, endpoint, call }, lifetime };
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.warnings = [];
    this.setConnected(false);
    if (session === null) return;
    session.lifetime.abort();
    session.surface.client.close();
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

  public async query(_statement: string, params?: unknown[]): Promise<QueryResult> {
    if (params !== undefined && params.length > 0)
      throw new DatabaseConfigError(
        "kubectl statements take no parameters: write the values in the statement.",
        KUBERNETES_TYPE,
      );
    this.requireSession();
    throw new QueryError(KUBERNETES_CONSOLE_PENDING, KUBERNETES_TYPE);
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

  /** Connects if needed, without the connect reads; a session opened here is kept when health answers. */
  public async getHealth(): Promise<HealthInfo> {
    const opened = this.session === null;
    const session = this.session ?? this.openSession();
    try {
      const health = await kubernetesHealth(session.surface);
      if (opened) {
        this.session = session;
        this.setConnected(true);
      }
      return health;
    } catch (error) {
      if (opened) {
        session.lifetime.abort();
        session.surface.client.close();
      }
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
