/**
 * MTConnect provider (#1722): one agent's device model, its current values, its buffer of recent
 * observations and its assets, read only, over the agent's REST interface.
 *
 * COMPOSITION AND DELEGATION ONLY. The route table is `routes.ts`, everything refused before a
 * socket opens is `guard.ts`, the one request is `client.ts`, the XML is `xml.ts`, the device model
 * is `model.ts`, a row is `rows.ts`, and what the provider declares about itself is
 * `capabilities.ts`. What stays here is the lifecycle, the declarations and the seams.
 *
 * Read only whatever the connection's `readOnly` flag says: the client offers one operation, a GET
 * of a route from a closed table, and there is no method argument or body parameter anywhere in it.
 * That is the shape rather than a setting, and it has to be, because MEASURED on the pinned agent
 * with `AllowPut = true` the agent's own Swagger grows from 15 operations to 39, among them a PUT
 * that sets an observation.
 *
 * No `queryReadOnly`: the console text is a request line rather than a query language, so there is
 * no agent statement execution and no MCP read query.
 *
 * The type id is not yet a member of the published `DatabaseType` union. That line and the factory's
 * `case` are the last step of this provider's PR, because six other issues queue for the same two
 * files; until then this class is exported and unreferenced by the factory, and the directory's
 * README records the two lines and the local alias they delete.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { httpOrigin, type HttpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport } from "@/lib/db/http/node-transport";
import { engineLimiter } from "@/lib/db/utils/bounded-limiter";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  MaintenanceResult,
  ObjectDetail,
  ObjectSourceDocument,
  ProviderOptions,
  ObjectDetailBatch,
  PerformanceMetrics,
  ProviderCapabilities,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { assertContainerPathShape, type ContainerPathShapeEngine } from "@/lib/db/object-kinds";
import {
  MTCONNECT_CONTAINER_LEVEL,
  MTCONNECT_DEFAULT_PORT,
  MTCONNECT_HEALTH_REQUEST,
  MTCONNECT_HEALTH_UNKNOWN,
  MTCONNECT_OBJECT_KINDS,
  MTCONNECT_QUERY_DIALECT,
} from "./capabilities";
import {
  headerOf,
  MtcClientError,
  readObservations,
  readOnce,
  type MtcAnswer,
  type MtcClientOptions,
} from "./client";
import {
  guardRequestLine,
  MtcRefusal,
  type MtcGuardOptions,
  type MtcRequest,
  type MtcWindow,
} from "./guard";
import { indexMtconnectModel, modelIsCurrent, type MtcModel } from "./model";
import type { MtcElement, MtcObservation } from "./xml";
import type { MtcOp } from "./routes";
import { buildRow, rowsFromAssets, rowsFromModel, sortRows, type MtcRow } from "./rows";

/** One agent's session: the transport, the held model and the window the cursor is read against. */
interface MtcSession {
  readonly origin: HttpOrigin;
  readonly pathPrefix: string;
  readonly transport: NodeTransport;
  model: MtcModel | undefined;
  window: MtcWindow | undefined;
}

const NOT_CONNECTED = "Provider is not connected. Call connect() first.";

/** How a refusal spells the container path: by the level's label, which reads "[Device]". */
const MTC_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: "mtconnect",
  label: "An MTConnect",
  shapeNames: "label",
};
/**
 * The rows one read answers at most, and the number a reader is refused against.
 *
 * CHOSEN, NOT MEASURED, and said so rather than dressed as a measurement. What IS measured is what
 * bounds it: `current` is about 164 bytes an observation, so ten thousand rows is about 1.6 MB of
 * answer, an order below the byte caps in `client.ts`; and the richest model measured answers 478
 * observations, so the cap is more than twenty times the largest real answer and still bounds a
 * generated one. No agent was found whose useful read needs more, and none was measured that does.
 *
 * EXPORTED so a test can bind the NUMBER and not only the mechanism. The guard takes `rowCap` as an
 * argument, which is right - the bound belongs to the read - but every unit test passed its own
 * literal, so the default this provider actually sends was held by nothing: the constant could have
 * become 1 and the suite would have stayed green while every reader got one row.
 */
export const ROW_CAP = 10_000;

/**
 * One permit per agent, measured rather than chosen.
 *
 * MEASURED on the pinned agent: while a 300 alternative `path` ran in a loop, the median of
 * `sample?count=1` on the same agent rose from 1.4 ms to 74.1 ms. The agent serves the machine's own
 * clients too, so this bound is about not degrading the shop floor's monitoring rather than about
 * our own latency (decision K-61).
 */
export const MTC_LIMITS = Object.freeze({
  /** MEASURED: the 1.4 ms to 74.1 ms figure above. One request at a time per agent. */
  perProvider: 1,
  /** CHOSEN: four agents read at once from one Studio, which is a load on this process rather than on any agent. */
  perEngine: 4,
  /** CHOSEN: a queue deeper than this is a reader waiting longer than they will tolerate anyway. */
  queueDepth: 64,
});

const limiterFor = engineLimiter("mtconnect", MTC_LIMITS);

/**
 * The options a typed request line is read with, as a function so the three things it carries can be
 * asserted without a socket.
 *
 * MEASURED, and this is why it is not inline any more: with `window` set to `undefined` where this
 * is built, every one of the 202 tests stayed green. The guard's window rules are tested, but with a
 * window the TEST supplies; that the provider hands over the window it read from the agent's own
 * Header was held by nothing, and without it `from`, `to` and `count` stop being checked against the
 * buffer that exists and start being checked against no buffer at all.
 */
export function guardOptionsFor(session: Pick<MtcSession, "window">, model: MtcModel): MtcGuardOptions {
  return {
    window: session.window,
    rowCap: ROW_CAP,
    knownDevices: new Set(model.devices.flatMap((device) => [device.name, device.uuid])),
  };
}

export class MTConnectProvider extends BaseDatabaseProvider {
  private session: MtcSession | null = null;
  private readonly limiter = limiterFor();

  /**
   * `options` IS CARRIED, and dropping it would have been a silent loss rather than a tidy-up.
   *
   * MEASURED: the factory resolves the connection's own `queryTimeout` into `options` before it
   * builds anything (`factory.ts`, `options = { ...options, queryTimeout: options.queryTimeout ??
   * connection.queryTimeout }`), and `BaseDatabaseProvider` reads it there
   * (`base-provider.ts:153`, `options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT`). This provider then
   * uses `this.queryTimeout` twice: the limiter's permit wait and the request's own abort signal. So
   * a constructor that ignored `options` would quietly replace a reader's configured timeout with the
   * default, on every read, with nothing failing. Every sibling takes it; this one does too.
   */
  public constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      // Only the fields `ProviderCapabilities` declares. `supportsSchemas` was in an earlier draft
      // and is not one of them; a cast had been hiding that too.
      // `"json"` because a dialect is declared, not because the text is JSON. The field is a closed
      // union of five languages and a request line is none of them; the type says a dialect is
      // declared "only beside queryLanguage: json", and it is what the dialect-less readers fall
      // back to. The same pair kubectl and S3 declare for a command line, for the same reason, and
      // `queryDialect` below is what every reader that matters consults first.
      queryLanguage: "json",
      // The grammar the text really is: one request line, a route from a closed table of nine, in
      // the agent's own URL grammar with GET implied. The union member landed with this provider's
      // registration; it was absent in an earlier draft and the field was left out rather than cast,
      // which is how the third shared line this provider needed was found.
      queryDialect: MTCONNECT_QUERY_DIALECT,
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Read-only whatever the connection's flag says: the client has one operation and it is a GET.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: MTCONNECT_DEFAULT_PORT,
      statementTerminator: "none",
      // No read changes what the tree shows, so no answer ever asks for a refresh. The pattern that
      // matches nothing is how the repository spells that.
      schemaRefreshPattern: "(?!)",
      // One container level, the device. The shape is the repository's, not a guess: `id` is
      // "catalog" or "schema" and the plural field is `labelPlural`, as RabbitMQ's virtual host
      // level declares it. An earlier draft wrote `plural` and hid the mismatch behind a cast.
      containerLevels: [{ id: "schema", label: MTCONNECT_CONTAINER_LEVEL.label, labelPlural: "Devices" }],
      containerPathShapes: "exact",
      objectKinds: MTCONNECT_OBJECT_KINDS,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  public async connect(): Promise<void> {
    const scheme = this.config.ssl === undefined || this.config.ssl === null ? "http" : "https";
    const origin = httpOrigin(scheme, this.config.host, this.config.port ?? MTCONNECT_DEFAULT_PORT);
    const transport = createNodeTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      // RabbitMQ's three settings, for the reasons MEASURED there and here: a link-local address is
      // refused before any socket, a 101 is refused at once, and an unreachable host is reported.
      refusesLinkLocal: true,
      refusesUpgrade: true,
      reportsUnreachable: true,
      requestHeaderNames: ["accept"],
    });
    this.session = {
      origin,
      pathPrefix: "/",
      transport,
      model: undefined,
      window: undefined,
    };
    // `connect()` proves an MTConnect agent is answering and reads the window, with the one read
    // every schema version from 1.3 to 2.8 answers. MEASURED on three models: 908 to 960 bytes in
    // 2 to 4 ms, and the size does not grow with the model.
    await this.readWindow();
    this.state = { ...this.state, connected: true };
  }

  public async disconnect(): Promise<void> {
    this.session?.transport.close();
    this.session = null;
    this.state = { ...this.state, connected: false };
  }

  private require(): MtcSession {
    if (this.session === null) throw new DatabaseConfigError(NOT_CONNECTED, this.type);
    return this.session;
  }

  private clientOptions(session: MtcSession): MtcClientOptions {
    return {
      origin: session.origin,
      pathPrefix: session.pathPrefix,
      transport: session.transport,
      withPermit: async (run) => {
        // The limiter's own API: a ticket is acquired and released, so the permit is held for
        // exactly the request and released whatever the request does.
        const ticket = await this.limiter.acquire(AbortSignal.timeout(this.queryTimeout));
        try {
          return await run();
        } finally {
          ticket.release();
        }
      },
      signal: AbortSignal.timeout(this.queryTimeout),
    };
  }

  /**
   * EVERY REFUSAL LEAVES THIS PROVIDER AS A `QueryError`, and that is a correctness rule rather than
   * a style one (#1722).
   *
   * MEASURED on `origin/main`: `providers/platform/kubernetes/objects.ts:348` turns a `QueryError` or
   * a `TimeoutError` into `{ unavailable: error.message }` and RE-THROWS anything else, and
   * `errors.ts:244` defines `isQueryError` as `instanceof QueryError`. So a refusal thrown as a plain
   * `Error` is handled as an unexpected failure and THE SENTENCE IT CARRIES NEVER REACHES THE READER.
   *
   * This provider had that defect in its first version, and it is recorded rather than quietly fixed:
   * `MtcClientError` (`client.ts`) and `MtcRefusal` (`guard.ts`) both derive from `Error`, and only the
   * `query()` path converted one of them. Every byte cap, every 8 KiB request ceiling, every "this
   * answer is not an MTConnect document" and every guard refusal reached the caller as a plain `Error`
   * from `connect()`, from the tree's own reads and from an asset's Source tab.
   *
   * The two classes are NOT re-parented onto `QueryError`, and that is measured too: the shared base
   * ends its constructor with `Object.setPrototypeOf(this, DatabaseError.prototype)`, so a subclass of
   * it answers `false` to `instanceof` its own name unless each constructor puts the prototype back.
   * A conversion at the boundary keeps the two classes exactly as the unit tests address them, and the
   * type that leaves is the one the product reads.
   */
  private asQueryError(error: unknown): unknown {
    if (error instanceof MtcRefusal || error instanceof MtcClientError) return new QueryError(error.message);
    return error;
  }

  /** One read, with every refusal converted on the way out. */
  private async read(session: MtcSession, request: MtcRequest): Promise<MtcAnswer> {
    try {
      return await readOnce(this.clientOptions(session), request);
    } catch (error) {
      throw this.asQueryError(error);
    }
  }

  /** One streaming read, with every refusal converted on the way out. */
  private async streamed(
    session: MtcSession,
    request: MtcRequest,
    onObservation: (observation: MtcObservation) => void,
  ): Promise<void> {
    try {
      await readObservations(this.clientOptions(session), request, ROW_CAP, onObservation);
    } catch (error) {
      throw this.asQueryError(error);
    }
  }

  /** One request line, read and refused in the product's own error type. */
  private guard(line: string, options: MtcGuardOptions): MtcRequest {
    try {
      return guardRequestLine(line, options);
    } catch (error) {
      throw this.asQueryError(error);
    }
  }

  /**
   * The Header of a read with no `from` and no `to`.
   *
   * MEASURED on the pinned agent: with `to` given, the Header's `firstSequence` is the request's own
   * `from` rather than the buffer's start, so buffer facts come only from a read without either.
   */
  private async readWindow(): Promise<MtcWindow> {
    const session = this.require();
    const answer = await this.read(session, this.guard(MTCONNECT_HEALTH_REQUEST, { rowCap: ROW_CAP }));
    const header = headerOf(answer.root);
    const window: MtcWindow = {
      instanceId: header.instanceId ?? "",
      firstSequence: BigInt(header.firstSequence ?? "1"),
      lastSequence: BigInt(header.lastSequence ?? "1"),
      nextSequence: BigInt(header.nextSequence ?? "1"),
      bufferSize: BigInt(header.bufferSize ?? "0"),
    };
    session.window = window;
    return window;
  }

  /**
   * The device model, read once and held.
   *
   * MEASURED: re-reading `probe` costs 2,918,819 bytes and a 70 ms median on a 500 device model, so
   * holding it is a requirement rather than an optimisation. It is read again only when the Header's
   * `instanceId` or `deviceModelChangeTime` changes.
   */
  private async model(): Promise<MtcModel> {
    const session = this.require();
    const window = session.window ?? (await this.readWindow());
    if (session.model !== undefined && modelIsCurrent(session.model, { instanceId: window.instanceId })) {
      return session.model;
    }
    const answer = await this.read(session, this.guard("/probe", { rowCap: ROW_CAP }));
    const model = indexMtconnectModel(answer.root);
    if (model === undefined) {
      throw new QueryError("This address answered a document that is not an MTConnect device model.");
    }
    session.model = model;
    return model;
  }

  // ==========================================================================
  // The read
  // ==========================================================================

  /**
   * One request line, read and refused before anything is sent.
   *
   * The text is a request line in the standard's own URL grammar with GET implied, not a query
   * language, which is why the provider declares a dialect of its own and no `queryReadOnly`.
   */
  public async query(sql: string): Promise<QueryResult> {
    const session = this.require();
    const model = await this.model();
    const started = Date.now();
    // A refusal from phase 0 is the provider's own sentence, named by its rule, and it leaves as a
    // `QueryError` like every other refusal here.
    const request = this.guard(sql, guardOptionsFor(session, model));

    const rows: MtcRow[] = [];
    if (request.op === "sample" || request.op === "current") {
      await this.streamed(session, request, (observation) => {
        const row = buildRow(observation, model);
        if (row !== undefined) rows.push(row);
      });
    } else {
      const answer = await this.read(session, request);
      if (answer.isError) throw new QueryError(this.sentenceFor(answer.root));
      // probe, assets and asset are read as a tree: none of them is a stream of observations.
      const rows = this.rowsOfDocument(answer.root, request.op, model, request.params.device);
      return {
        rows,
        fields: rows.length === 0 ? [] : Object.keys(rows[0]),
        rowCount: rows.length,
        executionTime: Date.now() - started,
      };
    }
    return this.resultOf(sortRows(rows), started);
  }

  /**
   * An agent's error document, turned into one sentence.
   *
   * The error is read by its TYPE, never by the HTTP status. MEASURED: cppagent answers 400 for
   * OUT_OF_RANGE where the 2.5.0 text gives 404, and SOURCE: MTConnect.NET answers 404 for the same
   * condition, so the status says only that an error happened. Both document shapes are read: the
   * typed elements of schema 2.6 and later, and the legacy `<Errors><Error errorCode=...>`.
   */
  private sentenceFor(root: {
    readonly children: readonly {
      readonly name: string;
      readonly attributes: Readonly<Record<string, string>>;
      readonly text: string;
      readonly children: readonly unknown[];
    }[];
  }): string {
    const errors = root.children.find((child) => child.name === "Errors");
    const first = errors?.children[0] as
      | {
          readonly name: string;
          readonly attributes: Readonly<Record<string, string>>;
          readonly text: string;
          readonly children: readonly { readonly name: string; readonly text: string }[];
        }
      | undefined;
    if (first === undefined) return "The agent answered an error document with no error in it.";
    const code = first.attributes.errorCode ?? first.name;
    const message = first.children.find((child) => child.name === "ErrorMessage")?.text ?? first.text;
    return message === "" ? `The agent refused this read (${code}).` : `${message} (${code})`;
  }

  /**
   * probe, assets and asset as rows. Each is a document rather than a stream of observations, so
   * each has columns of its own: the model's columns come from `probe` and the asset's from the
   * asset element, and neither shares the observation row's shape.
   */
  private rowsOfDocument(root: MtcElement, op: MtcOp, model: MtcModel, device?: string): QueryResult["rows"] {
    if (op === "probe") return rowsFromModel(model, device).map((row) => ({ ...row }));
    if (op === "assets" || op === "asset") {
      return rowsFromAssets(root).map((row) => ({
        assetId: row.assetId,
        type: row.type,
        deviceUuid: row.deviceUuid,
        timestamp: row.timestamp,
        removed: row.removed,
        hash: row.hash,
        ...row.attributes,
      }));
    }
    return [];
  }

  private resultOf(rows: readonly MtcRow[], started: number): QueryResult {
    const fields =
      rows.length === 0
        ? ["device", "component", "dataItemId", "name", "category", "type", "value", "units", "timestamp", "sequence"]
        : Object.keys(rows[0]);
    return {
      rows: rows.map((row) => ({ ...row })),
      fields,
      rowCount: rows.length,
      executionTime: Date.now() - started,
    };
  }

  // ==========================================================================
  // The tree
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    const model = await this.model();
    return model.devices.map((device, index) => ({
      path: [device.name],
      name: device.name,
      level: index === 0 ? 0 : 0,
      kinds: MTCONNECT_OBJECT_KINDS.map((kind) => kind.id),
    }));
  }

  /**
   * The device a container path names, refused by the SHARED check rather than by a length test here.
   *
   * FOUND BY A GATE: `tests/unit/db/container-path-shapes-capability.test.ts` holds that the engines
   * declaring `containerPathShapes` are exactly the engines whose providers call
   * `assertContainerPathShape`, and this provider declared `"exact"` while calling nothing. A
   * declaration with no check behind it means a path of the wrong length reaches the model lookup and
   * comes back as "no such device", which names the wrong mistake (#1147).
   */
  private deviceOf(container: readonly string[]): string {
    assertContainerPathShape(this.getCapabilities(), container, MTC_CONTAINER_PATH_ENGINE);
    return container[0];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, { count: number }>> {
    const model = await this.model();
    const device = this.deviceOf(container);
    const items = [...model.items.values()].filter((item) => item.deviceName === device);
    return {
      dataitem: { count: items.filter((item) => item.category !== "CONDITION").length },
      condition: { count: items.filter((item) => item.category === "CONDITION").length },
      asset: { count: 0 },
    };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const model = await this.model();
    const device = this.deviceOf(container);
    const items = [...model.items.values()].filter((item) => item.deviceName === device);
    const wanted = items.filter((item) =>
      kind === "condition" ? item.category === "CONDITION" : item.category !== "CONDITION",
    );
    return wanted.map((item) => ({
      path: [device, item.dataItemId],
      name: item.name === undefined ? item.dataItemId : `${item.componentPath}/${item.name}`,
      kind,
    }));
  }

  /**
   * One asset's document, which is the only object this provider has a document for.
   *
   * FOUND BY A GATE RATHER THAN BY DESIGN, and the gate is `tests/isolated/object-source-declarations.test.ts`:
   * the `asset` kind declared `hasSource: true` and `sourceLanguage: "xml"` while this method did not
   * exist, so the Source tab would have opened on a provider that cannot fill it. A declaration with
   * no reader behind it is the defect that file exists to catch, and it caught this one.
   *
   * The text is the agent's own answer rather than a re-render of the parsed tree, so `origin` can
   * say `stored`: an asset is a document the plant holds, and reordered attributes or re-indented
   * lines would not be it. The request goes through the same guard a typed request line does, so an
   * asset id that the guard would refuse is refused here in the same words.
   */
  public async readObjectSource(path: readonly string[], kind: string): Promise<ObjectSourceDocument> {
    const session = this.require();
    if (kind !== "asset") {
      throw new DatabaseConfigError(
        `Only an asset has a document. A ${kind} is a value with a timestamp and a sequence number, which the grid shows.`,
        this.type,
      );
    }
    const assetId = path[path.length - 1];
    if (assetId === undefined || assetId === "") {
      throw new DatabaseConfigError(`This path names no asset: ${JSON.stringify(path)}.`, this.type);
    }
    const request = this.guard(`/asset/${encodeURIComponent(assetId)}`, { rowCap: ROW_CAP });
    const answer = await this.read(session, request);
    if (answer.isError) throw new QueryError(this.sentenceFor(answer.root));
    return {
      path,
      kind,
      parts: [
        {
          id: "asset",
          label: "Asset",
          text: answer.text,
          language: "xml",
          // Complete: the answer holds the whole asset document, and there is no second half.
          form: "complete",
          origin: "stored",
          edit: { offered: false, reason: "This provider sends GET requests only, so no document can be submitted back." },
        },
      ],
    };
  }

  public async describeObject(path: readonly string[]): Promise<ObjectDetail> {
    const model = await this.model();
    const item = model.items.get(path[path.length - 1]);
    if (item === undefined) throw new QueryError(`This agent's model holds no data item ${path[path.length - 1]}.`);
    return {
      path,
      columns: [
        { name: "value", type: item.units ?? "text", nullable: true, isPrimary: false },
        { name: "timestamp", type: "timestamp", nullable: false, isPrimary: false },
        { name: "sequence", type: "integer", nullable: false, isPrimary: true },
      ],
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const objects = await this.listObjects(container, kind);
    const cap = limit ?? objects.length;
    const details: ObjectDetail[] = [];
    for (const object of objects.slice(0, cap)) details.push(await this.describeObject(object.path));
    return objects.length > cap
      ? { details, truncated: { limit: cap, reason: "the batch limit this read was given" } }
      : { details };
  }

  // ==========================================================================
  // Health, and the surfaces an agent does not publish
  // ==========================================================================

  /**
   * The Header of a fresh `sample?count=1`.
   *
   * A field the agent cannot answer reads "unknown" rather than a number, following the MQTT
   * provider. `activeConnections` is the one optional field, so it is omitted rather than guessed:
   * MEASURED, the Header carries the instance, the buffer size and the sequence window and nothing
   * about connections, uptime or storage.
   */
  public async getHealth(): Promise<HealthInfo> {
    const window = await this.readWindow();
    // Only the fields `HealthInfo` declares. An earlier draft added a `bufferedObservations` field
    // of its own behind a cast, which is a field no reader of `HealthInfo` would ever look at.
    // What the buffer holds belongs in the overview, where a count has a home.
    void window;
    return {
      databaseSize: MTCONNECT_HEALTH_UNKNOWN,
      cacheHitRatio: MTCONNECT_HEALTH_UNKNOWN,
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const model = await this.model();
    const window = await this.readWindow();
    return {
      version: "unknown",
      uptime: "unknown",
      maxConnections: 0,
      databaseSize: `${window.bufferSize} observations buffered`,
      tableCount: model.items.size,
      indexCount: 0,
    };
  }

  /** Empty: every metric is optional and an agent publishes none of them. No request. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.require();
    return {};
  }

  /** Empty: an agent keeps no query log. It has no queries. No request. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.require();
    return [];
  }

  /**
   * Empty: an agent publishes no client list.
   *
   * Its own Agent device does carry one observation an adapter's connection status, whose ids carry
   * the adapter's host and port. Those values are shown where the user asked for them and are not
   * carried into a surface like this one (MT-S10).
   */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.require();
    return [];
  }

  /** Empty: a data item has no row count, and the tree's counts are read from the model. No request. */
  public async getTableStats(): Promise<TableStats[]> {
    this.require();
    return [];
  }

  /** Empty: an agent has no index. No request. */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.require();
    return [];
  }

  /** Empty: an agent reports no storage. Its buffer size is a count of observations, not bytes. */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.require();
    return [];
  }

  /** Unreachable behind `supportsMaintenance: false`; a direct call is refused with its sentence. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    this.require();
    throw new QueryError("An MTConnect agent has no maintenance operation: every route of this provider reads.");
  }
}
