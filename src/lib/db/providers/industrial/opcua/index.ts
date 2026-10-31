/**
 * The OPC UA provider (#1677).
 *
 * READ-ONLY BY CONSTRUCTION, and the construction is three files deep: `client.ts` names eight
 * services and none writes, `library.ts` is the only module allowed to import the library, and
 * `tests/unit/db/opcua/seam.test.ts` asserts both across every module in the directory. The
 * connection's read-only checkbox cannot turn writing on, because there is nothing to turn on.
 *
 * ONE SESSION PER CONNECTION, closed on every path out. A server's session table is shared with the
 * plant's own SCADA clients: measured, OPC PLC allows 100 and the in-process server 10.
 *
 * AGENT MODE. `queryReadOnly` is the agent's: one read of `agent-statement.ts`'s table (a value read, a history read
 * or a one-level browse), refused before anything is sent when it is not one, and run by `agent-read.ts` over a session
 * opened for that read alone and closed when it ends, through a client that holds the read services only and counts
 * them. Values are answered with their engineering units (`agent-units.ts`), and the server's configuration, role
 * identities, session diagnostics and PubSub key management are withheld (`agent-withheld.ts`). On a handle opened for
 * any agent-mode profile no session is held, the console and the Keys panel are refused, and every reading the agent
 * does not report answers its reason (`agent-surface.ts`). MCP read stays closed on this engine.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KeyScanOptions,
  KeyScanPage,
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
import type { DatabaseConnection } from "@/lib/types";
import {
  agentFailure,
  boundedAgentClient,
  opcuaAgentResult,
  preflight,
  runOpcuaAgentRead,
  OpcuaAgentError,
  OPCUA_AGENT_FAILURE_SENTENCES,
  type OpcuaAgentAnswer,
} from "./agent-read";
import { readOpcuaAgentStatement, type OpcuaAgentPlan } from "./agent-statement";
import { OPCUA_AGENT_WITHHELD } from "./agent-surface";
import { OPCUA_CAPABILITIES } from "./capabilities";
import type { OpcuaReadOnlyClient } from "./client";
import { OPCUA_OBJECTS_FOLDER, OPCUA_SERVER_STATUS, OPCUA_TYPE } from "./constants";
import { readConnection, type OpcuaConnectionOptions } from "./connection";
import { historyEndSentence, readHistory } from "./history";
import { browseLevel, childBearingNodes, levelPage, levelScope, levelSlice, resolvePath } from "./key-scan";
import { OPCUA_LABELS, OPCUA_NODES_LISTED_ELSEWHERE, OPCUA_NO_TABLE_STATISTICS } from "./labels";
import { serverStatusCard } from "./overview";
import { nodeSourceDocument, OPCUA_OBJECT_KINDS } from "./objects";
import { readRequest } from "./read-request";
import { chunked, readChunkSize } from "./limits";
import { emptyResult, historyRows, OPCUA_HISTORY_COLUMNS, valueRows } from "./results";
import { OpcuaSessionPool } from "./session-pool";
import { pathSegments } from "./node-id";

/** How a session is opened, which production fills with the library and a test with its own. */
export type OpcuaSessionOpener = (options: OpcuaConnectionOptions) => Promise<OpcuaReadOnlyClient>;

/** Studio's own refusals on the agent's statement path, made before anything is sent. */
const OPCUA_PROVIDER_SENTENCES = {
  profileRequired: "Read-only execution requires a provider opened under the agent read-only profile",
  noEstimate: "OPC UA composes no estimating plan for the agent",
} as const;

export class OpcuaProvider extends BaseDatabaseProvider {
  private pool: OpcuaSessionPool;
  private connectionOptions: OpcuaConnectionOptions | undefined;
  /** Whether an agent-mode handle is open: it holds no session, so the pool cannot say. */
  private agentOpen = false;

  /**
   * The execution context third and the session opener fourth: the context decides whether this handle answers agent
   * reads, and a test substitutes its own opener and environment as before.
   */
  public constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly openSession?: OpcuaSessionOpener,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    super(config, options);
    this.pool = this.newPool();
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
   * handle does. Such a handle holds no session, refuses the console and the Keys panel, and answers every reading the
   * agent does not report with its reason.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  /** The refusal of a reading an agent-mode handle does not take, after the connection check every reading makes. */
  private agentWithheld(sentence: string): never {
    if (!this.agentOpen) throw new DatabaseConfigError("This OPC UA connection is not open.", OPCUA_TYPE);
    throw new QueryError(sentence, OPCUA_TYPE);
  }

  /** The session opener, or the refusal of a build that wired none in. */
  private opener(): OpcuaSessionOpener {
    if (this.openSession === undefined) {
      throw new QueryError(
        "This build has no OPC UA transport wired in. The provider's session is opened through its library " +
          "bridge, which is supplied where the server runs.",
        OPCUA_TYPE,
      );
    }
    return this.openSession;
  }

  /**
   * One pool, and a new one after a disconnect.
   *
   * A POOL IS SINGLE-USE AND A PROVIDER IS NOT. The pool latches closed on purpose - that is what
   * keeps a session which arrives after the close from being held - so `connect, disconnect,
   * connect` on one provider instance was refused for ever, with the sentence "Connect it again to
   * read from the server", which named the one call it had just made impossible. The HTTP routes
   * hide it (the factory builds a fresh provider when `isConnected()` is false), but the published
   * `DatabaseProvider` interface does not, and no other provider in the tree is single-use.
   */
  private newPool(): OpcuaSessionPool {
    return new OpcuaSessionPool(async () => {
      const read = this.requireOptions();
      return this.opener()(read);
    });
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return OPCUA_CAPABILITIES;
  }

  public override getLabels(): ProviderLabels {
    return OPCUA_LABELS;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Read the connection, then open the one session.
   *
   * Every refusal the connection can make happens before a socket exists, which is why this reads
   * the options first: an endpoint in the wrong scheme, a password with no username, a pin that is
   * not a thumbprint, a relative PKI root. A root that cannot be WRITTEN is not among them: the
   * certificate manager creates its directories lazily, so that one arrives from the dial and is
   * translated there (`session.ts`).
   */
  public async connect(): Promise<void> {
    this.connectionOptions = readConnection(
      this.config as DatabaseConnection & Record<string, unknown>,
      this.environment,
    );
    /*
     * AN AGENT-MODE HANDLE HOLDS NO SESSION. Every agent read opens its own and closes it, so nothing of one read
     * reaches the next; the connect proves the server answers by opening one session and closing it at once.
     */
    if (this.agentProfile) {
      const session = await this.opener()(this.connectionOptions);
      await session.close().catch(() => undefined);
      this.agentOpen = true;
      return;
    }
    // A pool that has been closed opens nothing ever again, so a reconnect gets a new one.
    if (this.pool.isSpent()) this.pool = this.newPool();
    await this.pool.acquire();
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.agentOpen = false;
    await this.pool.close();
    this.setConnected(false);
  }

  public override isConnected(): boolean {
    return this.agentProfile ? this.agentOpen : this.pool.isOpen();
  }

  private requireOptions(): OpcuaConnectionOptions {
    if (this.connectionOptions === undefined) throw new QueryError("This OPC UA connection is not open.", OPCUA_TYPE);
    return this.connectionOptions;
  }

  // ==========================================================================
  // The read console
  // ==========================================================================

  /**
   * One JSON read request: current values, or raw history for one node.
   *
   * Empty text is refused here rather than in the parser, because "nothing to run" is a different
   * thing from "this is not a request" and a reader should hear the difference.
   */
  public async query(text: string): Promise<QueryResult> {
    if (this.agentProfile) throw new RefusedBeforeSendError(OPCUA_AGENT_WITHHELD.query, OPCUA_TYPE, text);
    const trimmed = text.trim();
    if (trimmed === "") {
      throw new QueryError(
        'There is nothing to run. A read request names what to read: { "read": ["ns=3;s=SlowUInt1"] } for ' +
          'current values, or { "history": "ns=3;s=HistorianInt32", "limit": 500 } for raw history.',
        OPCUA_TYPE,
      );
    }
    const request = readRequest(trimmed);

    /*
     * EVERY REQUEST RUNS THROUGH `withSession`, which is what makes the sentence `errors.ts` writes
     * for BadSessionIdInvalid true: a session the server has forgotten is dropped and the read runs
     * once more on a fresh one, instead of failing under the same code for ever.
     */
    if (request.kind === "read") {
      return this.pool.withSession(async (client) => {
        const limits = await client.limits();
        const values = [];
        // Chunked by our own bound first: two of the four servers measured publish a limit they do
        // not enforce, and one publishes zero.
        for (const batch of chunked(request.nodeIds, readChunkSize(limits))) {
          // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps a read inside the server's operation limit.
          values.push(...(await client.read(batch)));
        }
        return valueRows(request.nodeIds, values);
      });
    }

    const history = await this.pool.withSession((client) => readHistory(client, request));
    /*
     * The read's own account of itself travels with it, EMPTY OR NOT: a page of nothing is where
     * the sentence matters most. Measured, a node that keeps no history and a node that does not
     * exist both answer zero values, and the server's own code is the only thing that tells them
     * apart - so an empty table with no sentence told a reader the window was empty when the truth
     * was BadHistoryOperationUnsupported or BadNodeIdUnknown.
     *
     * IT TRAVELS AS A `warnings` ENTRY, WHICH IS THE ONE CHANNEL A RESULT HAS. This was a `notice`
     * field cast onto `QueryResult` through `as`, and `QueryResult` has no such field: the cast was
     * why the typecheck stayed quiet, the route answered the sentence in the body, and nothing in
     * the product read it. Measured through the query route: a history read of a node that keeps
     * none answered HTTP 200 with the sentence in `notice` and an empty grid on screen - the exact
     * failure this sentence exists to prevent. `warnings` is what `StatsBar` and `ResultsGrid`
     * draw, and what the Postgres provider routes its own notices through.
     *
     * The status code travels as the warning's `code` when the server gave one, because that is
     * the field it belongs in, and the sentence already names it in words for a reader who is
     * looking at the grid rather than at the body.
     */
    const warnings = [
      {
        message: historyEndSentence(history.end, history.values.length, history.statusCode),
        ...(history.statusCode === undefined ? {} : { code: history.statusCode }),
      },
    ];
    if (history.values.length === 0) return { ...emptyResult(OPCUA_HISTORY_COLUMNS), warnings };
    return { ...historyRows(history.nodeId, history.values), warnings };
  }

  /**
   * One agent read. Only on a handle opened under the agent read-only profile; the request is read by
   * `readOpcuaAgentStatement` and refused before anything is sent when it is not one of the three reads, when it is a
   * history read or a browse of a withheld root, or when a value read names more nodes than the row budget. The read
   * runs over a session opened for it alone and closed when it ends, through `boundedAgentClient`, which holds the read
   * services and counts them against the request bound and the time budget, and its answer is refused past the row,
   * byte or time budget rather than cut. A failure is worded by its category, never in the server's text.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    if (!this.readOnlyProfile)
      throw new RefusedBeforeSendError(OPCUA_PROVIDER_SENTENCES.profileRequired, OPCUA_TYPE, statement);
    if (!this.agentOpen) throw new DatabaseConfigError("This OPC UA connection is not open.", OPCUA_TYPE);
    assertReadOnlyBudget(budget, OPCUA_TYPE);
    if (mode !== "execute")
      throw new RefusedBeforeSendError(OPCUA_PROVIDER_SENTENCES.noEstimate, OPCUA_TYPE, statement);
    const reading = readOpcuaAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, OPCUA_TYPE, statement);
    const early = preflight(reading.plan, budget);
    if (early !== undefined) throw new RefusedBeforeSendError(early, OPCUA_TYPE, statement);
    const started = Date.now();
    const answer = await this.agentRead(reading.plan, budget, started);
    return opcuaAgentResult(answer, budget, Date.now() - started);
  }

  /**
   * One read over its own session, raced against the time budget. The session is closed on every path out, the
   * deadline's included: a read still running when the budget ends meets the deadline at its next request, and its
   * session is closed then.
   */
  private async agentRead(
    plan: OpcuaAgentPlan,
    budget: ReadOnlyStatementBudget,
    started: number,
  ): Promise<OpcuaAgentAnswer> {
    const ms = budget.statementTimeoutMs;
    const options = this.requireOptions();
    const open = this.opener();
    let opened = false;
    const work = (async () => {
      const session = await open(options);
      opened = true;
      try {
        const client = boundedAgentClient(session, { deadlineAt: started + ms, timeoutMs: ms, now: Date.now });
        return await runOpcuaAgentRead(client, plan, budget);
      } finally {
        await session.close().catch(() => undefined);
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OpcuaAgentError(OPCUA_AGENT_FAILURE_SENTENCES.time(ms))), ms);
    });
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      throw agentFailure(error, opened);
    } finally {
      clearTimeout(timer);
    }
  }

  // ==========================================================================
  // The Keys panel
  // ==========================================================================

  /**
   * One level of the address space, which is one Browse of one node.
   *
   * The level is addressed by re-browsing from the Objects folder along the path's own segments,
   * rather than by translating the path in one call: `TranslateBrowsePathToNodeIds` would do it in
   * one request, measured at 4 ms against 5 ms for walking down at depth 4, but it is not one of
   * the eight services the seam allows and the seam's value is that the list is exhaustive.
   */
  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.keys);
    if (options.database !== undefined) {
      throw new DatabaseConfigError(
        "An OPC UA connection reads one server endpoint, so a page names no database.",
        OPCUA_TYPE,
      );
    }
    /**
     * ONE LEVEL, OR A SENTENCE. The panel asks a levels-declaring provider for a level every time
     * (`use-key-scan.ts`), and a request without `level` means "a walk of the whole key space,
     * paged" - which this provider refuses for the reason its own walk is bounded: an address space
     * is a graph, measured at 6,769 nodes over 7,040 paths on the documented fixture and larger again
     * nodes on another, with no cursor a server will resume. Answering one level and calling it a
     * walk would be a sample presented as a listing.
     */
    if (options.level !== true) {
      throw new DatabaseConfigError(
        "An OPC UA address space is browsed one level at a time: this page is asked for with level. " +
          "There is no whole-space walk, because a server publishes no cursor over its own graph and the " +
          "graph is reached by more paths than it has nodes.",
        OPCUA_TYPE,
      );
    }
    const pattern = options.pattern ?? "";
    // The pattern's own level, which is the pattern itself for a folder the reader opened and the
    // level above it for text typed in the filter box. Read before the session, so a pattern this
    // provider refuses costs no request.
    const scope = levelScope(pattern);
    return this.pool.withSession(async (client) => {
      const nodeId = scope.path === "" ? OPCUA_OBJECTS_FOLDER : await resolvePath(client, scope.segments);
      const references = await browseLevel(client, nodeId);
      /*
       * THE PAGE IS CHOSEN FIRST AND MEASURED SECOND, in that order, because the measurement costs
       * a Browse per row. One extra Browse round over the page's own rows is what lets a row be
       * drawn as a folder only when the server answered children for it - a folder that opens empty
       * costs the reader a click to learn nothing - and asking about the whole level instead cost
       * 501 requests to answer 200 rows of a level 10,000 wide, every page.
       */
      const slice = levelSlice(pattern, references, {
        cursor: options.cursor,
        count: options.count,
      });
      const folders = await childBearingNodes(client, slice.rows, await client.limits());
      return levelPage(slice, folders);
    });
  }

  // ==========================================================================
  // Objects
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    // One connection is one server endpoint: there is no container level to name.
    return [];
  }

  public async countObjects(): Promise<Record<string, KindCount>> {
    // A server publishes no count of its nodes, and a number from one Browse would be a total with
    // nothing behind it: measured, 6,769 nodes on the documented fixture and larger again on Milo.
    return {};
  }

  public async listObjects(): Promise<DatabaseObject[]> {
    throw new QueryError(this.agentProfile ? OPCUA_AGENT_WITHHELD.objects : OPCUA_NODES_LISTED_ELSEWHERE, OPCUA_TYPE);
  }

  public async describeObject(): Promise<ObjectDetail> {
    throw new QueryError(this.agentProfile ? OPCUA_AGENT_WITHHELD.objects : OPCUA_NODES_LISTED_ELSEWHERE, OPCUA_TYPE);
  }

  public async describeObjects(): Promise<ObjectDetailBatch> {
    throw new QueryError(this.agentProfile ? OPCUA_AGENT_WITHHELD.objects : OPCUA_NODES_LISTED_ELSEWHERE, OPCUA_TYPE);
  }

  /** One node's value and attributes, which is what clicking a key opens. */
  public async readObjectSource(path: readonly string[], kind: string): Promise<ObjectSourceDocument> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.keys);
    if (!OPCUA_OBJECT_KINDS.includes(kind as (typeof OPCUA_OBJECT_KINDS)[number])) {
      throw new DatabaseConfigError(`An OPC UA connection has one object kind, ${OPCUA_OBJECT_KINDS[0]}.`, OPCUA_TYPE);
    }
    const segments = path.flatMap((part) => pathSegments(part));
    /*
     * A PATH OF EMPTY STRINGS NAMES NO NODE, and it used to be answered as the Objects folder.
     * `pathSegments("")` is `[]` and `resolvePath(client, [])` is `i=85` - both correct on their
     * own, and together they turned `{"path":[""]}` into a 200 carrying a document for the folder,
     * under a key the caller sees as empty and with `BadAttributeIdInvalid` as its value's status.
     * The route refuses `path: []` in its own words one line earlier; this is the same refusal for
     * the path that survives it.
     */
    if (segments.length === 0) {
      throw new DatabaseConfigError(
        `This path names no node: ${JSON.stringify(path)}. A node is named by its browse path from the Objects ` +
          "folder, as the Keys panel writes it.",
        OPCUA_TYPE,
      );
    }
    const { nodeId, value } = await this.pool.withSession(async (client) => {
      const found = await resolvePath(client, segments);
      // One Read brings the value and every attribute the document shows, in one round trip.
      const [read] = await client.read([found]);
      return { nodeId: found, value: read };
    });
    const attributes = {
      ...(value?.dataTypeId === undefined ? {} : { dataType: value.dataTypeId }),
      ...(value?.valueRank === undefined ? {} : { valueRank: value.valueRank }),
      ...(value?.arrayDimensions === undefined ? {} : { arrayDimensions: value.arrayDimensions }),
      ...(value?.accessLevel === undefined ? {} : { accessLevel: value.accessLevel }),
      ...(value?.userAccessLevel === undefined ? {} : { userAccessLevel: value.userAccessLevel }),
      ...(value?.historizing === undefined ? {} : { historizing: value.historizing }),
      ...(value?.description === undefined ? {} : { description: value.description }),
    };
    return {
      path,
      kind,
      parts: [
        {
          id: "node",
          // The server's own word for what this is, which is the node class.
          label: "Node",
          // The node class is the server's answer, not an assumption: the same panel lists Objects
          // and Methods, and a document that called each of them a Variable would be wrong.
          text: nodeSourceDocument(nodeId, value?.nodeClass ?? "Unspecified", value, attributes),
          language: "json",
          // Complete: every attribute this provider reads is in it, and there is no second half.
          form: "complete",
          // Rendered, not stored: a server keeps no text for a node. This is a structured
          // definition this product prints, which is exactly what `rendered` means, and saying
          // `stored` would show a reconstruction as if it were the author's own bytes.
          origin: "rendered",
          // A node's value cannot be submitted back: this provider has no code that can write.
          edit: {
            offered: false,
            reason: "This provider has no code that can write to an OPC UA server.",
          },
        },
      ],
    };
  }

  // ==========================================================================
  // Surfaces a server does not have
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    // On an agent-mode handle the "unknown" figures and empty lists below would read as the server's own answer.
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.health);
    return {
      databaseSize: "unknown",
      // A server publishes no cache a client can read, and "unknown" is the honest value.
      cacheHitRatio: "unknown",
      slowQueries: [],
      activeSessions: [],
    } as HealthInfo;
  }

  /**
   * The Overview card, from the one node that answers it.
   *
   * THIS SAID "unknown" FOR EVERYTHING, and three of those were readable all along: a browser pass
   * opened the card against the documented fixture and found "unknown" version and uptime beside a
   * server that answers both, Good, through this very provider. `Server/ServerStatus` is mandatory
   * (Part 5) and holds the product name, the software version, the start time and the server's own
   * clock - measured on OPC PLC 2.15.10, one Read of `i=2256` returns all four.
   *
   * WHAT STAYS UNKNOWN STAYS UNKNOWN. A server publishes no size, and `CurrentSessionCount` is not
   * portable (measured: asyncua answers Good with an empty value, Milo `BadNotReadable` even to an
   * authenticated session), so neither is guessed at here. A server that refuses `ServerStatus`
   * falls back to the sentence this card drew before, rather than failing the whole dashboard: the
   * card is a readout, and an engine that will not say is not an engine that is broken.
   */
  public async getOverview(): Promise<DatabaseOverview> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.overview);
    const unknown = { version: "unknown", uptime: "unknown", databaseSize: "unknown", tableCount: 0, indexCount: 0 };
    try {
      const status = await this.pool.withSession(async (client) => {
        const [answer] = await client.read([OPCUA_SERVER_STATUS]);
        return answer?.statusCode === "Good"
          ? serverStatusCard(answer.value, (ms) => this.formatDuration(ms))
          : undefined;
      });
      return { ...unknown, ...(status ?? {}) } as DatabaseOverview;
    } catch {
      // The dashboard reads this beside three other panels; a server that will not answer one node
      // is not a reason to take the other three away.
      return unknown as DatabaseOverview;
    }
  }

  /*
   * THE THREE PANELS WITH NO LABEL REFUSE RATHER THAN ANSWER ZERO.
   *
   * An empty array here is drawn as a MEASUREMENT: a browser pass found the Tables panel reporting
   * "0 tables, 0 rows, 0 B" and "No tables found." against a server whose own tree lists nine root
   * folders, and the Storage card summing that nothing into "0 B". A server publishes no table or
   * index or size statistics at all - it has no tables - so the honest answer is that the read
   * cannot be made, not that it was made and found nothing.
   *
   * `base-provider.ts` settles each panel on its own and records a rejected one under
   * `errors[panel]`, which the dashboard draws as the engine's own sentence; the two CORE panels
   * that would turn four rejections into a dead connection (slow queries and sessions) keep their
   * empty arrays and say why through `getLabels()` instead.
   */
  public async getStorageStats(): Promise<StorageStats[]> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.storage);
    throw new QueryError(OPCUA_NO_TABLE_STATISTICS, OPCUA_TYPE);
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.performance);
    return {} as PerformanceMetrics;
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.slowQueries);
    // A server keeps no query log, because it answers no queries.
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.sessions);
    // CurrentSessionCount is a number, not a session list, and it is not portable either: measured,
    // asyncua answers Good with an empty value and Milo BadNotReadable even when authenticated.
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.tableStats);
    throw new QueryError(OPCUA_NO_TABLE_STATISTICS, OPCUA_TYPE);
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    if (this.agentProfile) this.agentWithheld(OPCUA_AGENT_WITHHELD.indexStats);
    throw new QueryError(OPCUA_NO_TABLE_STATISTICS, OPCUA_TYPE);
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(
      `Maintenance would be a write, and this provider has no code that can write to a server: its client ` +
        `exposes eight read services and nothing else. ${String(type)} is not one of them.`,
      OPCUA_TYPE,
    );
  }
}
