/**
 * The MQTT provider (#1635): a broker's topic tree, read only, in the Keys panel.
 *
 * READ-ONLY IS STRUCTURAL HERE, NOT A MODE. The encoder has five packets and no function that writes a PUBLISH;
 * CONNECT has no parameter for a Will; and the valve re-checks every outbound byte before it reaches the socket.
 * `enforcesReadOnly` is therefore true whatever the connection's flag says, and there is no path that could make
 * it false.
 *
 * ONE READ FILLS THE PANEL. A session subscribes once, collects what the broker delivers until one of our own
 * budgets ends it, and leaves. The panel's tree is drawn from that read; a refresh replaces it with a new one,
 * and two reads are never merged into one tree.
 *
 * `queryReadOnly` is the agent's: one read of a closed table of two (`agent-statement.ts`), the window over `#`
 * answered as totals and one topic the request names in full answered as its metadata, each a fresh session over the
 * same encoder and valve, and each answer projected to counts and flags (`agent-read.ts`), never a topic name or a
 * payload, and always with the window it listened for and the sentence that a topic not seen may still exist. On a
 * handle opened for any agent-mode profile, connecting is a handshake that subscribes to nothing, and every other
 * surface answers its reason (`agent-surface.ts`). MCP read stays closed on this engine.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { plaintextSecretRefusal } from "@/lib/db/http/endpoint";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import type {
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KeyScanOptions,
  KeyScanPage,
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
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
  ActiveSessionDetails,
  ProviderOptions,
} from "@/lib/db/types";
import { TUNNEL_FAR_END, type DatabaseConnection, type WithTunnelFarEnd } from "@/lib/types";
import {
  MQTT_AGENT_MIN_STATEMENT_MS,
  MQTT_METADATA_ONLY,
  mqttAgentFailure,
  mqttAgentResult,
  mqttAgentShortBudgetSentence,
  runMqttAgentRead,
} from "./agent-read";
import { readMqttAgentStatement } from "./agent-statement";
import { MQTT_AGENT_WITHHELD } from "./agent-surface";
import { MQTT_CONSENT_CLAUSE, MQTT_DEFAULT_PORT, MQTT_MAX_STRING_BYTES, MQTT_TYPE } from "./constants";
import { MQTT_KEY_SCAN, mqttKeyScanPage, readMqttKeyScanOptions } from "./key-scan";
import { MQTT_LABELS } from "./labels";
import {
  countMqttObjects,
  describeMqttObject,
  describeMqttObjects,
  listMqttObjects,
  MQTT_OBJECT_KINDS,
  mqttSourceDocument,
} from "./objects";
import { readTopics, type MqttReadOutcome, type MqttSessionOptions, type MqttTransportFactory } from "./session";

const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const NO_ESTIMATE = "MQTT composes no estimating plan for the agent";

export class MqttProvider extends BaseDatabaseProvider {
  /** The last read. The panel's tree and its rows both come from it, and a refresh replaces it. */
  private last: MqttReadOutcome | undefined;

  /**
   * The pattern of the last first page served from `last`, or undefined before the connect read was served.
   *
   * A REFRESH IS THE SAME QUESTION ASKED AGAIN. The panel asks for a first page when it opens, when its
   * refresh button is pressed, and on every change of its pattern box. Only the second means "read the broker
   * again": a changed pattern narrows the read already held, so typing a prefix opens no connection, and the
   * first page after connect is the connect read itself, so opening a connection costs one read and not two.
   */
  private servedPattern: string | undefined;

  /**
   * Opens nothing: a provider built only for its declarations touches no socket.
   *
   * `execution` is the execution context the factory passes, which tells an agent-mode handle from an editor one.
   * `openTransport` is the test seam. The integration tests replay a broker's recorded bytes through this same
   * class, so the CONNECT, the framing, the inbound limit and the decoder are the product's and not a copy.
   */
  public constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly openTransport?: MqttTransportFactory,
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
   * handle does. On such a handle no surface names a topic or reads a payload; the editor's handles keep every read.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  /** The refusal of a surface an agent-mode handle does not read, after the connection check every surface makes. */
  private agentWithheld(sentence: string): never {
    this.ensureConnected();
    throw new QueryError(sentence, MQTT_TYPE);
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      // Declared so a connection does not fall through to MongoDB's tab type, which `resolveTabType` gives
      // every `json` provider with no dialect of its own. "json" here means only "not SQL".
      queryDialect: "mqtt",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // One read returns what it saw and there is no page two, which the cursor of `MQTT_KEY_SCAN` states.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Structural: this provider has no code that can write to a broker.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: MQTT_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: MQTT_OBJECT_KINDS,
      keyScan: MQTT_KEY_SCAN,
      // Topic names and payloads are stored values: an agent read answers counts and flags.
      metadataOnly: MQTT_METADATA_ONLY,
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...MQTT_LABELS };
  }

  /** A read carries its own budgets, so no limit is added and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 0, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  private sessionOptions(): MqttSessionOptions {
    const config = this.config as DatabaseConnection & WithTunnelFarEnd;
    // The typed filter is trimmed here, where it is read; a topic name passed to `readTopics` is not.
    const filter = (config.database ?? "").trim();
    const host = (config.host ?? "").trim();
    if (host === "") throw new DatabaseConfigError("An MQTT connection needs a broker address.", MQTT_TYPE);
    const port = Number(config.port ?? MQTT_DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new DatabaseConfigError("An MQTT connection needs a port between 1 and 65,535.", MQTT_TYPE);
    // EVERY TYPED FIELD THAT BECOMES AN MQTT STRING IS BOUNDED HERE, before a socket exists. `encodeString`
    // already refused a string over 65,535 bytes, but it refused it inside a socket listener, where the
    // throw was an uncaught exception that ended the Node process. The filter is bounded in `readFilter`.
    for (const [label, value] of [
      ["broker address", host],
      ["username", config.user ?? ""],
      ["password", config.password ?? ""],
    ] as const) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > MQTT_MAX_STRING_BYTES)
        throw new DatabaseConfigError(
          `An MQTT ${label} holds at most ${MQTT_MAX_STRING_BYTES.toLocaleString("en-US")} bytes, and this ` +
            `one is ${bytes.toLocaleString("en-US")}.`,
          MQTT_TYPE,
        );
    }
    // `ssl.mode` is the connection's own SSL / TLS panel; "disable" is the only value that means plain TCP.
    const mode = config.ssl?.mode;
    const tls = mode !== undefined && mode !== "disable";
    const farEnd = config[TUNNEL_FAR_END];
    const user = config.user === undefined || config.user === "" ? undefined : config.user;
    const password = config.password === undefined || config.password === "" ? undefined : config.password;

    // A CREDENTIAL WITHOUT TLS IS REFUSED, which is what the dialog's own hint already promised and what no
    // code did. Every other engine with a secret calls this helper - Oxia, InfluxDB, Databend, Db2, S3 - and
    // this provider called nothing, so a password typed against a remote broker with the SSL mode on
    // `disable` went out as plaintext inside the CONNECT packet with the override box unticked. The override
    // is the reader's informed consent, not a default.
    const plaintext = plaintextSecretRefusal({
      host,
      tunnelled: config.sshTunnel?.enabled === true,
      tls,
      hasSecret: password !== undefined,
    });
    if (plaintext !== undefined && config.allowInsecureAuth !== true)
      throw new DatabaseConfigError(`${plaintext}${MQTT_CONSENT_CLAUSE}`, MQTT_TYPE);

    return {
      host,
      port,
      tls,
      // The house rule, stated in `src/lib/types.ts`: `require` encrypts and verifies nothing, because a
      // self-hosted broker ordinarily presents a self-signed certificate; every `verify-` mode verifies.
      // This passed nothing unless the reader set the flag, so `dialBroker`'s own default made `require`
      // verify - refusing the ordinary local TLS broker the hint under the selector says it accepts.
      ...(tls ? { rejectUnauthorized: config.ssl?.rejectUnauthorized ?? mode !== "require" } : {}),
      // THE CERTIFICATE BELONGS TO THE BROKER, NOT TO THE FORWARD. Through an SSH tunnel `host` is the local
      // end the socket dials, so checking the certificate against it fails for every correctly issued one.
      // The identity is the far end, which is what `tlsAgentOptions` does for every HTTP provider.
      ...(farEnd === undefined ? {} : { tlsIdentity: farEnd.host }),
      ...(config.ssl?.caCert === undefined || config.ssl.caCert === "" ? {} : { caCert: config.ssl.caCert }),
      ...(config.ssl?.clientCert === undefined || config.ssl.clientCert === ""
        ? {}
        : { clientCert: config.ssl.clientCert }),
      ...(config.ssl?.clientKey === undefined || config.ssl.clientKey === ""
        ? {}
        : { clientKey: config.ssl.clientKey }),
      ...(user === undefined ? {} : { user }),
      ...(password === undefined ? {} : { password }),
      // The connection's Database field carries the discovery filter, as Oxia's carries a namespace.
      ...(filter === "" ? {} : { filter }),
      ...(this.openTransport === undefined ? {} : { openTransport: this.openTransport }),
    };
  }

  /**
   * One read, which is both the connection test and the tree the panel draws. On an agent-mode handle it is a handshake
   * that subscribes to nothing: it proves the broker answers and accepts the credentials, and holds no topic, since every
   * agent read is a fresh session of its own.
   */
  public async connect(): Promise<void> {
    if (this.agentProfile) await readTopics({ ...this.sessionOptions(), handshakeOnly: true });
    else this.last = await readTopics(this.sessionOptions());
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.last = undefined;
    this.servedPattern = undefined;
    this.setConnected(false);
  }

  private requireRead(): MqttReadOutcome {
    if (this.last === undefined) throw new QueryError("This MQTT connection is not open.", MQTT_TYPE);
    return this.last;
  }

  /**
   * The read a page is drawn from: the connect read the first time, and a new read on every refresh after.
   *
   * A broker has no cursor, so every walk is one page and a first page is the only request that can mean
   * "read the broker again". `cursor` is `0` for a first page and nothing else ever asks for one, which is
   * why the decision can be made here rather than through a separate action the panel would have to learn.
   */
  private async readForPage(options: KeyScanOptions): Promise<MqttReadOutcome> {
    const held = this.requireRead();
    const first = options.cursor === undefined || options.cursor === "" || options.cursor === "0";
    if (!first) return held;
    const pattern = options.pattern ?? "";
    if (this.servedPattern !== pattern) {
      this.servedPattern = pattern;
      return held;
    }
    const fresh = await readTopics(this.sessionOptions());
    this.last = fresh;
    return fresh;
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  /** The console read is not in this version: the Keys panel is the surface, and it needs no query text. */
  public async query(text = ""): Promise<QueryResult> {
    if (this.agentProfile) {
      this.ensureConnected();
      throw new RefusedBeforeSendError(MQTT_AGENT_WITHHELD.query, MQTT_TYPE, text);
    }
    throw new QueryError(
      "This version reads a broker through the Keys panel. There is no query text to send: MQTT has no query " +
        "language, and no command that lists topics.",
      MQTT_TYPE,
    );
  }

  /**
   * One agent read request. Only on a handle opened under the agent read-only profile; the request is read by
   * `readMqttAgentStatement` and refused before anything is sent when it is not one read of the closed table, or when
   * the read's time budget cannot hold a whole window. Then the read is one fresh session, Clean Start and nothing kept,
   * over the encoder and the valve, and its answer is the metadata-only projection with its window and the completeness
   * sentence, refused past the byte budget. A failure is worded by its kind, never by the broker's or the transport's
   * words.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    if (!this.readOnlyProfile) throw new RefusedBeforeSendError(PROFILE_REQUIRED, MQTT_TYPE, statement);
    this.ensureConnected();
    assertReadOnlyBudget(budget, MQTT_TYPE);
    if (mode !== "execute") throw new RefusedBeforeSendError(NO_ESTIMATE, MQTT_TYPE, statement);
    const reading = readMqttAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, MQTT_TYPE, statement);
    if (budget.statementTimeoutMs < MQTT_AGENT_MIN_STATEMENT_MS) {
      throw new RefusedBeforeSendError(mqttAgentShortBudgetSentence(budget.statementTimeoutMs), MQTT_TYPE, statement);
    }
    const started = Date.now();
    try {
      const answer = await runMqttAgentRead(this.sessionOptions(), reading.plan, budget);
      return mqttAgentResult(answer, budget, statement, Date.now() - started);
    } catch (error) {
      throw mqttAgentFailure(error, budget.statementTimeoutMs, statement) ?? error;
    }
  }

  /** A broker has one key space, so no container level is declared and none is listed. */
  public async listContainers(): Promise<Container[]> {
    return [];
  }

  public async countObjects(): Promise<Record<string, KindCount>> {
    return countMqttObjects();
  }

  public async listObjects(_container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.topics);
    return listMqttObjects(kind);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.topics);
    return describeMqttObject(path, kind);
  }

  public async describeObjects(_container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.topics);
    return describeMqttObjects(kind);
  }

  /**
   * A topic's payload.
   *
   * The payload is fetched on demand rather than held: the tree needs addresses, and holding every payload is
   * the one thing that makes a reader slow enough for a broker to start dropping messages on its behalf.
   */
  public async readObjectSource(path: readonly string[], kind: string): Promise<ObjectSourceDocument> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.source);
    const topic = path[path.length - 1] ?? "";
    // MQTT 5.0 section 4.7.3: a topic name is at least one character, and an empty filter here would read `#`.
    if (topic === "") throw new DatabaseConfigError("A topic name is at least one character long.", MQTT_TYPE);
    // A second read, subscribed to that one topic, which is the only read that keeps a payload.
    const read = await readTopics({ ...this.sessionOptions(), filter: topic, keepPayloadFor: topic });
    return mqttSourceDocument(path, kind, read.topics.get(topic));
  }

  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    // Refused before the read is touched, so a refused page costs nothing.
    readMqttKeyScanOptions(options);
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.keys);
    const read = await this.readForPage(options);
    return mqttKeyScanPage(read.topics, options, {
      scope: read.scope,
      endReason: read.endReason,
      provenLoss: read.provenLoss,
      ...(read.endCode === undefined ? {} : { endCode: read.endCode }),
    });
  }

  // ==========================================================================
  // Surfaces a broker does not have
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.health);
    const read = this.last;
    return {
      databaseSize:
        read === undefined
          ? "unknown"
          : `${read.topics.size.toLocaleString("en-US")} ${read.topics.size === 1 ? "topic" : "topics"}`,
      // A broker has no cache a client can read, and saying "unknown" is the honest value.
      cacheHitRatio: "unknown",
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.overview);
    const read = this.requireRead();
    return {
      version: "MQTT 5.0",
      // A broker publishes no uptime a subscriber can read.
      uptime: "unknown",
      maxConnections: 0,
      databaseSize: `${read.topics.size.toLocaleString("en-US")} topics seen in the last read`,
      // A broker has no tables and no indexes, and a topic count is not a table count.
      tableCount: 0,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.performance);
    return {};
  }

  // On an agent-mode handle each empty answer below would read as the broker's own; the reason is answered instead.

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.slowQueries);
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.sessions);
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.tableStats);
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.indexStats);
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    if (this.agentProfile) this.agentWithheld(MQTT_AGENT_WITHHELD.storage);
    return [];
  }

  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(MQTT_LABELS.vacuumGlobalDesc, MQTT_TYPE);
  }
}
