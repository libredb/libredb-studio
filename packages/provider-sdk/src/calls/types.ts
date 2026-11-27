/**
 * The provider contract's calls (docs/providers/CONTRACT.md, the calls chapter): the shapes the host passes a provider
 * package's implementation and the shapes it answers.
 *
 * The host calls the implementation in its own process, as async functions. Every request and answer is data in the
 * value codec's domain (`@libredb/provider-sdk/values`), except the session handle `open` answers, which is the
 * package's own and which the host never reads.
 *
 * The SDK declares each shape the contexts and the object tree share with Studio's own source (`TlsSettings`,
 * `EgressDecision`, `TrustMaterial`, `PoolSettings`, `TunnelFarEnd`, `AdmittedHostPaths`, and the tree's `Container`,
 * `DatabaseObject`, `KindCount`, `ObjectDetail` and the shapes they hold, the maintenance run's answer and the
 * maintenance preview, the monitoring panels' answers and the pool statistics, and the health answer) itself, because a
 * package imports nothing from Studio; a census in Studio's tests holds each one mutually assignable with Studio's
 * type.
 */
import type {
  AgentReading,
  ConsoleCalls,
  EngineId,
  ExecuteRequestField,
  FacetOffer,
  Facets,
  FieldName,
  MaintenanceCalls,
  MaintenanceOperation,
  MonitoringCalls,
  MonitoringPanels,
  ObjectsCalls,
  ProviderManifest,
  TlsMode,
} from "../manifest/manifest-types.generated";
import type { SessionState } from "../errors";
import type { EnvReader } from "./env";

/** The provider contract this SDK's calls serve, the one the manifest schema names. */
export const PROVIDER_CONTRACT = "0.1" satisfies ProviderManifest["contract"];

/**
 * The optional console facets, the keys of `$defs/consoleCalls` other than `execute`, in schema order. Each is the path
 * to its function under the implementation's `console`, and the manifest's `calls.console` declares each as offered or
 * not.
 */
export const CONSOLE_FACETS = Object.freeze(["cancel", "endScope", "transaction"] as const) satisfies readonly Exclude<
  keyof ConsoleCalls,
  "execute"
>[];

export type ConsoleFacet = (typeof CONSOLE_FACETS)[number];

/**
 * The actions a `console.transaction` request names: open a transaction on the session, commit it, roll it back, or
 * read the session state, which changes nothing.
 */
export const TRANSACTION_ACTIONS = Object.freeze(["begin", "commit", "rollback", "state"] as const);

export type TransactionAction = (typeof TRANSACTION_ACTIONS)[number];

/**
 * The optional object facets, the keys of `$defs/objectsCalls`, in schema order. Each is the path to its function under
 * the implementation's `objects`, and the manifest's `calls.objects` declares each as offered or not.
 */
export const OBJECTS_FACETS = Object.freeze(["tree"] as const) satisfies readonly (keyof ObjectsCalls)[];

export type ObjectsFacet = (typeof OBJECTS_FACETS)[number];

/**
 * The actions an `objects.tree` request names: list the containers under a parent, count each kind's objects in one
 * container, list one kind's objects in one container, describe one object, and describe every object of one kind in
 * one container in one read.
 */
export const TREE_ACTIONS = Object.freeze(["containers", "count", "list", "describe", "describeMany"] as const);

export type TreeAction = (typeof TREE_ACTIONS)[number];

/**
 * The maintenance facets, the keys of `$defs/maintenanceCalls`, in schema order. Each is the path to its function under
 * the implementation's `maintenance`, and the manifest's `calls.maintenance` declares each as offered or not.
 */
export const MAINTENANCE_FACETS = Object.freeze([
  "run",
  "preview",
] as const) satisfies readonly (keyof MaintenanceCalls)[];

export type MaintenanceFacet = (typeof MAINTENANCE_FACETS)[number];

/** The maintenance operations, `$defs/maintenanceOperation`, in schema order: the vocabulary an engine's list names. */
export const MAINTENANCE_OPERATIONS = Object.freeze([
  "vacuum",
  "analyze",
  "reindex",
  "kill",
  "optimize",
  "check",
  "compact",
  "defragment",
  "disarm",
  "load",
  "release",
] as const) satisfies readonly MaintenanceOperation[];

/**
 * The monitoring facets, the keys of `$defs/monitoringCalls`, in schema order. Each is the path to its function under
 * the implementation's `monitoring`, and the manifest's `calls.monitoring` declares each as offered or not.
 */
export const MONITORING_FACETS = Object.freeze([
  "panel",
  "poolStats",
] as const) satisfies readonly (keyof MonitoringCalls)[];

export type MonitoringFacet = (typeof MONITORING_FACETS)[number];

/**
 * The call that serves each agent reading, `$defs/agentReading`, in schema order: the monitoring panel of
 * `$defs/monitoringPanels` whose `monitoring.panel` call reads it, or null for `health`, which the mandatory health
 * call serves. An engine's reading is admitted where that call is offered (clause C-4).
 */
export const AGENT_READING_PANELS = Object.freeze({
  sessions: "activeSessions",
  "slow-queries": "slowQueries",
  "table-stats": "tables",
  "index-stats": "indexes",
  storage: "storage",
  health: null,
} as const) satisfies Readonly<Record<AgentReading, keyof MonitoringPanels | null>>;

/** The optional request fields of console execute, `$defs/executeRequestField`, in schema order. */
export const EXECUTE_REQUEST_FIELDS = Object.freeze([
  "params",
  "offset",
  "readOnly",
] as const) satisfies readonly ExecuteRequestField[];

/**
 * The modes of a read-only execute (clause C-78): `execute` runs the statement and answers its rows, and
 * `estimate-plan` answers the engine's estimated plan for it, never running it, or refuses. A request without a mode
 * executes the statement.
 */
export const READ_ONLY_MODES = Object.freeze(["execute", "estimate-plan"] as const);

export type ReadOnlyMode = (typeof READ_ONLY_MODES)[number];

/** What every call is given beside its request. */
export interface CallContext {
  /**
   * When the call must have answered: one absolute time, in epoch milliseconds on the clock `Date.now()` reads, which
   * every step of the call consumes.
   */
  readonly deadline: number;
  /** Aborts when the deadline passes or the caller goes. */
  readonly signal: AbortSignal;
  /** The package's declared environment, read through the host. */
  readonly env: EnvReader;
}

/**
 * The connection's TLS settings, as the connection holds them. `mode` is typed as one of the provider contract's TLS
 * modes; that the engine's declaration lists it is not yet held on every path, and the test-connection route and the
 * storage writes do not yet hold a mode to the contract's modes either (backlog D790).
 */
export interface TlsSettings {
  readonly mode: TlsMode;
  readonly caCert?: string;
  readonly clientCert?: string;
  readonly clientKey?: string;
  readonly rejectUnauthorized?: boolean;
}

/** Core's egress decision: whether private hosts are blocked, and whether that is the documented default. */
export interface EgressDecision {
  readonly blocksPrivateHosts: boolean;
  readonly source: "default" | "set";
}

/** Core's trust material: the certificates the operator added to the trust store, never the file they came from. */
export interface TrustMaterial {
  readonly certificates: readonly string[];
}

/** The pool a session opens, with core's defaults filled in. */
export interface PoolSettings {
  readonly min: number;
  readonly max: number;
  /** Milliseconds an idle connection is kept. */
  readonly idleTimeout: number;
  /** Milliseconds a request waits for a connection. */
  readonly acquireTimeout: number;
}

/** Where core's SSH tunnel forwards to: the address the connection named before core rewrote `host` and `port`. */
export interface TunnelFarEnd {
  readonly host: string;
  readonly port: number;
}

/**
 * The files on the host the connection's host path fields name, as core admitted them: an absolute path per field the
 * connection sets.
 */
export interface AdmittedHostPaths {
  readonly clientCertificatePath?: string;
  readonly clientPrivateKeyPath?: string;
}

/** One value of a connection field, as the connection holds it. */
export type ConnectionFieldValue = string | number | boolean | readonly string[];

/** The connection's values, keyed by the contract's field names; a field the connection does not set is absent. */
export type ConnectionFieldValues = { readonly [Field in FieldName]?: ConnectionFieldValue };

/** What the host decided the session may do. */
export interface OpenPolicy {
  /** Open the session under an execution profile's read-only boundary. */
  readonly readOnly: boolean;
  /** Whether the session will be sent statements under that boundary, so a provider that proves it at open does. */
  readonly sendsStatements: boolean;
  /** Whether a statement may reach files and the network beyond the database's own. */
  readonly allowExternalFileAccess: boolean;
  /** The connection's read-only mode: refuse every write before anything is sent. */
  readonly refuseWrites: boolean;
  /**
   * The connection is an operator's seed, its `managed` flag exactly true. With `literalSeedFile` false the server side
   * wrote its credential text, the one case a provider may sign in with the server's own identity.
   */
  readonly managed: boolean;
  /**
   * The connection is a row of a seed file read in literal mode, which a platform writes from data its users control,
   * so it is never server-written, whatever `managed` says.
   */
  readonly literalSeedFile: boolean;
}

/** What `open` is given. */
export interface OpenContext extends CallContext {
  /** The engine, of those the manifest declares, the connection is opened as. */
  readonly engine: EngineId;
  /** The connection's id, the same across every session the host opens for it. */
  readonly connectionId: string;
  /** The id of the operator seed the connection came from, where it came from one. */
  readonly seedId?: string;
  /**
   * The connection's fields as the host rewrote them: a tunnel's local endpoint replaces `host` and `port`, and an
   * agent credential replaces `user` and `password`.
   */
  readonly connection: ConnectionFieldValues;
  /** Where the tunnel core opened forwards to; present only when the session runs through one. */
  readonly tunnelFarEnd?: TunnelFarEnd;
  /** The route of the connection's SSH tunnel, its switch, bastion and user length-framed; present when it has one. */
  readonly tunnelRoute?: string;
  /**
   * The file a local-file engine opens, as core admitted it: an absolute path, or `:memory:`. The provider opens it and
   * resolves nothing itself; the `database` and `connectionString` fields stay as the connection holds them.
   */
  readonly admittedFile?: string;
  /** The files the connection's host path fields name, as core admitted them. */
  readonly admittedHostPaths?: AdmittedHostPaths;
  readonly tls?: TlsSettings;
  readonly egress: EgressDecision;
  readonly trust: TrustMaterial;
  readonly policy: OpenPolicy;
  readonly pool?: PoolSettings;
  readonly timezone?: string;
}

/**
 * For one maintenance operation a provider measured at open, the placements its server accepts: on a row, over the
 * whole database, or neither.
 */
export interface MaintenanceAccepted {
  readonly operation: MaintenanceOperation;
  readonly perEntity: boolean;
  readonly global: boolean;
}

/** The maintenance an engine declares: the two maintenance members of its facets, the list and the specs. */
export type EngineMaintenance = Pick<Facets, "maintenance" | "maintenanceSpecs">;

/**
 * What a session answers narrower than its manifest's `calls`: a closed object at the paths of `calls`, every key
 * optional, every value a subset of the declared one. A key left out keeps the declared value. A later surface adds its
 * own top-level key: `maintenance` holds the placements the session's server accepts, one item for each operation the
 * provider measured, which only withdraw what the session's engine declares.
 */
export interface Refinement {
  readonly calls?: {
    readonly console?: {
      readonly execute?: { readonly honours: readonly ExecuteRequestField[] };
      readonly cancel?: FacetOffer;
      readonly endScope?: FacetOffer;
      readonly transaction?: FacetOffer;
    };
    readonly objects?: {
      readonly tree?: FacetOffer;
    };
    readonly maintenance?: {
      readonly run?: FacetOffer;
      readonly preview?: FacetOffer;
    };
    readonly monitoring?: {
      readonly panel?: FacetOffer;
      readonly poolStats?: FacetOffer;
    };
  };
  readonly maintenance?: readonly MaintenanceAccepted[];
}

/**
 * What `open` answers: the session handle, which the host never reads, the server's version where it reports one, a
 * refinement where the session answers less than the manifest declares, and the engine principal the session acts as
 * where the provider can name one.
 */
export interface OpenAnswer<Handle> {
  readonly handle: Handle;
  readonly serverVersion?: string;
  readonly refine?: Refinement;
  /**
   * The engine principal the session acts as, a user name and never any part of a secret, which the maintenance audit
   * row names.
   */
  readonly engineUser?: string;
}

/** The page the host asks for, its bound resolved by the host: a limit and an offset, or every row. */
export type PageBound = { readonly limit: number; readonly offset: number } | { readonly unlimited: true };

/** The most a read-only execute may answer: a count of rows and of UTF-8 JSON bytes of those rows. */
export interface ReadBudget {
  readonly maxRows: number;
  readonly maxBytes: number;
}

/**
 * A read-only execute (clause C-78): the statement runs on the session's read-only boundary, its answer within the
 * budget's rows and bytes or refused, never truncated, in the mode asked for. Its time is the call's deadline, so it
 * carries none of its own.
 */
export interface ReadOnlyExecute {
  readonly budget: ReadBudget;
  /** Absent: the statement executes. */
  readonly mode?: ReadOnlyMode;
}

/** What console execute is asked to run. */
export interface ExecuteRequest {
  readonly statement: string;
  /** The caller's name for this run, so `console.cancel` can name it. */
  readonly runId?: string;
  /** Bound parameter values, in the value codec's domain; sent only to a package that honours `params`. */
  readonly params?: readonly unknown[];
  /** A non-zero offset is sent only to a package that honours `offset`. */
  readonly page: PageBound;
  /** The session scope the statement runs in; sent only to a package that offers `console.endScope`. */
  readonly scope?: string;
  /**
   * The statement runs inside the transaction `console.transaction` opened on the session, on the transaction's own
   * connection; sent only to a package that offers `console.transaction`, and never with a `scope`. A statement sent
   * without it runs outside any transaction the facet opened.
   */
  readonly transaction?: true;
  /**
   * A read-only execute, sent only to a package that honours `readOnly`, and only to a session opened with
   * `policy.readOnly` and `policy.sendsStatements` both true, which takes no execute without it (clause C-78).
   */
  readonly readOnly?: ReadOnlyExecute;
}

/** A notice the engine attached to a statement it completed. */
export interface Warning {
  readonly message: string;
  readonly code?: number | string;
  readonly severity?: string;
}

/** A column that holds vectors: their kind, element type, dimension and, for a sparse column, its cell encoding. */
export interface VectorColumnShape {
  readonly kind: "dense" | "sparse" | "multi";
  readonly dtype: "float32" | "float64" | "float16" | "bfloat16" | "int8" | "uint8" | "binary";
  readonly dimension: number | null;
  readonly sparseEncoding?: "index-map" | "indices-values";
}

/** One column of a result: its name, unique in its result, its type as the engine spells it, and its vector shape. */
export interface Column {
  readonly name: string;
  readonly type?: string;
  readonly vector?: VectorColumnShape;
}

/** How much one batch may hold, and the pump's own row measure for the pull that asks for it. */
export interface BatchLimit {
  readonly maxRows: number;
  readonly maxBytes: number;
  /**
   * The size of `row`, as `encodedRowBytes` answers it: the pump's own measure for this pull, so a source sizes each
   * row it answers with it, and the pump measures no such row again. Called after its pull answered, it throws.
   *
   * @throws {ValueCodecError} For a cell outside the value codec's domain.
   * @throws {Error} When called after its pull answered, a defect of the source.
   */
  readonly measure: (row: readonly unknown[]) => number;
}

/** One batch of rows, each positional under the result's columns, and whether the result has no row left. */
export interface RowBatch {
  readonly rows: readonly (readonly unknown[])[];
  readonly done: boolean;
}

/** One result set, read in batches. */
export interface ResultSource {
  readonly columns: readonly Column[];
  /** The provider's own count of rows the statement returned or changed, never a recount. */
  readonly rowCount?: number;
  next(limit: BatchLimit): Promise<RowBatch>;
  close(): Promise<void>;
}

/** What console execute answers. */
export interface ExecuteAnswer {
  /** One source per result set, in the engine's order. */
  readonly results: readonly ResultSource[];
  readonly warnings: readonly Warning[];
  readonly executionTimeMs: number;
  /** Whether the provider rewrote the statement to apply the page. */
  readonly pageApplied: boolean;
  /** Set when the provider applied a bound of its own. */
  readonly boundApplied?: true;
  readonly explainPlan?: unknown;
  /** The session state after the statement; answered to every statement sent with `transaction`. */
  readonly sessionState?: SessionState;
}

export interface CancelRequest {
  readonly runId: string;
}

/** Whether the engine stopped the run. */
export interface CancelAnswer {
  readonly cancelled: boolean;
}

export interface EndScopeRequest {
  readonly scope: string;
}

/** Whether the scope's session held an open transaction, which is then rolled back. */
export interface EndScopeAnswer {
  readonly openTransaction: "none" | "rolled-back";
}

/**
 * What `console.transaction` is asked to do. `begin` may require the server to report the transaction state, so a
 * provider that cannot read it refuses the begin rather than answer a state it guessed.
 */
export type TransactionRequest =
  | { readonly action: "begin"; readonly requireReportedState?: true }
  | { readonly action: Exclude<TransactionAction, "begin"> };

/**
 * The session state after a `console.transaction` call: `in-transaction`, an aborted transaction included,
 * `not-in-transaction`, or `unknown` when the provider cannot tell. Only `begin` may answer `stateReported`, whether the
 * server reported the transaction state.
 */
export interface TransactionAnswer {
  readonly sessionState: SessionState;
  readonly stateReported?: boolean;
}

/**
 * The console's calls. `execute` is mandatory; each optional facet is implemented exactly when the manifest's
 * `calls.console` offers it. Written as methods so an implementation over its own handle type is a
 * `ProviderImpl<unknown>` too: the handle is opaque to the host.
 */
export interface ConsoleImpl<Handle> {
  execute(handle: Handle, request: ExecuteRequest, ctx: CallContext): Promise<ExecuteAnswer>;
  cancel?(handle: Handle, request: CancelRequest, ctx: CallContext): Promise<CancelAnswer>;
  endScope?(handle: Handle, request: EndScopeRequest, ctx: CallContext): Promise<EndScopeAnswer>;
  transaction?(handle: Handle, request: TransactionRequest, ctx: CallContext): Promise<TransactionAnswer>;
}

/**
 * One container: its path, opaque and sent back exactly as answered, its name, its index into the engine's container
 * levels, whether the session is already in it where the engine says so, and the kinds it holds when it does not hold
 * every one.
 */
export interface Container {
  readonly path: readonly string[];
  readonly name: string;
  readonly level: number;
  readonly isSessionDefault?: boolean;
  readonly kinds?: readonly string[];
}

/** One piece of an object's key range the connection may read: one key, every key under a prefix, or a range. */
export type ObjectReadRange =
  | { readonly key: string }
  | { readonly prefix: string }
  | { readonly start: string; readonly end: string };

/**
 * One object: its path, which addresses it, opaque and sent back exactly as answered, its name, which labels it, its
 * kind, the engine's word for a state a reader should act on, its counts where the engine has them, and the pieces of
 * its range the connection may read where they do not cover it.
 */
export interface DatabaseObject {
  readonly path: readonly string[];
  readonly name: string;
  readonly kind: string;
  readonly status?: string;
  readonly rowCount?: number;
  readonly sizeBytes?: number;
  readonly readRanges?: readonly ObjectReadRange[];
}

/**
 * The count of one kind in one container: a count, a count read from a bounded sample with the provider's sentence for
 * what bounded it, or the engine's sentence for a read that was refused.
 */
export type KindCount =
  | { readonly count: number }
  | { readonly count: number; readonly sampledFrom: string }
  | { readonly unavailable: string };

/** One column of an object, as Studio's object detail carries it. */
export interface ColumnSchema {
  readonly name: string;
  readonly type: string;
  readonly baseType?: string;
  readonly declaredType?: string;
  readonly nullable: boolean;
  readonly isPrimary: boolean;
  readonly defaultValue?: string;
  readonly defaultExpression?: string;
  readonly provenance?: "sampled";
  readonly projectable?: boolean;
}

/** One index of an object. Its columns are a mutable list, as Studio's own type has them. */
export interface IndexSchema {
  readonly name: string;
  readonly columns: string[];
  readonly unique: boolean;
}

/** One foreign key of an object. */
export interface ForeignKeySchema {
  readonly columnName: string;
  readonly referencedTable: string;
  readonly referencedColumn: string;
}

/** One exclusion constraint of an object: its name and its definition as the engine prints it. */
export interface ExclusionConstraintSchema {
  readonly name: string;
  readonly definition: string;
}

/**
 * One object's columns, indexes and foreign keys, its indexes the engine's sentence where the read was refused, and its
 * exclusion constraints where the engine has them.
 */
export interface ObjectDetail {
  readonly path: readonly string[];
  readonly columns: readonly ColumnSchema[];
  readonly indexes: readonly IndexSchema[] | { readonly unavailable: string };
  readonly foreignKeys: readonly ForeignKeySchema[];
  readonly exclusionConstraints?: readonly ExclusionConstraintSchema[];
}

/** Every object's detail of one kind in one container, and the bound that stopped the read short, when one did. */
export interface ObjectDetailBatch {
  readonly details: readonly ObjectDetail[];
  readonly truncated?: { readonly limit: number; readonly reason: string };
}

/** List the containers under `parent`, or at the top level when it is absent. */
export interface TreeContainersRequest {
  readonly action: "containers";
  readonly parent?: readonly string[];
}

/** Count each kind's objects in one container. */
export interface TreeCountRequest {
  readonly action: "count";
  readonly container: readonly string[];
}

/** List one kind's objects in one container. */
export interface TreeListRequest {
  readonly action: "list";
  readonly container: readonly string[];
  readonly kind: string;
}

/** Describe one object of one kind. */
export interface TreeDescribeRequest {
  readonly action: "describe";
  readonly path: readonly string[];
  readonly kind: string;
}

/**
 * Describe every object of one kind in one container in one read, at most `limit` of them when it is sent, each default
 * as SQL text when `defaultSql` is sent.
 */
export interface TreeDescribeManyRequest {
  readonly action: "describeMany";
  readonly container: readonly string[];
  readonly kind: string;
  readonly limit?: number;
  readonly defaultSql?: true;
}

/** What `objects.tree` is asked to do: one request per action, each with its own members. */
export type TreeRequest =
  | TreeContainersRequest
  | TreeCountRequest
  | TreeListRequest
  | TreeDescribeRequest
  | TreeDescribeManyRequest;

/** What a `containers` request answers. */
export interface TreeContainersAnswer {
  readonly containers: readonly Container[];
  /**
   * Sent only on a top-level listing (no `parent`) that answers no container: the provider's sentence for why its
   * inventory cannot be listed without configuration the session lacks, completing "could be listed:". An engine with
   * no container level reads no top-level listing, so it is never asked.
   */
  readonly needsConfiguration?: string;
}

/** What a `count` request answers: each kind's count, keyed by the kind. */
export interface TreeCountAnswer {
  readonly counts: Readonly<Record<string, KindCount>>;
}

/** What a `list` request answers. */
export interface TreeListAnswer {
  readonly objects: readonly DatabaseObject[];
}

/** What a `describe` request answers. */
export interface TreeDescribeAnswer {
  readonly detail: ObjectDetail;
}

/**
 * What `objects.tree` answers, one form per action, each told apart by its keys: a `describeMany` request answers an
 * `ObjectDetailBatch`.
 */
export type TreeAnswer =
  | TreeContainersAnswer
  | TreeCountAnswer
  | TreeListAnswer
  | TreeDescribeAnswer
  | ObjectDetailBatch;

/**
 * The form a request of action `A` answers: the one `checkTreeAnswer` holds the answer to, so a reader past that check
 * reads its action's member as typed.
 */
export type TreeAnswerOf<A extends TreeAction> = {
  readonly containers: TreeContainersAnswer;
  readonly count: TreeCountAnswer;
  readonly list: TreeListAnswer;
  readonly describe: TreeDescribeAnswer;
  readonly describeMany: ObjectDetailBatch;
}[A];

/**
 * The object facets. Each is implemented exactly when the manifest's `calls.objects` offers it. Written as methods so
 * an implementation over its own handle type is a `ProviderImpl<unknown>` too.
 */
export interface ObjectsImpl<Handle> {
  tree?(handle: Handle, request: TreeRequest, ctx: CallContext): Promise<TreeAnswer>;
}

/**
 * What `maintenance.run` is asked to run: one operation the session's engine lists, on the object or session `target`
 * names in the namespace `container` names. An absent `target` runs the operation over the whole database, and an
 * absent `container` names none.
 */
export interface MaintenanceRunRequest {
  readonly operation: MaintenanceOperation;
  /** The object a per-row control names, or the session id a `kill` ends. */
  readonly target?: string;
  /** The namespace the target lives in, by the engine's own meaning: a schema, a database, an owner, a bucket. */
  readonly container?: string;
}

/**
 * What `maintenance.run` answers: whether the engine took the operation, how long it ran in milliseconds and the
 * engine's sentence, and, for an operation whose answer is a table, its rows and their fields; `fields` is present
 * whenever `rows` is, and every row value is in the value codec's domain.
 */
export interface MaintenanceRunAnswer {
  readonly success: boolean;
  readonly executionTime: number;
  readonly message: string;
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  /** The order of the columns of `rows`. */
  readonly fields?: readonly string[];
}

/**
 * What `maintenance.preview` is asked to read: what one per-row operation would do to the object `path` addresses,
 * container levels first and the object last, so `path` is never empty.
 */
export interface MaintenancePreviewRequest {
  readonly operation: MaintenanceOperation;
  readonly path: readonly string[];
}

/** One figure a maintenance preview rests on, printed as a label and its value. */
export interface MaintenanceFact {
  readonly label: string;
  readonly value: string;
}

/**
 * What `maintenance.preview` answers: one sentence of what the operation will do, the facts it rests on, the
 * preflight's sentence where one refuses the operation, and how fresh or exact the facts are.
 */
export interface MaintenancePreview {
  readonly summary: string;
  readonly facts: readonly MaintenanceFact[];
  readonly refusal?: string;
  readonly note?: string;
}

/**
 * The maintenance facets. Each is implemented exactly when the manifest's `calls.maintenance` offers it. Written as
 * methods so an implementation over its own handle type is a `ProviderImpl<unknown>` too.
 */
export interface MaintenanceImpl<Handle> {
  run?(handle: Handle, request: MaintenanceRunRequest, ctx: CallContext): Promise<MaintenanceRunAnswer>;
  preview?(handle: Handle, request: MaintenancePreviewRequest, ctx: CallContext): Promise<MaintenancePreview>;
}

/** A monitoring panel, `$defs/monitoringPanels`' keys: the vocabulary an engine's `facets.monitoring` states. */
export type MonitoringPanel = keyof MonitoringPanels;

/** Read the overview panel. */
export interface MonitoringOverviewRequest {
  readonly panel: "overview";
}

/** Read the performance panel. */
export interface MonitoringPerformanceRequest {
  readonly panel: "performance";
}

/** Read the slow queries panel: at most `limit` queries, a bound the host resolves. */
export interface MonitoringSlowQueriesRequest {
  readonly panel: "slowQueries";
  readonly limit: number;
}

/** Read the active sessions panel: at most `limit` sessions, a bound the host resolves. */
export interface MonitoringActiveSessionsRequest {
  readonly panel: "activeSessions";
  readonly limit: number;
}

/** Read the table statistics panel: the tables of `schema`, or of every user schema when it is absent. */
export interface MonitoringTablesRequest {
  readonly panel: "tables";
  readonly schema?: string;
}

/** Read the index statistics panel: the indexes of `schema`, or of every user schema when it is absent. */
export interface MonitoringIndexesRequest {
  readonly panel: "indexes";
  readonly schema?: string;
}

/** Read the storage panel. */
export interface MonitoringStorageRequest {
  readonly panel: "storage";
}

/**
 * What `monitoring.panel` is asked to read: one request per panel, each told apart by its `panel` and with its own
 * members.
 */
export type MonitoringPanelRequest =
  | MonitoringOverviewRequest
  | MonitoringPerformanceRequest
  | MonitoringSlowQueriesRequest
  | MonitoringActiveSessionsRequest
  | MonitoringTablesRequest
  | MonitoringIndexesRequest
  | MonitoringStorageRequest;

/**
 * The overview panel: the server's version and uptime, when it started, its open connections where the engine measures
 * them, its connection ceiling, where `0` says none is published, its size, in bytes where the engine publishes a byte
 * figure, and its table and index counts, the table count a floor where `tableCountSampledFrom` says what it counted.
 */
export interface DatabaseOverview {
  readonly version: string;
  readonly uptime: string;
  readonly startTime?: Date;
  readonly activeConnections?: number;
  readonly maxConnections: number;
  readonly databaseSize: string;
  readonly databaseSizeBytes?: number;
  readonly tableCount: number;
  readonly tableCountSampledFrom?: string;
  readonly indexCount: number;
}

/**
 * The performance panel, each figure present only where the engine measures it: the cache hit ratio as a percentage,
 * the engine's advice for a low one, transactions and queries per second, buffer pool usage as a percentage, deadlocks
 * and checkpoint write time.
 */
export interface PerformanceMetrics {
  readonly cacheHitRatio?: number;
  readonly cacheHitAdvice?: string;
  readonly transactionsPerSecond?: number;
  readonly queriesPerSecond?: number;
  readonly bufferPoolUsage?: number;
  readonly deadlocks?: number;
  readonly checkpointWriteTime?: string;
}

/** One slow query, with its statistics. */
export interface SlowQueryStats {
  readonly queryId?: string;
  readonly query: string;
  readonly calls: number;
  readonly totalTime: number;
  readonly avgTime: number;
  readonly minTime?: number;
  readonly maxTime?: number;
  readonly rows: number;
  readonly sharedBlksHit?: number;
  readonly sharedBlksRead?: number;
}

/** Which summary card a session counts toward; `waiting` is a session that is blocked. */
export type SessionActivity = "active" | "idle" | "idle-in-transaction" | "waiting" | "other";

/**
 * One session: its engine's own status word in `state`, the card it counts toward where the engine classifies its
 * vocabulary, and `terminable` false on a row the engine's kill cannot end.
 */
export interface ActiveSessionDetails {
  readonly pid: number | string;
  readonly user: string;
  readonly database: string;
  readonly applicationName?: string;
  readonly clientAddr?: string;
  readonly state: string;
  readonly activity?: SessionActivity;
  readonly query: string;
  readonly queryStart?: Date;
  readonly duration: string;
  readonly durationMs: number;
  readonly waitEventType?: string;
  readonly waitEvent?: string;
  readonly blocked?: boolean;
  readonly terminable?: boolean;
}

/** One table's statistics, each count and size present only where the engine publishes it. */
export interface TableStats {
  readonly schemaName: string;
  readonly tableName: string;
  readonly rowCount?: number;
  readonly liveRowCount?: number;
  readonly deadRowCount?: number;
  readonly tableSize?: string;
  readonly tableSizeBytes?: number;
  readonly indexSize?: string;
  readonly indexSizeBytes?: number;
  readonly totalSize: string;
  readonly totalSizeBytes: number;
  readonly lastVacuum?: Date;
  readonly lastAnalyze?: Date;
  readonly bloatRatio?: number;
}

/** One index's statistics. Its columns are a mutable list, as Studio's own type has them. */
export interface IndexStats {
  readonly schemaName: string;
  readonly tableName: string;
  readonly indexName: string;
  readonly indexType?: string;
  readonly columns: string[];
  readonly isUnique: boolean;
  readonly isPrimary: boolean;
  readonly indexSize: string;
  readonly indexSizeBytes?: number;
  readonly scans: number;
  readonly usageRatio?: number;
}

/** One storage area: its name, where it lives, its size and usage, and its write-ahead log's size where it has one. */
export interface StorageStats {
  readonly name: string;
  readonly location?: string;
  readonly size: string;
  readonly sizeBytes: number;
  readonly usagePercent?: number;
  readonly walSize?: string;
  readonly walSizeBytes?: number;
}

/**
 * What `monitoring.panel` answers: one form per panel with exactly one key, the panel's own, holding what that panel
 * reads, which is the monitoring payload's member for that panel.
 */
export type MonitoringPanelAnswer =
  | { readonly overview: DatabaseOverview }
  | { readonly performance: PerformanceMetrics }
  | { readonly slowQueries: readonly SlowQueryStats[] }
  | { readonly activeSessions: readonly ActiveSessionDetails[] }
  | { readonly tables: readonly TableStats[] }
  | { readonly indexes: readonly IndexStats[] }
  | { readonly storage: readonly StorageStats[] };

/**
 * The counts of the session's own pool: its connections in all, the idle and the active ones, the requests waiting for
 * one, and the configured ceiling where the provider reports one.
 */
export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  readonly active: number;
  readonly waiting: number;
  readonly max?: number;
}

/**
 * The monitoring facets. Each is implemented exactly when the manifest's `calls.monitoring` offers it. Written as
 * methods so an implementation over its own handle type is a `ProviderImpl<unknown>` too.
 */
export interface MonitoringImpl<Handle> {
  panel?(handle: Handle, request: MonitoringPanelRequest, ctx: CallContext): Promise<MonitoringPanelAnswer>;
  poolStats?(handle: Handle, ctx: CallContext): Promise<PoolStats>;
}

/** One of the slowest queries a health answer names. */
export interface SlowQuery {
  readonly query: string;
  readonly calls: number;
  readonly avgTime: string;
}

/** One session a health answer names. */
export interface ActiveSession {
  readonly pid: number | string;
  readonly user: string;
  readonly database: string;
  readonly state: string;
  readonly query: string;
  readonly duration: string;
}

/**
 * What `health` answers: the count of open connections where the engine measures it, left out where it cannot and never
 * a zero in its place, the database's size, its cache hit ratio, its slowest queries and its sessions.
 */
export interface HealthInfo {
  readonly activeConnections?: number;
  readonly databaseSize: string;
  readonly cacheHitRatio: string;
  readonly slowQueries: readonly SlowQuery[];
  readonly activeSessions: readonly ActiveSession[];
}

/** A package's implementation: the functions the host calls, keyed by the path of each call's name. */
export interface ProviderImpl<Handle> {
  open(ctx: OpenContext): Promise<OpenAnswer<Handle>>;
  close(handle: Handle, ctx: CallContext): Promise<void>;
  /** Reaches the engine and answers its health; every session answers it. */
  health(handle: Handle, ctx: CallContext): Promise<HealthInfo>;
  readonly console: ConsoleImpl<Handle>;
  /** The object facets; may be absent, or an empty record, when the implementation offers none. */
  readonly objects?: ObjectsImpl<Handle>;
  /** The maintenance facets; may be absent, or an empty record, when the implementation offers none. */
  readonly maintenance?: MaintenanceImpl<Handle>;
  /** The monitoring facets; may be absent, or an empty record, when the implementation offers none. */
  readonly monitoring?: MonitoringImpl<Handle>;
}

/**
 * The record a package's entry default-exports: a plain object, with no class and no brand, because several copies
 * of the SDK may share Studio's process and a brand of one copy means nothing to another.
 */
export interface ProviderModule {
  readonly contract: typeof PROVIDER_CONTRACT;
  /** A deep-frozen copy of the manifest the package passed; the schema admits it at the loader, not here. */
  readonly manifest: unknown;
  readonly impl: ProviderImpl<unknown>;
}
