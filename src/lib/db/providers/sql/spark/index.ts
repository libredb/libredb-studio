/**
 * Apache Spark over Spark Connect: one Spark session per request scope plus a provider-owned metadata session that
 * never receives user text, every result read through the bounded decoder, and every failure mapped once, here, onto
 * the repository's error classes. Studio treats every Spark statement as write-capable: Spark has no engine-side
 * read-only mode, so no read-only surface is declared.
 *
 * The constructor validates nothing and opens nothing, so a census builds the provider unconnected. Its third argument
 * replaces the wire transport for a test; the factory never passes it.
 */
import { QueryError } from "@/lib/db/errors";
import {
  assertContainerPathShape,
  assertObjectPathShape,
  type ContainerPathShapeEngine,
  findKind,
  type ObjectPathShapeEngine,
} from "@/lib/db/object-kinds";
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
  ObjectKindSpec,
  ObjectSourceDocument,
  OpenQueryTransactionOutcome,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderLabels,
  ProviderOptions,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { logger } from "@/lib/logger";
import type { DatabaseConnection, DatabaseType, QueryResult, QueryWarning, WithTunnelFarEnd } from "@/lib/types";
import { SQLBaseProvider } from "../sql-base";
import { buildSparkConnectionOptions, type SparkConnectionOptions, sparkErrorConnection } from "./connection-options";
import {
  SPARK_CONTROL_DEADLINE_MS,
  SPARK_DEFAULT_PORT,
  SPARK_HEARTBEAT_DEADLINE_MS,
  SPARK_INTROSPECT_IN_FLIGHT_MAX,
  SPARK_REFUSED_SESSION_MAP_MAX,
  SPARK_RUN_TAG_PREFIX,
  SPARK_STREAM_MAX_RECEIVED_BYTES,
} from "./constants";
import {
  SPARK_ERROR_SENTENCES,
  SparkError,
  type SparkErrorConnection,
  sparkVersionText,
  toDatabaseError,
  toSparkError,
} from "./errors";
import { SparkRuns, type SparkStatementResult } from "./execute";
import {
  grpcWireTransport,
  type SparkPlanStream,
  sparkCallMetadata,
  type SparkWireCall,
  type SparkWireChannel,
  type SparkWireTransport,
} from "./grpc-client";
import { SparkHeartbeat } from "./heartbeat";
import * as introspect from "./introspect";
import { readHealth, readOverview, SPARK_MONITORING_LABELS, type SparkMonitoringDeps } from "./monitoring";
import {
  configGetAllRequest,
  configGetOptionRequest,
  configSetRequest,
  releaseSessionRequest,
  type SparkSessionRef,
  sqlCommandRequest,
  versionRequest,
} from "./requests";
import { readCommandAnswer, SPARK_CUT_WARNINGS } from "./result-stream";
import { SparkSessions } from "./session";
import { scriptBlockRefusal, SPARK_STATEMENT_SENTENCES, unicodeSpaceRefusal, uriFormRefusal } from "./statement-shape";
import { meetsSparkFloor, parseSparkVersion } from "./version";

const SPARK: DatabaseType = "spark";
/** Below the namespace level nothing nests: an answer, not a refusal. */
const CONTAINER_DEPTH = 2;
/** A setup statement's stream takes the same bound on bytes received as a run's. */
const SETUP_LIMITS = { maxReceivedBytes: SPARK_STREAM_MAX_RECEIVED_BYTES };

/** The provider's own sentences: the maintenance refusal, and the two cards the panel never draws, worded true. */
export const SPARK_PROVIDER_SENTENCES = Object.freeze({
  maintenanceRefused: "Apache Spark has no maintenance operations in Studio.",
  analyzeGlobalDesc:
    "Spark computes table statistics with ANALYZE TABLE, which runs a job on the cluster; Studio does not run it in this version.",
  vacuumGlobalDesc:
    "Spark has no VACUUM of its own; table formats such as Delta and Iceberg run their own maintenance.",
});

/** How `assertContainerPathShape` and `assertObjectPathShape` name this engine in a refusal. */
const SPARK_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: SPARK,
  label: "An Apache Spark",
  shapeNames: "label",
};
const SPARK_OBJECT_PATH_ENGINE: ObjectPathShapeEngine = {
  code: SPARK,
  label: "An Apache Spark",
  attachedSegment: "required",
};

/** The three kinds the tree lists: tables and views carry columns and a definition, functions neither. */
export const SPARK_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "table",
    role: "relation",
    label: "Table",
    labelPlural: "Tables",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "sql",
  },
  {
    id: "view",
    role: "relation",
    label: "View",
    labelPlural: "Views",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "sql",
  },
  { id: "function", role: "routine", label: "Function", labelPlural: "Functions", hasColumns: false, hasSource: false },
] as const);

/**
 * The probe session ids of connects refused at the version check, by connection id and configured endpoint, which is
 * the far end under an SSH tunnel: the tunnel's local forward listens on a new ephemeral port for each attempt, so the
 * channel target changes from one attempt to the next. A server without ReleaseSession keeps a session until it idles
 * out, so the next connect of the same connection reads the version on the remembered id, and repeated refusals hold
 * one server session, not one per attempt. Past the bound the oldest entry is dropped; a connect that meets the floor,
 * or that released its probe, removes its connection's entry.
 */
const REFUSED_PROBES = new Map<string, string>();

function rememberRefusedProbe(key: string, sessionId: string): void {
  REFUSED_PROBES.delete(key);
  REFUSED_PROBES.set(key, sessionId);
  for (const oldest of REFUSED_PROBES.keys()) {
    if (REFUSED_PROBES.size <= SPARK_REFUSED_SESSION_MAP_MAX) break;
    REFUSED_PROBES.delete(oldest);
  }
}

/** The test seam: absent, the real gRPC adapter is used. */
export interface SparkDeps {
  readonly transport: SparkWireTransport;
}

/** A metadata statement waiting for a slot: granted one in arrival order, or refused. */
interface SlotWaiter {
  readonly grant: () => void;
  readonly refuse: (error: SparkError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The metadata statements in flight on one connection, at most SPARK_INTROSPECT_IN_FLIGHT_MAX. The namespace walk keeps
 * its own batches to that bound, but two tree expansions and a count or a bulk column read at the same moment would
 * pass it on one channel, so every metadata statement runs in a slot. A statement waits for a free slot in arrival
 * order, and the wait counts against its deadline: one still waiting when its deadline passes is refused unsent, with
 * the sentence of a statement whose timeout passed before Studio could send it. A slot is given back however its
 * statement ends. Once the connection closes, every statement still waiting, and every later one, is refused as
 * cancelled.
 */
class SparkMetadataSlots {
  private free = SPARK_INTROSPECT_IN_FLIGHT_MAX;
  private readonly waiting: SlotWaiter[] = [];
  private closed = false;

  constructor(private readonly timeoutMs: number) {}

  /** Runs `statement` once a slot is free, and gives the slot back when it ends. */
  async run<T>(deadline: Date, statement: () => Promise<T>): Promise<T> {
    await this.take(deadline);
    try {
      return await statement();
    } finally {
      this.giveBack();
    }
  }

  /** Refuses every statement still waiting, and every later one; the slots in use come back as their statements end. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.refuse(new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled));
    }
  }

  private take(deadline: Date): Promise<void> {
    if (this.closed) return Promise.reject(new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled));
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: SlotWaiter = {
        grant: resolve,
        refuse: reject,
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          reject(new SparkError("deadline", SPARK_ERROR_SENTENCES.deadlineBeforeSend(this.timeoutMs)));
        }, deadline.getTime() - Date.now()),
      };
      this.waiting.push(waiter);
    });
  }

  /** A slot given back goes to the statement that has waited longest, or is free again. */
  private giveBack(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.free += 1;
      return;
    }
    clearTimeout(next.timer);
    next.grant();
  }
}

/**
 * `waiting` until `deadline`: when the deadline passes first, the statement that waits is refused with `sentence`, and
 * what it waited for goes on.
 */
function beforeDeadline<T>(waiting: Promise<T>, deadline: Date, sentence: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SparkError("deadline", sentence)), deadline.getTime() - Date.now());
  });
  return Promise.race([waiting, passed]).finally(() => clearTimeout(timer));
}

/** One opened channel with everything that runs over it. */
interface SparkConnection {
  readonly options: SparkConnectionOptions;
  readonly channel: SparkWireChannel;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sessions: SparkSessions;
  readonly runs: SparkRuns;
  readonly metadataSlots: SparkMetadataSlots;
  /**
   * The connect's version read and its probe's release, from the moment the read is sent, each call under its control
   * deadline. It never rejects, the connect meets their failures itself, and the close waits for it before it closes
   * the channel, so a release still to be sent goes out on an open channel.
   */
  probe: Promise<void>;
}

/** One completed statement as the grid's result; a cut is reported with its warning and on `pagination.wasLimited`. */
function toQueryResult(result: SparkStatementResult, executionTime: number): QueryResult {
  return {
    fields: result.fields,
    rows: result.rows,
    rowCount: result.rows.length,
    executionTime,
    ...(result.fields.length === 0 ? {} : { columnTypes: result.columnTypes }),
    ...(result.cut === null
      ? {}
      : {
          warnings: [{ message: SPARK_CUT_WARNINGS[result.cut] }],
          pagination: {
            limit: MAX_UNLIMITED_ROWS,
            offset: 0,
            hasMore: false,
            totalReturned: result.rows.length,
            wasLimited: true,
          },
        }),
  };
}

/** The `server_side_session_id` of a Config answer or an ExecutePlan response, or "" when it carries none. */
function serverSideId(answer: unknown): string {
  const id = (answer as { server_side_session_id?: unknown } | undefined)?.server_side_session_id;
  return typeof id === "string" ? id : "";
}

/**
 * A control call, a session's Config set among them, with its failure mapped. The session registry maps no failure and
 * repeats a metadata read only for a SparkError of the categories session-closed and session-changed, so every session
 * setup step, and every metadata read that is not a run, maps its own failure: here, or for a setup statement in the
 * setup phase. Unmapped, a closed session would never be read again on a new one, and a server's text would reach a
 * sentence without passing serverText.
 */
async function mapControl<T>(connection: SparkErrorConnection, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSparkError(error, { connection, phase: "control" });
  }
}

/** A setup statement's own ids: a new operation and a new tag, never a run's. */
function setupIds() {
  return { operationId: crypto.randomUUID(), tag: `${SPARK_RUN_TAG_PREFIX}${crypto.randomUUID()}` };
}

/** Reads a setup statement's answer to its end, past progress and metrics, and answers the server-side id it carried. */
async function readSetupAnswer(stream: SparkPlanStream): Promise<string> {
  let observed = "";
  const read = stream.read.bind(stream);
  stream.read = async () => {
    const response = await read();
    observed = serverSideId(response) || observed;
    return response;
  };
  await readCommandAnswer(stream);
  return observed;
}

export class SparkProvider extends SQLBaseProvider {
  /** The connected channel, its sessions and its runs. */
  private connection: SparkConnection | null = null;
  /** The connection `connect()` is still opening, so `disconnect()` can end it too. */
  private connecting: SparkConnection | null = null;
  /** Connections whose close is still stopping their runs and releasing their sessions. */
  private readonly closing = new Set<SparkConnection>();
  /** Each connection's one close, from the moment it began: none is closed twice, and every caller waits for it. */
  private readonly closes = new WeakMap<SparkConnection, Promise<void>>();
  /** How many connects began: each connect takes the next number when it begins. */
  private connectsBegun = 0;
  /** Session releases in progress, each under the control deadline. */
  private releasing = 0;

  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly deps: Partial<SparkDeps> = {},
  ) {
    super(config, options);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "spark-text",
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsColumnProfiling: false,
      supportsTransactions: false,
      supportsSqlFormat: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: SPARK_DEFAULT_PORT,
      identifierQuoting: "backtick-always",
      containerNameSpelling: "engine",
      schemaRefreshPattern: "^\\s*(CREATE|DROP|ALTER|REPLACE|REPAIR|MSCK)\\b",
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
      ],
      containerPathShapes: "exact",
      objectKinds: SPARK_OBJECT_KINDS,
      agentWalkScope: { mode: "session-default", whenNoDefault: { walk: "parent-default-children" } },
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeGlobalTitle: "Not Run from Studio",
      analyzeGlobalDesc: SPARK_PROVIDER_SENTENCES.analyzeGlobalDesc,
      vacuumGlobalTitle: "Not Run from Studio",
      vacuumGlobalDesc: SPARK_PROVIDER_SENTENCES.vacuumGlobalDesc,
      statementLanguage: "Spark SQL",
      slowQueriesEmptyState: SPARK_MONITORING_LABELS.slowQueriesEmptyState,
      sessionsEmptyState: SPARK_MONITORING_LABELS.sessionsEmptyState,
    };
  }

  // -- control calls -------------------------------------------------------------------------------------------------

  /**
   * A control call: its own deadline from the moment it is sent, and a signal no run aborts. A heartbeat beat passes
   * SPARK_HEARTBEAT_DEADLINE_MS; every other control call takes SPARK_CONTROL_DEADLINE_MS.
   */
  private static control(
    metadata: Readonly<Record<string, string>>,
    deadlineMs: number = SPARK_CONTROL_DEADLINE_MS,
  ): SparkWireCall {
    return { metadata, deadline: new Date(Date.now() + deadlineMs), signal: new AbortController().signal };
  }

  /** AnalyzePlan spark_version on `session`: one unary call, no Spark job; "" when the answer carries no text. */
  private static async version(
    connection: Pick<SparkConnection, "channel" | "metadata">,
    session: SparkSessionRef,
  ): Promise<string> {
    const answer = await connection.channel.unary(
      "AnalyzePlan",
      versionRequest(session),
      SparkProvider.control(connection.metadata),
    );
    const version = (answer as { spark_version?: { version?: unknown } | null }).spark_version?.version;
    return typeof version === "string" ? version : "";
  }

  /** The channel and everything that runs over it; sends nothing. */
  private open(options: SparkConnectionOptions): SparkConnection {
    const channel = (this.deps.transport ?? grpcWireTransport)(options);
    const metadata = sparkCallMetadata(options.token);
    const errorConnection = sparkErrorConnection(options);
    const control = () => SparkProvider.control(metadata);
    const sessions = new SparkSessions(
      {
        // Each setup step maps its own failure, and answers the server-side id of its answer, which the registry
        // observes before the session's first run.
        configSet: (session, pairs) =>
          mapControl(errorConnection, async () =>
            serverSideId(await channel.unary("Config", configSetRequest(session, pairs), control())),
          ),
        // SET CATALOG and USE NAMESPACE can wait on a catalog that is slow on first use, so both share the
        // connection's query timeout from the setup's start, and a failure names its statement.
        runSetup: async (session, sql, setupStart) => {
          const call: SparkWireCall = {
            metadata,
            deadline: new Date(setupStart + options.callTimeoutMs),
            signal: new AbortController().signal,
          };
          try {
            return await readSetupAnswer(
              channel.executePlan(sqlCommandRequest(session, sql, setupIds()), call, SETUP_LIMITS),
            );
          } catch (error) {
            throw toSparkError(error, {
              connection: errorConnection,
              phase: "setup",
              step: sql,
              timeoutMs: options.callTimeoutMs,
            });
          }
        },
        release: async (session) => {
          try {
            await channel.unary("ReleaseSession", releaseSessionRequest(session), control());
          } catch (error) {
            // The registry swallows the failure. The log names only its category, never the server's text or the token.
            const { category } = toSparkError(error, { connection: errorConnection, phase: "control" });
            logger.warn("A Spark session release failed", { category });
            throw error;
          }
        },
      },
      { catalog: options.catalog, namespace: options.namespace },
    );
    // Each beat goes on the run's own session and channel, under its own deadline; a failed beat ends nothing.
    const heartbeat = new SparkHeartbeat(async (session) => {
      await channel.unary(
        "Config",
        configGetOptionRequest(session, ["spark.sql.ansi.enabled"]),
        SparkProvider.control(metadata, SPARK_HEARTBEAT_DEADLINE_MS),
      );
    });
    const runs = new SparkRuns({
      channel: () => channel,
      metadata,
      heartbeat,
      sessions,
      errorConnection,
      timeoutMs: options.callTimeoutMs,
    });
    return {
      options,
      channel,
      metadata,
      sessions,
      runs,
      metadataSlots: new SparkMetadataSlots(options.callTimeoutMs),
      probe: Promise.resolve(),
    };
  }

  // -- lifecycle -----------------------------------------------------------------------------------------------------

  /**
   * The option checks, the channel, the version read on a probe session, the metadata session's setup, then the current
   * catalog and namespace read. A failure closes what it opened and is mapped once. A second `connect()` replaces the
   * first connection and closes it; when the second fails, it closes the first connection too, so no connection stays
   * open behind a provider that reports itself disconnected. A connect still running when a second one starts is
   * displaced: its connection's close begins at once, so it sends nothing more but its probe's release, and it ends
   * cancelled. One still running when a disconnect begins ends cancelled too. A connect answers once every connection it
   * replaced or displaced is closed.
   */
  public async connect(): Promise<void> {
    const generation = ++this.connectsBegun;
    let options: SparkConnectionOptions | undefined;
    let opened: SparkConnection | null = null;
    // The connection of a connect still opening that this one displaced.
    let overtaken: SparkConnection | null = null;
    try {
      options = buildSparkConnectionOptions(this.config as DatabaseConnection & WithTunnelFarEnd, {
        queryTimeout: this.queryTimeout,
      });
      opened = this.open(options);
      overtaken = this.connecting;
      this.connecting = opened;
      if (overtaken !== null) {
        // Its close begins now, so the displaced connect sends nothing more but its probe's release. This connect waits
        // for that close before it answers and meets its failure there; the handler here only keeps a failure that
        // lands before then from being reported as unhandled.
        this.close(overtaken).catch(() => undefined);
      }
      await this.checkVersion(opened);
      await this.metadataSql(opened, "SHOW CURRENT NAMESPACE");
      // A disconnect() or a second connect() took this connection while it opened: this connect ended cancelled.
      if (this.connecting !== opened) throw new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled);
    } catch (error) {
      // A disconnect() or a second connect() took this connection from `connecting`: this connect ended cancelled,
      // whatever its own call met then, a failure of the channel a disconnect closed included, so it never reports a
      // server that answered as unreachable.
      const taken = opened !== null && this.connecting !== opened;
      // Once a later connect began, whether it displaced this one or began after a disconnect took it, this connect
      // leaves the provider's state to that later connect, whatever became of it since: still opening, connected,
      // failed, or connected and then disconnected.
      const displaced = this.connectsBegun !== generation;
      // A refusal of the option checks is already the repository's DatabaseConfigError.
      const failure = toDatabaseError(
        taken
          ? new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled)
          : options === undefined
            ? error
            : toSparkError(error, { connection: sparkErrorConnection(options), phase: "connect" }),
      );
      // Not displaced, the failure becomes the provider's state at once, before any close awaits, so a connect that
      // completes during the closes keeps its own; the connection this one was to replace is closed too.
      const previous = displaced ? null : this.connection;
      if (!displaced) {
        this.connection = null;
        this.setError(failure);
      }
      if (opened !== null && this.connecting === opened) this.connecting = null;
      // Every close starts at once, so no connection waits outside `connection`, `connecting` and `closing` for
      // another's close, and a Stop reaches its runs throughout. A close rejects only when a channel's close() throws,
      // and that error then reaches this connect's caller in place of its own failure.
      await Promise.all(
        [opened, previous, overtaken]
          .filter((item): item is SparkConnection => item !== null)
          .map((item) => this.close(item)),
      );
      throw failure;
    }
    this.connecting = null;
    const previous = this.connection;
    this.connection = opened;
    this.setConnected(true);
    await Promise.all(
      [previous, overtaken].filter((item): item is SparkConnection => item !== null).map((item) => this.close(item)),
    );
  }

  /**
   * The version read on a probe session before any setup, and the floor. The probe is released whatever the version:
   * a connect that meets the floor sets up a metadata session of its own, because the session registry creates every
   * session id itself, and a refused one leaves no session behind on a server that offers ReleaseSession. A probe is
   * remembered for the next connect of this connection when it was refused, for a version below the floor or for one
   * Studio cannot read, and the server cannot release it, having no ReleaseSession.
   * The read and the release are the connection's probe from the moment the read is sent, so a close that begins
   * between the version answer and the release, a disconnect's or a second connect's, waits for the release before it
   * closes the channel.
   */
  private async checkVersion(connection: SparkConnection): Promise<void> {
    const probed = this.readVersionOnProbe(connection);
    // The connect meets a failure of the read through `probed`; the close only waits.
    connection.probe = probed.then(
      () => undefined,
      () => undefined,
    );
    const refusal = await probed;
    if (refusal !== undefined) throw new SparkError("version", refusal);
  }

  /** The version read on the probe session and the probe's release; answers the version check's refusal, if any. */
  private async readVersionOnProbe(connection: SparkConnection): Promise<string | undefined> {
    const { host, port } = connection.options.endpoint;
    const key = `${this.config.id}\u0000${host}\u0000${port}`;
    const probe: SparkSessionRef = { sessionId: REFUSED_PROBES.get(key) ?? crypto.randomUUID() };
    const text = await SparkProvider.version(connection, probe);
    const version = parseSparkVersion(text);
    // A server's text: sparkVersionText withholds a token in it and bounds it before a sentence quotes it.
    const shown = sparkVersionText(text, connection.options.secretForms);
    const refusal =
      version === undefined
        ? SPARK_ERROR_SENTENCES.versionUnreadable(shown)
        : meetsSparkFloor(version)
          ? undefined
          : SPARK_ERROR_SENTENCES.versionTooOld(shown);
    if (refusal === undefined) REFUSED_PROBES.delete(key);
    try {
      await connection.channel.unary(
        "ReleaseSession",
        releaseSessionRequest(probe),
        SparkProvider.control(connection.metadata),
      );
      // A released id is closed on the server, so no later connect may read on it.
      REFUSED_PROBES.delete(key);
    } catch (error) {
      const { category } = toSparkError(error, {
        connection: sparkErrorConnection(connection.options),
        phase: "control",
      });
      if (refusal !== undefined && category === "unimplemented") rememberRefusedProbe(key, probe.sessionId);
    }
    return refusal;
  }

  /**
   * Closes `connection` once: the close that began first is recorded before any of it runs, and every caller, a
   * disconnect, a failed connect or one that displaced another, waits for that one. It rejects only when the channel's
   * close() throws, and then every caller meets that error.
   */
  private close(connection: SparkConnection): Promise<void> {
    const began = this.closes.get(connection);
    if (began !== undefined) return began;
    const closed = Promise.withResolvers<void>();
    this.closes.set(connection, closed.promise);
    closed.resolve(this.tearDown(connection));
    return closed.promise;
  }

  /**
   * Refuses the metadata statements still waiting for a slot and closes the session registry, both at once, then stops
   * every run, releases every session under the control deadline, waits for the connect's version read and its probe's
   * release, and closes the channel. The refusals come first, so no slot a stopped run gives back starts a statement,
   * and no session setup or metadata read sends anything while the runs are being stopped.
   */
  private async tearDown(connection: SparkConnection): Promise<void> {
    this.closing.add(connection);
    this.releasing += 1;
    connection.metadataSlots.close();
    connection.sessions.close();
    try {
      await connection.runs.cancelAll();
      await connection.sessions.releaseAll();
      await connection.probe;
    } finally {
      // The bookkeeping comes first, so a channel whose close() throws leaves nothing closing and nothing in flight.
      this.releasing -= 1;
      this.closing.delete(connection);
      connection.channel.close();
    }
  }

  /**
   * Ends the connected connection and one still opening, and answers once every close in progress has ended, one a
   * displaced or a failed connect began included, so no channel of this provider is left open; idempotent.
   */
  public async disconnect(): Promise<void> {
    const open = [this.connection, this.connecting, ...this.closing].filter(
      (item): item is SparkConnection => item !== null,
    );
    this.connection = null;
    this.connecting = null;
    this.setConnected(false);
    await Promise.all(open.map((item) => this.close(item)));
  }

  /** The caution for a connection that sends no token, whose server ran its calls; nothing with a token. */
  public connectWarnings(): QueryWarning[] {
    const options = this.connection?.options;
    if (options === undefined || options.token !== undefined) return [];
    return [{ message: SPARK_ERROR_SENTENCES.tokenlessCaution(options.endpoint.host, options.endpoint.port) }];
  }

  /**
   * Test Connection only. With a token configured, one AnalyzePlan without it on a fresh session id, under the control
   * deadline, and, when it was answered, ReleaseSession of that id the same way: an answer means the server runs calls
   * without checking a token. A refusal or any other failure answers []. Without a token nothing is sent, because
   * `connectWarnings()` already cautions.
   */
  public async testConnectionWarnings(): Promise<QueryWarning[]> {
    const connection = this.connection;
    if (connection === null || connection.options.token === undefined) return [];
    const bare = { channel: connection.channel, metadata: sparkCallMetadata(undefined) };
    const probe: SparkSessionRef = { sessionId: crypto.randomUUID() };
    try {
      await SparkProvider.version(bare, probe);
    } catch {
      return [];
    }
    try {
      await bare.channel.unary("ReleaseSession", releaseSessionRequest(probe), SparkProvider.control(bare.metadata));
    } catch {
      // The caution stands; the server drops an unreleased session after its idle timeout.
    }
    const { host, port } = connection.options.endpoint;
    return [{ message: SPARK_ERROR_SENTENCES.tokenUnchecked(host, port) }];
  }

  /** True while a run, or a session release, of any of this provider's connections is in progress. */
  public hasRunsInFlight(): boolean {
    return this.releasing > 0 || this.reachable().some((connection) => connection.runs.runsInFlight() > 0);
  }

  /** The connected connection, one still opening, and every one whose close is still stopping its runs. */
  private reachable(): SparkConnection[] {
    return [this.connection, this.connecting, ...this.closing].filter(
      (connection): connection is SparkConnection => connection !== null,
    );
  }

  private requireConnection(): SparkConnection {
    this.ensureConnected();
    return this.connection as SparkConnection;
  }

  // -- statements ----------------------------------------------------------------------------------------------------

  /**
   * One statement in its scope's session (a statement session without a scope). Bound parameters, a scripting block, a
   * Unicode space and an unquoted address Studio's reader reads differently are refused before any call.
   */
  public async query(sql: string, params?: unknown[], queryId?: string, scope?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) {
      throw new QueryError(SPARK_STATEMENT_SENTENCES.boundParameters, this.type, sql);
    }
    const refusal = scriptBlockRefusal(sql) ?? unicodeSpaceRefusal(sql) ?? uriFormRefusal(sql);
    if (refusal !== undefined) throw new QueryError(refusal, this.type, sql);
    const connection = this.requireConnection();
    try {
      const { result, executionTime } = await this.trackQuery(() =>
        this.measureExecution(() =>
          connection.runs.run({
            sql,
            queryId,
            session: () => connection.sessions.forScope(scope),
            deadline: new Date(Date.now() + connection.options.callTimeoutMs),
          }),
        ),
      );
      return toQueryResult(result, executionTime);
    } catch (error) {
      throw toDatabaseError(error, sql);
    }
  }

  /**
   * Stop: true once the run settled as cancelled within the control deadline, false for an unknown or finished run. A
   * run on a connection whose close is still stopping it is reached too.
   */
  public async cancelQuery(queryId: string): Promise<boolean> {
    const answers = await Promise.all(this.reachable().map((connection) => connection.runs.cancel(queryId)));
    return answers.includes(true);
  }

  /**
   * Releases the scope's request session. Spark has no transaction across statements, so there is never one to roll
   * back, and the answer is always "none".
   */
  public async endOpenQueryTransaction(scope?: string): Promise<OpenQueryTransactionOutcome> {
    const connection = this.connection;
    if (scope === undefined || connection === null) return "none";
    this.releasing += 1;
    try {
      await connection.sessions.endScope(scope);
    } finally {
      this.releasing -= 1;
    }
    return "none";
  }

  // -- the metadata session ------------------------------------------------------------------------------------------

  /**
   * One statement the provider wrote, in one of the connection's metadata slots, on the metadata session, read again
   * once on a new one when the server closed it. Its deadline is the connection's query timeout from now, unless the
   * read it belongs to passes the read's own, and its waits count against it: the wait for a slot, and the wait for the
   * metadata session's setup, the first one and the repeat's. A statement whose deadline passes before it is sent is
   * refused with the not-sent sentence. The repeat comes only after the statement was sent on the session the server
   * closed, so a repeat whose deadline passes before it is sent again, waiting for the new session's setup or at its
   * send, is refused with the sentence of a lost metadata session instead.
   */
  private metadataSql(
    connection: SparkConnection,
    sql: string,
    deadline: Date = new Date(Date.now() + connection.options.callTimeoutMs),
  ): Promise<SparkStatementResult> {
    const beforeSend = (repeat: boolean) =>
      repeat ? () => SPARK_ERROR_SENTENCES.metadataSessionLost : SPARK_ERROR_SENTENCES.deadlineBeforeSend;
    return connection.metadataSlots.run(deadline, () =>
      connection.sessions.readMetadata(
        (session, repeat) =>
          connection.runs.run({ sql, session: async () => session, deadline, deadlineBeforeSend: beforeSend(repeat) }),
        (setup, repeat) => beforeDeadline(setup, deadline, beforeSend(repeat)(connection.options.callTimeoutMs)),
      ),
    );
  }

  /** Config get_all under `prefix` on the metadata session; Spark answers each key with the prefix removed. */
  private confAll(connection: SparkConnection, prefix: string): Promise<Readonly<Record<string, string>>> {
    return connection.sessions.readMetadata(async (session) => {
      const answer = await mapControl(sparkErrorConnection(connection.options), () =>
        connection.channel.unary(
          "Config",
          configGetAllRequest(session, prefix),
          SparkProvider.control(connection.metadata),
        ),
      );
      const pairs = (answer as { pairs?: readonly { key?: unknown; value?: unknown }[] | null }).pairs ?? [];
      return Object.fromEntries(
        pairs.map((pair) => [String(pair.key), typeof pair.value === "string" ? pair.value : ""]),
      );
    });
  }

  /** The tree's statements on `connection`; given `deadline`, every statement of the read runs under that one. */
  private introspectDeps(connection: SparkConnection, deadline?: Date): introspect.SparkIntrospectDeps {
    return {
      runSql: (sql) => this.metadataSql(connection, sql, deadline),
      confKeys: async (prefix) => Object.keys(await this.confAll(connection, prefix)),
    };
  }

  private monitoringDeps(connection: SparkConnection): SparkMonitoringDeps {
    return {
      // A server's text, shown as the connect path quotes it: a token withheld and the length bounded.
      version: async () =>
        sparkVersionText(
          await connection.sessions.readMetadata((session) =>
            mapControl(sparkErrorConnection(connection.options), () => SparkProvider.version(connection, session)),
          ),
          connection.options.secretForms,
        ),
      confAll: (prefix) => this.confAll(connection, prefix),
      currentNamespace: async () => (await this.metadataSql(connection, "SHOW CURRENT NAMESPACE")).rows.at(0),
      tableCount: async (catalog, namespace) =>
        (await introspect.listObjects(this.introspectDeps(connection), [catalog, namespace], "table")).length,
    };
  }

  /**
   * Every read of the tree and the panels: connected, and every failure mapped once. A read whose connection's close
   * began, a disconnect's or a second connect's, ended cancelled, whatever its call met then, so a channel that close
   * shut is never reported as a server that did not answer.
   */
  private async surface<T>(read: (connection: SparkConnection) => Promise<T>): Promise<T> {
    const connection = this.requireConnection();
    try {
      return await read(connection);
    } catch (error) {
      throw toDatabaseError(
        this.closes.has(connection) ? new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled) : error,
      );
    }
  }

  /** A `[catalog, namespace]` container, refused at any other depth before any statement. */
  private container(container: readonly string[]): readonly string[] {
    assertContainerPathShape(this.getCapabilities(), container, SPARK_CONTAINER_PATH_ENGINE);
    return container;
  }

  /** A `[catalog, namespace, name]` path of a declared kind, refused otherwise before any statement. */
  private objectPath(path: readonly string[], kind: string): readonly string[] {
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) throw new QueryError(introspect.SPARK_INTROSPECT_SENTENCES.noKind(kind), this.type);
    assertObjectPathShape(capabilities, spec, kind, path, SPARK_OBJECT_PATH_ENGINE);
    return path;
  }

  // -- the object surface --------------------------------------------------------------------------------------------

  public async listContainers(parent: readonly string[] = []): Promise<Container[]> {
    if (parent.length >= CONTAINER_DEPTH) {
      this.ensureConnected();
      return [];
    }
    return this.surface((connection) =>
      parent.length === 0
        ? introspect.listCatalogs(this.introspectDeps(connection))
        : introspect.listNamespaces(this.introspectDeps(connection), parent[0]),
    );
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const checked = this.container(container);
    return this.surface((connection) => introspect.countObjects(this.introspectDeps(connection), checked));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const checked = this.container(container);
    return this.surface((connection) => introspect.listObjects(this.introspectDeps(connection), checked, kind));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const checked = this.objectPath(path, kind);
    return this.surface((connection) => introspect.describeObject(this.introspectDeps(connection), checked, kind));
  }

  /**
   * One deadline for the whole read: its listing and every DESCRIBE TABLE share the connection's query timeout from the
   * read's start, so each statement runs in the time that is left. Once that time is up the read fails as a statement
   * past the timeout fails, with no details, and sends nothing more.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const checked = this.container(container);
    return this.surface((connection) => {
      const deadline = new Date(Date.now() + connection.options.callTimeoutMs);
      return introspect.describeObjects(this.introspectDeps(connection, deadline), checked, kind, limit);
    });
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const checked = this.objectPath(path, kind);
    return this.surface((connection) =>
      introspect.readObjectSource(this.introspectDeps(connection), checked, kind, limit),
    );
  }

  // -- panels --------------------------------------------------------------------------------------------------------

  public async getOverview(): Promise<DatabaseOverview> {
    return this.surface((connection) => readOverview(this.monitoringDeps(connection)));
  }

  /** One AnalyzePlan on the metadata session, which also keeps that session from idling out. */
  public async getHealth(): Promise<HealthInfo> {
    return this.surface((connection) => readHealth(this.monitoringDeps(connection)));
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

  /** No Spark SQL statement lists indexes. */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    throw new QueryError(SPARK_MONITORING_LABELS.tablesRefused, this.type);
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    throw new QueryError(SPARK_MONITORING_LABELS.storageRefused, this.type);
  }

  /** Unreachable behind supportsMaintenance: false; a direct call is refused with its sentence. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(SPARK_PROVIDER_SENTENCES.maintenanceRefused, this.type);
  }
}
