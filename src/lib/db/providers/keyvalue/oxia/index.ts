/**
 * Oxia provider (#424): read-only browsing of an Oxia namespace over Oxia's gRPC client API. Shards in the tree, every
 * key in the Keys panel, one `oxia client` read command per run in the editor.
 *
 * COMPOSITION AND DELEGATION ONLY. The wire is `grpc-client.ts` behind the `OxiaClient` seam, the connection rules
 * `connection-options.ts`, the grammar `lexer.ts` and `commands.ts`, a command's run `execute.ts` over `walks.ts`, the
 * grid `results.ts`, the object surface `objects.ts`, the Keys panel `key-scan.ts`, health and the overview
 * `monitoring-reads.ts`, and every sentence of a failure `errors.ts`. What stays here is the session's lifecycle, the
 * declarations, the surface every module reads through (the limited client, the brief snapshot cache, the order
 * verdict and its lifetime), each call's deadline, the run registry, and the one failure path every call takes.
 *
 * `cancelQuery` exists because a run can be stopped; every Oxia run reads, so there is no write already sent to
 * protect. No `getPoolStats` and no transaction methods: each is detected by presence.
 *
 * `queryReadOnly` is the agent's: a closed table of metadata reads (`agent-statement.ts`) over the stub that holds only
 * reads, answered through a metadata-only projection (`agent-metadata-read.ts`). Oxia has no authorization, so the
 * table is the boundary. Key names count as stored values, so a handle opened for any agent-mode profile lists no key
 * and reads no value on any surface. MCP read stays closed on this engine.
 */
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseConnection,
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
  ProviderOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import {
  createRunRegistry,
  engineLimiter,
  type ProviderLimiter,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import {
  OXIA_AGENT_COUNT_SENTENCES,
  OXIA_METADATA_ONLY,
  type OxiaAgentAnswer,
  oxiaAgentFailure,
  oxiaAgentResult,
} from "./agent-metadata-read";
import { type OxiaAgentPlan, readOxiaAgentStatement } from "./agent-statement";
import type { OxiaCallOptions, OxiaClient, OxiaSnapshot } from "./client";
import { parseOxiaCommand } from "./commands";
import {
  buildOxiaConnectionOptions,
  type OxiaConnectionOptions,
  oxiaEndpointText,
  oxiaErrorConnection,
} from "./connection-options";
import {
  OXIA_CELL_LIMIT,
  OXIA_DEFAULT_PORT,
  OXIA_HEALTH_DEADLINE_MS,
  OXIA_LIMITER_OPTIONS,
  OXIA_MAX_LIMIT,
  OXIA_RUN_BYTE_BUDGET,
  OXIA_SNAPSHOT_TTL_MS,
  OXIA_SURFACE_DEADLINE_MS,
  OXIA_TYPE,
} from "./constants";
import { OxiaError, type OxiaErrorConnection, toProviderError } from "./errors";
import { executeOxiaCommand } from "./execute";
import { createGrpcOxiaClient, type OxiaClientFactory } from "./grpc-client";
import { OXIA_KEY_SCAN, readOxiaKeyScanOptions, scanOxiaKeysPage } from "./key-scan";
import { OXIA_LABELS } from "./labels";
import { oxiaHealth, oxiaOverview } from "./monitoring-reads";
import {
  countOxiaObjects,
  describeOxiaObject,
  describeOxiaObjects,
  listOxiaObjects,
  OXIA_OBJECT_KINDS,
  readOxiaObjectSource,
} from "./objects";
import { type OrderVerdict, verdictIsProvisional } from "./order";
import { oxiaResult } from "./results";
import { detectKeyOrder, limitedOxiaClient, listRange, type OxiaSurface, readKeyAnywhere } from "./walks";

/** One process-wide table for every Oxia provider: 4 calls per provider, 16 per process, a queue of 64 (SB1-9.1). */
const oxiaLimiter = engineLimiter("oxia", OXIA_LIMITER_OPTIONS);

/** SB2-5.3: a command has no binding, and dropping the values would run another command than the one built. */
const PARAMETERS_REFUSAL = "Oxia commands take no parameters: write the values in the command.";

const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const NO_ESTIMATE = "Oxia composes no estimating plan for the agent";

/** The refusal of an editor surface that reads keys or values, on a handle opened for an agent-mode profile. */
const PROFILE_SURFACE_REFUSED =
  "An Oxia handle opened for agent mode answers only the agent's metadata reads, through queryReadOnly, and lists no key or value: key names count as stored values.";

/** The failures that mean the shard map moved: the brief cache is dropped, so "run it again" reads it afresh. */
const MAP_MOVED: ReadonlySet<string> = new Set(["not-leader", "leader-changing", "shard-not-found"]);

/**
 * A permit wait that the call's deadline ended (the limited client joins a timeout at the deadline to the wait's
 * signal) rejects with a `DOMException` named `TimeoutError`: that is the call's deadline, on no shard, so it is worded
 * by the deadline sentence and reads no map again. A wait the run's own signal ended keeps the registry's
 * `QueryCancelledError`, and anything else passes as it is (ruling R2).
 */
function permitWaitFailure(error: unknown): unknown {
  return error instanceof DOMException && error.name === "TimeoutError" ? new OxiaError("deadline-exceeded") : error;
}

/** One connected session: the raw client, what the connection resolved to, and what every call of it shares. */
interface OxiaSession {
  readonly client: OxiaClient;
  readonly options: OxiaConnectionOptions;
  readonly errors: OxiaErrorConnection;
  readonly surface: OxiaSurface;
  /** Aborted at disconnect, so no call outlives its session. */
  readonly lifetime: AbortController;
}

/** A connection is one namespace with no container level (O5), so every object is addressed at the root. */
function requireRoot(container: readonly string[]): void {
  if (container.length !== 0)
    throw new QueryError(`An Oxia connection has no container level; received ${JSON.stringify(container)}`, OXIA_TYPE);
}

export class OxiaProvider extends BaseDatabaseProvider {
  private session: OxiaSession | null = null;
  private readonly limiter: ProviderLimiter = oxiaLimiter();
  private readonly runs: RunRegistry = createRunRegistry();
  /** The last validated, admitted snapshot, for `OXIA_SNAPSHOT_TTL_MS` (SB1-5.3). */
  private cached: OxiaSnapshot | undefined;
  /** The namespace's order verdict; a decided one is kept for the provider's life (SB1-7.2). */
  private verdict: OrderVerdict | undefined;

  /**
   * Validates nothing and opens nothing: the connection's rules run in `connect()`, so a provider built only for its
   * declarations (the factory's census, `POST /api/db/provider-meta`) touches no socket. `createClient` is the test
   * seam (SB3-9 I-5).
   */
  constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    private readonly createClient: OxiaClientFactory = createGrpcOxiaClient,
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
   * handle does. On such a handle no surface names a key or reads a value, and the editor's command path is refused;
   * the editor's own handles keep every read.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  // ==========================================================================
  // Declarations (SB2-9.1, SB2-9.2)
  // ==========================================================================

  /** Every member written out: the base's defaults are SQL's, so each flag here is a decision. */
  public override getCapabilities(): ProviderCapabilities {
    return {
      // One oxia client read command, declared as etcd declares its command line: "json" means only "not SQL".
      queryLanguage: "json",
      queryDialect: "oxia",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Read-only whatever the flag says: the stub holds only reads, and the parser refuses every write verb (O1).
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: OXIA_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: OXIA_OBJECT_KINDS,
      keyScan: OXIA_KEY_SCAN,
      // Key names and values are stored values: the agent's answers carry the shard map's counts and named keys' metadata.
      metadataOnly: OXIA_METADATA_ONLY,
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...OXIA_LABELS };
  }

  /** The command carries its own bound (`--limit`): no limit is added, and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: DEFAULT_QUERY_LIMIT, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle (SB1-5.1)
  // ==========================================================================

  /** The options, the client, and one snapshot read, which runs the dial policy over every leader; no order probe. */
  public async connect(): Promise<void> {
    if (this.session !== null) await this.disconnect();
    const session = this.openSession();
    try {
      await session.surface.snapshot(this.surfaceCall(session));
    } catch (error) {
      const failure = await this.providerError(error, "connection test", session, this.surfaceTimeoutMs(session));
      // A client that was built holds channels, so a connect that fails closes it.
      session.lifetime.abort();
      session.client.close();
      throw failure;
    }
    this.session = session;
    this.setConnected(true);
  }

  /** The options, the client and the surface, with no read: connect and health's connect-if-needed share it. */
  private openSession(): OxiaSession {
    // Refused before any client exists: the field rules of SB1-4, already worded.
    const options = buildOxiaConnectionOptions(this.config, {
      executionReadOnly: this.execution.readOnly === true,
      queryTimeout: this.queryTimeout,
    });
    const client = this.createClient(options);
    this.cached = undefined;
    this.verdict = undefined;
    return {
      client,
      options,
      errors: oxiaErrorConnection(options),
      surface: this.surfaceOver(limitedOxiaClient(client, this.limiter)),
      lifetime: new AbortController(),
    };
  }

  public async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.cached = undefined;
    this.verdict = undefined;
    this.setConnected(false);
    if (session === null) return;
    session.lifetime.abort();
    session.client.close();
  }

  // ==========================================================================
  // The surface every module reads through (SB1-5.3, SB1-7.2, SB1-9.1)
  // ==========================================================================

  /** The limited client, the brief snapshot cache, and the order verdict with its lifetime rule. */
  private surfaceOver(client: OxiaClient): OxiaSurface {
    const snapshot = async (call: OxiaCallOptions): Promise<OxiaSnapshot> => {
      const cached = this.cached;
      if (cached !== undefined && Date.now() - cached.readAt < OXIA_SNAPSHOT_TTL_MS) return cached;
      const read = await client.getSnapshot(call);
      this.cached = read;
      return read;
    };
    const order = async (call: OxiaCallOptions): Promise<OrderVerdict> => {
      const kept = this.verdict;
      // A decided verdict is kept for the provider's life; `empty` and `assumed` are probed again on every call.
      if (kept !== undefined && !verdictIsProvisional(kept)) return kept;
      const verdict = await detectKeyOrder(client, await snapshot(call), call);
      this.verdict = verdict;
      return verdict;
    };
    return { client, snapshot, order };
  }

  private requireSession(): OxiaSession {
    this.ensureConnected();
    // Set before setConnected(true) and cleared with setConnected(false), so a connected provider has one.
    return this.session as OxiaSession;
  }

  /** The deadline of a tree, Keys panel or connect call: the query timeout, capped at the surface deadline (SB1-5.1). */
  private surfaceTimeoutMs(session: OxiaSession): number {
    return Math.min(session.options.callTimeoutMs, OXIA_SURFACE_DEADLINE_MS);
  }

  private surfaceCall(session: OxiaSession, signal: AbortSignal = session.lifetime.signal): OxiaCallOptions {
    return { signal, deadline: Date.now() + this.surfaceTimeoutMs(session) };
  }

  /**
   * The one failure path (SB1-5.3, SB1-9.4): a permit wait the deadline ended is the deadline; a moved map drops the
   * cache; a deadline on a shard call drops it and reads the map once, under the surface deadline and `signal`, to say
   * what happened to the shard, with no data call retried (SB1-13 D5); then errors.ts words the failure for the
   * operation, naming `timeoutMs`, the deadline the failed call ran under (ruling R4).
   */
  private async providerError(
    error: unknown,
    operation: string,
    session: OxiaSession,
    timeoutMs: number,
    signal: AbortSignal = session.lifetime.signal,
  ): Promise<Error> {
    let failure = permitWaitFailure(error);
    if (failure instanceof OxiaError && MAP_MOVED.has(failure.category)) this.cached = undefined;
    if (failure instanceof OxiaError && failure.category === "deadline-exceeded" && failure.shardId !== undefined) {
      this.cached = undefined;
      failure = await this.rereadAfterDeadline(failure, session, signal);
    }
    return toProviderError(failure, { operation, connection: { ...session.errors, timeoutMs } });
  }

  /** SB1-9.4: the shard gone is shard-not-found, its leader moved is leader-changing, and anything else the deadline. */
  private async rereadAfterDeadline(error: OxiaError, session: OxiaSession, signal: AbortSignal): Promise<unknown> {
    let snapshot: OxiaSnapshot;
    try {
      snapshot = await session.surface.snapshot(this.surfaceCall(session, signal));
    } catch {
      // The re-read only words the failure; when it fails too, the deadline is what happened.
      return error;
    }
    const shard = snapshot.shards.find((candidate) => candidate.id === error.shardId);
    if (shard === undefined) return new OxiaError("shard-not-found", { shardId: error.shardId, rpc: error.rpc });
    if (error.leader !== undefined && shard.leader.address !== error.leader)
      return new OxiaError("leader-changing", { shardId: error.shardId, rpc: error.rpc });
    return error;
  }

  /** A surface read under the surface deadline, its failure through the one failure path. */
  private async read<T>(
    operation: string,
    work: (surface: OxiaSurface, call: OxiaCallOptions) => Promise<T>,
  ): Promise<T> {
    const session = this.requireSession();
    try {
      return await work(session.surface, this.surfaceCall(session));
    } catch (error) {
      throw await this.providerError(error, operation, session, this.surfaceTimeoutMs(session));
    }
  }

  // ==========================================================================
  // Query path (SB2-5.3)
  // ==========================================================================

  /**
   * One console command: re-parsed here with the connection's own context, so the server is the authority for the
   * -a, -n and write-command sentences whatever the browser sent (SB2-5.2), then run under the run registry and the
   * query timeout. The timeout is the calls' one absolute deadline, never the run's signal: grpc-js ends a call past it
   * with DEADLINE_EXCEEDED, so SB1-9.4's re-read runs and the deadline sentence is what the user reads; the run's
   * signal aborts only at a cancel or at the session's end (ruling R2).
   */
  public async query(text: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    if (params !== undefined && params.length > 0) throw new DatabaseConfigError(PARAMETERS_REFUSAL, OXIA_TYPE);
    const session = this.requireSession();
    if (this.agentProfile) throw new RefusedBeforeSendError(PROFILE_SURFACE_REFUSED, OXIA_TYPE, text);
    const { options } = session;
    const parsed = parseOxiaCommand(text, {
      endpoint: oxiaEndpointText(options),
      namespace: options.namespace,
      // The mode is named while it holds, whatever set it (O1).
      readOnly: options.readOnly !== undefined,
    });
    if (!parsed.ok) throw new QueryError(parsed.refusal.message, OXIA_TYPE);
    const deadline = Date.now() + options.callTimeoutMs;
    // No timeout signal: the session's lifetime, so the run aborts only at its cancel or at disconnect.
    const run = this.runs.begin(queryId, session.lifetime.signal);
    try {
      const started = Date.now();
      const outcome = await executeOxiaCommand(session.surface, parsed.parsed, {
        bounds: {
          rowLimit: OXIA_MAX_LIMIT,
          byteBudget: OXIA_RUN_BYTE_BUDGET,
          cellLimit: OXIA_CELL_LIMIT,
          queryTimeoutMs: options.callTimeoutMs,
        },
        // Every call of the run, and its permit waits, end at this one deadline.
        call: { signal: run.signal, deadline },
        namespace: options.namespace,
      });
      return oxiaResult(outcome, parsed.parsed, OXIA_CELL_LIMIT, Date.now() - started);
    } catch (error) {
      throw await this.providerError(error, parsed.parsed.command.kind, session, options.callTimeoutMs, run.signal);
    } finally {
      run.end();
    }
  }

  /**
   * One agent command. Only on a handle opened under the agent read-only profile; the command is read by
   * `readOxiaAgentStatement` against the closed table and refused before anything is sent when it is not one of the
   * metadata reads. Then, under the request's deadline, the shard map is read afresh (never the brief cache) and the
   * read's own calls are sent over the read-only stub, in the connection's namespace, with no partition key, index,
   * comparison or header of the request's own, only the connection's token. Its answer is the metadata-only projection,
   * refused past the row or byte budget rather than cut, and an Oxia failure is worded by its category alone.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    const session = this.requireSession();
    if (!this.readOnlyProfile) throw new RefusedBeforeSendError(PROFILE_REQUIRED, OXIA_TYPE, statement);
    assertReadOnlyBudget(budget, OXIA_TYPE);
    if (mode !== "execute") throw new RefusedBeforeSendError(NO_ESTIMATE, OXIA_TYPE, statement);
    const reading = readOxiaAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, OXIA_TYPE, statement);
    const started = Date.now();
    // The session's lifetime, so a disconnect ends the read, and the request's deadline on every call and permit wait.
    const call: OxiaCallOptions = {
      signal: session.lifetime.signal,
      deadline: Date.now() + budget.statementTimeoutMs,
    };
    try {
      const answer = await this.agentRead(session, reading.plan, budget, call);
      return oxiaAgentResult(answer, budget, statement, Date.now() - started);
    } catch (error) {
      throw oxiaAgentFailure(error, budget, statement) ?? error;
    }
  }

  /** The reads of `plan` over the limited client, and their answer as the projection reads it. */
  private async agentRead(
    session: OxiaSession,
    plan: OxiaAgentPlan,
    budget: ReadOnlyStatementBudget,
    call: OxiaCallOptions,
  ): Promise<OxiaAgentAnswer> {
    const { client } = session.surface;
    const snapshot = await client.getSnapshot(call);
    switch (plan.op) {
      case "shards":
        return { op: plan.op, snapshot };
      case "key metadata": {
        const found = await readKeyAnywhere(client, snapshot, plan.key, call);
        if (!("holders" in found)) return { op: plan.op, record: found.record };
        if (found.holders > 1) throw new QueryError(OXIA_AGENT_COUNT_SENTENCES.manyHolders(found.holders), OXIA_TYPE);
        return { op: plan.op, record: undefined };
      }
      case "key count": {
        const { order } = await session.surface.order(call);
        const limit = budget.maxResultRows;
        // Every key of the namespace: a range the request names is refused before this, since narrower counts would
        // spell out key names.
        const answer = await listRange(
          client,
          snapshot,
          order,
          { range: { startInclusive: "", endExclusive: "" }, limit },
          call,
        );
        // The keys stay here: only how many there are is answered, and a namespace Studio could not count to its end is
        // refused rather than answered as the part it read.
        if (answer.stoppedBy !== undefined) throw new QueryError(OXIA_AGENT_COUNT_SENTENCES.overBytes, OXIA_TYPE);
        if (answer.more) throw new QueryError(OXIA_AGENT_COUNT_SENTENCES.overRows(limit), OXIA_TYPE);
        return { op: plan.op, count: answer.keys.length };
      }
    }
  }

  /** Stops a running or queued run by its id and answers true; an id that names no run answers false. */
  public async cancelQuery(queryId: string): Promise<boolean> {
    return this.runs.cancel(queryId);
  }

  // ==========================================================================
  // Object surface (SB2-7), answered by objects.ts
  // ==========================================================================

  public async listContainers(): Promise<Container[]> {
    return [];
  }

  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    requireRoot(container);
    return this.read("object read", (surface, call) => countOxiaObjects(surface, call));
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    requireRoot(container);
    if (this.agentProfile && kind === "key") {
      this.ensureConnected();
      throw new QueryError(PROFILE_SURFACE_REFUSED, OXIA_TYPE);
    }
    return this.read("object read", (surface, call) => listOxiaObjects(surface, kind, call));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    return describeOxiaObject(path, kind);
  }

  public async describeObjects(container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    requireRoot(container);
    return describeOxiaObjects(kind);
  }

  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    if (this.agentProfile && kind === "key") {
      this.ensureConnected();
      throw new QueryError(PROFILE_SURFACE_REFUSED, OXIA_TYPE);
    }
    return this.read("object read", (surface, call) => readOxiaObjectSource(surface, path, kind, limit, call));
  }

  // ==========================================================================
  // Keys panel (SB2-8), answered by key-scan.ts
  // ==========================================================================

  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    // The options are refused before the session is read, so a refused page sends nothing.
    readOxiaKeyScanOptions(options);
    if (this.agentProfile) {
      this.ensureConnected();
      throw new QueryError(PROFILE_SURFACE_REFUSED, OXIA_TYPE);
    }
    return this.read("Keys panel page", (surface, call) => scanOxiaKeysPage(surface, options, call));
  }

  // ==========================================================================
  // Monitoring (SB2-9.5), answered by monitoring-reads.ts
  // ==========================================================================

  /**
   * SB1-9.5: connect if needed, then the snapshot afresh and Health/Check, each under the health deadline. A provider
   * with no session builds one without the connect read (ruling R3), so the health read is the one snapshot read and a
   * silent shard map still reaches Check; the session is kept when health answers and closed when it fails.
   */
  public async getHealth(): Promise<HealthInfo> {
    const opened = this.session === null;
    const session = this.session ?? this.openSession();
    const deadlineMs = Math.min(OXIA_HEALTH_DEADLINE_MS, session.options.callTimeoutMs);
    try {
      const health = await oxiaHealth(session.surface, deadlineMs, session.lifetime.signal);
      if (opened) {
        this.session = session;
        this.setConnected(true);
      }
      return health;
    } catch (error) {
      const failure = await this.providerError(error, "health check", session, deadlineMs);
      if (opened) {
        session.lifetime.abort();
        session.client.close();
      }
      throw failure;
    }
  }

  public async getOverview(): Promise<DatabaseOverview> {
    return this.read("object read", (surface, call) => oxiaOverview(surface, call));
  }

  /** No RPC of the client API reports a size, and v1 has no metrics panel (O14). */
  public async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  /** Oxia has no tables; `tableStatsCaption` says where its shards and keys are. */
  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  /** Nothing is measured, so every optional figure is absent. */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return {};
  }

  /** Oxia keeps no query log. */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }

  /** Oxia does not list client sessions. */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }

  /** Secondary indexes have no catalog to list. */
  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  /** `supportsMaintenance: false`: nothing sends maintenance, and a direct call is refused in the label's words. */
  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(OXIA_LABELS.vacuumGlobalDesc, OXIA_TYPE);
  }
}
