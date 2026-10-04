/**
 * The Oxia provider's I/O-free seam (SB1-2.1).
 *
 * Every module above this line depends on `OxiaClient`, never on the gRPC library: `grpc-client.ts` is the one
 * implementation, and tests implement the interface with fakes injected by constructor.
 *
 * 64-bit integers (shard ids, versions, counts, timestamps, session ids) are decimal strings, because a JavaScript
 * number loses digits past 2^53 and tsconfig targets ES2017, where a bigint literal is error TS2737.
 *
 * The RPC names and the walk answer types are declared here too, so that no module of an earlier build step imports a
 * later one: the errors module names an RPC before the adapter exists, and the walks' callers read their answers
 * without importing the walks.
 */

/** int64 and fixed64 travel as decimal strings. */
export type OxiaInt64 = string;
export type OxiaComparison = "EQUAL" | "FLOOR" | "CEILING" | "LOWER" | "HIGHER";

/** A host and a port as Studio parsed them: lower-case host (IPv6 bracketed and RFC 5952 compressed), port 1 to 65535. */
export interface OxiaEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface OxiaLeader {
  readonly host: string;
  readonly port: number;
  /** `host:port`, the channel-map key; never the server's raw string. */
  readonly address: string;
  /** True when the server's string was byte-equal to the authority Studio sent (C2): served by the bootstrap channel. */
  readonly bootstrap: boolean;
}

export interface OxiaShard {
  readonly id: OxiaInt64;
  readonly minHash: number; // inclusive, 0 to 4294967295
  readonly maxHash: number; // inclusive
  readonly leader: OxiaLeader;
}

/** The namespace's shard map, validated (C11) and admitted by the dial policy (C2 to C5), sorted by `minHash`. */
export interface OxiaSnapshot {
  readonly namespace: string;
  readonly shards: readonly OxiaShard[];
  /** Epoch ms when it was read, for the brief cache (SB1-5.3). */
  readonly readAt: number;
}

export interface OxiaVersion {
  readonly versionId: OxiaInt64;
  readonly modificationsCount: OxiaInt64;
  /** Epoch milliseconds as a decimal string (fixed64). */
  readonly createdTimestamp: OxiaInt64;
  readonly modifiedTimestamp: OxiaInt64;
  /** Present for an ephemeral record. */
  readonly sessionId?: OxiaInt64;
  readonly clientIdentity?: string;
}

/** One answer of a Read get, or one RangeScan record. */
export interface OxiaRecord {
  readonly status: "OK" | "KEY_NOT_FOUND";
  /**
   * Always set on an OK answer. A comparison get, a secondary-index get and every RangeScan record carry the key
   * the server returned; an EQUAL get, whose answer has no key on the wire (GetResponse.key is sent only for
   * non-exact queries), carries the key that was asked, as the Go client's `toGetResult` does (F16).
   */
  readonly key?: string;
  readonly version?: OxiaVersion;
  /** Present when `includeValue` was asked and the record exists. */
  readonly value?: Uint8Array;
  readonly secondaryIndexKey?: string;
}

export interface OxiaGet {
  readonly key: string;
  readonly includeValue: boolean;
  readonly comparison: OxiaComparison;
  readonly secondaryIndexName?: string;
}

/** A key range in the namespace's order; "" is unbounded at either end. */
export interface OxiaRange {
  readonly startInclusive: string;
  readonly endExclusive: string;
  readonly secondaryIndexName?: string;
}

export interface OxiaCallOptions {
  readonly signal: AbortSignal;
  /** Absolute deadline in epoch ms; every call has one (C14). */
  readonly deadline: number;
  /**
   * Received serialized bytes after which a Read stream ends as a truncated Read (receive-cap with `answered`); `read`
   * alone takes it, and without it the limit is OXIA_RUN_BYTE_BUDGET (ruling R24).
   */
  readonly maxReceivedBytes?: number;
}

export interface OxiaStreamOptions extends OxiaCallOptions {
  /** Received serialized bytes after which the stream cancels itself as a truncation (SB1-3, SB1-9.2). */
  readonly maxReceivedBytes: number;
}

/** A server stream of keys (List) or records (RangeScan), read one message at a time. */
export interface OxiaStream<T> {
  /** The next message's items; undefined at the end, after cancel() or at the byte limit. */
  next(): Promise<readonly T[] | undefined>;
  readonly receivedBytes: number;
  /** True when the stream ended by cancel() or by its byte limit rather than by the server's end. */
  readonly truncated: boolean;
  cancel(): void;
}

export type OxiaHealth = "SERVING" | "NOT_SERVING" | "UNKNOWN" | "SERVICE_UNKNOWN";

export interface OxiaClient {
  getSnapshot(call: OxiaCallOptions): Promise<OxiaSnapshot>;
  read(shard: OxiaShard, gets: readonly OxiaGet[], call: OxiaCallOptions): Promise<readonly OxiaRecord[]>;
  list(shard: OxiaShard, range: OxiaRange, call: OxiaStreamOptions): OxiaStream<string>;
  rangeScan(shard: OxiaShard, range: OxiaRange, call: OxiaStreamOptions): OxiaStream<OxiaRecord>;
  health(call: OxiaCallOptions): Promise<OxiaHealth>;
  close(): void;
}

// The RPC names, declared here so errors.ts can name an RPC before the adapter exists (D2). SB1-2.4.
/** The RPCs the adapter can name; the stub holds these and no other (C9). */
export const OXIA_ALLOWLISTED_RPCS = ["GetShardAssignments", "Read", "List", "RangeScan"] as const;
export const OXIA_HEALTH_RPCS = ["Check"] as const;
export type OxiaRpc = (typeof OXIA_ALLOWLISTED_RPCS)[number] | "Health/Check";

/** Fails to compile when OxiaRpc gains a member that neither list names. */
type ListedRpc = (typeof OXIA_ALLOWLISTED_RPCS)[number] | `Health/${(typeof OXIA_HEALTH_RPCS)[number]}`;
const everyRpcListed: OxiaRpc extends ListedRpc ? (ListedRpc extends OxiaRpc ? true : never) : never = true;
void everyRpcListed;

// Walk answers: what walks.ts returns and execute.ts, key-scan.ts, objects.ts and results.ts read (D3). SB2-11.1,
// consistency rulings 7 and 8, the apply-round ruling.
/** One record above the seam. */
export interface OxiaRecordView {
  /** For an EQUAL get with no index, the asked key; otherwise the key the server returned. */
  readonly key: string;
  /** Absent when withheld at the receive cap (C13), and when the read asked no value. */
  readonly value?: Uint8Array;
  readonly withheld?: true;
  readonly version: OxiaVersion;
  /** Set for a secondary-index get only: the winner's secondaryIndexKey from the fan-out (SB1-7.6). */
  readonly secondaryIndexKey?: string;
  /** The shard that answered; the key Source tab's metadata shows it (SB2-7.5). */
  readonly shard: OxiaInt64;
}
/** What every key walk returns: fullWalkPage, prefixWalkPage, childrenPage and listRange. */
export interface OxiaKeysAnswer {
  readonly keys: readonly string[];
  readonly more: boolean;
  /** Only listRange sets it. */
  readonly stoppedBy?: "bytes";
  /** Only listRange with an index over more than one shard sets it. */
  readonly indexConcatenated?: true;
  readonly shardsRead: number;
}
/** What rangeScanPage and prefixScanPage return; `stoppedBy` names a stop, never an error. */
export interface OxiaRecordsAnswer {
  readonly records: readonly OxiaRecordView[];
  readonly more: boolean;
  readonly stoppedBy?: "bytes" | "receive-cap";
  readonly indexConcatenated?: true;
  readonly shardsRead: number;
}
