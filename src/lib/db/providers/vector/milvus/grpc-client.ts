/**
 * The Milvus provider's gRPC adapter: the one provider file that imports @grpc/proto-loader and the generated
 * descriptor (vector-family spec 5.1, 5.11, E15), over the shared gRPC transport of src/lib/db/grpc/, which
 * tests/unit/db/milvus/seam-guard.test.ts holds.
 *
 * The channel, its options (`grpc.enable_retries: 0` among them), the credentials with the IP-identity rule and the
 * unary call are the shared gRPC transport's, src/lib/db/grpc/; this file adds a stub built from MilvusService
 * filtered to E15's allowlist, so no `Connect`, whose ClientInfo carries the host name, and no ClientTelemetryService
 * method can be called although the full descriptor is loaded (E3). Every allowlisted RPC answers as the first call on
 * a fresh channel with no Connect (R41 M18). Milvus's allowlist is unary only.
 *
 * The adapter half, `createGrpcMilvusClient`, is `MilvusClient` over a `MilvusWireTransport`: `grpcWireTransport`
 * here, and in tests the recorded wire of tests/helpers/milvus-wire.ts.
 */
import { fromJSON, type MethodDefinition, type PackageDefinition, type ServiceDefinition } from "@grpc/proto-loader";
import { openGrpcChannel } from "@/lib/db/grpc/channel";
import { type CallOptions, type MilvusClient, MilvusError, type WireStatus } from "./client";
import type { MilvusAuth, MilvusConnectionOptions } from "./connection-options";
import { MilvusUnsentStatus, statusFailure, toMilvusError } from "./errors";
import { MILVUS_DESCRIPTOR } from "./proto/descriptor";

/**
 * How the adapter reads MILVUS_DESCRIPTOR: the field names the `.proto` files spell, 64-bit integers as decimal
 * strings, enums by name, every absent field at its default, and each oneof's name as a virtual field.
 */
export const MILVUS_LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

/** E15's RPCs as MilvusService names them. */
export type MilvusRpc =
  | "GetVersion"
  | "CheckHealth"
  | "GetMetrics"
  | "ListDatabases"
  | "DescribeDatabase"
  | "ShowCollections"
  | "DescribeCollection"
  | "BatchDescribeCollection"
  | "DescribeIndex"
  | "GetLoadState"
  | "GetLoadingProgress"
  | "GetCollectionStatistics"
  | "ShowPartitions"
  | "ListAliases"
  | "DescribeAlias"
  | "Query"
  | "Search"
  | "HybridSearch"
  | "LoadCollection"
  | "ReleaseCollection";

/** Every RPC the adapter may name, in E15's order; the stub holds these and no other. */
export const MILVUS_ALLOWLISTED_RPCS = [
  "GetVersion",
  "CheckHealth",
  "GetMetrics",
  "ListDatabases",
  "DescribeDatabase",
  "ShowCollections",
  "DescribeCollection",
  "BatchDescribeCollection",
  "DescribeIndex",
  "GetLoadState",
  "GetLoadingProgress",
  "GetCollectionStatistics",
  "ShowPartitions",
  "ListAliases",
  "DescribeAlias",
  "Query",
  "Search",
  "HybridSearch",
  "LoadCollection",
  "ReleaseCollection",
] as const satisfies readonly MilvusRpc[];

/** Fails to compile when `MilvusRpc` gains an RPC the list above does not name. */
type UnlistedRpc = Exclude<MilvusRpc, (typeof MILVUS_ALLOWLISTED_RPCS)[number]>;
const everyRpcListed: [UnlistedRpc] extends [never] ? true : UnlistedRpc = true;
void everyRpcListed;

const MILVUS_SERVICE = "milvus.proto.milvus.MilvusService";

let packageDefinition: PackageDefinition | undefined;
let allowlisted: ServiceDefinition | undefined;

/** The descriptor as grpc-js reads it, built on first use and kept for the process: `fromJSON` costs 22 to 55 ms (R47 M5). */
export function milvusDefinition(): PackageDefinition {
  packageDefinition ??= fromJSON(MILVUS_DESCRIPTOR, MILVUS_LOADER_OPTIONS);
  return packageDefinition;
}

/** E3: MilvusService filtered to the allowlist, the one definition the stub is built from. */
export function allowlistedService(): ServiceDefinition {
  if (allowlisted === undefined) {
    const full = milvusDefinition()[MILVUS_SERVICE] as ServiceDefinition;
    allowlisted = Object.fromEntries(MILVUS_ALLOWLISTED_RPCS.map((rpc) => [rpc, full[rpc]])) as ServiceDefinition;
  }
  return allowlisted;
}

/** Every method that is not on the allowlist, then every allowlisted RPC missing: empty for the stub alone. */
export function allowlistFindings(methods: readonly string[]): string[] {
  const allowed: readonly string[] = MILVUS_ALLOWLISTED_RPCS;
  return [
    ...methods.filter((method) => !allowed.includes(method)).map((method) => `${method} is not on the allowlist`),
    ...allowed.filter((rpc) => !methods.includes(rpc)).map((rpc) => `${rpc} is missing`),
  ];
}

function wireMethod(rpc: MilvusRpc): MethodDefinition<object, object> {
  return allowlistedService()[rpc] as MethodDefinition<object, object>;
}

/** One call as the adapter hands it to the transport. */
export interface MilvusWireCall {
  /** What the adapter attaches: `authorization`, and nothing else. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly deadline: Date;
  /** The call's own signal; its abort is `call.cancel()`. */
  readonly signal: AbortSignal;
}

/** The one channel of a provider instance; messages are the descriptor's, as MILVUS_LOADER_OPTIONS reads them. */
export interface MilvusWireChannel {
  unary(rpc: MilvusRpc, request: object, call: MilvusWireCall): Promise<object>;
  /** Closes the client and ends every socket it holds (E16). */
  close(): void;
}

/** Opens the channel for validated options; sends nothing. */
export type MilvusWireTransport = (options: MilvusConnectionOptions) => MilvusWireChannel;

/** The one implementation over the shared gRPC transport of src/lib/db/grpc/. */
export const grpcWireTransport: MilvusWireTransport = (options) => {
  const channel = openGrpcChannel({
    target: options.target,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    receiveCapBytes: options.receiveCapBytes,
    retries: "none",
    unsent: (status) => new MilvusUnsentStatus(status),
  });
  return {
    unary: (rpc, request, call) => channel.unary(wireMethod(rpc), request, call),
    close: () => channel.close(),
  };
};

// -- the adapter -----------------------------------------------------------------------------------------------------

/** E14's method classes: queries and searches 30 s, every other call 10 s. */
const QUERY_CLASS: ReadonlySet<MilvusRpc> = new Set(["Query", "Search", "HybridSearch"]);
const QUERY_CLASS_MS = 30_000;
const OTHER_CLASS_MS = 10_000;

/** A call's deadline: its class's, capped by the connection's query timeout (E14). */
export function deadlineMs(rpc: MilvusRpc, callTimeoutMs: number): number {
  return Math.min(QUERY_CLASS.has(rpc) ? QUERY_CLASS_MS : OTHER_CLASS_MS, callTimeoutMs);
}

/** The one GetMetrics request the adapter writes (E29): no caller can ask for another metric. */
export const SYSTEM_INFO_REQUEST = '{"metric_type": "system_info"}';

/** The RPCs whose request message has no `db_name` field; every other one carries `CallOptions.db` (E16). */
const WITHOUT_DB_NAME: ReadonlySet<MilvusRpc> = new Set(["GetVersion", "CheckHealth", "GetMetrics", "ListDatabases"]);
/** The RPCs whose answer is a `common.Status` itself. */
const ANSWERS_A_STATUS: ReadonlySet<MilvusRpc> = new Set(["LoadCollection", "ReleaseCollection"]);

/** E4: base64 of `user:password`, or of the token when the user is empty (R09 F7, R04 F5); nothing else carries it. */
function authorizationOf(auth: MilvusAuth): Readonly<Record<string, string>> {
  switch (auth.kind) {
    case "none":
      return {};
    case "password":
      return { authorization: Buffer.from(`${auth.user}:${auth.password}`, "utf8").toString("base64") };
    case "token":
      return { authorization: Buffer.from(auth.token, "utf8").toString("base64") };
  }
}

/**
 * `MilvusClient` over a transport, `grpcWireTransport` by default. It opens the one channel and sends nothing until a
 * method is called; it has no logger, no retry and no Connect. Every answer's `common.Status` is checked, and every
 * failure is classified by `toMilvusError`, so a caller sees a `MilvusError` and nothing else.
 */
export async function createGrpcMilvusClient(
  options: MilvusConnectionOptions,
  transport: MilvusWireTransport = grpcWireTransport,
): Promise<MilvusClient> {
  const channel = transport(options);
  const metadata = authorizationOf(options.auth);
  let closed = false;

  const send = async <T>(rpc: MilvusRpc, request: object, call: CallOptions): Promise<T> => {
    if (closed) throw new MilvusError("closed", "The client is closed");
    if (call.signal.aborted) throw toMilvusError(call.signal.reason, call.signal);
    // CallOptions.db last, so no request can name another database (E16).
    const wire = WITHOUT_DB_NAME.has(rpc) ? request : { ...request, db_name: call.db };
    let answer: object;
    try {
      answer = await channel.unary(rpc, wire, {
        metadata,
        deadline: new Date(Date.now() + deadlineMs(rpc, options.callTimeoutMs)),
        signal: call.signal,
      });
    } catch (error) {
      throw toMilvusError(error, call.signal);
    }
    const status = ANSWERS_A_STATUS.has(rpc)
      ? (answer as WireStatus)
      : (answer as { readonly status?: WireStatus | null }).status;
    const failure = statusFailure(status, rpc);
    if (failure !== undefined) throw failure;
    return answer as T;
  };

  return {
    getVersion: (o) => send("GetVersion", {}, o),
    checkHealth: (o) => send("CheckHealth", {}, o),
    getMetricsSystemInfo: (o) => send("GetMetrics", { request: SYSTEM_INFO_REQUEST }, o),
    listDatabases: (o) => send("ListDatabases", {}, o),
    describeDatabase: (r, o) => send("DescribeDatabase", r, o),
    showCollections: (o) => send("ShowCollections", {}, o),
    describeCollection: (r, o) => send("DescribeCollection", r, o),
    batchDescribeCollection: (r, o) => send("BatchDescribeCollection", r, o),
    describeIndex: (r, o) => send("DescribeIndex", r, o),
    getLoadState: (r, o) => send("GetLoadState", r, o),
    getLoadingProgress: (r, o) => send("GetLoadingProgress", r, o),
    getCollectionStatistics: (r, o) => send("GetCollectionStatistics", r, o),
    showPartitions: (r, o) => send("ShowPartitions", r, o),
    listAliases: (r, o) => send("ListAliases", r, o),
    describeAlias: (r, o) => send("DescribeAlias", r, o),
    query: (r, o) => send("Query", r, o),
    search: (r, o) => send("Search", r, o),
    hybridSearch: (r, o) => send("HybridSearch", r, o),
    loadCollection: (r, o) => send("LoadCollection", r, o),
    releaseCollection: (r, o) => send("ReleaseCollection", r, o),
    close: () => {
      if (closed) return;
      closed = true;
      channel.close();
    },
  };
}
