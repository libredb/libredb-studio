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
 *
 * `queryReadOnly` is the agent's: one read of a closed table of metadata reads (`agent-statement.ts`), sent through
 * the agent's client, which holds the Metadata and ListOffsets reads alone, and answered through a metadata-only
 * projection (`agent-metadata-read.ts`): topic names, partitions, broker node ids and racks, the cluster id and each
 * partition's earliest and end offsets, never a record's key, value, headers or timestamp, a broker's host and port,
 * a config, a log directory or a consumer group. On a handle opened for any agent-mode profile every other surface
 * goes through that client too (`agent-surface.ts`): the editor's read and an object's source are refused, and what
 * needs a withheld read answers its reason. MCP read stays closed on this engine.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { assertReadOnlyBudget, rowBudgetSentence } from "@/lib/db/providers/sql/read-only-budget";
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
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import {
  KAFKA_AGENT_TOPIC_COLUMNS,
  KAFKA_METADATA_ONLY,
  kafkaAgentFailure,
  kafkaAgentResult,
  runKafkaAgentRead,
} from "./agent-metadata-read";
import { readKafkaAgentStatement } from "./agent-statement";
import { agentCountObjects, agentHealth, agentListObjects, KAFKA_AGENT_WITHHELD } from "./agent-surface";
import { type KafkaAgentReadClient, KafkaError, type KafkaReadClient } from "./client";
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

/**
 * A package that does not resolve, in the form that names it: "Cannot find module 'ajv/dist/core'", the
 * specifier a CommonJS require named, under Node and Bun alike, and "Cannot find package '@scope/name'"
 * for an ES module import of a package no install holds, which Bun also writes for a subpath its
 * installed package lacks. The measured failure takes the first form, since `ajv-draft-04` requires
 * `ajv/dist/core` from CommonJS. The Next.js server wraps an external package's load failure in an Error
 * of its own that keeps this text and drops the code, so the text is what is read. A package name only,
 * scoped or not, with or without a subpath; a failure written otherwise is not read and surfaces as
 * itself, such as Node's ES module loader's for a subpath its installed package lacks, as when the
 * package sits at another major, which names the file by its absolute path, as it names a relative import.
 */
const UNRESOLVED_PACKAGE = /Cannot find (?:module|package) '((?:@[\w.~-]+\/)?[\w~-][\w.~-]*(?:\/[^']*)?)'/;

/**
 * The refusal of a client library that cannot load because the installation does not resolve a package
 * it requires (spec 3.2): a host that installs with bun can hold an ajv 6 where the library's
 * `ajv-draft-04` looks for ajv 8. It names the package and never quotes the runtime's text, which
 * carries the server's paths. Anything else answers undefined, and surfaces as itself.
 */
function unloadableLibrary(error: unknown): KafkaError | undefined {
  const specifier = error instanceof Error ? UNRESOLVED_PACKAGE.exec(error.message)?.[1] : undefined;
  if (specifier === undefined) return undefined;
  return new KafkaError(
    "invalid-config",
    `The Kafka client library could not be loaded: the module "${specifier}" it requires does not resolve in this installation. See docs/providers/kafka.md section 2.5`,
  );
}

/** Every read is held to the same bounds (spec 5.4, K5). */
const READ_LIMITS: ReadLimits = { resultByteBudget: KAFKA_RESULT_BYTE_BUDGET, cellLimit: KAFKA_CELL_LIMIT };

const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const NO_ESTIMATE = "Kafka composes no estimating plan for the agent";

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
    private readonly execution: ProviderExecutionContext = {},
    private readonly createClient: (o: KafkaConnectionOptions) => Promise<KafkaReadClient> = defaultCreateClient,
  ) {
    super(config, options);
  }

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `queryReadOnly` answer; the operations profile's acquisitions send no statement.
   */
  private get readOnlyProfile(): boolean {
    return this.execution.readOnly === true && this.execution.sendsStatements === true;
  }

  /**
   * Whether this handle was opened for any agent-mode profile: every execution profile opens `readOnly` and no editor
   * handle does. On such a handle every surface reads through the agent's client; the editor's own handles keep every
   * read.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  /**
   * The connected client narrowed to the agent's reads: a new object holding the Metadata and ListOffsets reads alone,
   * so no other method of the client is reachable from an agent-mode surface, whatever its type says.
   */
  private agentClient(): KafkaAgentReadClient {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    const client = this.client!;
    return {
      metadata: (topics) => client.metadata(topics),
      listTopics: () => client.listTopics(),
      offsets: (topic, at) => client.offsets(topic, at),
    };
  }

  /** One agent-mode surface over the agent's client, whose failure is worded by its category alone. */
  private async agentGuarded<T>(operation: (client: KafkaAgentReadClient) => Promise<T>): Promise<T> {
    const client = this.agentClient();
    try {
      return await operation(client);
    } catch (error) {
      throw kafkaAgentFailure(error, this.queryTimeout) ?? error;
    }
  }

  /** The refusal of a surface an agent-mode handle does not read, after the connection check every surface makes. */
  private agentWithheld(sentence: string): never {
    this.ensureConnected();
    throw new QueryError(sentence, this.type);
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
      supportsTransactions: false,
      supportsMaintenance: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
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
      // A record's key, value, headers and timestamp are stored values: an agent read answers names, counts and flags.
      metadataOnly: KAFKA_METADATA_ONLY,
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
      // The library loads with the first client, so a package the installation cannot resolve fails
      // here, and only here is it the library's (spec 3.2).
      client = await this.createClient(this.connectionOptions).catch((error: unknown) => {
        throw unloadableLibrary(error) ?? error;
      });
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
    // The editor's read fetches records, whose cells are stored values: never on an agent-mode handle.
    if (this.agentProfile) {
      this.ensureConnected();
      throw new RefusedBeforeSendError(KAFKA_AGENT_WITHHELD.query, this.type, text);
    }
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

  /**
   * One agent read request. Only on a handle opened under the agent read-only profile; the request is read by
   * `readKafkaAgentStatement` and refused before anything is sent when it is not one read of the closed table or when
   * its limit passes the row budget. Then the read runs over the agent's client, Metadata and ListOffsets alone, under
   * the request's time budget, with nothing kept from one call for the next, and its answer is the metadata-only
   * projection, refused past the byte budget. A failure is worded by its category, never by the broker's words.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    this.ensureConnected();
    if (!this.readOnlyProfile) throw new RefusedBeforeSendError(PROFILE_REQUIRED, this.type, statement);
    assertReadOnlyBudget(budget, this.type);
    if (mode !== "execute") throw new RefusedBeforeSendError(NO_ESTIMATE, this.type, statement);
    const reading = readKafkaAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, this.type, statement);
    if (reading.plan.limit > budget.maxResultRows) {
      const sentence = rowBudgetSentence(reading.plan.limit, budget.maxResultRows);
      throw new RefusedBeforeSendError(sentence, this.type, statement);
    }
    const started = Date.now();
    try {
      const answer = await runKafkaAgentRead(this.agentClient(), reading.plan, budget.statementTimeoutMs);
      return kafkaAgentResult(answer, budget, statement, Date.now() - started);
    } catch (error) {
      throw kafkaAgentFailure(error, budget.statementTimeoutMs, statement) ?? error;
    }
  }

  // ==========================================================================
  // Object surface (spec 4), answered by `objects.ts`
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return objects.listContainers();
  }

  public countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    if (this.agentProfile) return this.agentGuarded((client) => agentCountObjects(client, container));
    return this.guarded((client) => objects.countObjects(client, container));
  }

  public listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    if (this.agentProfile) return this.agentGuarded((client) => agentListObjects(client, container, kind));
    return this.guarded((client) => objects.listObjects(client, container, kind));
  }

  /** A topic's columns: the agent read's on an agent-mode handle, so no surface names a record cell there. */
  public describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    if (this.agentProfile) {
      return this.agentGuarded((client) =>
        objects.describeObject(client, this.getCapabilities(), path, kind, KAFKA_AGENT_TOPIC_COLUMNS),
      );
    }
    return this.guarded((client) => objects.describeObject(client, this.getCapabilities(), path, kind));
  }

  public describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    if (this.agentProfile) {
      return this.agentGuarded((client) =>
        objects.describeObjects(client, container, kind, limit, KAFKA_AGENT_TOPIC_COLUMNS),
      );
    }
    return this.guarded((client) => objects.describeObjects(client, container, kind, limit));
  }

  /** An object's source holds configs, group members and committed offsets: refused on an agent-mode handle. */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.source);
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
    if (this.agentProfile) return this.agentGuarded(agentHealth);
    return this.guarded(async (client) => {
      // The forced broker read must succeed; health reads no broker config (spec 7.1, M-I).
      await client.metadata([]);
      return healthFrom(await this.readLogDirs(client));
    });
  }

  public async getOverview(): Promise<DatabaseOverview> {
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.overview);
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

  public async getStorageStats(): Promise<StorageStats[]> {
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.storage);
    return this.guarded(async (client) => storageFrom(await this.readLogDirs(client)));
  }

  /** Every metric is optional, so an empty object is the honest answer: the protocol reports none (spec 7.1). */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  /** Empty: Kafka keeps no query log. `getLabels().slowQueriesEmptyState` says so in the panel. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    // On an agent-mode handle an empty answer would read as the broker's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.slowQueries);
    this.ensureConnected();
    return [];
  }

  /** Empty: the protocol reports no client sessions. `getLabels().sessionsEmptyState` says so in the panel. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    // On an agent-mode handle an empty answer would read as the broker's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.sessions);
    this.ensureConnected();
    return [];
  }

  /** Empty: a topic has no honest message count, and `TableStats.rowCount` is required (spec 4.3, 7.1). */
  public async getTableStats(): Promise<TableStats[]> {
    // On an agent-mode handle an empty answer would read as the broker's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.tableStats);
    this.ensureConnected();
    return [];
  }

  /** Empty: a topic has no index. */
  public async getIndexStats(): Promise<IndexStats[]> {
    // On an agent-mode handle an empty answer would read as the broker's own; the reason is answered instead.
    if (this.agentProfile) this.agentWithheld(KAFKA_AGENT_WITHHELD.indexStats);
    this.ensureConnected();
    return [];
  }

  /** Unreachable behind `supportsMaintenance: false`; a direct call is refused as the Redis provider refuses one. */
  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    this.ensureConnected();
    throw new QueryError(`Unsupported maintenance type for Kafka: ${type}`, this.type);
  }
}
