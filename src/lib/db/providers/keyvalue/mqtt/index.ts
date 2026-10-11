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
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { plaintextSecretRefusal } from "@/lib/db/http/endpoint";
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
  ProviderLabels,
  QueryResult,
  SlowQueryStats,
  StorageStats,
  TableStats,
  ActiveSessionDetails,
  ProviderOptions,
} from "@/lib/db/types";
import { TUNNEL_FAR_END, type DatabaseConnection, type WithTunnelFarEnd } from "@/lib/types";
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
   * `openTransport` is the test seam. The integration tests replay a broker's recorded bytes through this same
   * class, so the CONNECT, the framing, the inbound limit and the decoder are the product's and not a copy.
   */
  public constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly openTransport?: MqttTransportFactory,
  ) {
    super(config, options);
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
      supportsCreateTable: false,
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

  /** One read, which is both the connection test and the tree the panel draws. */
  public async connect(): Promise<void> {
    this.last = await readTopics(this.sessionOptions());
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
  public async query(): Promise<QueryResult> {
    throw new QueryError(
      "This version reads a broker through the Keys panel. There is no query text to send: MQTT has no query " +
        "language, and no command that lists topics.",
      MQTT_TYPE,
    );
  }

  /** A broker has one key space, so no container level is declared and none is listed. */
  public async listContainers(): Promise<Container[]> {
    return [];
  }

  public async countObjects(): Promise<Record<string, KindCount>> {
    return countMqttObjects();
  }

  public async listObjects(_container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return listMqttObjects(kind);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeMqttObject(path, kind);
  }

  public async describeObjects(_container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    return describeMqttObjects(kind);
  }

  /**
   * A topic's payload.
   *
   * The payload is fetched on demand rather than held: the tree needs addresses, and holding every payload is
   * the one thing that makes a reader slow enough for a broker to start dropping messages on its behalf.
   */
  public async readObjectSource(path: readonly string[], kind: string): Promise<ObjectSourceDocument> {
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
    return {};
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(MQTT_LABELS.vacuumGlobalDesc, MQTT_TYPE);
  }
}
