/**
 * The etcd provider's I/O-free seam (spec 3.1, 3.5).
 *
 * Every module above this line depends on `EtcdClient`, never on the gRPC library: `grpc-client.ts`
 * is the one implementation, and tests implement the interface with fakes. The interface holds the
 * allowlist of spec E11 and nothing else, so a method that is not declared here cannot be called by
 * provider logic at all; the seam guard holds the adapter to the same list.
 *
 * Keys and values are bytes. 64-bit integers (revisions, versions, counts, TTLs, lease and member
 * ids) are decimal strings, because a JavaScript number loses digits past 2^53 and tsconfig targets
 * ES2017, where a bigint literal is error TS2737.
 */

/** Bytes as etcd holds them. Keys and values are never strings inside the provider. */
export type EtcdBytes = Uint8Array;

/** 64-bit integers travel as decimal strings; ids too, until shown. */
export type EtcdInt64 = string;

export interface EtcdResponseHeader {
  readonly clusterId: EtcdInt64;
  readonly memberId: EtcdInt64;
  readonly revision: EtcdInt64;
  readonly raftTerm: EtcdInt64;
}

export interface EtcdKeyValue {
  readonly key: EtcdBytes;
  /** Empty for a keys-only read. */
  readonly value: EtcdBytes;
  readonly createRevision: EtcdInt64;
  readonly modRevision: EtcdInt64;
  readonly version: EtcdInt64;
  /** "0" when the key holds no lease. */
  readonly lease: EtcdInt64;
}

/** A byte interval. No `rangeEnd` is the one key; `rangeEnd` of one 0x00 byte runs to the end. */
export interface EtcdByteRange {
  readonly key: EtcdBytes;
  readonly rangeEnd?: EtcdBytes;
}

export interface EtcdRangeRequest extends EtcdByteRange {
  /** Always positive (spec E14). */
  readonly limit: number;
  /** Absent reads the latest revision. */
  readonly revision?: EtcdInt64;
  readonly keysOnly?: boolean;
  readonly countOnly?: boolean;
  readonly serializable?: boolean;
}

export interface EtcdRangeResponse {
  readonly header: EtcdResponseHeader;
  readonly kvs: readonly EtcdKeyValue[];
  readonly more: boolean;
  readonly count: EtcdInt64;
}

export interface EtcdPutRequest {
  readonly key: EtcdBytes;
  readonly value: EtcdBytes;
  readonly lease?: EtcdInt64;
  readonly prevKv?: boolean;
  readonly ignoreValue?: boolean;
  readonly ignoreLease?: boolean;
}

export interface EtcdPutResponse {
  readonly header: EtcdResponseHeader;
  readonly prevKv?: EtcdKeyValue;
}

export interface EtcdDeleteRangeRequest extends EtcdByteRange {
  readonly prevKv?: boolean;
}

export interface EtcdDeleteRangeResponse {
  readonly header: EtcdResponseHeader;
  readonly deleted: EtcdInt64;
  readonly prevKvs: readonly EtcdKeyValue[];
}

export type EtcdCompareTarget = "version" | "create" | "mod" | "value" | "lease";
export type EtcdCompareResult = "equal" | "greater" | "less" | "not-equal";

export interface EtcdCompare extends EtcdByteRange {
  readonly target: EtcdCompareTarget;
  readonly result: EtcdCompareResult;
  /** A decimal string for version, create, mod and lease; bytes for value. */
  readonly operand: EtcdInt64 | EtcdBytes;
}

export type EtcdRequestOp =
  | { readonly op: "range"; readonly request: EtcdRangeRequest }
  | { readonly op: "put"; readonly request: EtcdPutRequest }
  | { readonly op: "delete"; readonly request: EtcdDeleteRangeRequest };

export type EtcdResponseOp =
  | { readonly op: "range"; readonly response: EtcdRangeResponse }
  | { readonly op: "put"; readonly response: EtcdPutResponse }
  | { readonly op: "delete"; readonly response: EtcdDeleteRangeResponse };

export interface EtcdTxnRequest {
  readonly compare: readonly EtcdCompare[];
  readonly success: readonly EtcdRequestOp[];
  readonly failure: readonly EtcdRequestOp[];
}

export interface EtcdTxnResponse {
  readonly header: EtcdResponseHeader;
  readonly succeeded: boolean;
  readonly responses: readonly EtcdResponseOp[];
}

export interface EtcdWatchRequest extends EtcdByteRange {
  readonly startRevision?: EtcdInt64;
  readonly prevKv?: boolean;
}

export interface EtcdWatchEvent {
  readonly type: "put" | "delete";
  readonly kv: EtcdKeyValue;
  readonly prevKv?: EtcdKeyValue;
}

/**
 * The events of one watch response, or of one fragment of a large one: the adapter hands each on as it arrives, so
 * the watch's row limit and byte budget apply inside one response (spec 5.3, E14).
 */
export interface EtcdWatchBatch {
  readonly header: EtcdResponseHeader;
  readonly events: readonly EtcdWatchEvent[];
}

/**
 * How a watch ended. `canceled` carries the server's `cancel_reason` exactly as it arrived, which is
 * either a bare etcd message or grpc-go's "rpc error: code = <Code> desc = <message>" form (SRC
 * `etcd__server_etcdserver_api_v3rpc_watch.go` near 270-310); `errors.ts` reads both.
 */
export type EtcdWatchEnd =
  | { readonly reason: "stopped" }
  | { readonly reason: "aborted" }
  | { readonly reason: "compacted"; readonly compactRevision: EtcdInt64 }
  | { readonly reason: "canceled"; readonly cancelReason: string };

export interface EtcdLeaseGrantResponse {
  readonly header: EtcdResponseHeader;
  readonly id: EtcdInt64;
  readonly ttl: EtcdInt64;
}
export interface EtcdLeaseTimeToLiveResponse {
  readonly header: EtcdResponseHeader;
  readonly id: EtcdInt64;
  /** "-1" for an expired or unknown lease, as etcd answers it. */
  readonly ttl: EtcdInt64;
  readonly grantedTtl: EtcdInt64;
  readonly keys: readonly EtcdBytes[];
}
export interface EtcdLeaseKeepAliveResponse {
  readonly id: EtcdInt64;
  /** "0" for an expired or unknown lease, as etcd answers it. */
  readonly ttl: EtcdInt64;
}

/** `linearizable: false` is the serializable read the tree uses; the editor's `member list` defaults to true (spec 4.3, 5.1.3). */
export interface EtcdMemberListRequest {
  readonly linearizable: boolean;
}

export interface EtcdMember {
  readonly id: EtcdInt64;
  readonly name: string;
  readonly peerUrls: readonly string[];
  readonly clientUrls: readonly string[];
  readonly isLearner: boolean;
}

export interface EtcdStatus {
  readonly header: EtcdResponseHeader;
  readonly version: string;
  readonly dbSize: EtcdInt64;
  readonly dbSizeInUse: EtcdInt64;
  /**
   * The server's answer as it came: from 3.6.6 the quota the member runs under, and on 3.6.0 to 3.6.5
   * the flag's own value, 0 for the 2 GiB default; on either a negative value is a disabled quota, and
   * a server before 3.6 sends none, read as "0" (spec 7.1, measured 2026-10-01).
   */
  readonly dbSizeQuota: EtcdInt64;
  readonly leader: EtcdInt64;
  readonly raftIndex: EtcdInt64;
  readonly raftTerm: EtcdInt64;
  readonly raftAppliedIndex: EtcdInt64;
  readonly errors: readonly string[];
  readonly isLearner: boolean;
  readonly storageVersion: string;
}

/** The raised alarm types of the vendored v3.7.2 proto; `NONE` is never raised (spec 7.2). */
export type EtcdAlarmType = "nospace" | "corrupt";
export interface EtcdAlarm {
  readonly memberId: EtcdInt64;
  readonly alarm: EtcdAlarmType;
}

export type EtcdPermissionType = "read" | "write" | "readwrite";
export interface EtcdPermission extends EtcdByteRange {
  readonly type: EtcdPermissionType;
}

export interface EtcdAuthStatus {
  readonly enabled: boolean;
  readonly authRevision: EtcdInt64;
}

/** Every call takes its own signal; the adapter adds the deadline, the token and `hasleader`. */
export interface EtcdCallOptions {
  readonly signal: AbortSignal;
}

/**
 * The allowlist of spec E11, plus `close()` for E16, and nothing else. No bare put is on it: a top-level
 * put is E8's guarded `txn`, the value edit is a `txn`, and a put in a `txn` body is a request inside it.
 */
export interface EtcdClient {
  range(request: EtcdRangeRequest, options: EtcdCallOptions): Promise<EtcdRangeResponse>;
  deleteRange(request: EtcdDeleteRangeRequest, options: EtcdCallOptions): Promise<EtcdDeleteRangeResponse>;
  txn(request: EtcdTxnRequest, options: EtcdCallOptions): Promise<EtcdTxnResponse>;
  /**
   * Opens one watch, calls `onBatch` for every response and every fragment that carries events, in
   * order, and settles when `onBatch` answers "stop", the signal aborts, or the server cancels; a
   * signal that aborts while the token is renewed after the server cancelled the watch in band
   * (spec E4) settles with that cancellation, since no watch was created again. It always ends the
   * stream with `call.cancel()` before it settles (spec 5.3).
   */
  watch(
    request: EtcdWatchRequest,
    onBatch: (batch: EtcdWatchBatch) => "continue" | "stop",
    options: EtcdCallOptions,
  ): Promise<EtcdWatchEnd>;
  leaseGrant(ttlSeconds: number, options: EtcdCallOptions): Promise<EtcdLeaseGrantResponse>;
  leaseRevoke(id: EtcdInt64, options: EtcdCallOptions): Promise<{ readonly header: EtcdResponseHeader }>;
  leaseKeepAliveOnce(id: EtcdInt64, options: EtcdCallOptions): Promise<EtcdLeaseKeepAliveResponse>;
  leaseTimeToLive(id: EtcdInt64, keys: boolean, options: EtcdCallOptions): Promise<EtcdLeaseTimeToLiveResponse>;
  leaseLeases(
    options: EtcdCallOptions,
  ): Promise<{ readonly header: EtcdResponseHeader; readonly ids: readonly EtcdInt64[] }>;
  memberList(
    request: EtcdMemberListRequest,
    options: EtcdCallOptions,
  ): Promise<{ readonly header: EtcdResponseHeader; readonly members: readonly EtcdMember[] }>;
  status(options: EtcdCallOptions): Promise<EtcdStatus>;
  alarmList(options: EtcdCallOptions): Promise<readonly EtcdAlarm[]>;
  /** DEACTIVATE one alarm by its exact member id and type from an `alarmList` answer (spec 7.2). */
  alarmDisarm(alarm: EtcdAlarm, options: EtcdCallOptions): Promise<readonly EtcdAlarm[]>;
  /** Sent with `physical: true` (spec 7.2). */
  compact(revision: EtcdInt64, options: EtcdCallOptions): Promise<void>;
  defragment(options: EtcdCallOptions): Promise<void>;
  authStatus(options: EtcdCallOptions): Promise<EtcdAuthStatus>;
  /**
   * Signs in with the credentials the client was built with and keeps the token in the client's
   * memory: it is never returned, logged or placed in an error (spec E2). The step of the connect
   * sequence (spec 6.1); renewal after the three answers of spec E4 is the adapter's own business.
   */
  authenticate(options: EtcdCallOptions): Promise<void>;
  userList(options: EtcdCallOptions): Promise<readonly string[]>;
  /** The user's role names. */
  userGet(name: string, options: EtcdCallOptions): Promise<readonly string[]>;
  roleList(options: EtcdCallOptions): Promise<readonly string[]>;
  roleGet(name: string, options: EtcdCallOptions): Promise<readonly EtcdPermission[]>;
  /** Closes the channel; later calls reject with the `closed` category. */
  close(): Promise<void>;
}

/** Every method of `EtcdClient`, in the order spec E11 lists them; the compiler holds it complete. */
export const ETCD_CLIENT_METHODS = [
  "range",
  "deleteRange",
  "txn",
  "watch",
  "leaseGrant",
  "leaseRevoke",
  "leaseKeepAliveOnce",
  "leaseTimeToLive",
  "leaseLeases",
  "memberList",
  "status",
  "alarmList",
  "alarmDisarm",
  "compact",
  "defragment",
  "authStatus",
  "authenticate",
  "userList",
  "userGet",
  "roleList",
  "roleGet",
  "close",
] as const satisfies readonly (keyof EtcdClient)[];

/** Fails to compile when `EtcdClient` gains a method the list above does not name. */
type UnlistedMethod = Exclude<keyof EtcdClient, (typeof ETCD_CLIENT_METHODS)[number]>;
const everyMethodListed: [UnlistedMethod] extends [never] ? true : UnlistedMethod = true;
void everyMethodListed;

export type EtcdErrorCategory =
  | "not-connected" // the request never left the client: no connection established, a refused socket, a deadline before the pick
  | "unavailable" // the request may have left: leader changed, stopped, etcd's timeouts, a dropped or reset connection
  | "no-leader" // "etcdserver: no leader" (hasleader), a lost quorum; nothing was applied
  | "tls" // handshake or verification failure, a missing or refused client certificate
  | "unauthenticated" // the three renewal answers of spec E4, raised after the one renewal
  | "auth-failed" // wrong password or unknown user
  | "permission-denied"
  | "compacted"
  | "future-revision"
  | "request-too-large" // etcd's "request is too large", or the server's own receive cap
  | "too-many-ops"
  | "duplicate-key"
  | "too-many-requests"
  | "no-space" // database space exceeded
  | "resource-exhausted" // an answer past this client's receive cap
  | "lease-not-found"
  | "invalid-argument"
  | "failed-precondition"
  | "deadline-exceeded"
  | "cancelled" // the call's own signal aborted it (cancelQuery), decided by toEtcdError alone
  | "cancelled-elsewhere" // a CANCELLED the call's own signal did not cause: etcd's, or the runtime's
  | "closed"
  | "unknown";

/** Which part of a TLS connection failed, when the runtime said so (spec E5, 5.6). Only on the `tls` category. */
export type EtcdTlsFailure =
  | "chain" // the server's certificate is not signed by a trusted CA
  | "name" // the server's certificate does not name the identity checked
  | "not-tls" // the port answered, but not with TLS
  | "client-certificate-required" // the server asked for a client certificate and got none
  | "client-certificate-refused"; // the server refused the client certificate it got

export class EtcdError extends Error {
  // Declared, never defined as fields, so an absent code or TLS failure is an absent property
  // under every class-field semantics (Bun defines declared fields as undefined otherwise).
  declare readonly category: EtcdErrorCategory;
  /** The gRPC status code, when the server or the client library gave one. */
  declare readonly grpcCode?: number;
  /** etcd's own text, or the runtime's text or error code for a TLS or socket failure. */
  declare readonly detail: string;
  declare readonly tlsFailure?: EtcdTlsFailure;
  constructor(category: EtcdErrorCategory, detail: string, grpcCode?: number, tlsFailure?: EtcdTlsFailure) {
    if (tlsFailure !== undefined && category !== "tls") {
      throw new TypeError(`An EtcdError of category ${category} cannot carry a TLS failure`);
    }
    super(detail);
    this.name = "EtcdError";
    this.category = category;
    this.detail = detail;
    if (grpcCode !== undefined) this.grpcCode = grpcCode;
    if (tlsFailure !== undefined) this.tlsFailure = tlsFailure;
  }
}

/** What the provider asks the adapter to tell it (R13 D10). */
export interface EtcdClientHooks {
  /**
   * Called once after a renewal that met "etcdserver: revision of auth store is old" (spec E4, 4.7):
   * the grants may have changed with the auth store, so the provider reads them again before its next
   * permission-aware walk.
   */
  readonly onAuthStoreChanged?: () => void;
}

/**
 * Builds the one client of a provider instance; injected, so tests pass a fake (spec 3.5). The
 * provider instantiates it with `EtcdConnectionOptions` from `connection-options.ts` (plan C4),
 * which this file does not import, so the seam stays the bottom of the provider's module graph.
 */
export type EtcdClientFactory<TOptions> = (options: TOptions, hooks?: EtcdClientHooks) => Promise<EtcdClient>;
