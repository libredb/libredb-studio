/**
 * The read-only Sparkplug B provider.
 *
 * It browses the groups, edge nodes and devices a broker carries, names and types their metrics
 * from the birth certificates the edge nodes publish, and reads metric values from the data
 * messages. It publishes nothing: no host state, no command, no rebirth request, no will, no
 * retained message. On a Sparkplug system a publish is an actuation, so that is a structural
 * property of this class and not a mode it can be put into.
 *
 * WHAT IS NOT HERE YET, said plainly so nobody reads an absence as a defect.
 *
 * The dial is not here. The shipped MQTT provider carries its transport inside its own directory,
 * and the agreed shape is to move that transport to a shared module first, in a change of its own
 * that alters no behaviour. Until it lands, this class reaches a broker only through the reader
 * seam below, which is also how its tests drive it. A provider built without a seam answers every
 * declaration and refuses to connect, with a sentence that names the missing piece rather than a
 * socket error.
 *
 * No type-id is registered for this class either: no union member, no factory case, no dialect
 * record, no counter. MEASURED on 2026-10-13 in a separate worktree copy, adding the registration
 * without a provider class gives 27 TypeScript errors and three failing factory tests, because
 * `tests/isolated/factory.test.ts` loops over every shipped type-id and builds its provider. So
 * the registration and this class belong in one change, and that change is not this one.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { isTlsFailureCode, type NodeTlsMaterial } from "@/lib/db/http/node-transport";
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
  ObjectSourcePart,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { DatabaseConnection, QueryResult, QueryWarning } from "@/lib/types";
import { DEFAULT_WINDOW_SECONDS, MAX_BYTES_PER_READ, MAX_MESSAGES_PER_READ, SPARKPLUG_DEFAULT_PORT } from "./constants";
import { foldMessages, type UnresolvedValue } from "./fold";
import { SPARKPLUG_LABELS } from "./labels";
import {
  countObjects as countSparkplugObjects,
  listEdgeNodes,
  listGroups,
  listObjects as listSparkplugObjects,
  livenessSentence,
  objectColumns,
  SPARKPLUG_CONTAINER_LEVELS,
  SPARKPLUG_KINDS,
  SPARKPLUG_OBJECT_KINDS,
} from "./objects";
import { sparkplugTlsMaterial } from "./connection-options";
import { describeScope, parseReadQuery } from "./request";
import { buildRows, describeResult, RESULT_FIELDS } from "./results";
import { readOnce, type TransportFactory } from "./session";
import { type EdgeNodeState, ReadState } from "./state";
import { groupIdIsFilterSafe, readFilters } from "./topics";

export { SPARKPLUG_DEFAULT_PORT };

/** What one bounded read asks for. The transport decides how to satisfy it. */
export interface SparkplugReadRequest {
  readonly host: string;
  readonly port: number;
  /**
   * The SSL / TLS panel as the socket takes it, or null for a plain socket.
   *
   * It is part of the REQUEST and not of the transport's own setup because the dialog's panel is
   * part of what the user asked for: a read against a TLS-only broker is a different read from one
   * against a plain port, and a request that cannot carry it leaves the panel with nowhere to go.
   */
  readonly tls?: NodeTlsMaterial | null;
  /** One group, or empty for every group. */
  readonly groupId: string;
  readonly filters: readonly string[];
  /**
   * How long the read subscribes for, in seconds.
   *
   * IT IS HERE BECAUSE THE FIRST VERSION ACCEPTED IT AND THEN THREW IT AWAY. The console request
   * took `seconds` up to 300, the result's own sentence printed it ("42 second window over every
   * group"), and `query()` served rows from the read the CONNECT had already done. So a user who
   * asked for 42 seconds was told they got 42 seconds and got 3. A number a user can set, that is
   * echoed back to them and changes nothing, is worse than one the field does not offer: it reads
   * as a measurement of something.
   *
   * The transport's own read budget is 3 seconds, so a window longer than that needs more than one
   * transport read to satisfy. Whether the transport grows a longer budget or the reader loops is a
   * transport decision and not this module's; what this field fixes is that the number now reaches
   * the thing that reads, so the answer cannot silently be 3.
   */
  readonly windowSeconds: number;
}

/**
 * What one bounded read returns.
 *
 * `endReason` is the budget that ended it, in the user's words, because a read that ended early is
 * a sample and the panel has to be able to say which bound stopped it.
 */
export interface SparkplugReadOutcome {
  readonly state: ReadState;
  /** Values the read carried under an alias nothing in hand could name. Rows are built for them. */
  readonly unresolved?: readonly UnresolvedValue[];
  /** The broker's own reason code, when a refusal carried one. */
  readonly refusalCode?: number;
  /** The runtime's code for the error that ended the dial, when there was one. */
  readonly transportErrorCode?: string;
  readonly endReason: string;
  readonly messagesSeen: number;
  readonly bytesSeen: number;
  /**
   * True when the broker answered the CONNECT with a CONNACK the session accepted.
   *
   * Optional because a seam answers without dialling, and a test handing back a recorded read is
   * not claiming a broker was silent: only a `false` carries that claim.
   */
  readonly handshook?: boolean;
  /** How long the read waited, which is the number a silent plant's sentence needs. */
  readonly elapsedMs?: number;
}

/** The seam a test fills to answer without a broker. Left empty, the provider dials for itself. */
export type SparkplugReader = (request: SparkplugReadRequest) => Promise<SparkplugReadOutcome>;

/**
 * Dial a broker, take one bounded read, and fold what came back into the state the panels answer
 * from.
 *
 * EXPORTED SO IT CAN BE DRIVEN WITHOUT A SOCKET. `openTransport` is the session's own seam: given
 * one, nothing is dialled and no address is resolved, so the whole path from bytes on a wire to a
 * `ReadState` is testable end to end. Left empty, it opens a real socket through the shared egress
 * rule.
 */
export async function dialAndRead(
  request: SparkplugReadRequest,
  openTransport?: TransportFactory,
): Promise<SparkplugReadOutcome> {
  const outcome = await readOnce({
    host: request.host,
    port: request.port,
    filters: request.filters,
    windowMs: request.windowSeconds * 1000,
    ...(request.tls === undefined ? {} : { tls: request.tls }),
    maxMessages: MAX_MESSAGES_PER_READ,
    maxBytes: MAX_BYTES_PER_READ,
    ...(openTransport === undefined ? {} : { openTransport }),
  });
  const folded = foldMessages(outcome.messages);
  return {
    state: folded.state,
    unresolved: folded.unresolved,
    ...(outcome.refusalCode === undefined ? {} : { refusalCode: outcome.refusalCode }),
    ...(outcome.transportErrorCode === undefined ? {} : { transportErrorCode: outcome.transportErrorCode }),
    endReason: outcome.endReason,
    messagesSeen: outcome.messages.length,
    bytesSeen: outcome.bytesSeen,
    handshook: outcome.handshook,
    elapsedMs: outcome.elapsedMs,
  };
}

export class SparkplugProvider extends BaseDatabaseProvider {
  /** The last read. The tree and its rows both come from it, and a refresh replaces it. */
  private last: SparkplugReadOutcome | undefined;

  /**
   * Opens nothing: a provider built only for its declarations touches no socket.
   *
   * `read` is the seam. The integration tests replay a broker's recorded bytes through this same
   * class, so the topic parser, the decoder, the value layer and the birth state are the product's
   * and not a copy of them.
   */
  public constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly read?: SparkplugReader,
  ) {
    super(config, options);
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /** Every member written out: the base class's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      /*
       * The console dialect, which decides the tab type and three offers with it.
       *
       * IT WAS ABSENT UNTIL THE REGISTRATION, AND THE ABSENCE HAD A MEASURED CONSEQUENCE. A `json`
       * provider with no dialect of its own falls back to MongoDB's tab type, and the dialect
       * registry's golden file recorded exactly that: `tabType: "mongodb"`, with column profiling,
       * code generation and a count query all true. Four things this engine cannot do, offered
       * because one line was missing. The union member, the editor record and the registry record
       * arrive together with this line, which is what the compiler was refusing until now.
       */
      queryDialect: "sparkplug",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // One read returns what it saw and there is no page two: a broker has no cursor.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Structural: this class has no code that can write to a broker.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: SPARKPLUG_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: SPARKPLUG_CONTAINER_LEVELS,
      objectKinds: SPARKPLUG_OBJECT_KINDS,
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...SPARKPLUG_LABELS };
  }

  /** A read carries its own budgets, so no limit is added and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 0, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  private request(windowSeconds = DEFAULT_WINDOW_SECONDS): SparkplugReadRequest {
    const host = (this.config.host ?? "").trim();
    if (host === "") throw new DatabaseConfigError("A Sparkplug connection needs a broker address.");
    const port = Number(this.config.port ?? SPARKPLUG_DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new DatabaseConfigError("A Sparkplug connection needs a port between 1 and 65,535.");

    // The Database field names one group, or is empty for every group. Refused here, before any
    // socket exists, because a group holding `+`, `/` or `#` would either widen the subscription
    // past that group or make the filter invalid, and escaping it would hide the mistake.
    const groupId = (this.config.database ?? "").trim();
    if (groupId !== "" && !groupIdIsFilterSafe(groupId))
      throw new DatabaseConfigError(
        'A group name cannot contain "+", "#" or "/": those are MQTT filter characters, and a group ' +
          "holding one cannot be subscribed to on its own. Leave the field empty to read every group.",
      );

    // THE PANEL IS READ HERE, BEFORE ANY SOCKET, for the reason every other refusal in this method
    // is here: a malformed panel is a sentence about the form rather than about the broker.
    const tls = sparkplugTlsMaterial(this.config, host);

    return {
      host,
      port,
      groupId,
      filters: readFilters(groupId === "" ? undefined : groupId),
      windowSeconds,
      tls,
    };
  }

  private reader(): SparkplugReader {
    // NO REFUSAL HERE ANY MORE, and the sentence that used to stand here is the reason this is
    // worth a comment. It said the provider read through the shared MQTT transport, which stopped
    // being true when this provider got its own session, and `provider.test.ts` pinned that sentence
    // with a regular expression, so a false claim read as a verified one. The provider dials for
    // itself now, and the seam is what a test fills to answer without a broker.
    return this.read ?? ((request) => dialAndRead(request));
  }

  public async connect(): Promise<void> {
    const request = this.request();
    const outcome = await this.reader()(request);
    // A DIAL THAT NEVER OPENED IS NOT AN EMPTY READ. The session reports it as an end reason like
    // any other, which is right for the session: it ran and it stopped. It is wrong here, because a
    // connection that was never made has no result to show and a panel drawing "0 rows, ended:
    // dial-failed" reads as a quiet broker rather than a wrong address. Everything else, including
    // a broker that closed on us mid-read, IS a read: it has what it saw and why it stopped.
    // THREE REFUSALS AND THREE SENTENCES, because a reader does something different about each.
    // Everything else IS a read: it has what it saw and why it stopped, so it is kept.
    const code = outcome.refusalCode === undefined ? "" : ` The broker's own reason code was ${outcome.refusalCode}.`;
    // TWO OF THE FOUR ARE NOT QUERY FAILURES, AND THE CLASS IS WHAT THE PANEL READS. A QueryError
    // reaches the route as 400 with no retry; a ConnectionError reaches it as 503, retryable, and
    // carrying the host and port as fields. Measured, before any of this was written: the route
    // answered a dial against an address with nothing on it with `400 QUERY_ERROR`, which tells a
    // user their request was wrong when what was wrong was the address. The two that happen BEFORE
    // a session exists are connection failures; the two that happen after it opened are refusals of
    // this read, and those stay QueryErrors.
    if (outcome.endReason === "dial-failed") {
      // A TLS FAILURE IS NOT AN ADDRESS FAILURE, and the old sentence said it was. The dial ended
      // before any MQTT byte either way, so the end reason is the same; what differs is what the
      // user has to change. The runtime's code decides: a certificate verification name arrives
      // without the `ERR_` prefix (OpenSSL's X509_V_ERR_* names, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
      // measured against a CA that signed nothing), and the host name check is
      // ERR_TLS_CERT_ALTNAME_INVALID. Both are the panel's business; anything else is the address's.
      const code = outcome.transportErrorCode;
      if (code !== undefined && isTlsFailureCode(code))
        throw new ConnectionError(
          `${request.host}:${request.port} presented a certificate Studio does not trust for this host: ` +
            "check the CA certificate under SSL / TLS, and that the certificate names the host set in the " +
            `connection. The runtime's own reason was ${code}.`,
          "sparkplug",
          request.host,
          request.port,
        );
      throw new ConnectionError(
        `Could not open a connection to ${request.host}:${request.port}. Nothing was read, so this is ` +
          "not an empty broker: check the address, the port and whether the broker accepts a connection " +
          "from this machine.",
        "sparkplug",
        request.host,
        request.port,
      );
    }
    if (outcome.endReason === "connect-refused")
      throw new ConnectionError(
        `The broker at ${request.host}:${request.port} refused the connection.${code} The address and the ` +
          "port are right, because a broker answered: what it would not accept is this client.",
        "sparkplug",
        request.host,
        request.port,
      );
    if (outcome.endReason === "wildcards-unavailable")
      throw new QueryError(
        `The broker at ${request.host}:${request.port} says it does not accept wildcard subscriptions, ` +
          "and it said so when the connection opened rather than when the subscription was sent. A " +
          "Sparkplug read has no wildcard-free form: the namespace puts the message type at a fixed " +
          "level, so every filter has to cross it. There is no narrower filter to try here.",
      );
    if (outcome.endReason === "subscription-refused")
      throw new QueryError(
        `The broker at ${request.host}:${request.port} accepted the connection and refused every ` +
          `subscription, so nothing could be read.${code} This is NOT a quiet plant. Brokers commonly ` +
          "refuse the widest filters and grant narrower ones, so naming one group rather than reading " +
          "every group is the first thing to try.",
      );
    // A SOCKET THAT OPENED IS NOT A BROKER THAT ANSWERED, and until this was measured the two were
    // one outcome. A port that accepts TCP and then says nothing gave `time-budget`, zero messages
    // and a panel reading "Connection successful" after the whole window had elapsed: three seconds
    // of waiting reported as a reached plant. The CONNACK is the only evidence that anything there
    // speaks MQTT, so a read that never saw one is a connection failure rather than an empty plant.
    if (outcome.handshook === false)
      throw new ConnectionError(
        `${request.host}:${request.port} accepted a connection and then answered nothing: no CONNACK arrived ` +
          `in ${Math.round((outcome.elapsedMs ?? request.windowSeconds * 1000) / 1000)} seconds. Something is ` +
          "listening on this port, but it is not answering MQTT: check that this is the broker's MQTT port " +
          "rather than its web or metrics port, and that the port does not require TLS.",
        "sparkplug",
        request.host,
        request.port,
      );
    this.last = outcome;
  }

  /**
   * The caution a successful read carries when the broker answered and the plant said nothing.
   *
   * NOT AN ERROR, and that is the measured part: the CONNACK came, so the address and the port are
   * right and a retry changes nothing. What `Connection successful` alone does not say is that the
   * window passed in silence, and the two reasons for that silence - an idle plant, or a group no
   * edge node publishes under - are both the reader's to resolve rather than this provider's.
   */
  public connectWarnings(): QueryWarning[] {
    const outcome = this.last;
    if (outcome === undefined || outcome.messagesSeen > 0) return [];
    const seconds = Math.round((outcome.elapsedMs ?? 0) / 1000);
    return [
      {
        message:
          `The broker accepted the connection and sent nothing for ${seconds} ${seconds === 1 ? "second" : "seconds"}: ` +
          "no birth certificate and no data message arrived on the subscribed filters. An edge node republishes its " +
          "birth on every reconnect and on every rebirth request, so a window this quiet is either an idle plant or " +
          "a group that no edge node publishes under.",
      },
    ];
  }

  public async disconnect(): Promise<void> {
    // Nothing is held open: a read subscribes, takes what the budgets allow and disconnects.
    this.last = undefined;
  }

  private requireRead(): SparkplugReadOutcome {
    if (this.last === undefined) throw new QueryError("This Sparkplug connection is not open.");
    return this.last;
  }

  // ==========================================================================
  // The console read
  // ==========================================================================

  /**
   * One JSON read request, in the Kafka console's style.
   *
   * The parsing, the refusals and the row building all live in their own modules, so this method is
   * only the place they meet: `request.ts` decides what was asked, `results.ts` decides what the
   * rows are, and neither of them can reach a broker.
   */
  public async query(sql: string): Promise<QueryResult> {
    const started = Date.now();
    // Parsed BEFORE the read is touched, so a refused request costs nothing.
    const query = parseReadQuery(sql);
    // A CONSOLE READ IS A READ. It takes a fresh one with the window that was asked for, rather
    // than serving the connect read again: the tree's rows come from the connect read, but a
    // console request names a window and that window has to be the one that runs.
    this.requireRead();
    const read = await this.reader()(this.request(query.seconds));
    const rows = buildRows(read.state, query, read.unresolved ?? []);
    return {
      rows: rows as unknown as Record<string, unknown>[],
      fields: [...RESULT_FIELDS],
      rowCount: rows.length,
      executionTime: Date.now() - started,
      // Two sentences, because a row count alone reads as a total: what the read was, and what it
      // could not answer.
      warnings: [{ message: describeScope(query) }, { message: describeResult(read.state, rows, read.endReason) }],
    };
  }

  // ==========================================================================
  // The tree
  // ==========================================================================

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const read = this.requireRead();
    if (parent === undefined || parent.length === 0) return listGroups(read.state);
    if (parent.length === 1) return listEdgeNodes(read.state, parent[0]);
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    return countSparkplugObjects(this.requireRead().state, container);
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    return listSparkplugObjects(this.requireRead().state, container, kind);
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return {
      path,
      columns: objectColumns(this.requireRead().state, path, kind),
      // A birth certificate declares no index and no foreign key, and an empty list is the honest answer.
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    const state = this.requireRead().state;
    const details = listSparkplugObjects(state, container, kind).map((object) => ({
      path: object.path,
      columns: objectColumns(state, object.path, kind),
      indexes: [],
      foreignKeys: [],
    }));
    return { details };
  }

  /**
   * What this read can say about the node's liveness, as a part of its own rather than a flag.
   *
   * IT IS PROSE BECAUSE THE SHORT FORM IS THE MISLEADING ONE. The tree carries a short status for
   * the two notable cases, and a reader meeting "not seen in this read" needs the rest of it: a node
   * that published nothing during the window and has a stored certificate looks exactly like one
   * that is running and quiet. The sentence says that, so the status cannot be read as "it is gone".
   */
  private static livenessPartFor(node: EdgeNodeState | undefined): ObjectSourcePart[] {
    if (node === undefined) return [];
    return [
      {
        id: "liveness",
        label: "Liveness",
        text: livenessSentence(node),
        // `text` and not `json`: this part is a sentence for a reader, not a document to parse.
        language: "text",
        form: "complete",
        origin: "rendered",
      },
    ];
  }

  /**
   * The decoded birth certificate the definitions came from, as JSON, with its origin.
   *
   * The origin is part of the document rather than a footnote: a stored certificate's values are
   * birth-time values, which the specification states outright, and a reader who cannot see which
   * copy they are looking at will read them as current.
   */
  public async readObjectSource(path: readonly string[], kind: string): Promise<ObjectSourceDocument> {
    const state = this.requireRead().state;
    const node = state.all().find((one) => one.groupId === path[0] && one.edgeNodeId === path[1]);
    const birth = kind === SPARKPLUG_KINDS.device ? node?.devices.get(path[path.length - 1] ?? "") : node?.birth;
    if (birth === undefined)
      return {
        path,
        kind,
        parts: [
          {
            id: "birth",
            label: "Birth certificate",
            unavailable:
              "No birth certificate for this object was seen in this read. A certificate is published at " +
              "QoS 0 and not retained, so a reader that subscribed after it was published gets none from a " +
              "broker that does not store them, and an aware broker had none stored.",
          },
          ...SparkplugProvider.livenessPartFor(node),
        ],
      };
    return {
      path,
      kind,
      parts: [
        {
          id: "birth",
          label: "Birth certificate",
          text: JSON.stringify(
            {
              origin: birth.origin,
              bdSeq: birth.bdSeq ?? null,
              payloadTimestamp: birth.payloadTimestamp ?? null,
              metrics: birth.metrics,
            },
            null,
            2,
          ),
          language: "json",
          // Complete as a certificate: this is the whole decoded message, not an excerpt of one.
          form: "complete",
          origin: birth.origin === "stored" ? "stored" : "rendered",
        },
        ...SparkplugProvider.livenessPartFor(node),
      ],
    };
  }

  // ==========================================================================
  // Surfaces a broker does not have
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    const read = this.last;
    if (read === undefined)
      return { databaseSize: "unknown", cacheHitRatio: "unknown", slowQueries: [], activeSessions: [] };
    const summary = read.state.summary();
    return {
      databaseSize: `${summary.edgeNodes} edge nodes and ${summary.devices} devices seen in the last read`,
      // A broker has no cache a client can read, and saying so is the honest value.
      cacheHitRatio: "unknown",
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const read = this.requireRead();
    const summary = read.state.summary();
    return {
      // The payload convention this provider decodes, not a broker version: a broker publishes none
      // a subscriber can read.
      version: "Sparkplug B, specification 3.0.0",
      uptime: "unknown",
      maxConnections: 0,
      databaseSize:
        `${summary.edgeNodes} edge nodes, ${summary.devices} devices, ` +
        `${summary.birthsStored} stored and ${summary.birthsLive} live birth certificates`,
      // A group is not a table and an edge node is not a table, so counting them here would be a
      // different number wearing the word "table".
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
    throw new QueryError(SPARKPLUG_LABELS.vacuumGlobalDesc);
  }
}
