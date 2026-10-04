/**
 * The Oxia provider's gRPC adapter: the one provider file that imports @grpc/proto-loader and the generated
 * descriptor (SB1-1.3, SB1-2.3, SB1-2.4, SB1-5.5, SB1-5.5a), over the shared gRPC transport of src/lib/db/grpc/.
 *
 * The stub is built from OxiaClient filtered to OXIA_ALLOWLISTED_RPCS and Health filtered to Check, so no write,
 * session, notification or watch RPC exists here although the whole descriptor is loaded (C9). Every channel of the
 * channel map, one per address, is opened through an injected `OxiaWireTransport`: `grpcOxiaWireTransport` in
 * production, a recorded wire or an in-process server in tests. Every key, bound and index name is checked before any
 * request, every stream has a received-byte limit, every call carries the caller's deadline, no call is retried and
 * nothing is logged. tests/unit/db/oxia/seam-guard.test.ts holds it.
 */
import { fromJSON, type MethodDefinition, type PackageDefinition, type ServiceDefinition } from "@grpc/proto-loader";
import { QueryError } from "@/lib/db/errors";
import {
  type GrpcCall,
  type GrpcChannel,
  type GrpcChannelConfig,
  type GrpcServerStream,
  openGrpcChannel,
} from "@/lib/db/grpc/channel";
import { type GrpcTlsOptions, grpcTarget, grpcTlsIdentity } from "@/lib/db/grpc/tls";
import {
  OXIA_ALLOWLISTED_RPCS,
  OXIA_HEALTH_RPCS,
  type OxiaCallOptions,
  type OxiaClient,
  type OxiaGet,
  type OxiaHealth,
  type OxiaLeader,
  type OxiaRange,
  type OxiaRecord,
  type OxiaRpc,
  type OxiaShard,
  type OxiaSnapshot,
  type OxiaStream,
  type OxiaStreamOptions,
  type OxiaVersion,
} from "./client";
import { admitLeaders, type OxiaConnectionOptions, oxiaLeaderParser } from "./connection-options";
import {
  OXIA_INTERNAL_PREFIX,
  OXIA_IP_SERVER_NAME,
  OXIA_LEADER_MAX_BYTES,
  OXIA_READ_BATCH_GETS,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_RUN_BYTE_BUDGET,
  OXIA_TYPE,
} from "./constants";
import {
  OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
  OXIA_INDEX_NAME_SENTENCE,
  OXIA_LONE_SURROGATE_SENTENCE,
  OxiaError,
  OxiaUnsentStatus,
  toOxiaError,
} from "./errors";
import { hasLoneSurrogate } from "./order";
import { OXIA_DESCRIPTOR } from "./proto/descriptor";
import { validateAssignments, type WireAssignments } from "./routing";

/** How the adapter reads OXIA_DESCRIPTOR: field names as spelled, int64 and fixed64 as decimal strings, enums by name. */
export const OXIA_LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

const CLIENT_SERVICE = "io.oxia.proto.v1.OxiaClient";
const HEALTH_SERVICE = "grpc.health.v1.Health";
/** How a health RPC is named beside the client's, so the two lists cannot collide. */
const HEALTH_PREFIX = "Health/";

/** Fails to compile when `OxiaRpc` gains a member the two lists do not name. */
type ListedRpc = (typeof OXIA_ALLOWLISTED_RPCS)[number] | `${typeof HEALTH_PREFIX}${(typeof OXIA_HEALTH_RPCS)[number]}`;
type UnlistedRpc = Exclude<OxiaRpc, ListedRpc>;
const everyRpcListed: [UnlistedRpc] extends [never] ? true : UnlistedRpc = true;
void everyRpcListed;

/** An OxiaClient RPC: each is a server stream. */
type StreamRpc = (typeof OXIA_ALLOWLISTED_RPCS)[number];

/** The four answers of grpc.health.v1's ServingStatus. */
const HEALTH_STATES: readonly string[] = [
  "SERVING",
  "NOT_SERVING",
  "UNKNOWN",
  "SERVICE_UNKNOWN",
] satisfies OxiaHealth[];
/** An index name may not begin with the internal prefix's word: the server builds `__oxia/idx/<index>/<key>` from it. */
const RESERVED_INDEX_PREFIX = OXIA_INTERNAL_PREFIX.slice(0, -"/".length);
const ENCODER = new TextEncoder();

let packageDefinition: PackageDefinition | undefined;
let allowlisted: { readonly client: ServiceDefinition; readonly health: ServiceDefinition } | undefined;

/** The descriptor as grpc-js reads it, built on first use and kept for the process. */
export function oxiaDefinition(): PackageDefinition {
  packageDefinition ??= fromJSON(OXIA_DESCRIPTOR, OXIA_LOADER_OPTIONS);
  return packageDefinition;
}

function filtered(service: string, rpcs: readonly string[]): ServiceDefinition {
  const full = oxiaDefinition()[service] as ServiceDefinition;
  return Object.fromEntries(rpcs.map((rpc) => [rpc, full[rpc]])) as ServiceDefinition;
}

/** OxiaClient filtered to OXIA_ALLOWLISTED_RPCS, and Health filtered to Check: the only definitions methods are taken from. */
export function allowlistedServices(): { readonly client: ServiceDefinition; readonly health: ServiceDefinition } {
  allowlisted ??= {
    client: filtered(CLIENT_SERVICE, OXIA_ALLOWLISTED_RPCS),
    health: filtered(HEALTH_SERVICE, OXIA_HEALTH_RPCS),
  };
  return allowlisted;
}

/** Every method not on the allowlist, then every allowlisted RPC missing: empty for the stub alone. */
export function allowlistFindings(methods: readonly string[]): string[] {
  const allowed: readonly string[] = [
    ...OXIA_ALLOWLISTED_RPCS,
    ...OXIA_HEALTH_RPCS.map((rpc) => `${HEALTH_PREFIX}${rpc}`),
  ];
  return [
    ...methods.filter((method) => !allowed.includes(method)).map((method) => `${method} is not on the allowlist`),
    ...allowed.filter((rpc) => !methods.includes(rpc)).map((rpc) => `${rpc} is missing`),
  ];
}

function method(rpc: StreamRpc): MethodDefinition<object, object> {
  return allowlistedServices().client[rpc] as MethodDefinition<object, object>;
}

function healthMethod(): MethodDefinition<object, object> {
  return allowlistedServices().health[OXIA_HEALTH_RPCS[0]] as MethodDefinition<object, object>;
}

/** Opens the channel for one channel-map address (`sentAuthority` for the bootstrap, `OxiaLeader.address` for a listed leader). */
export interface OxiaWireTransport {
  /** Called once per address; `config` is that channel's full config: its dial target and its own TLS options. */
  channel(address: string, config: GrpcChannelConfig): GrpcChannel;
}

/** Production: `openGrpcChannel(config)`; the address is not used. */
export const grpcOxiaWireTransport: OxiaWireTransport = {
  channel: (_address, config) => openGrpcChannel(config),
};

/** What the provider's constructor takes (SB3-9 I-5). */
export type OxiaClientFactory = (options: OxiaConnectionOptions) => OxiaClient;

// -- wire shapes, as OXIA_LOADER_OPTIONS decodes them ----------------------------------------------------------------

interface WireVersion {
  readonly version_id: string;
  readonly modifications_count: string;
  readonly created_timestamp: string;
  readonly modified_timestamp: string;
  readonly session_id?: string | null;
  readonly client_identity?: string | null;
}

/** A GetResponse: a proto3 `optional` field is absent when it was not on the wire. */
interface WireRecord {
  readonly status: string | number;
  readonly version?: WireVersion | null;
  readonly value?: Uint8Array | null;
  readonly key?: string | null;
  readonly secondary_index_key?: string | null;
}

interface WireReadResponse {
  readonly gets: readonly WireRecord[];
}

interface WireListResponse {
  readonly keys: readonly string[];
}

interface WireRangeScanResponse {
  readonly records: readonly WireRecord[];
}

/** What one Read stream delivered, read before the stream is cancelled. */
interface ReadAnswers {
  readonly answers: readonly WireRecord[];
  readonly truncated: boolean;
}

/** Reads one Read stream to its end (declared here so no type-only line sits in the adapter's body). */
type AnswerReader = (stream: GrpcServerStream, call: OxiaCallOptions, shard: OxiaShard) => Promise<ReadAnswers>;

/** Opens one List or RangeScan stream and reads each message's items through `items`. */
type RangeOpener = <T>(
  rpc: "List" | "RangeScan",
  shard: OxiaShard,
  range: OxiaRange,
  call: OxiaStreamOptions,
  items: (message: object) => readonly T[],
) => OxiaStream<T>;

// -- channel configs -------------------------------------------------------------------------------------------------

function channelConfig(target: string, tls: GrpcTlsOptions | undefined): GrpcChannelConfig {
  return {
    target,
    ...(tls === undefined ? {} : { tls }),
    receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
    retries: "none",
    unsent: (status) => new OxiaUnsentStatus(status),
  };
}

/** A host without the brackets an IPv6 literal is written in; any other host unchanged (decision D6). */
function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** A listed leader's channel: its own target and TLS identity, from the validated parts, never the server's string. */
function leaderConfig(options: OxiaConnectionOptions, leader: OxiaLeader): GrpcChannelConfig {
  const bare = unbracketed(leader.host);
  const tls = options.tlsMaterial && grpcTlsIdentity(options.tlsMaterial, bare, OXIA_IP_SERVER_NAME);
  return channelConfig(grpcTarget(bare, leader.port), tls);
}

// -- text checks (SB1-4.9, C10) --------------------------------------------------------------------------------------

function refusal(sentence: string): QueryError {
  return new QueryError(sentence, OXIA_TYPE);
}

function checkBound(text: string): void {
  if (hasLoneSurrogate(text)) throw refusal(OXIA_LONE_SURROGATE_SENTENCE);
}

function checkKey(key: string): void {
  checkBound(key);
  if (key.startsWith(OXIA_INTERNAL_PREFIX)) throw refusal(OXIA_ADAPTER_INTERNAL_KEY_SENTENCE);
}

function checkIndex(name: string | undefined): void {
  if (name === undefined) return;
  checkBound(name);
  const word =
    name !== "" &&
    ENCODER.encode(name).length <= OXIA_LEADER_MAX_BYTES &&
    !name.includes("/") &&
    !name.startsWith(RESERVED_INDEX_PREFIX);
  if (!word) throw refusal(OXIA_INDEX_NAME_SENTENCE);
}

// -- answers ---------------------------------------------------------------------------------------------------------

function present<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function toVersion(wire: WireVersion): OxiaVersion {
  return {
    versionId: wire.version_id,
    modificationsCount: wire.modifications_count,
    createdTimestamp: wire.created_timestamp,
    modifiedTimestamp: wire.modified_timestamp,
    ...(present(wire.session_id) ? { sessionId: wire.session_id } : {}),
    ...(present(wire.client_identity) ? { clientIdentity: wire.client_identity } : {}),
  };
}

/**
 * One answer as the seam reads it. An OK answer with no key gets the asked key only for an EQUAL get without an index
 * (F16); any other OK answer without a key, an OK answer without a version, and a status the client cannot read are
 * `malformed`. An answer that asked the value and carries none holds the empty value, because the server puts no
 * `value` field on the wire for an empty value (ruling R28): a RangeScan record always asks it, a get by `includeValue`.
 */
function toRecord(wire: WireRecord, rpc: OxiaRpc, asked?: OxiaGet): OxiaRecord {
  if (wire.status === "KEY_NOT_FOUND") return { status: "KEY_NOT_FOUND" };
  const exact = asked !== undefined && asked.comparison === "EQUAL" && asked.secondaryIndexName === undefined;
  const key = present(wire.key) ? wire.key : exact ? asked.key : undefined;
  if (wire.status !== "OK" || key === undefined || !present(wire.version)) throw new OxiaError("malformed", { rpc });
  const valueAsked = asked?.includeValue ?? true;
  return {
    status: "OK",
    key,
    version: toVersion(wire.version),
    ...(present(wire.value) ? { value: Uint8Array.from(wire.value) } : valueAsked ? { value: new Uint8Array(0) } : {}),
    ...(present(wire.secondary_index_key) ? { secondaryIndexKey: wire.secondary_index_key } : {}),
  };
}

function wireRange(shard: OxiaShard, range: OxiaRange): object {
  return {
    shard: shard.id,
    start_inclusive: range.startInclusive,
    end_exclusive: range.endExclusive,
    include_internal_keys: false,
    ...(range.secondaryIndexName === undefined ? {} : { secondary_index_name: range.secondaryIndexName }),
  };
}

function wireGet(get: OxiaGet): object {
  return {
    key: get.key,
    include_value: get.includeValue,
    comparison_type: get.comparison,
    ...(get.secondaryIndexName === undefined ? {} : { secondary_index_name: get.secondaryIndexName }),
  };
}

// -- the adapter -----------------------------------------------------------------------------------------------------

/**
 * `OxiaClient` over a transport, `grpcOxiaWireTransport` by default. It opens no channel until a call; the bootstrap
 * channel is kept under the sent authority and serves every leader byte-equal to it, and each listed leader gets one
 * channel of its own, kept until `close()`. After `close()` every failure is `OxiaError("closed")`.
 */
export function createGrpcOxiaClient(
  options: OxiaConnectionOptions,
  transport: OxiaWireTransport = grpcOxiaWireTransport,
): OxiaClient {
  const channels = new Map<string, GrpcChannel>();
  let closed = false;
  const metadata: Readonly<Record<string, string>> =
    options.token === undefined ? {} : { authorization: `Bearer ${options.token}` };

  /** The bootstrap channel for `undefined` or a bootstrap leader; a listed leader's own channel otherwise. */
  const channelFor = (leader: OxiaLeader | undefined): GrpcChannel => {
    const listed = leader !== undefined && !leader.bootstrap ? leader : undefined;
    const address = listed === undefined ? options.sentAuthority : listed.address;
    let channel = channels.get(address);
    if (channel === undefined) {
      const config = listed === undefined ? channelConfig(options.target, options.tls) : leaderConfig(options, listed);
      channel = transport.channel(address, config);
      channels.set(address, channel);
    }
    return channel;
  };

  const grpcCall = (call: OxiaCallOptions): GrpcCall => ({
    metadata,
    deadline: new Date(call.deadline),
    signal: call.signal,
  });

  const begin = (rpc: OxiaRpc, call: OxiaCallOptions): void => {
    if (closed) throw new OxiaError("closed", { rpc });
    if (call.signal.aborted) throw toOxiaError(call.signal.reason, rpc, call.signal);
  };

  const failure = (error: unknown, rpc: OxiaRpc, call: OxiaCallOptions, shard?: OxiaShard): OxiaError =>
    closed
      ? new OxiaError("closed", { rpc })
      : toOxiaError(error, rpc, call.signal, shard && { id: shard.id, leader: shard.leader.address });

  /** Every message of one Read stream; a receive-cap failure carries the answers read before it (C13). */
  const readAnswers: AnswerReader = async (stream, call, shard) => {
    const answers: WireRecord[] = [];
    for (;;) {
      let message: object | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one reader takes the stream's messages in order.
        message = await stream.read();
      } catch (error) {
        const classified = failure(error, "Read", call, shard);
        if (classified.category !== "receive-cap") throw classified;
        throw new OxiaError("receive-cap", { ...classified, answered: answers.length });
      }
      if (message === undefined) return { answers, truncated: stream.truncated };
      answers.push(...(message as WireReadResponse).gets);
    }
  };

  const openRange: RangeOpener = (rpc, shard, range, call, items) => {
    begin(rpc, call);
    checkKey(range.startInclusive);
    checkBound(range.endExclusive);
    checkIndex(range.secondaryIndexName);
    const stream = channelFor(shard.leader).serverStream(method(rpc), wireRange(shard, range), grpcCall(call), {
      maxReceivedBytes: call.maxReceivedBytes,
    });
    return {
      next: async () => {
        let message: object | undefined;
        try {
          message = await stream.read();
        } catch (error) {
          throw failure(error, rpc, call, shard);
        }
        return message === undefined ? undefined : items(message);
      },
      get receivedBytes() {
        return stream.receivedBytes;
      },
      get truncated() {
        return stream.truncated;
      },
      cancel: () => stream.cancel(),
    };
  };

  return {
    getSnapshot: async (call) => {
      const rpc = "GetShardAssignments";
      begin(rpc, call);
      const stream = channelFor(undefined).serverStream(method(rpc), { namespace: options.namespace }, grpcCall(call), {
        maxReceivedBytes: OXIA_RECEIVE_CAP_BYTES,
      });
      let message: object | undefined;
      try {
        message = await stream.read();
      } catch (error) {
        const classified = failure(error, rpc, call);
        if (classified.category !== "receive-cap") throw classified;
        throw new OxiaError("snapshot-invalid", { rpc, snapshotProblem: "too-large" });
      } finally {
        // The first message is the whole map; the stream is never kept open (C14).
        stream.cancel();
      }
      if (message === undefined) throw new OxiaError("malformed", { rpc });
      const validated = validateAssignments(message as WireAssignments, options.namespace, oxiaLeaderParser(options));
      if ("problem" in validated) throw new OxiaError("snapshot-invalid", { rpc, snapshotProblem: validated.problem });
      const policy = admitLeaders(
        options,
        validated.shards.map((shard) => shard.leaderRaw),
      );
      if (policy.refusal !== undefined) throw new OxiaError("leader-refused", { rpc, sentence: policy.refusal });
      const snapshot: OxiaSnapshot = {
        namespace: options.namespace,
        shards: validated.shards.map((shard) => ({
          id: shard.id,
          minHash: shard.minHash,
          maxHash: shard.maxHash,
          leader: policy.admitted.get(shard.leaderRaw) as OxiaLeader,
        })),
        readAt: Date.now(),
      };
      return snapshot;
    },

    read: async (shard, gets, call) => {
      const rpc = "Read";
      begin(rpc, call);
      if (gets.length < 1 || gets.length > OXIA_READ_BATCH_GETS) {
        throw new RangeError(`A Read sends 1 to ${OXIA_READ_BATCH_GETS.toLocaleString("en-US")} gets`);
      }
      for (const get of gets) {
        checkKey(get.key);
        checkIndex(get.secondaryIndexName);
      }
      const request = { shard: shard.id, gets: gets.map(wireGet) };
      const stream = channelFor(shard.leader).serverStream(method(rpc), request, grpcCall(call), {
        maxReceivedBytes: call.maxReceivedBytes ?? OXIA_RUN_BYTE_BUDGET,
      });
      let read: ReadAnswers;
      try {
        read = await readAnswers(stream, call, shard);
      } finally {
        stream.cancel();
      }
      const answered = read.answers.length;
      if (read.truncated && answered < gets.length) {
        throw new OxiaError("receive-cap", { rpc, answered, shardId: shard.id, leader: shard.leader.address });
      }
      if (answered !== gets.length) throw new OxiaError("malformed", { rpc });
      return read.answers.map((wire, index) => toRecord(wire, rpc, gets[index]));
    },

    list: (shard, range, call) =>
      openRange("List", shard, range, call, (message) => (message as WireListResponse).keys),

    rangeScan: (shard, range, call) =>
      openRange("RangeScan", shard, range, call, (message) =>
        (message as WireRangeScanResponse).records.map((record) => toRecord(record, "RangeScan")),
      ),

    health: async (call) => {
      const rpc = "Health/Check";
      begin(rpc, call);
      let answer: object;
      try {
        answer = await channelFor(undefined).unary(healthMethod(), { service: "" }, grpcCall(call));
      } catch (error) {
        throw failure(error, rpc, call);
      }
      const status = (answer as { readonly status?: unknown }).status;
      if (typeof status !== "string" || !HEALTH_STATES.includes(status)) throw new OxiaError("malformed", { rpc });
      return status as OxiaHealth;
    },

    close: () => {
      if (closed) return;
      closed = true;
      for (const channel of channels.values()) channel.close();
      channels.clear();
    },
  };
}
