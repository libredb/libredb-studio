/**
 * The Milvus provider's gRPC adapter: the one provider file that imports @grpc/grpc-js, @grpc/proto-loader and the
 * generated descriptor (vector-family spec 5.1, 5.11, E15), which tests/unit/db/milvus/seam-guard.test.ts holds.
 *
 * The transport half is a copy of the etcd provider's (src/lib/db/providers/keyvalue/etcd/grpc-client.ts), made under
 * the isolation rule (decision Q1a): the channel options, the IP-identity rule, the TLS mapping, the closing
 * credentials and the unary call wrapper; no etcd file is imported. Two departures are the spec's own:
 * `grpc.enable_retries: 0` (E7), and a stub built from MilvusService filtered to E15's allowlist, so no `Connect`,
 * whose ClientInfo carries the host name, and no ClientTelemetryService method can be called although the full
 * descriptor is loaded (E3). Every allowlisted RPC answers as the first call on a fresh channel with no Connect (R41
 * M18). Milvus's allowlist is unary only, so there is no stream half.
 *
 * The adapter half, `createGrpcMilvusClient`, is `MilvusClient` over a `MilvusWireTransport`: `grpcWireTransport`
 * here, and in tests the recorded wire of tests/helpers/milvus-wire.ts.
 */
import type { Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import {
  type CallCredentials,
  ChannelCredentials,
  type ChannelOptions,
  Client,
  credentials,
  type experimental,
  Metadata,
  type ServiceError,
  type VerifyOptions,
} from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition, type PackageDefinition, type ServiceDefinition } from "@grpc/proto-loader";
import type { MilvusConnectionOptions, MilvusTlsOptions } from "./connection-options";
import { MilvusUnsentStatus } from "./errors";
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

/** The one implementation over @grpc/grpc-js. */
export const grpcWireTransport: MilvusWireTransport = (options) => {
  const closing = new ClosingCredentials(channelCredentials(options.tls));
  const client = new Client(options.target, closing, channelOptions(options));
  return {
    unary: (rpc, request, call) => unaryCall(client, rpc, request, call),
    close: () => {
      client.close();
      closing.endEverySocket();
    },
  };
};

/**
 * E7, exactly. Five are etcd's: no service config from DNS, so a `grpc_config=` TXT record can install no retry
 * policy and no ORCA balancer whose proto path a bundle breaks; the receive cap; no proxy from the environment (E2);
 * a 10 s keepalive with a 6 s timeout, which finds a silently dropped connection on the first call after idle and
 * stays above the native server's 5 s ping minimum (R41 M6). `grpc.enable_retries: 0` is an addition: it makes every
 * failure an explicit error. Never set: `grpc.keepalive_permit_without_calls`, `grpc.max_send_message_length` and
 * `grpc.default_compression_algorithm`, so Milvus answers uncompressed (R41 M25).
 */
export function channelOptions(options: MilvusConnectionOptions): ChannelOptions {
  return {
    "grpc.service_config_disable_resolution": 1,
    "grpc.max_receive_message_length": options.receiveCapBytes,
    "grpc.enable_http_proxy": 0,
    "grpc.enable_retries": 0,
    "grpc.keepalive_time_ms": 10_000,
    "grpc.keepalive_timeout_ms": 6_000,
    ...(options.tls === undefined ? {} : { "grpc.ssl_target_name_override": options.tls.serverNameOverride }),
  };
}

/**
 * E6's credentials: `require` encrypts and checks nothing; every other mode checks the chain, against the pasted CA
 * or the runtime's roots, and the name. grpc-js hands `checkServerIdentity` the override name, so an IP identity's
 * check closes over the IP and never reads its `host` argument.
 */
function channelCredentials(tls: MilvusTlsOptions | undefined): ChannelCredentials {
  if (tls === undefined) return credentials.createInsecure();
  const pair = tls.clientCertificate;
  return credentials.createSsl(
    tls.ca === undefined ? null : Buffer.from(tls.ca),
    pair === undefined ? null : Buffer.from(pair.key),
    pair === undefined ? null : Buffer.from(pair.cert),
    verifyOptions(tls),
  );
}

function verifyOptions(tls: MilvusTlsOptions): VerifyOptions {
  if (!tls.verify) return { rejectUnauthorized: false };
  if (!tls.identityIsIp) return { rejectUnauthorized: true };
  const ip = tls.identity;
  return {
    rejectUnauthorized: true,
    checkServerIdentity: (_override, certificate) => checkServerIdentity(ip, certificate),
  };
}

const CHANNEL_CLOSED = "The channel closed before this connection was established";

/**
 * E16, copied from the etcd adapter, whose docblock records what outlived grpc-js 1.14.5's own close(): a TLS
 * handshake a peer never answers, a dial after the close from a backoff timer, an HTTP/2 session waiting for SETTINGS,
 * and a subchannel built after the close. The connector below ends every socket still in its handshake on
 * `destroy()`, refuses readiness from then on, keeps every socket it was handed until that socket closes, and
 * `endEverySocket()` ends them all and destroys every connector made after it. The credentials equal only themselves,
 * so no two clients share a subchannel.
 */
export class ClosingCredentials extends ChannelCredentials {
  private readonly sockets = new Set<Socket>();
  private closed = false;

  constructor(private readonly inner: ChannelCredentials) {
    super();
  }

  _isSecure(): boolean {
    return this.inner._isSecure();
  }

  _equals(other: ChannelCredentials): boolean {
    return other === this;
  }

  _createSecureConnector(
    channelTarget: experimental.GrpcUri,
    options: ChannelOptions,
    callCredentials?: CallCredentials,
  ): experimental.SecureConnector {
    const connector = closingConnector(
      this.inner._createSecureConnector(channelTarget, options, callCredentials),
      this.sockets,
    );
    if (this.closed) connector.destroy();
    return connector;
  }

  endEverySocket(): void {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
  }
}

function closingConnector(inner: experimental.SecureConnector, sockets: Set<Socket>): experimental.SecureConnector {
  const handshaking = new Map<Socket, (reason: Error) => void>();
  let destroyed = false;
  const end = (socket: Socket, fail: (reason: Error) => void) => {
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
    waitForReady: () => (destroyed ? Promise.reject(new Error(CHANNEL_CLOSED)) : inner.waitForReady()),
    getCallCredentials: () => inner.getCallCredentials(),
    destroy: () => {
      destroyed = true;
      for (const [socket, fail] of handshaking) end(socket, fail);
      inner.destroy();
    },
  };
}

function metadataOf(call: MilvusWireCall): Metadata {
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

/** Whether grpc-js gave a call a transport: it asks a call's credentials for metadata only once a pick has. */
function pickNotice(): { readonly credentials: CallCredentials; readonly picked: () => boolean } {
  let picked = false;
  return {
    credentials: credentials.createFromMetadataGenerator((_options, callback) => {
      picked = true;
      callback(null, new Metadata());
    }),
    picked: () => picked,
  };
}

function callFailure(error: ServiceError, signal: AbortSignal, picked: boolean): Error {
  return signal.aborted && !picked ? new MilvusUnsentStatus(error) : error;
}

function unaryCall(client: Client, rpc: MilvusRpc, request: object, call: MilvusWireCall): Promise<object> {
  const method = wireMethod(rpc);
  const pick = pickNotice();
  return new Promise<object>((resolve, reject) => {
    let release: () => void = () => undefined;
    const pending = client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      request,
      metadataOf(call),
      { deadline: call.deadline, credentials: pick.credentials },
      (error, value) => {
        release();
        if (error) reject(callFailure(error, call.signal, pick.picked()));
        else resolve(value as object);
      },
    );
    release = cancelOnAbort(call.signal, () => pending.cancel());
  });
}
