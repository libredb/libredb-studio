/**
 * The provider contract's calls (docs/providers/CONTRACT.md, the calls chapter): the shapes the host passes a provider
 * package's implementation and the shapes it answers.
 *
 * The host calls the implementation in its own process, as async functions. Every request and answer is data in the
 * value codec's domain (`@libredb/provider-sdk/values`), except the session handle `open` answers, which is the
 * package's own and which the host never reads.
 *
 * The SDK declares each shape the contexts share with Studio's own source (`TlsSettings`, `EgressDecision`,
 * `TrustMaterial`, `PoolSettings`, `TunnelFarEnd`, `AdmittedHostPaths`) itself, because a package imports nothing from
 * Studio; a census in Studio's tests holds each one mutually assignable with Studio's type.
 */
import type {
  ConsoleCalls,
  EngineId,
  ExecuteRequestField,
  FacetOffer,
  FieldName,
  ProviderManifest,
} from "../manifest/manifest-types.generated";
import type { EnvReader } from "./env";

/** The provider contract this SDK's calls serve, the one the manifest schema names. */
export const PROVIDER_CONTRACT = "0.1" satisfies ProviderManifest["contract"];

/**
 * The optional console facets, the keys of `$defs/consoleCalls` other than `execute`, in schema order. Each is the path
 * to its function under the implementation's `console`, and the manifest's `calls.console` declares each as offered or
 * not.
 */
export const CONSOLE_FACETS = Object.freeze(["cancel", "endScope"] as const) satisfies readonly Exclude<
  keyof ConsoleCalls,
  "execute"
>[];

export type ConsoleFacet = (typeof CONSOLE_FACETS)[number];

/** The optional request fields of console execute, `$defs/executeRequestField`, in schema order. */
export const EXECUTE_REQUEST_FIELDS = Object.freeze([
  "params",
  "offset",
] as const) satisfies readonly ExecuteRequestField[];

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

/** The connection's TLS settings, as the connection holds them. */
export interface TlsSettings {
  readonly mode: "disable" | "require" | "verify-system" | "verify-ca" | "verify-full";
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
 * What a session answers narrower than its manifest's `calls`: a closed object at the paths of `calls`, every key
 * optional, every value a subset of the declared one. A key left out keeps the declared value. A later surface adds its
 * own top-level key.
 */
export interface Refinement {
  readonly calls?: {
    readonly console?: {
      readonly execute?: { readonly honours: readonly ExecuteRequestField[] };
      readonly cancel?: FacetOffer;
      readonly endScope?: FacetOffer;
    };
  };
}

/**
 * What `open` answers: the session handle, which the host never reads, the server's version where it reports one, and
 * a refinement where the session answers less than the manifest declares.
 */
export interface OpenAnswer<Handle> {
  readonly handle: Handle;
  readonly serverVersion?: string;
  readonly refine?: Refinement;
}

/** The page the host asks for, its bound resolved by the host: a limit and an offset, or every row. */
export type PageBound = { readonly limit: number; readonly offset: number } | { readonly unlimited: true };

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

/** How much one batch may hold. */
export interface BatchLimit {
  readonly maxRows: number;
  readonly maxBytes: number;
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
 * The console's calls. `execute` is mandatory; each optional facet is implemented exactly when the manifest's
 * `calls.console` offers it. Written as methods so an implementation over its own handle type is a
 * `ProviderImpl<unknown>` too: the handle is opaque to the host.
 */
export interface ConsoleImpl<Handle> {
  execute(handle: Handle, request: ExecuteRequest, ctx: CallContext): Promise<ExecuteAnswer>;
  cancel?(handle: Handle, request: CancelRequest, ctx: CallContext): Promise<CancelAnswer>;
  endScope?(handle: Handle, request: EndScopeRequest, ctx: CallContext): Promise<EndScopeAnswer>;
}

/** A package's implementation: the functions the host calls, keyed by the path of each call's name. */
export interface ProviderImpl<Handle> {
  open(ctx: OpenContext): Promise<OpenAnswer<Handle>>;
  close(handle: Handle, ctx: CallContext): Promise<void>;
  readonly console: ConsoleImpl<Handle>;
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
