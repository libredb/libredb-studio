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
import { readConnectionOptions } from "./connection-options";
import { AMQP_PORT_EMPTY_CAUTION, cancelledError, PROVIDER_CLOSED } from "./errors";
import { RABBITMQ_LABELS } from "./labels";
import {
  type DeadlineSignalFactory,
  RABBITMQ_DEFAULT_MANAGEMENT_PORT,
  RABBITMQ_TYPE,
  type RabbitMQClock,
  SYSTEM_CLOCK,
  systemDeadlineSignal,
} from "./limits";
import { RABBITMQ_OBJECT_KINDS } from "./objects";

/** The test seams; the factory passes none, so a built provider always runs on these defaults. */
export interface RabbitMQSeams {
  readonly clock: RabbitMQClock;
  readonly deadlineSignal: DeadlineSignalFactory;
}

const DEFAULT_SEAMS: RabbitMQSeams = Object.freeze({ clock: SYSTEM_CLOCK, deadlineSignal: systemDeadlineSignal });

/** One container level: the virtual host, discovered from the management API. */
export const RABBITMQ_CONTAINER_LEVELS: ContainerLevels = [
  { id: "schema", label: "Virtual host", labelPlural: "Virtual hosts" },
];

/**
 * The refusal of every member that would reach the broker while the provider is still being built: the type is
 * registered, so the census and the dialog work, and nothing is sent.
 */
export const RABBITMQ_PROVIDER_PENDING = "The RabbitMQ provider is not complete in this build.";

export class RabbitMQProvider extends BaseDatabaseProvider {
  /** The merged seams: the factory passes none, so a factory-built provider holds the defaults. */
  protected readonly seams: RabbitMQSeams;
  /** One per instance; `disconnect()` aborts it, so nothing started on this instance outlives it. */
  protected readonly lifetime = new AbortController();

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

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** The connection rules refuse before any socket; then the interim refusal. */
  public async connect(): Promise<void> {
    readConnectionOptions(this.config);
    this.pending();
  }

  /** Aborts everything started on this instance with the closed sentence; safe to call twice. */
  public async disconnect(): Promise<void> {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(cancelledError(PROVIDER_CLOSED));
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

  // ==========================================================================
  // Query path
  // ==========================================================================

  public async query(): Promise<QueryResult> {
    this.pending();
  }

  // ==========================================================================
  // Object surface
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    this.pending();
  }

  public async countObjects(): Promise<Record<string, KindCount>> {
    this.pending();
  }

  public async listObjects(): Promise<DatabaseObject[]> {
    this.pending();
  }

  public async describeObject(): Promise<ObjectDetail> {
    this.pending();
  }

  public async describeObjects(): Promise<ObjectDetailBatch> {
    this.pending();
  }

  public async readObjectSource(): Promise<ObjectSourceDocument> {
    this.pending();
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.pending();
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.pending();
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.pending();
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.pending();
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.pending();
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.pending();
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.pending();
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.pending();
  }

  public async runMaintenance(): Promise<MaintenanceResult> {
    this.pending();
  }
}
