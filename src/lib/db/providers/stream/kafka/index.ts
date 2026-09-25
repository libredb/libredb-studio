/**
 * Apache Kafka provider (issue #1088). Read-only browsing over the Kafka protocol: topics,
 * consumer groups with lag, brokers and configs, and reading messages by partition, offset or
 * timestamp through a JSON read request.
 *
 * COMPOSITION AND DELEGATION ONLY (spec 3.5). The wire lives in `platformatic-client.ts`, the
 * connection rules in `connection-options.ts`, request parsing in `request.ts`, the read loop in
 * `read.ts`, shaping in `results.ts` and `decode.ts`, the object surface and lag in `objects.ts`
 * and `groups.ts`, the monitoring mappings in `monitoring.ts` and the error table in `errors.ts`.
 * What stays here is lifecycle, the declarations, and which read each surface makes.
 *
 * No `cancelQuery` and no `getPoolStats` (spec 5.5, 7.1): both are detected by presence, and a read
 * is bounded by its limit, its budgets and its timeout, with no server-side evaluation to stop.
 * `prepareQuery` is the base pass-through: the read request carries its own limit (spec 5.1).
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
  MaintenanceType,
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
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { KafkaError, type KafkaReadClient } from "./client";
import { KAFKA_DEFAULT_PORT, type KafkaConnectionOptions, kafkaConnectionOptions } from "./connection-options";
import { toDatabaseError } from "./errors";
import { healthFrom, overviewFrom, storageFrom } from "./monitoring";
import * as objects from "./objects";
import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client";
import { KAFKA_CELL_LIMIT, KAFKA_RESULT_BYTE_BUDGET, type ReadLimits, readMessages } from "./read";
import { parseReadRequest } from "./request";
import { toQueryResult } from "./results";

/** How a real connection gets its client: the library, loaded once for the process. */
const defaultCreateClient = async (options: KafkaConnectionOptions): Promise<KafkaReadClient> =>
  createPlatformaticClient(options, await loadPlatformatic());

/** Every read is held to the same bounds (spec 5.4, K5). */
const READ_LIMITS: ReadLimits = { resultByteBudget: KAFKA_RESULT_BYTE_BUDGET, cellLimit: KAFKA_CELL_LIMIT };

const EMPTY_REQUEST_MESSAGE = 'The editor is empty: write a read request such as {"topic": "orders"}';
const BOUND_PARAMS_MESSAGE = "Bound params are not supported: a Kafka read request has no placeholders";

export class KafkaProvider extends BaseDatabaseProvider {
  private client: KafkaReadClient | null = null;
  // Not `options`: BaseDatabaseProvider already holds `protected readonly options: ProviderOptions`.
  private connectionOptions: KafkaConnectionOptions | null = null;

  /**
   * Validates nothing and opens nothing: the connection's rules (spec 3.6 K1, K3, 6.1) are checked
   * in `connect()`, before any client exists, so a provider built only to read its declarations
   * (the factory's census, a route refusing an unconnected request) touches no socket.
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly createClient: (o: KafkaConnectionOptions) => Promise<KafkaReadClient> = defaultCreateClient,
  ) {
    super(config, options);
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /**
   * Every member written out rather than spread over the base's, the Prometheus provider's shape:
   * the base's defaults are SQL's, so a flag the base gains later is a decision here, never an
   * inherited permissive default (spec 6.2).
   */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // A JSON read request of this product's own schema (spec 3.3, 5.1), not MongoDB's JSON.
      queryLanguage: "json",
      queryDialect: "kafka",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsMaintenance: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      // A topic is a relation the broker holds, not a grouping derived from a scan.
      tablesAreDerivedGroupings: false,
      declaresForeignKeys: false,
      statementTerminator: "none",
      // Read-only: no maintenance operation exists here, and no read request changes what the
      // tree shows, so the refresh pattern matches nothing; the base's SQL pattern, compiled
      // case-insensitively, would match a read of a topic named "orders-drop" and reload the tree.
      maintenanceOperations: [],
      schemaRefreshPattern: "(?!)",
      defaultPort: KAFKA_DEFAULT_PORT,
      containerLevels: objects.KAFKA_CONTAINER_LEVELS,
      objectKinds: objects.KAFKA_OBJECT_KINDS,
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: "Topic",
      entityNamePlural: "Topics",
      rowName: "Message",
      rowNamePlural: "Messages",
      selectAction: "Read Latest 50",
      generateAction: "Generate Read Request",
      searchPlaceholder: "Search topics...",
      // Stated verbatim by plan mode ("Write it in ..."), and the only fact about how a statement
      // is written that its prompt carries per engine (src/lib/agent/investigation.ts). The request
      // schema is this product's own and parseReadRequest refuses any other key, so the sentence
      // carries the schema and says that the inventory's columns are not keys (spec 6.3). The
      // integration test parses each example in it with that parser.
      statementLanguage: `the JSON read request this editor executes - one object, {"topic": "<topic name>", "partition": <n>, "from": "earliest" | "latest" | {"offset": <n>} | {"timestamp": "<ISO-8601 with a zone>"}, "limit": <1 to ${DEFAULT_QUERY_LIMIT}>}, of which only "topic" is required: "from" defaults to "latest", "limit" to 50, and "partition" is required with an offset; for example {"topic": "orders", "from": "latest", "limit": 50} or {"topic": "orders", "partition": 0, "from": {"offset": "120"}} - and no other key: "offset" and "timestamp" go inside "from", never at the top level, the inventory's other columns (key, value, headers and their encodings) are fields each message comes back with, not keys of the request, and a read request reads one topic's messages, never a consumer group's lag`,
      slowQueriesEmptyState: "Kafka exposes no query log",
      sessionsEmptyState: "Kafka does not report client sessions over its protocol",
      // Never rendered: maintenanceControl() gates every placement on supportsMaintenance first
      // (src/lib/db/types.ts). Worded true for Kafka anyway.
      analyzeAction: "Analyze Topic",
      vacuumAction: "Compact Topic",
      analyzeGlobalLabel: "Analyze",
      analyzeGlobalTitle: "Not available",
      analyzeGlobalDesc: "Kafka has no statistics to update.",
      vacuumGlobalLabel: "Compact",
      vacuumGlobalTitle: "Not available",
      vacuumGlobalDesc:
        "Log compaction is a topic config the broker applies on its own schedule; Studio does not trigger it.",
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** The validated bootstrap address. Before validation only a validation refusal is mapped, and it names no address. */
  private get bootstrap(): { host: string; port: number } {
    return this.connectionOptions?.broker ?? { host: "", port: KAFKA_DEFAULT_PORT };
  }

  public async connect(): Promise<void> {
    let client: KafkaReadClient | undefined;
    try {
      // Refused before any client exists: an address that is not one, SASL without TLS, a
      // credential SASL cannot carry, an SSH tunnel (spec 3.6 K1, K3, 6.1).
      this.connectionOptions = kafkaConnectionOptions(this.config, this.queryTimeout);
      client = await this.createClient(this.connectionOptions);
      // One forced read of the brokers proves a broker answers the protocol at this address, with
      // this credential, while the user is still looking at the connection form.
      await client.metadata([]);
    } catch (error) {
      const failure = toDatabaseError(error, this.bootstrap, this.queryTimeout);
      // A client that was built holds sockets, so a connect that fails after it closes them (spec
      // 3.6 K8). A close that fails too is logged, never thrown over the failure that explains the
      // connect.
      await client?.close().catch((closeError: unknown) => this.logError("connect cleanup", closeError));
      this.setError(failure);
      throw failure;
    }
    this.client = client;
    this.setConnected(true);
  }

  /** Closes the Admin, the Consumer and the fetch pool (spec 3.6 K8). */
  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.setConnected(false);
    await client?.close();
  }

  /** One call on the connected client, whose failure surfaces as this repository's error class (spec 5.6). */
  private async guarded<T>(operation: (client: KafkaReadClient) => Promise<T>): Promise<T> {
    this.ensureConnected();
    try {
      // Assigned before setConnected(true) and cleared with setConnected(false), so a connected
      // provider always has one.
      return await operation(this.client!);
    } catch (error) {
      throw toDatabaseError(error, this.bootstrap, this.queryTimeout);
    }
  }

  // ==========================================================================
  // Query path (spec 5)
  // ==========================================================================

  public async query(text: string, params?: unknown[]): Promise<QueryResult> {
    // Empty text is the provider's refusal, before anything else (spec 5.1).
    if (text.trim() === "") throw new QueryError(EMPTY_REQUEST_MESSAGE, this.type);
    // A read request has no binding, and dropping the values would run a different read from the
    // one the caller built. An empty list binds nothing and is not a refusal.
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(BOUND_PARAMS_MESSAGE, this.type);
    return this.guarded(async (client) => {
      const started = Date.now();
      const request = parseReadRequest(text, DEFAULT_QUERY_LIMIT);
      // The read runs under the connection's query timeout; every other call is bounded by the
      // client's connect and request timeouts, set to the same value (spec 5.4).
      const outcome = await readMessages(client, request, READ_LIMITS, AbortSignal.timeout(this.queryTimeout));
      return toQueryResult(outcome.rows, Date.now() - started, request.limit, outcome.warnings, outcome.wasLimited);
    });
  }

  // ==========================================================================
  // Object surface (spec 4), answered by `objects.ts`
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return objects.listContainers();
  }

  public countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return this.guarded((client) => objects.countObjects(client, container));
  }

  public listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return this.guarded((client) => objects.listObjects(client, container, kind));
  }

  public describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return this.guarded((client) => objects.describeObject(client, this.getCapabilities(), path, kind));
  }

  public describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    return this.guarded((client) => objects.describeObjects(client, container, kind, limit));
  }

  public readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    return this.guarded((client) => objects.readObjectSource(client, this.getCapabilities(), path, kind, limit));
  }

  // ==========================================================================
  // Monitoring (spec 7.1), answered by `monitoring.ts`
  // ==========================================================================

  /**
   * The log dirs of every listed topic, or undefined where the principal may not read them: a
   * principal without Describe on the cluster is refused them (M-I), and the panels then say N/A
   * rather than fail (KM4). Only that refusal: any other failure is a real one and propagates.
   */
  private async readLogDirs(client: KafkaReadClient) {
    const metadata = await client.metadata();
    try {
      return await client.logDirs(metadata.topics);
    } catch (error) {
      if (error instanceof KafkaError && error.category === "authorization") return undefined;
      throw error;
    }
  }

  /** A broker's configs, or none where the principal may not read them (KM4): `maxConnections` 0 is "no limit published". */
  private async readBrokerConfigs(client: KafkaReadClient, nodeId: number) {
    try {
      return await client.brokerConfigs(nodeId);
    } catch (error) {
      if (error instanceof KafkaError && error.category === "authorization") return [];
      throw error;
    }
  }

  public getHealth(): Promise<HealthInfo> {
    return this.guarded(async (client) => {
      // The forced broker read must succeed; health reads no broker config (spec 7.1, M-I).
      await client.metadata([]);
      return healthFrom(await this.readLogDirs(client));
    });
  }

  public getOverview(): Promise<DatabaseOverview> {
    return this.guarded(async (client) => {
      const metadata = await client.metadata([]);
      // The lowest listed node, so the figure does not move between loads: on KRaft the Metadata
      // answer's controller id is a random live broker (spec 4.1). The client lists brokers in
      // node-id order.
      const [broker] = metadata.brokers;
      if (broker === undefined) throw new KafkaError("protocol", "The broker's metadata listed no live broker");
      const [topics, brokerConfigs, logDirs] = await Promise.all([
        client.listTopics(),
        this.readBrokerConfigs(client, broker.nodeId),
        this.readLogDirs(client),
      ]);
      return overviewFrom({ topicCount: topics.length, brokerConfigs, logDirs });
    });
  }

  public getStorageStats(): Promise<StorageStats[]> {
    return this.guarded(async (client) => storageFrom(await this.readLogDirs(client)));
  }

  /** Every metric is optional, so an empty object is the honest answer: the protocol reports none (spec 7.1). */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: Kafka keeps no query log. `getLabels().slowQueriesEmptyState` says so in the panel. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: the protocol reports no client sessions. `getLabels().sessionsEmptyState` says so in the panel. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: a topic has no honest message count, and `TableStats.rowCount` is required (spec 4.3, 7.1). */
  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Empty: a topic has no index. */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  /** Unreachable behind `supportsMaintenance: false`; a direct call is refused as the Redis provider refuses one. */
  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    this.ensureConnected();
    throw new QueryError(`Unsupported maintenance type for Kafka: ${type}`, this.type);
  }
}
