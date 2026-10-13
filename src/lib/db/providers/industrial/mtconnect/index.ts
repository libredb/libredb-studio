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
  ObjectDetailBatch,
  PerformanceMetrics,
  ProviderCapabilities,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { MTCONNECT_DEFAULT_PORT, MTCONNECT_OBJECT_KINDS } from "./capabilities";
import { headerOf, readObservations, readOnce, type MtcClientOptions } from "./client";
import { guardRequestLine, MtcRefusal, type MtcWindow } from "./guard";
import { indexMtconnectModel, modelIsCurrent, type MtcModel } from "./model";
import type { MtcElement } from "./xml";
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
const ROW_CAP = 10_000;

/**
 * One permit per agent, measured rather than chosen.
 *
 * MEASURED on the pinned agent: while a 300 alternative `path` ran in a loop, the median of
 * `sample?count=1` on the same agent rose from 1.4 ms to 74.1 ms. The agent serves the machine's own
 * clients too, so this bound is about not degrading the shop floor's monitoring rather than about
 * our own latency (decision K-61).
 */
const limiterFor = engineLimiter("mtconnect", { perProvider: 1, perEngine: 4, queueDepth: 64 });

export class MTConnectProvider extends BaseDatabaseProvider {
  private session: MtcSession | null = null;
  private readonly limiter = limiterFor();

  public constructor(config: DatabaseConnection) {
    super(config);
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
      queryDialect: "mtconnect",
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
      containerLevels: [{ id: "schema", label: "Device", labelPlural: "Devices" }],
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
   * The Header of a read with no `from` and no `to`.
   *
   * MEASURED on the pinned agent: with `to` given, the Header's `firstSequence` is the request's own
   * `from` rather than the buffer's start, so buffer facts come only from a read without either.
   */
  private async readWindow(): Promise<MtcWindow> {
    const session = this.require();
    const answer = await readOnce(
      this.clientOptions(session),
      guardRequestLine("/sample?count=1", { rowCap: ROW_CAP }),
    );
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
    const answer = await readOnce(this.clientOptions(session), guardRequestLine("/probe", { rowCap: ROW_CAP }));
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
    let request;
    try {
      request = guardRequestLine(sql, {
        window: session.window,
        rowCap: ROW_CAP,
        knownDevices: new Set(model.devices.flatMap((device) => [device.name, device.uuid])),
      });
    } catch (error) {
      // A refusal from phase 0 is the provider's own sentence, named by its rule.
      if (error instanceof MtcRefusal) throw new QueryError(error.message);
      throw error;
    }

    const rows: MtcRow[] = [];
    if (request.op === "sample" || request.op === "current") {
      await readObservations(this.clientOptions(session), request, ROW_CAP, (observation) => {
        const row = buildRow(observation, model);
        if (row !== undefined) rows.push(row);
      });
    } else {
      const answer = await readOnce(this.clientOptions(session), request);
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

  public async countObjects(container: readonly string[]): Promise<Record<string, { count: number }>> {
    const model = await this.model();
    const device = container[0];
    const items = [...model.items.values()].filter((item) => item.deviceName === device);
    return {
      dataitem: { count: items.filter((item) => item.category !== "CONDITION").length },
      condition: { count: items.filter((item) => item.category === "CONDITION").length },
      asset: { count: 0 },
    };
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const model = await this.model();
    const device = container[0];
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
      databaseSize: "unknown",
      cacheHitRatio: "unknown",
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
