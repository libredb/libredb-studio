/**
 * RabbitMQ provider (#1656): a read-only browser for one broker's virtual hosts, streams, queues and exchanges over
 * the management HTTP API, and a bounded, non-destructive read of a stream's messages over AMQP 0-9-1.
 *
 * COMPOSITION AND DELEGATION ONLY. The connection rules are `connection-options.ts`, every constant `limits.ts`,
 * every sentence and the one error boundary `errors.ts`, the labels `labels.ts`, the click's text `generators.ts`,
 * the kinds `objects.ts` and the read's columns `results.ts`. What stays here is the lifecycle, the declarations and
 * the seams.
 *
 * Read-only whatever `readOnly` says: no route of the management client writes, and the AMQP client has no encoder
 * for a publish, a get or a queue method. No `queryReadOnly`, so no agent statement execution and no MCP read.
 *
 * The seams are test seams the factory never passes, and no connection field reaches them.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import type {
  ActiveSessionDetails,
  Container,
  ContainerLevels,
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
import type { DatabaseConnection, QueryWarning } from "@/lib/types";
import { testConnectionCautions } from "./access-check";
import { type RabbitMQEndpoints, readConnectionOptions } from "./connection-options";
import {
  AMQP_PORT_EMPTY_CAUTION,
  cancelledError,
  configError,
  type ErrorSite,
  isOwnError,
  NOT_CONNECTED,
  PROVIDER_CLOSED,
  rabbitmqBoundary,
} from "./errors";
import { RABBITMQ_LABELS } from "./labels";
import {
  type DeadlineSignalFactory,
  RABBITMQ_DEFAULT_MANAGEMENT_PORT,
  RABBITMQ_TYPE,
  type RabbitMQClock,
  SYSTEM_CLOCK,
  systemDeadlineSignal,
} from "./limits";
import {
  createManagementClient,
  type ManagementClient,
  type ManagementTransportFactory,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "./management/client";
import { MANAGEMENT_ROUTES, type ManagementRouteId } from "./management/routes";
import { readHealth, readOverview, refuseMaintenance, supportedVersion } from "./monitoring";
import {
  countKinds,
  createStreamListingMemo,
  describeKind,
  describeKindBatch,
  listKind,
  listVhosts,
  RABBITMQ_OBJECT_KINDS,
  type StreamListingMemo,
} from "./objects";
import { readSource } from "./source";
import { createTrackingProbe, type TrackingProbe } from "./tracking-probe";

/** The test seams; the factory passes none, so a built provider always runs on these defaults. */
export interface RabbitMQSeams {
  readonly managementTransport: ManagementTransportFactory;
  readonly clock: RabbitMQClock;
  readonly deadlineSignal: DeadlineSignalFactory;
}

const DEFAULT_SEAMS: RabbitMQSeams = Object.freeze({
  managementTransport: createNodeTransport,
  clock: SYSTEM_CLOCK,
  deadlineSignal: systemDeadlineSignal,
});

/** What connect() establishes and disconnect() ends: the endpoints, the management client and what hangs off it. */
interface RabbitMQSession {
  readonly endpoints: RabbitMQEndpoints;
  readonly management: ManagementClient;
  readonly tracking: TrackingProbe;
  readonly streams: StreamListingMemo;
}

/** The route a member names when an unexpected failure is reported: its main GET's label. */
const label = (id: ManagementRouteId) => MANAGEMENT_ROUTES[id].label;
/** Own keys only: a kind named like a prototype member ("toString", "__proto__") finds no listing here. */
const KIND_LISTING: ReadonlyMap<string, ManagementRouteId> = new Map([
  ["stream", "streams-page"],
  ["queue", "queues-page"],
  ["exchange", "exchanges-page"],
]);

/** One container level: the virtual host, discovered from the management API. */
export const RABBITMQ_CONTAINER_LEVELS: ContainerLevels = [
  { id: "schema", label: "Virtual host", labelPlural: "Virtual hosts" },
];

/**
 * The refusal of query() while the read path is still being built: the type is registered and the management
 * surfaces work, so the tree and the dialog work, and no read is sent.
 */
export const RABBITMQ_PROVIDER_PENDING = "The RabbitMQ provider is not complete in this build.";

export class RabbitMQProvider extends BaseDatabaseProvider {
  /** The merged seams: the factory passes none, so a factory-built provider holds the defaults. */
  protected readonly seams: RabbitMQSeams;
  /** One per instance; `disconnect()` aborts it, so nothing started on this instance outlives it. */
  protected readonly lifetime = new AbortController();
  /** This instance's own permits: 4 management GETs and 1 bindings GET at once, within the process's bounds. */
  private readonly managementLimiter = rabbitmqManagementLimiter();
  private readonly bindingsLimiter = rabbitmqBindingsLimiter();
  private session: RabbitMQSession | null = null;

  /**
   * Validates nothing and opens nothing: the connection's rules run in `connect()`, so a provider built only for its
   * declarations (the factory's census, `POST /api/db/provider-meta`) touches no socket.
   */
  constructor(config: DatabaseConnection, options: ProviderOptions = {}, seams: Partial<RabbitMQSeams> = {}) {
    super(config, options);
    this.seams = { ...DEFAULT_SEAMS, ...seams };
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A JSON read request of this product's own schema, not MongoDB's JSON.
      queryLanguage: "json",
      queryDialect: "rabbitmq",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsMaintenance: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      tablesAreDerivedGroupings: false,
      declaresForeignKeys: false,
      // Read-only whatever the flag says: the management client sends GET only, and the AMQP client cannot publish.
      enforcesReadOnly: true,
      statementTerminator: "none",
      maintenanceOperations: [],
      // No read request changes what the tree shows.
      schemaRefreshPattern: "(?!)",
      defaultPort: RABBITMQ_DEFAULT_MANAGEMENT_PORT,
      containerLevels: RABBITMQ_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: RABBITMQ_OBJECT_KINDS,
      // Plan mode reads the default virtual host, not every virtual host of a large broker.
      agentWalkScope: { mode: "session-default" },
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...RABBITMQ_LABELS };
  }

  /** Refuses before any I/O while the provider is incomplete. */
  private pending(): never {
    throw new DatabaseConfigError(RABBITMQ_PROVIDER_PENDING, RABBITMQ_TYPE);
  }

  /**
   * The connected session, or this provider's own refusal: the closed sentence after disconnect(), and before
   * connect() the not-connected one. The read path takes its management client from here too.
   */
  private requireConnected(): RabbitMQSession {
    if (this.lifetime.signal.aborted) throw this.closedError();
    if (this.session === null) throw configError(NOT_CONNECTED);
    return this.session;
  }

  private closedError(): Error {
    const reason: unknown = this.lifetime.signal.reason;
    return isOwnError(reason) ? (reason as Error) : cancelledError(PROVIDER_CLOSED);
  }

  /** One member's work on the connected session, ending in the provider's one boundary. */
  private async browse<T>(
    route: string,
    work: (session: RabbitMQSession) => Promise<T>,
    site: ErrorSite = "browse",
  ): Promise<T> {
    const session = this.requireConnected();
    try {
      return await work(session);
    } catch (error) {
      throw rabbitmqBoundary(error, { site, endpoint: session.endpoints.management.display, route });
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Exactly two management GETs and no AMQP connection: who this user is to the management API, then the broker's
   * version, which must be 4.2 or later. A refusal at either closes the client and leaves the provider unconnected.
   * A connected instance keeps its session, and a disconnect() that lands while connect() awaits wins.
   */
  public async connect(): Promise<void> {
    if (this.lifetime.signal.aborted) throw this.closedError();
    if (this.session !== null) return;
    let endpoints: RabbitMQEndpoints;
    try {
      endpoints = readConnectionOptions(this.config);
    } catch (error) {
      throw rabbitmqBoundary(error, { site: "connect", endpoint: "", route: label("whoami") });
    }
    const display = endpoints.management.display;
    let management: ManagementClient | undefined;
    try {
      management = createManagementClient({
        endpoint: endpoints.management,
        transport: this.seams.managementTransport,
        deadlineSignal: this.seams.deadlineSignal,
        queryTimeoutMs: this.queryTimeout,
        lifetime: this.lifetime.signal,
        limiters: { management: this.managementLimiter, bindings: this.bindingsLimiter },
      });
      await management.get("whoami", {}, { site: "connect" });
      supportedVersion((await management.get("overview-version", {}, { site: "connect" })).version);
    } catch (error) {
      management?.close();
      const failure = rabbitmqBoundary(error, { site: "connect", endpoint: display, route: label("whoami") });
      this.setError(failure);
      throw failure;
    }
    if (this.lifetime.signal.aborted) {
      management.close();
      throw this.closedError();
    }
    this.session = {
      endpoints,
      management,
      tracking: createTrackingProbe(management),
      streams: createStreamListingMemo(),
    };
    this.setConnected(true);
  }

  /** Aborts everything started on this instance with the closed sentence and closes the client; safe to call twice. */
  public async disconnect(): Promise<void> {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(cancelledError(PROVIDER_CLOSED));
    this.session?.management.close();
    this.session = null;
    this.setConnected(false);
  }

  /**
   * A fact of the configuration, read without I/O: an empty AMQP port browses only, which Test Connection states
   * as its one caution. Synchronous, and empty for every other record.
   */
  public connectWarnings(): QueryWarning[] {
    const amqpPort: unknown = this.config.amqpPort;
    return amqpPort === undefined || amqpPort === null || amqpPort === "" ? [{ message: AMQP_PORT_EMPTY_CAUTION }] : [];
  }

  /** Cautions for a user's Test Connection only: alarms, no virtual host, readable classic or quorum queues. */
  public testConnectionWarnings(): Promise<QueryWarning[]> {
    return this.browse(
      label("alarms"),
      (s) => testConnectionCautions(s.management, s.tracking, this.seams.deadlineSignal),
      "test-connection",
    );
  }

  // ==========================================================================
  // Query path
  // ==========================================================================

  public async query(): Promise<QueryResult> {
    this.pending();
  }

  // ==========================================================================
  // Object surface
  // ==========================================================================

  /** The virtual hosts; "/" is marked as plan mode's walk default, not as a session the broker holds. */
  public listContainers(): Promise<Container[]> {
    return this.browse(label("vhosts"), (s) => listVhosts(s.management));
  }

  public countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return this.browse(label("queues-page"), (s) => countKinds(s.management, this.getCapabilities(), container));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return this.browse(label(KIND_LISTING.get(kind) ?? "streams-page"), (s) =>
      listKind(s.management, this.getCapabilities(), s.streams, container, kind),
    );
  }

  public describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return this.browse(label("streams-page"), async () => describeKind(this.getCapabilities(), path, kind));
  }

  public describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    return this.browse(label("streams-page"), (s) =>
      describeKindBatch(s.management, this.getCapabilities(), s.streams, container, kind, limit),
    );
  }

  public readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return this.browse(label(kind === "exchange" ? "exchange" : "queue"), (s) =>
      readSource(
        {
          client: s.management,
          tracking: s.tracking,
          capabilities: this.getCapabilities(),
          now: () => this.seams.clock.now(),
        },
        path,
        kind,
        limit,
      ),
    );
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  public getHealth(): Promise<HealthInfo> {
    return this.browse(label("overview-version"), (s) => readHealth(s.management));
  }

  public getOverview(): Promise<DatabaseOverview> {
    return this.browse(label("overview-full"), (s) => readOverview(s.management));
  }

  /** Every metric is optional, so an empty object is the honest answer. No GET. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.requireConnected();
    return {};
  }

  /** Empty: RabbitMQ keeps no query log. No GET. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.requireConnected();
    return [];
  }

  /** Empty: broker connections name other users and client addresses, so Studio does not list them. No GET. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.requireConnected();
    return [];
  }

  /** Empty: counts are sampled per folder in the tree, never a row count. No GET. */
  public async getTableStats(): Promise<TableStats[]> {
    this.requireConnected();
    return [];
  }

  /** Empty: a stream has no index. No GET. */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.requireConnected();
    return [];
  }

  /** Empty: the management API a management user may read reports no storage per object. No GET. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.requireConnected();
    return [];
  }

  /** Unreachable behind supportsMaintenance: false; a direct call is refused with its sentence. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    this.requireConnected();
    return refuseMaintenance();
  }
}
