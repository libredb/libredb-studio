/**
 * The etcd provider's gRPC adapter: the one provider file that imports @grpc/grpc-js and the descriptor (spec 3.1,
 * 3.2, E11), which the seam guard holds.
 *
 * `createGrpcEtcdClient` is plan C1's `EtcdClient` over a narrow transport, `EtcdWireTransport` (plan C5). It turns
 * each seam request into the descriptor's wire message and each answer back, attaches the token and the `hasleader`
 * metadata (spec E4, 6.1), puts the connection's deadline and the call's own signal on every call (spec 5.3), renews
 * the token within spec E4's bound, hands each fragment of a watch answer on as it arrives, ends every watch and
 * keep-alive stream with `call.cancel()` (spec 5.3, E16), ends every socket the channel still holds when it closes, a
 * TLS handshake or an HTTP/2 session waiting for SETTINGS among them, and dials nothing after it (E16), and hands every
 * failure to `toEtcdError` (plan C9). Tests run it over the
 * recorded transport of tests/helpers/etcd-fixtures.ts (plan C11), so only the server is fake; the provider runs it
 * over `grpcWireTransport`, the one implementation that knows grpc-js.
 *
 * Every wire message is typed below as an interface named `Wire` plus its descriptor message name, with the field
 * names the `.proto` files spell, 64-bit integers as decimal strings and enums by name (ETCD_LOADER_OPTIONS), and
 * tests/unit/db/etcd/wire-fields.test.ts holds each property to the descriptor, so a misspelled field fails a test
 * rather than reading `undefined`.
 */
import type { Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import {
  type CallCredentials,
  ChannelCredentials,
  type ChannelOptions,
  Client,
  type ClientDuplexStream,
  credentials,
  type experimental,
  Metadata,
  type VerifyOptions,
} from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition, type ServiceDefinition } from "@grpc/proto-loader";
import {
  type EtcdAlarm,
  type EtcdAlarmType,
  type EtcdCallOptions,
  type EtcdClient,
  type EtcdClientHooks,
  type EtcdCompare,
  type EtcdCompareResult,
  type EtcdCompareTarget,
  type EtcdDeleteRangeRequest,
  type EtcdDeleteRangeResponse,
  EtcdError,
  type EtcdInt64,
  type EtcdKeyValue,
  type EtcdLeaseKeepAliveResponse,
  type EtcdMember,
  type EtcdPermission,
  type EtcdPermissionType,
  type EtcdPutRequest,
  type EtcdPutResponse,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
  type EtcdRequestOp,
  type EtcdResponseHeader,
  type EtcdResponseOp,
  type EtcdTxnRequest,
  type EtcdTxnResponse,
  type EtcdWatchBatch,
  type EtcdWatchEnd,
  type EtcdWatchEvent,
  type EtcdWatchRequest,
} from "./client";
import type { EtcdConnectionOptions, EtcdTlsOptions } from "./connection-options";
import { cancelReasonToEtcdError, toEtcdError, writeNotApplied } from "./errors";
import { INT64_MAX, INT64_MIN, UINT64_MAX } from "./keys";
import { ETCD_DESCRIPTOR } from "./proto/descriptor";

/**
 * How the adapter reads ETCD_DESCRIPTOR (plan C0): the field names the `.proto` files spell, 64-bit integers as
 * decimal strings, enums by name, every absent field at its default, and each oneof's name as a virtual field.
 * tests/unit/db/etcd/descriptor.test.ts loads the descriptor with the same options.
 */
export const ETCD_LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

/** The unary RPCs of spec E11, as "<service>/<method>" of etcdserverpb; no bare Put, since every put rides in a Txn. */
export type EtcdUnaryRpc =
  | "KV/Range"
  | "KV/DeleteRange"
  | "KV/Txn"
  | "KV/Compact"
  | "Lease/LeaseGrant"
  | "Lease/LeaseRevoke"
  | "Lease/LeaseTimeToLive"
  | "Lease/LeaseLeases"
  | "Cluster/MemberList"
  | "Maintenance/Alarm"
  | "Maintenance/Status"
  | "Maintenance/Defragment"
  | "Auth/AuthStatus"
  | "Auth/Authenticate"
  | "Auth/UserList"
  | "Auth/UserGet"
  | "Auth/RoleList"
  | "Auth/RoleGet";
/** The two streams of spec E11; LeaseKeepAlive carries exactly one exchange. */
export type EtcdStreamRpc = "Watch/Watch" | "Lease/LeaseKeepAlive";
export type EtcdWireRpc = EtcdUnaryRpc | EtcdStreamRpc;

/** Every RPC the adapter may name, in spec E11's order; the seam guard holds it to the descriptor. */
export const ETCD_ALLOWLISTED_RPCS = [
  "KV/Range",
  "KV/DeleteRange",
  "KV/Txn",
  "Watch/Watch",
  "Lease/LeaseGrant",
  "Lease/LeaseRevoke",
  "Lease/LeaseKeepAlive",
  "Lease/LeaseTimeToLive",
  "Lease/LeaseLeases",
  "Cluster/MemberList",
  "Maintenance/Status",
  "Maintenance/Alarm",
  "KV/Compact",
  "Maintenance/Defragment",
  "Auth/AuthStatus",
  "Auth/Authenticate",
  "Auth/UserList",
  "Auth/UserGet",
  "Auth/RoleList",
  "Auth/RoleGet",
] as const satisfies readonly EtcdWireRpc[];

/** Fails to compile when `EtcdWireRpc` gains an RPC the list above does not name. */
type UnlistedRpc = Exclude<EtcdWireRpc, (typeof ETCD_ALLOWLISTED_RPCS)[number]>;
const everyRpcListed: [UnlistedRpc] extends [never] ? true : UnlistedRpc = true;
void everyRpcListed;

/** Spec 6.1: "when-linearizable" is a Range or MemberList unless serializable, and a Txn unless every op is a serializable Range. */
export type EtcdLeaderRule = "always" | "never" | "when-linearizable";

/**
 * Spec 6.1's table, keyed by the allowlist: "never" for the calls a member answers from its own state, and
 * "when-linearizable" for the three whose request decides it. A call that needs the leader then fails at once with
 * "etcdserver: no leader" on a member without one (R08 G6.8), while these still answer, as they do for etcdctl.
 * KE14 measured each exemption on etcd-cluster on 2026-10-01 (Task 22): with two of three members stopped, all six
 * answered, while a linearizable get and member list failed at once with "etcdserver: no leader".
 */
export const HASLEADER_RULES: Readonly<Record<EtcdWireRpc, EtcdLeaderRule>> = {
  "KV/Range": "when-linearizable",
  "KV/DeleteRange": "always",
  "KV/Txn": "when-linearizable",
  "Watch/Watch": "always",
  "Lease/LeaseGrant": "always",
  "Lease/LeaseRevoke": "always",
  "Lease/LeaseKeepAlive": "always",
  "Lease/LeaseTimeToLive": "always",
  "Lease/LeaseLeases": "never",
  "Cluster/MemberList": "when-linearizable",
  "Maintenance/Status": "never",
  "Maintenance/Alarm": "always",
  "KV/Compact": "always",
  "Maintenance/Defragment": "never",
  "Auth/AuthStatus": "always",
  "Auth/Authenticate": "always",
  "Auth/UserList": "always",
  "Auth/UserGet": "always",
  "Auth/RoleList": "always",
  "Auth/RoleGet": "always",
};

/** One call as the adapter hands it to the transport. */
export interface EtcdWireCall {
  /** What the adapter attaches: `token` once signed in, and `hasleader` by HASLEADER_RULES. */
  readonly metadata: Readonly<Record<string, string>>;
  /** The gRPC deadline: the call's start plus `callTimeoutMs` (spec 5.3). */
  readonly deadline: Date;
  /** The call's own signal; its abort is `call.cancel()`. */
  readonly signal: AbortSignal;
}

/** One bidirectional stream. */
export interface EtcdWireStream {
  write(message: object): void;
  /** The next message; undefined once the server ended the stream; a rejection with the call's error. */
  read(): Promise<object | undefined>;
  /** grpc-js `call.cancel()`, on every end (spec 5.3, E16). */
  cancel(): void;
}

/** The one channel of a provider instance; messages are the descriptor's, as ETCD_LOADER_OPTIONS reads them. */
export interface EtcdWireChannel {
  unary(rpc: EtcdUnaryRpc, request: object, call: EtcdWireCall): Promise<object>;
  stream(rpc: EtcdStreamRpc, call: EtcdWireCall): EtcdWireStream;
  /** `grpcWireTransport` cancels every stream still open, closes the client and ends every socket it holds (E16). */
  close(): void;
}

/** Opens the channel for validated options; sends nothing. */
export type EtcdWireTransport = (options: EtcdConnectionOptions) => EtcdWireChannel;

// The wire messages the adapter sends and reads, one interface per descriptor message, each property a field of
// that message as ETCD_LOADER_OPTIONS decodes it: bytes as Uint8Array (a Buffer on decode), 64-bit integers as
// decimal strings, enums by name, an absent message field as null. wire-fields.test.ts holds them to the descriptor.

interface WireResponseHeader {
  readonly cluster_id: string;
  readonly member_id: string;
  readonly revision: string;
  readonly raft_term: string;
}

interface WireKeyValue {
  readonly key: Uint8Array;
  readonly create_revision: string;
  readonly mod_revision: string;
  readonly version: string;
  readonly value: Uint8Array;
  readonly lease: string;
}

/** No sort and no revision filter, which make the server load the whole range whatever the limit (spec E14). */
interface WireRangeRequest {
  readonly key: Uint8Array;
  readonly range_end?: Uint8Array;
  readonly limit: string;
  readonly revision?: string;
  readonly serializable?: boolean;
  readonly keys_only?: boolean;
  readonly count_only?: boolean;
}

interface WireRangeResponse {
  readonly header: WireResponseHeader | null;
  readonly kvs: readonly WireKeyValue[];
  readonly more: boolean;
  readonly count: string;
}

interface WirePutRequest {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
  readonly lease?: string;
  readonly prev_kv?: boolean;
  readonly ignore_value?: boolean;
  readonly ignore_lease?: boolean;
}

interface WirePutResponse {
  readonly header: WireResponseHeader | null;
  readonly prev_kv: WireKeyValue | null;
}

interface WireDeleteRangeRequest {
  readonly key: Uint8Array;
  readonly range_end?: Uint8Array;
  readonly prev_kv?: boolean;
}

interface WireDeleteRangeResponse {
  readonly header: WireResponseHeader | null;
  readonly deleted: string;
  readonly prev_kvs: readonly WireKeyValue[];
}

interface WireCompare {
  readonly result: "EQUAL" | "GREATER" | "LESS" | "NOT_EQUAL";
  readonly target: "VERSION" | "CREATE" | "MOD" | "VALUE" | "LEASE";
  readonly key: Uint8Array;
  readonly range_end?: Uint8Array;
  readonly version?: string;
  readonly create_revision?: string;
  readonly mod_revision?: string;
  readonly value?: Uint8Array;
  readonly lease?: string;
}

interface WireRequestOp {
  readonly request_range?: WireRangeRequest;
  readonly request_put?: WirePutRequest;
  readonly request_delete_range?: WireDeleteRangeRequest;
}

/** The oneof member etcd set; the others are absent. */
interface WireResponseOp {
  readonly response_range?: WireRangeResponse;
  readonly response_put?: WirePutResponse;
  readonly response_delete_range?: WireDeleteRangeResponse;
}

interface WireTxnRequest {
  readonly compare: readonly WireCompare[];
  readonly success: readonly WireRequestOp[];
  readonly failure: readonly WireRequestOp[];
}

interface WireTxnResponse {
  readonly header: WireResponseHeader | null;
  readonly succeeded: boolean;
  readonly responses: readonly WireResponseOp[];
}

interface WireCompactionRequest {
  readonly revision: string;
  readonly physical: boolean;
}

/** No progress notification and no filter: spec 5.1.3 refuses --progress-notify, and the grammar has no filter. */
interface WireWatchCreateRequest {
  readonly key: Uint8Array;
  readonly range_end?: Uint8Array;
  readonly start_revision?: string;
  readonly prev_kv?: boolean;
  readonly fragment: boolean;
}

interface WireWatchRequest {
  readonly create_request: WireWatchCreateRequest;
}

interface WireEvent {
  readonly type: "PUT" | "DELETE";
  readonly kv: WireKeyValue | null;
  readonly prev_kv: WireKeyValue | null;
}

interface WireWatchResponse {
  readonly header: WireResponseHeader | null;
  readonly created: boolean;
  readonly canceled: boolean;
  readonly compact_revision: string;
  readonly cancel_reason: string;
  readonly fragment: boolean;
  readonly events: readonly WireEvent[];
}

interface WireLeaseGrantRequest {
  readonly TTL: string;
}

interface WireLeaseGrantResponse {
  readonly header: WireResponseHeader | null;
  readonly ID: string;
  readonly TTL: string;
  readonly error: string;
}

interface WireLeaseRevokeRequest {
  readonly ID: string;
}

interface WireLeaseRevokeResponse {
  readonly header: WireResponseHeader | null;
}

interface WireLeaseKeepAliveRequest {
  readonly ID: string;
}

interface WireLeaseKeepAliveResponse {
  readonly ID: string;
  readonly TTL: string;
}

interface WireLeaseTimeToLiveRequest {
  readonly ID: string;
  readonly keys: boolean;
}

interface WireLeaseTimeToLiveResponse {
  readonly header: WireResponseHeader | null;
  readonly ID: string;
  readonly TTL: string;
  readonly grantedTTL: string;
  readonly keys: readonly Uint8Array[];
}

interface WireLeaseStatus {
  readonly ID: string;
}

interface WireLeaseLeasesResponse {
  readonly header: WireResponseHeader | null;
  readonly leases: readonly WireLeaseStatus[];
}

interface WireMemberListRequest {
  readonly linearizable: boolean;
}

interface WireMember {
  readonly ID: string;
  readonly name: string;
  readonly peerURLs: readonly string[];
  readonly clientURLs: readonly string[];
  readonly isLearner: boolean;
}

interface WireMemberListResponse {
  readonly header: WireResponseHeader | null;
  readonly members: readonly WireMember[];
}

interface WireStatusResponse {
  readonly header: WireResponseHeader | null;
  readonly version: string;
  readonly dbSize: string;
  readonly leader: string;
  readonly raftIndex: string;
  readonly raftTerm: string;
  readonly raftAppliedIndex: string;
  readonly errors: readonly string[];
  readonly dbSizeInUse: string;
  readonly isLearner: boolean;
  readonly storageVersion: string;
  readonly dbSizeQuota: string;
}

/** GET, or DEACTIVATE of one pair a GET answered, and no other action (spec E11, 7.2). */
interface WireAlarmRequest {
  readonly action: "GET" | "DEACTIVATE";
  readonly memberID?: string;
  readonly alarm?: "NOSPACE" | "CORRUPT";
}

interface WireAlarmMember {
  readonly memberID: string;
  readonly alarm: "NONE" | "NOSPACE" | "CORRUPT";
}

interface WireAlarmResponse {
  readonly alarms: readonly WireAlarmMember[];
}

interface WireAuthStatusResponse {
  readonly enabled: boolean;
  readonly authRevision: string;
}

interface WireAuthenticateRequest {
  readonly name: string;
  readonly password: string;
}

interface WireAuthenticateResponse {
  readonly token: string;
}

interface WireAuthUserListResponse {
  readonly users: readonly string[];
}

interface WireAuthUserGetRequest {
  readonly name: string;
}

interface WireAuthUserGetResponse {
  readonly roles: readonly string[];
}

interface WireAuthRoleListResponse {
  readonly roles: readonly string[];
}

interface WireAuthRoleGetRequest {
  readonly role: string;
}

interface WirePermission {
  readonly permType: "READ" | "WRITE" | "READWRITE";
  readonly key: Uint8Array;
  readonly range_end: Uint8Array;
}

interface WireAuthRoleGetResponse {
  readonly perm: readonly WirePermission[];
}

/** etcd's metadata names (SRC `etcd__api_v3rpc_rpctypes_metadatafields.go`, `etcd__api_v3rpc_rpctypes_md.go`). */
const TOKEN_METADATA = "token";
const REQUIRE_LEADER_METADATA = "hasleader";

/** The one E4 answer after which the user's grants may have changed with the auth store (R13 D10). */
const AUTH_STORE_OLD = "etcdserver: revision of auth store is old";

const COMPARE_RESULTS: Readonly<Record<EtcdCompareResult, WireCompare["result"]>> = {
  equal: "EQUAL",
  greater: "GREATER",
  less: "LESS",
  "not-equal": "NOT_EQUAL",
};
const COMPARE_TARGETS: Readonly<Record<EtcdCompareTarget, WireCompare["target"]>> = {
  version: "VERSION",
  create: "CREATE",
  mod: "MOD",
  value: "VALUE",
  lease: "LEASE",
};
const ALARM_TYPES: Readonly<Record<EtcdAlarmType, "NOSPACE" | "CORRUPT">> = { nospace: "NOSPACE", corrupt: "CORRUPT" };

// The enum names each answer may carry, read by one table apiece. NONE is never a raised alarm (spec 7.2), and a
// value outside a table, such as one a newer server adds, is refused rather than guessed as a neighbour.
const ALARM_NAMES: ReadonlyMap<string, EtcdAlarmType> = new Map([
  ["NOSPACE", "nospace"],
  ["CORRUPT", "corrupt"],
]);
const EVENT_NAMES: ReadonlyMap<string, EtcdWatchEvent["type"]> = new Map([
  ["PUT", "put"],
  ["DELETE", "delete"],
]);
const PERMISSION_NAMES: ReadonlyMap<string, EtcdPermissionType> = new Map([
  ["READ", "read"],
  ["WRITE", "write"],
  ["READWRITE", "readwrite"],
]);

const DECIMAL = /^-?\d+$/;

/** The descriptor as grpc-js reads it; built once, and read by `grpcWireTransport` alone. */
const DEFINITION = fromJSON(ETCD_DESCRIPTOR, ETCD_LOADER_OPTIONS);

function wireMethod(rpc: EtcdWireRpc): MethodDefinition<object, object> {
  const [service, method] = rpc.split("/");
  return (DEFINITION[`etcdserverpb.${service}`] as ServiceDefinition)[method];
}

/** The one implementation over @grpc/grpc-js: the target, the credentials of spec E5, the receive cap of E14, deadlines and aborts. */
export const grpcWireTransport: EtcdWireTransport = (options) => {
  const closing = new ClosingCredentials(channelCredentials(options.tls));
  const client = new Client(options.target, closing, channelOptions(options));
  const streams = new Set<EtcdWireStream>();
  return {
    unary: (rpc, request, call) => unaryCall(client, rpc, request, call),
    stream: (rpc, call) => openStream(client, rpc, call, streams),
    close: () => {
      // Each stream ends with call.cancel(), grpc-js's close() releases the subchannels, and every socket they still
      // hold ends last, whatever it waits for (spec E16).
      for (const stream of streams) stream.cancel();
      client.close();
      closing.endEverySocket();
    },
  };
};

/**
 * Spec E4: with no service config from DNS, grpc-js only retries a call that never left the client, so a
 * `grpc_config=` TXT record on the host cannot install a retry or hedging policy that resends a write etcd
 * applied, or a load-balancing config the bundled client cannot load (KE7, measured in Task 1). E14: no answer
 * past the receive cap is read. E5: the TLS identity is the override in every TLS mode, never the dialled address.
 * E1: the channel dials the endpoint itself, never a proxy that `grpc_proxy`, `https_proxy` or `http_proxy` names,
 * which grpc-js otherwise asks to CONNECT to the endpoint (`mapProxyName`, http_proxy.ts).
 */
export function channelOptions(options: EtcdConnectionOptions): ChannelOptions {
  return {
    "grpc.service_config_disable_resolution": 1,
    "grpc.max_receive_message_length": options.receiveCapBytes,
    "grpc.enable_http_proxy": 0,
    ...(options.tls === undefined ? {} : { "grpc.ssl_target_name_override": options.tls.serverNameOverride }),
  };
}

/**
 * The credentials of spec E5's table, which connection-options.ts reduced to `verify` and the identity. `require`
 * encrypts and checks nothing, the connection's own choice; every other mode checks the chain, against the pasted
 * CA or the runtime's roots, and the name. grpc-js hands `checkServerIdentity` the override name, never the dialled
 * address (reconciliation D0-3), so an IP identity's check closes over the IP and never reads its `host` argument,
 * which is ETCD_IP_SERVER_NAME. `grpcWireTransport` wraps either kind in ClosingCredentials (E16).
 */
function channelCredentials(tls: EtcdTlsOptions | undefined): ChannelCredentials {
  if (tls === undefined) return credentials.createInsecure();
  const pair = tls.clientCertificate;
  return credentials.createSsl(
    tls.ca === undefined ? null : Buffer.from(tls.ca),
    pair === undefined ? null : Buffer.from(pair.key),
    pair === undefined ? null : Buffer.from(pair.cert),
    verifyOptions(tls),
  );
}

function verifyOptions(tls: EtcdTlsOptions): VerifyOptions {
  if (!tls.verify) return { rejectUnauthorized: false };
  if (!tls.identityIsIp) return { rejectUnauthorized: true };
  const ip = tls.identity;
  return {
    rejectUnauthorized: true,
    checkServerIdentity: (_override, certificate) => checkServerIdentity(ip, certificate),
  };
}

/** What a connector of a closed channel refuses with. */
const CHANNEL_CLOSED = "The channel closed before this connection was established";

/**
 * Spec E16: grpc-js's own credentials, plaintext or TLS, wrapped so that nothing of a channel outlives the adapter's
 * close(). In grpc-js 1.14.5, `client.close()` reaches the credentials' connector only through its `destroy()`
 * (`Subchannel.unref`, subchannel.ts), which grpc-js's own connectors leave empty, and three things outlived it
 * (measured under Node 24.14.0 and Bun 1.4.2). A TLS handshake the peer never answers:
 * `Http2SubchannelConnector.connect` (transport.ts) hands the TCP socket it connected to the connector, whose
 * `connect` (`SecureConnectorImpl`, channel-credentials.ts) waits for the handshake with no bound, so the socket, and
 * the process, stayed alive. A dial after the close: `Subchannel.unref` moves only a CONNECTING or READY subchannel to
 * IDLE, and one in TRANSIENT_FAILURE dials the endpoint again when its backoff timer ends (`handleBackoffTimer`),
 * whatever its refcount, about a second after the attempt that failed. And an HTTP/2 session still waiting for the
 * peer's SETTINGS, plaintext or TLS: `createSession` (transport.ts) opens it over the connector's socket and unrefs it,
 * and only `Http2SubchannelConnector.shutdown()`, which nothing calls, would close it.
 * The connector below, the hook `experimental.SecureConnector` describes, ends on `destroy()` every socket still in
 * its handshake, and at once a socket handed over after it, whose TCP connect outlived the close, and fails that
 * connect itself, since Node never settles a handshake whose socket was destroyed (Bun reports ECONNRESET); and from
 * `destroy()` on it refuses `waitForReady()`, which grpc-js awaits before every TCP connect, so nothing is dialled.
 * It keeps every socket it was handed until that socket closes, and `endEverySocket()`, which the adapter's close()
 * calls, ends them all. A `destroy()` alone ends no socket past its handshake: grpc-js also destroys a connector when
 * the load balancer releases a subchannel whose address left a re-resolution, and then shuts its transport down
 * gracefully, so that a call in flight, a write among them, finishes with an answer.
 * The credentials equal only themselves, so no two clients share a subchannel: grpc-js's insecure credentials equal
 * any other, which would let two plaintext clients of one endpoint share one, and one client's close reach the other.
 */
export class ClosingCredentials extends ChannelCredentials {
  /** Every socket a connector of these credentials was handed, until it closes. */
  private readonly sockets = new Set<Socket>();

  constructor(private readonly inner: ChannelCredentials) {
    super();
  }

  _isSecure(): boolean {
    return this.inner._isSecure();
  }

  /** Only themselves, so no client shares another's subchannel, plaintext or TLS. */
  _equals(other: ChannelCredentials): boolean {
    return other === this;
  }

  _createSecureConnector(
    channelTarget: experimental.GrpcUri,
    options: ChannelOptions,
    callCredentials?: CallCredentials,
  ): experimental.SecureConnector {
    return closingConnector(this.inner._createSecureConnector(channelTarget, options, callCredentials), this.sockets);
  }

  /** The adapter's close(): ends every socket its connectors still hold, in a handshake, a session or a call. */
  endEverySocket(): void {
    for (const socket of this.sockets) socket.destroy();
  }
}

function closingConnector(inner: experimental.SecureConnector, sockets: Set<Socket>): experimental.SecureConnector {
  // Each socket still in its handshake, with the failure that ends its connect.
  const handshaking = new Map<Socket, (reason: Error) => void>();
  let destroyed = false;
  const end = (socket: Socket, fail: (reason: Error) => void) => {
    // Destroyed without an error: grpc-js listens for none on the TCP socket once it has connected.
    socket.destroy();
    fail(new Error(CHANNEL_CLOSED));
  };
  return {
    connect: (socket) =>
      new Promise<experimental.SecureConnectResult>((resolve, reject) => {
        if (destroyed) {
          end(socket, reject);
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        handshaking.set(socket, reject);
        // Out of its handshake the moment that settles, before grpc-js hears of it, so a destroy() right after a
        // completed handshake leaves the established socket be.
        inner.connect(socket).then(
          (secured) => {
            handshaking.delete(socket);
            resolve(secured);
          },
          (failure: unknown) => {
            handshaking.delete(socket);
            reject(failure);
          },
        );
      }),
    // grpc-js awaits this before each TCP connect, the one a backoff timer that outlived the close starts included.
    waitForReady: () => (destroyed ? Promise.reject(new Error(CHANNEL_CLOSED)) : inner.waitForReady()),
    getCallCredentials: () => inner.getCallCredentials(),
    destroy: () => {
      destroyed = true;
      for (const [socket, fail] of handshaking) end(socket, fail);
      inner.destroy();
    },
  };
}

function metadataOf(call: EtcdWireCall): Metadata {
  const metadata = new Metadata();
  for (const [key, value] of Object.entries(call.metadata)) metadata.set(key, value);
  return metadata;
}

/** Ends a call through `cancel` when its signal aborts, at once when it already has; returns the listener's removal. */
function cancelOnAbort(signal: AbortSignal, cancel: () => void): () => void {
  if (signal.aborted) {
    cancel();
    return () => undefined;
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

function unaryCall(client: Client, rpc: EtcdUnaryRpc, request: object, call: EtcdWireCall): Promise<object> {
  const method = wireMethod(rpc);
  return new Promise<object>((resolve, reject) => {
    // grpc-js answers after this function returns, so the listener's removal is in place by then.
    let release: () => void = () => undefined;
    const pending = client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      request,
      metadataOf(call),
      { deadline: call.deadline },
      (error, value) => {
        release();
        if (error) reject(error);
        else resolve(value as object);
      },
    );
    release = cancelOnAbort(call.signal, () => pending.cancel());
  });
}

/**
 * A grpc-js bidirectional stream as the adapter reads it: messages in order, then the end or the call's error. It is
 * one of `open` until it is cancelled, so the channel's close() can cancel it first.
 */
function openStream(client: Client, rpc: EtcdStreamRpc, call: EtcdWireCall, open: Set<EtcdWireStream>): EtcdWireStream {
  const method = wireMethod(rpc);
  const duplex: ClientDuplexStream<object, object> = client.makeBidiStreamRequest(
    method.path,
    method.requestSerialize,
    method.responseDeserialize,
    metadataOf(call),
    { deadline: call.deadline },
  );
  const received: object[] = [];
  const waiting: Array<{
    readonly resolve: (message: object | undefined) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: { readonly error: unknown } | undefined;
  duplex.on("data", (message: object) => {
    const reader = waiting.shift();
    if (reader === undefined) received.push(message);
    else reader.resolve(message);
  });
  duplex.on("end", () => {
    ended = true;
    for (const reader of waiting.splice(0)) reader.resolve(undefined);
  });
  // grpc-js emits a failed call's error before its end, so a reader meets the error, never a clean end.
  duplex.on("error", (error: unknown) => {
    failure = { error };
    for (const reader of waiting.splice(0)) reader.reject(error);
  });
  const release = cancelOnAbort(call.signal, () => duplex.cancel());
  const stream: EtcdWireStream = {
    write: (message) => {
      duplex.write(message);
    },
    read: () => {
      const message = received.shift();
      if (message !== undefined) return Promise.resolve(message);
      if (failure !== undefined) return Promise.reject(failure.error);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    cancel: () => {
      open.delete(stream);
      release();
      duplex.cancel();
    },
  };
  open.add(stream);
  return stream;
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: EtcdError };

/** How one leg of a watch ended, or which of spec E4's in-band answers ended it, which one renewal may meet. */
type WatchLeg =
  | { readonly end: EtcdWatchEnd }
  | { readonly renew: EtcdError; readonly cancelReason: string; readonly sentWith: string | undefined };

/**
 * C1's `EtcdClient` over a transport, `grpcWireTransport` by default; it satisfies
 * `EtcdClientFactory<EtcdConnectionOptions>`. It opens the one channel and sends nothing (spec E16).
 */
export async function createGrpcEtcdClient(
  options: EtcdConnectionOptions,
  hooks: EtcdClientHooks = {},
  transport: EtcdWireTransport = grpcWireTransport,
): Promise<EtcdClient> {
  const channel = transport(options);
  // The token lives here and nowhere else: never returned, logged or placed in an error (spec E2).
  let token: string | undefined;
  let renewal: { authStoreChanged: boolean; readonly done: Promise<void> } | undefined;
  let notifiedFor: string | undefined;
  let closed = false;
  // Aborted by close(), so a renewal still in flight, the client's own call, ends with the channel.
  const closing = new AbortController();
  const closedError = () => new EtcdError("closed", "The client is closed");

  const wireCall = (rpc: EtcdWireRpc, request: object, signal: AbortSignal): EtcdWireCall => ({
    metadata: {
      ...(token === undefined || rpc === "Auth/Authenticate" ? {} : { [TOKEN_METADATA]: token }),
      ...(leaderRequired(rpc, request) ? { [REQUIRE_LEADER_METADATA]: "true" } : {}),
    },
    deadline: new Date(Date.now() + options.callTimeoutMs),
    signal,
  });

  /** The failure a call meets before anything is sent: a closed client, or a signal already aborted. */
  const unsendable = (signal: AbortSignal): EtcdError | undefined => {
    if (closed) return closedError();
    return signal.aborted ? toEtcdError(signal.reason, signal) : undefined;
  };

  const attempt = async (rpc: EtcdUnaryRpc, request: object, signal: AbortSignal): Promise<Attempt<object>> => {
    const refused = unsendable(signal);
    if (refused !== undefined) return { ok: false, error: refused };
    try {
      return { ok: true, value: await channel.unary(rpc, request, wireCall(rpc, request, signal)) };
    } catch (error) {
      return { ok: false, error: toEtcdError(error, signal) };
    }
  };

  /** Spec E4's three answers, renewed only where a credential is configured: certificate mode sends no token (6.1). */
  const renewable = (error: EtcdError) => error.category === "unauthenticated" && options.auth.kind === "password";

  const signIn = async (signal: AbortSignal): Promise<void> => {
    const { auth } = options;
    if (auth.kind !== "password") {
      const credential = auth.kind === "none" ? "no credential" : "its certificate";
      throw new TypeError(`This etcd client signs in with ${credential}, so it has no password to authenticate with`);
    }
    const request: WireAuthenticateRequest = { name: auth.user, password: auth.password };
    const answer = await attempt("Auth/Authenticate", request, signal);
    if (!answer.ok) throw answer.error;
    token = (answer.value as WireAuthenticateResponse).token;
  };

  const notifyAuthStoreChanged = () => {
    // Once per token: every call that met the auth change was sent under the token the renewal replaced (R13 D10).
    if (notifiedFor === token) return;
    notifiedFor = token;
    hooks.onAuthStoreChanged?.();
  };

  /**
   * One renewal for every call that met one of E4's answers under the same token: a call that meets one while a
   * renewal runs joins it, and a call whose token another renewal already replaced starts none (spec E4). The
   * renewal is cleared in the same step that decides its report, so no answer that joins it goes unreported.
   */
  const renewAfter = (error: EtcdError, sentWith: string | undefined): Promise<void> => {
    const authStoreChanged = error.detail === AUTH_STORE_OLD;
    if (renewal !== undefined) {
      if (authStoreChanged) renewal.authStoreChanged = true;
      return renewal.done;
    }
    if (token !== sentWith) {
      if (authStoreChanged) notifyAuthStoreChanged();
      return Promise.resolve();
    }
    const pending = {
      authStoreChanged,
      done: signIn(closing.signal).then(
        () => {
          renewal = undefined;
          if (pending.authStoreChanged) notifyAuthStoreChanged();
        },
        (failure: unknown) => {
          renewal = undefined;
          // A renewal close() ended is the client closing, never the sign-in's own failure.
          throw closed ? closedError() : failure;
        },
      ),
    };
    renewal = pending;
    return pending.done;
  };

  /**
   * One exchange within spec E4's bound. On one of its three answers the token is renewed once, shared with every
   * call that met one under the same token, and a read is sent once more; a second failure is raised. A write is
   * sent once more after the renewal only when `writeNotApplied` holds its answer as certainly not applied: the
   * renewal answers KE12 measured as leaving a write unapplied (`ETCD_RENEWAL_ANSWERS_NOT_APPLIED`). A write that
   * met any other renewal answer waits for the renewal it started or joined, so the next call carries the new token
   * and a stale auth revision is still reported (R13 D10), and is then raised with its own answer, in 5.6's class of
   * a write whose outcome is unknown, whatever the renewal met.
   */
  const bounded = async <T>(exchange: () => Promise<Attempt<T>>, write: boolean, signal: AbortSignal): Promise<T> => {
    const sentWith = token;
    const first = await exchange();
    if (first.ok) return first.value;
    if (!renewable(first.error)) throw first.error;
    const renewed = until(renewAfter(first.error, sentWith), signal);
    if (write && !writeNotApplied(first.error)) {
      // A failed sign-in never replaces the sentence that the write may have been applied. It leaves the token it
      // would have replaced, so the next call meets the same answer and signs in again; a read raises that failure.
      await renewed.catch(() => undefined);
      throw first.error;
    }
    await renewed;
    const second = await exchange();
    if (second.ok) return second.value;
    throw second.error;
  };

  const send = async <T>(
    rpc: EtcdUnaryRpc,
    request: object,
    callOptions: EtcdCallOptions,
    write: boolean,
  ): Promise<T> => (await bounded(() => attempt(rpc, request, callOptions.signal), write, callOptions.signal)) as T;

  /**
   * One leg of a watch: its own stream, from the cursor's revision, until an end. One of spec E4's in-band answers
   * ends the leg asking for the renewal; the caller creates the watch once more after it.
   */
  const watchLeg = async (
    request: EtcdWatchRequest,
    cursor: { startRevision: EtcdInt64 | undefined },
    onBatch: (batch: EtcdWatchBatch) => "continue" | "stop",
    signal: AbortSignal,
  ): Promise<WatchLeg> => {
    if (closed) throw closedError();
    if (signal.aborted) return { end: { reason: "aborted" } };
    const sentWith = token;
    const stream = channel.stream("Watch/Watch", wireCall("Watch/Watch", {}, signal));
    try {
      stream.write(watchRequest(request, cursor.startRevision));
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- a watch answers one response after another, in order.
        const response = await readWatch(stream, signal);
        if (response === "aborted") return { end: { reason: "aborted" } };
        if (response.canceled) {
          if (response.compact_revision !== "0") {
            return { end: { reason: "compacted", compactRevision: response.compact_revision } };
          }
          const error = cancelReasonToEtcdError(response.cancel_reason);
          if (renewable(error)) return { renew: error, cancelReason: response.cancel_reason, sentWith };
          return { end: { reason: "canceled", cancelReason: response.cancel_reason } };
        }
        const answered = header(response.header, "Watch/Watch");
        // A watch created again starts after the last revision this one delivered, so no event arrives twice.
        if (response.created && cursor.startRevision === undefined) cursor.startRevision = following(answered.revision);
        // Each fragment is handed on as it arrives, so the row limit and the byte budget stop a watch inside one large
        // answer, and the fragments that arrived before an abort, the window's included, are not lost (spec 5.3, E14).
        if (response.events.length === 0) continue;
        const events = response.events.map(watchEvent);
        cursor.startRevision = following(events[events.length - 1].kv.modRevision);
        if (onBatch({ header: answered, events }) === "stop") return { end: { reason: "stopped" } };
      }
    } finally {
      stream.cancel();
    }
  };

  const watch: EtcdClient["watch"] = async (request, onBatch, callOptions) => {
    if (request.startRevision !== undefined) int64(request.startRevision, "WatchCreateRequest.start_revision");
    const cursor = { startRevision: request.startRevision };
    const first = await watchLeg(request, cursor, onBatch, callOptions.signal);
    if ("end" in first) return first.end;
    // Spec 5.3 and E4: one renewal, then the watch is created once more; a second such answer ends it.
    await until(renewAfter(first.renew, first.sentWith), callOptions.signal);
    const second = await watchLeg(request, cursor, onBatch, callOptions.signal);
    return "end" in second ? second.end : { reason: "canceled", cancelReason: second.cancelReason };
  };

  /** One keep-alive exchange on a stream of its own: one request, one answer, and the stream cancelled (spec E11). */
  const keepAliveExchange = async (
    id: EtcdInt64,
    signal: AbortSignal,
  ): Promise<Attempt<EtcdLeaseKeepAliveResponse>> => {
    const refused = unsendable(signal);
    if (refused !== undefined) return { ok: false, error: refused };
    const stream = channel.stream("Lease/LeaseKeepAlive", wireCall("Lease/LeaseKeepAlive", {}, signal));
    try {
      const request: WireLeaseKeepAliveRequest = { ID: id };
      stream.write(request);
      const answered = await stream.read();
      if (answered === undefined) {
        return {
          ok: false,
          error: new EtcdError("unavailable", "etcd ended the keep-alive stream before it answered"),
        };
      }
      const answer = answered as WireLeaseKeepAliveResponse;
      return { ok: true, value: { id: answer.ID, ttl: answer.TTL } };
    } catch (error) {
      return { ok: false, error: toEtcdError(error, signal) };
    } finally {
      stream.cancel();
    }
  };

  return {
    async range(request, callOptions) {
      const answer = await send<WireRangeResponse>("KV/Range", rangeRequest(request), callOptions, false);
      return rangeResponse(answer, "KV/Range");
    },
    async deleteRange(request, callOptions) {
      const answer = await send<WireDeleteRangeResponse>("KV/DeleteRange", deleteRequest(request), callOptions, true);
      return deleteResponse(answer, "KV/DeleteRange");
    },
    async txn(request, callOptions) {
      const writes = [...request.success, ...request.failure].some((op) => op.op !== "range");
      const answer = await send<WireTxnResponse>("KV/Txn", txnRequest(request), callOptions, writes);
      return txnResponse(answer);
    },
    watch,
    async leaseGrant(ttlSeconds, callOptions) {
      const request: WireLeaseGrantRequest = { TTL: int64(String(ttlSeconds), "LeaseGrantRequest.TTL") };
      const answer = await send<WireLeaseGrantResponse>("Lease/LeaseGrant", request, callOptions, true);
      if (answer.error !== "") throw new EtcdError("unknown", answer.error);
      return { header: header(answer.header, "Lease/LeaseGrant"), id: answer.ID, ttl: answer.TTL };
    },
    async leaseRevoke(id, callOptions) {
      const request: WireLeaseRevokeRequest = { ID: int64(id, "LeaseRevokeRequest.ID") };
      const answer = await send<WireLeaseRevokeResponse>("Lease/LeaseRevoke", request, callOptions, true);
      return { header: header(answer.header, "Lease/LeaseRevoke") };
    },
    // A keep-alive is a write (spec 5.1.3), so E4 bounds it as one.
    async leaseKeepAliveOnce(id, callOptions) {
      const checked = int64(id, "LeaseKeepAliveRequest.ID");
      return bounded(() => keepAliveExchange(checked, callOptions.signal), true, callOptions.signal);
    },
    async leaseTimeToLive(id, keys, callOptions) {
      const request: WireLeaseTimeToLiveRequest = { ID: int64(id, "LeaseTimeToLiveRequest.ID"), keys };
      const answer = await send<WireLeaseTimeToLiveResponse>("Lease/LeaseTimeToLive", request, callOptions, false);
      return {
        header: header(answer.header, "Lease/LeaseTimeToLive"),
        id: answer.ID,
        ttl: answer.TTL,
        grantedTtl: answer.grantedTTL,
        keys: answer.keys,
      };
    },
    async leaseLeases(callOptions) {
      const answer = await send<WireLeaseLeasesResponse>("Lease/LeaseLeases", {}, callOptions, false);
      return { header: header(answer.header, "Lease/LeaseLeases"), ids: answer.leases.map((lease) => lease.ID) };
    },
    async memberList(request, callOptions) {
      const wire: WireMemberListRequest = { linearizable: request.linearizable };
      const answer = await send<WireMemberListResponse>("Cluster/MemberList", wire, callOptions, false);
      return { header: header(answer.header, "Cluster/MemberList"), members: answer.members.map(member) };
    },
    async status(callOptions) {
      const answer = await send<WireStatusResponse>("Maintenance/Status", {}, callOptions, false);
      return {
        header: header(answer.header, "Maintenance/Status"),
        version: answer.version,
        dbSize: answer.dbSize,
        dbSizeInUse: answer.dbSizeInUse,
        dbSizeQuota: answer.dbSizeQuota,
        leader: answer.leader,
        raftIndex: answer.raftIndex,
        raftTerm: answer.raftTerm,
        raftAppliedIndex: answer.raftAppliedIndex,
        errors: answer.errors,
        isLearner: answer.isLearner,
        storageVersion: answer.storageVersion,
      };
    },
    async alarmList(callOptions) {
      const request: WireAlarmRequest = { action: "GET" };
      const answer = await send<WireAlarmResponse>("Maintenance/Alarm", request, callOptions, false);
      return answer.alarms.map(alarm);
    },
    async alarmDisarm(target, callOptions) {
      // The exact pair a GET answered: a member id of 0 or a type the member does not hold clears nothing (spec 7.2).
      const request: WireAlarmRequest = {
        action: "DEACTIVATE",
        memberID: uint64(target.memberId, "AlarmRequest.memberID"),
        alarm: ALARM_TYPES[target.alarm],
      };
      const answer = await send<WireAlarmResponse>("Maintenance/Alarm", request, callOptions, true);
      return answer.alarms.map(alarm);
    },
    async compact(revision, callOptions) {
      const request: WireCompactionRequest = {
        revision: int64(revision, "CompactionRequest.revision"),
        physical: true,
      };
      await send<object>("KV/Compact", request, callOptions, true);
    },
    async defragment(callOptions) {
      await send<object>("Maintenance/Defragment", {}, callOptions, true);
    },
    async authStatus(callOptions) {
      const answer = await send<WireAuthStatusResponse>("Auth/AuthStatus", {}, callOptions, false);
      return { enabled: answer.enabled, authRevision: answer.authRevision };
    },
    authenticate: (callOptions) => signIn(callOptions.signal),
    async userList(callOptions) {
      const answer = await send<WireAuthUserListResponse>("Auth/UserList", {}, callOptions, false);
      return answer.users;
    },
    async userGet(name, callOptions) {
      const request: WireAuthUserGetRequest = { name };
      const answer = await send<WireAuthUserGetResponse>("Auth/UserGet", request, callOptions, false);
      return answer.roles;
    },
    async roleList(callOptions) {
      const answer = await send<WireAuthRoleListResponse>("Auth/RoleList", {}, callOptions, false);
      return answer.roles;
    },
    async roleGet(name, callOptions) {
      const request: WireAuthRoleGetRequest = { role: name };
      const answer = await send<WireAuthRoleGetResponse>("Auth/RoleGet", request, callOptions, false);
      return answer.perm.map(permission);
    },
    async close() {
      if (closed) return;
      closed = true;
      closing.abort();
      channel.close();
    },
  };
}

/**
 * Settles with `done`, or as soon as `signal` aborts: a call that waits for a shared renewal still ends on its own
 * abort, and the send after it then meets that abort. `done` stays handled for a caller that stopped waiting.
 */
function until(done: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const release = cancelOnAbort(signal, resolve);
    done.then(resolve, reject).finally(release);
  });
}

/** Whether a call carries `hasleader: true` (spec 6.1, HASLEADER_RULES). */
function leaderRequired(rpc: EtcdWireRpc, request: object): boolean {
  switch (HASLEADER_RULES[rpc]) {
    case "always":
      return true;
    case "never":
      return false;
    case "when-linearizable":
      return !answeredLocally(rpc, request);
  }
}

function answeredLocally(rpc: EtcdWireRpc, request: object): boolean {
  if (rpc === "KV/Range") return (request as WireRangeRequest).serializable === true;
  if (rpc === "Cluster/MemberList") return !(request as WireMemberListRequest).linearizable;
  // A Txn is answered locally only when every request of both lists is a serializable get, as etcd's
  // IsTxnSerializable reads it, so a txn with no request at all is too.
  const txn = request as WireTxnRequest;
  return [...txn.success, ...txn.failure].every((op) => op.request_range?.serializable === true);
}

async function readWatch(stream: EtcdWireStream, signal: AbortSignal): Promise<WireWatchResponse | "aborted"> {
  let message: object | undefined;
  try {
    message = await stream.read();
  } catch (error) {
    // The call's own signal ended it: the caller's cancel or its window. Anything else ends the watch as an error
    // naming the cause, never as a quiet window (spec 5.3).
    if (signal.aborted) return "aborted";
    throw toEtcdError(error, signal);
  }
  if (message === undefined)
    throw new EtcdError("unavailable", "etcd ended the watch stream before it cancelled the watch");
  return message as WireWatchResponse;
}

/**
 * A 64-bit integer as the wire carries it (plan Global Constraints), checked before anything is sent: protobufjs
 * encodes any other string as a different number with no error, "1.5" as 1, "abc" as 0 and 2^63 as -2^63
 * (measured on 7.6.6), so a malformed revision, id or operand would reach etcd as another one.
 */
function int64(value: string, field: string): string {
  if (!DECIMAL.test(value) || BigInt(value) < INT64_MIN || BigInt(value) > INT64_MAX) {
    throw new RangeError(`${field} takes a decimal 64-bit integer; nothing was sent`);
  }
  return value;
}

/** A member id, the one unsigned 64-bit integer the adapter sends; checked as `int64` is. */
function uint64(value: string, field: string): string {
  if (!DECIMAL.test(value) || BigInt(value) < BigInt(0) || BigInt(value) > UINT64_MAX) {
    throw new RangeError(`${field} takes a decimal unsigned 64-bit integer; nothing was sent`);
  }
  return value;
}

/** An enum name read by its table; a name the table does not hold is refused in words, never guessed. */
function named<T>(table: ReadonlyMap<string, T>, value: unknown, what: string): T {
  const found = table.get(value as string);
  if (found === undefined)
    throw new EtcdError("unknown", `etcd answered ${what} ${String(value)}, which this client does not read`);
  return found;
}

/** The decimal revision after `revision`, a 64-bit integer carried as a string (plan Global Constraints). */
function following(revision: EtcdInt64): EtcdInt64 {
  return (BigInt(revision) + BigInt(1)).toString();
}

function header(wire: WireResponseHeader | null, rpc: EtcdWireRpc): EtcdResponseHeader {
  if (wire === null) throw new EtcdError("unknown", `etcd's answer to ${rpc} carried no response header`);
  return { clusterId: wire.cluster_id, memberId: wire.member_id, revision: wire.revision, raftTerm: wire.raft_term };
}

function keyValue(wire: WireKeyValue): EtcdKeyValue {
  return {
    key: wire.key,
    value: wire.value,
    createRevision: wire.create_revision,
    modRevision: wire.mod_revision,
    version: wire.version,
    lease: wire.lease,
  };
}

function rangeRequest(request: EtcdRangeRequest): WireRangeRequest {
  if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new RangeError("Every Range carries a positive whole limit (spec E14); nothing was sent");
  }
  return {
    key: request.key,
    ...(request.rangeEnd === undefined ? {} : { range_end: request.rangeEnd }),
    limit: String(request.limit),
    ...(request.revision === undefined ? {} : { revision: int64(request.revision, "RangeRequest.revision") }),
    ...(request.serializable === true ? { serializable: true } : {}),
    ...(request.keysOnly === true ? { keys_only: true } : {}),
    ...(request.countOnly === true ? { count_only: true } : {}),
  };
}

function rangeResponse(wire: WireRangeResponse, rpc: EtcdWireRpc): EtcdRangeResponse {
  return { header: header(wire.header, rpc), kvs: wire.kvs.map(keyValue), more: wire.more, count: wire.count };
}

function putRequest(request: EtcdPutRequest): WirePutRequest {
  return {
    key: request.key,
    value: request.value,
    ...(request.lease === undefined ? {} : { lease: int64(request.lease, "PutRequest.lease") }),
    ...(request.prevKv === true ? { prev_kv: true } : {}),
    ...(request.ignoreValue === true ? { ignore_value: true } : {}),
    ...(request.ignoreLease === true ? { ignore_lease: true } : {}),
  };
}

function putResponse(wire: WirePutResponse): EtcdPutResponse {
  return {
    header: header(wire.header, "KV/Txn"),
    ...(wire.prev_kv === null ? {} : { prevKv: keyValue(wire.prev_kv) }),
  };
}

function deleteRequest(request: EtcdDeleteRangeRequest): WireDeleteRangeRequest {
  return {
    key: request.key,
    ...(request.rangeEnd === undefined ? {} : { range_end: request.rangeEnd }),
    ...(request.prevKv === true ? { prev_kv: true } : {}),
  };
}

function deleteResponse(wire: WireDeleteRangeResponse, rpc: EtcdWireRpc): EtcdDeleteRangeResponse {
  return { header: header(wire.header, rpc), deleted: wire.deleted, prevKvs: wire.prev_kvs.map(keyValue) };
}

function compare(request: EtcdCompare): WireCompare {
  const base = {
    result: COMPARE_RESULTS[request.result],
    target: COMPARE_TARGETS[request.target],
    key: request.key,
    ...(request.rangeEnd === undefined ? {} : { range_end: request.rangeEnd }),
  };
  switch (request.target) {
    case "value":
      return { ...base, value: bytesOperand(request) };
    case "version":
      return { ...base, version: int64(int64Operand(request), "Compare.version") };
    case "create":
      return { ...base, create_revision: int64(int64Operand(request), "Compare.create_revision") };
    case "mod":
      return { ...base, mod_revision: int64(int64Operand(request), "Compare.mod_revision") };
    case "lease":
      return { ...base, lease: int64(int64Operand(request), "Compare.lease") };
  }
}

function int64Operand(request: EtcdCompare): EtcdInt64 {
  if (typeof request.operand !== "string") {
    throw new TypeError(`A ${request.target} compare takes a decimal string as its operand (plan C1)`);
  }
  return request.operand;
}

function bytesOperand(request: EtcdCompare): Uint8Array {
  if (typeof request.operand === "string") throw new TypeError("A value compare takes bytes as its operand (plan C1)");
  return request.operand;
}

function requestOp(op: EtcdRequestOp): WireRequestOp {
  switch (op.op) {
    case "range":
      return { request_range: rangeRequest(op.request) };
    case "put":
      return { request_put: putRequest(op.request) };
    case "delete":
      return { request_delete_range: deleteRequest(op.request) };
  }
}

function txnRequest(request: EtcdTxnRequest): WireTxnRequest {
  return {
    compare: request.compare.map(compare),
    success: request.success.map(requestOp),
    failure: request.failure.map(requestOp),
  };
}

function responseOp(wire: WireResponseOp): EtcdResponseOp {
  if (wire.response_range !== undefined) return { op: "range", response: rangeResponse(wire.response_range, "KV/Txn") };
  if (wire.response_put !== undefined) return { op: "put", response: putResponse(wire.response_put) };
  if (wire.response_delete_range !== undefined) {
    return { op: "delete", response: deleteResponse(wire.response_delete_range, "KV/Txn") };
  }
  throw new EtcdError("unknown", "etcd answered a txn request with a response this client never asks for");
}

function txnResponse(wire: WireTxnResponse): EtcdTxnResponse {
  return {
    header: header(wire.header, "KV/Txn"),
    succeeded: wire.succeeded,
    responses: wire.responses.map(responseOp),
  };
}

function watchRequest(request: EtcdWatchRequest, startRevision: EtcdInt64 | undefined): WireWatchRequest {
  return {
    create_request: {
      key: request.key,
      ...(request.rangeEnd === undefined ? {} : { range_end: request.rangeEnd }),
      ...(startRevision === undefined ? {} : { start_revision: startRevision }),
      ...(request.prevKv === true ? { prev_kv: true } : {}),
      // Spec 5.3: etcd splits a large answer, whose fragments the watch leg hands on one by one, so the watch loop
      // gathers them within its bounds before results.ts shapes them.
      fragment: true,
    },
  };
}

function watchEvent(wire: WireEvent): EtcdWatchEvent {
  const type = named(EVENT_NAMES, wire.type, "a watch event type");
  if (wire.kv === null) throw new EtcdError("unknown", "etcd sent a watch event with no key-value");
  return { type, kv: keyValue(wire.kv), ...(wire.prev_kv === null ? {} : { prevKv: keyValue(wire.prev_kv) }) };
}

function member(wire: WireMember): EtcdMember {
  return {
    id: wire.ID,
    name: wire.name,
    peerUrls: wire.peerURLs,
    clientUrls: wire.clientURLs,
    isLearner: wire.isLearner,
  };
}

function alarm(wire: WireAlarmMember): EtcdAlarm {
  return { memberId: wire.memberID, alarm: named(ALARM_NAMES, wire.alarm, "an alarm type") };
}

function permission(wire: WirePermission): EtcdPermission {
  return {
    type: named(PERMISSION_NAMES, wire.permType, "a permission type"),
    key: wire.key,
    ...(wire.range_end.length === 0 ? {} : { rangeEnd: wire.range_end }),
  };
}
