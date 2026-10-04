/**
 * The Oxia provider's one error table (SB1-6), in two halves, and the sentences other modules quote.
 *
 * `toOxiaError` is the adapter's half: a grpc-js status, a runtime error or the call's own abort to an `OxiaError`,
 * decided by the gRPC code, the RPC that failed and grpc-js's own local prefixes. `toProviderError` is the provider's
 * half: an `OxiaError` to the repository's error classes, with a sentence that carries no server text, no grpc-js
 * message, no token and no address but a validated `host:port` (SB1-6.2). The server's `details` is read only to
 * classify: for UNAUTHENTICATED against a closed prefix list, and for grpc-js's local texts; it is never shown.
 *
 * The local text tables are copies of the Milvus provider's (src/lib/db/providers/vector/milvus/errors.ts), made under
 * the isolation rule.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import type { OxiaInt64, OxiaRpc } from "./client";
import {
  OXIA_ADMIN_PORT,
  OXIA_DEFAULT_PORT,
  OXIA_LEADER_MAX_BYTES,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_RUN_BYTE_BUDGET,
  OXIA_TYPE,
} from "./constants";
import { SNAPSHOT_PROBLEM_REASONS, type SnapshotProblem } from "./routing";

export type OxiaErrorCategory =
  | "not-connected"
  | "dns"
  | "refused"
  | "tls"
  | "unauthenticated"
  | "permission-denied"
  | "unimplemented"
  | "namespace-not-found"
  | "not-initialized"
  | "leader-changing"
  | "not-leader"
  | "shard-not-found"
  | "server-cancelled"
  | "server-state"
  | "invalid-argument"
  | "deadline-exceeded"
  | "cancelled"
  | "receive-cap"
  | "connection-dropped"
  | "unavailable"
  | "closed"
  | "silent-assignments"
  | "snapshot-invalid"
  | "leader-refused"
  | "malformed"
  | "record-changed"
  | "unknown";

export type OxiaUnauthenticatedCause =
  | "empty-token"
  | "malformed-token"
  | "unknown-issuer"
  | "forbidden-audience"
  | "bad-signature"
  | "expired"
  | "no-username"
  | "other";

export type OxiaTlsFailure =
  | "chain"
  | "name"
  | "not-tls"
  | "client-certificate-required"
  | "client-certificate-refused"
  | "client-certificate-expired";

/** SnapshotProblem plus the receive-cap reason of SB1-9.3 ("the shard map is larger than 16 MiB"). */
export type OxiaSnapshotProblem = SnapshotProblem | "too-large";

export interface OxiaErrorFields {
  readonly grpcCode?: number;
  readonly unsent?: true;
  readonly tlsFailure?: OxiaTlsFailure;
  readonly authCause?: OxiaUnauthenticatedCause;
  /** Read only: how many gets were answered before a receive-cap failure (C13). */
  readonly answered?: number;
  readonly shardId?: OxiaInt64;
  /** The admitted parsed address the adapter called, for the not-leader sentence. */
  readonly leader?: string;
  /** The RPC that failed; decides the receive-cap and NotFound rows. */
  readonly rpc?: OxiaRpc;
  readonly snapshotProblem?: OxiaSnapshotProblem;
  /** Already-worded policy refusal (SB1-5.4). */
  readonly sentence?: string;
}

/** Every member of OxiaErrorFields: a record, so a member added to the interface fails the typecheck here. */
const FIELD_NAMES: Readonly<Record<keyof OxiaErrorFields, true>> = {
  grpcCode: true,
  unsent: true,
  tlsFailure: true,
  authCause: true,
  answered: true,
  shardId: true,
  leader: true,
  rpc: true,
  snapshotProblem: true,
  sentence: true,
};

/**
 * A classified failure of the Oxia client. Its message names the category and nothing the server or grpc-js wrote.
 * Each field is copied as an own property only when defined, so `new OxiaError(e.category, { ...e, answered })`
 * re-wraps an error with one more field and ignores the spread's `category`, `name` and `message`.
 */
export class OxiaError extends Error implements OxiaErrorFields {
  readonly category: OxiaErrorCategory;
  declare readonly grpcCode?: number;
  declare readonly unsent?: true;
  declare readonly tlsFailure?: OxiaTlsFailure;
  declare readonly authCause?: OxiaUnauthenticatedCause;
  declare readonly answered?: number;
  declare readonly shardId?: OxiaInt64;
  declare readonly leader?: string;
  declare readonly rpc?: OxiaRpc;
  declare readonly snapshotProblem?: OxiaSnapshotProblem;
  declare readonly sentence?: string;

  constructor(category: OxiaErrorCategory, fields?: OxiaErrorFields) {
    super(`The Oxia client failed (${category})`);
    this.name = "OxiaError";
    this.category = category;
    const own = this as Record<string, unknown>;
    for (const name of Object.keys(FIELD_NAMES) as (keyof OxiaErrorFields)[]) {
      const value = fields?.[name];
      if (value !== undefined) own[name] = value;
    }
  }
}

/**
 * grpc-js's failure of a call that its own signal ended before grpc-js gave it a transport, so its request never
 * left; the transport raises this in place of grpc-js's "Cancelled on client" (src/lib/db/grpc/channel.ts).
 */
export class OxiaUnsentStatus extends Error {
  declare readonly code: number;
  declare readonly details: string;
  constructor(status: { readonly code: number; readonly details: string; readonly message: string }) {
    super(status.message);
    this.name = "OxiaUnsentStatus";
    this.code = status.code;
    this.details = status.details;
  }
}

// -- the adapter's half ----------------------------------------------------------------------------------------------

// gRPC status codes (grpc/grpc `doc/statuscodes.md`), the numbers grpc-js reports.
const CANCELLED = 1;
const INVALID_ARGUMENT = 3;
const DEADLINE_EXCEEDED = 4;
const NOT_FOUND = 5;
const PERMISSION_DENIED = 7;
const RESOURCE_EXHAUSTED = 8;
const FAILED_PRECONDITION = 9;
const ABORTED = 10;
const UNIMPLEMENTED = 12;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

// Oxia 0.16's own status codes (`proto/client.proto` status values sent as gRPC codes).
const NOT_INITIALIZED = 100;
const INVALID_TERM = 101;
const INVALID_STATUS = 102;
const CANCELLED_BY_SERVER = 103;
const ALREADY_CLOSED = 104;
const NODE_IS_NOT_LEADER = 106;
const NAMESPACE_NOT_FOUND = 110;
const NODE_IS_NOT_MEMBER = 112;
/** The 0.16 codes a read does not expect: a session, a notification or a write state. */
const STATE_ERRORS: ReadonlySet<number> = new Set([105, 107, 108, 109, 111]);
/** The codes that say a shard's leadership is moving, on 0.16 and on 0.17. */
const LEADER_CHANGING: ReadonlySet<number> = new Set([
  INVALID_TERM,
  INVALID_STATUS,
  ALREADY_CLOSED,
  NODE_IS_NOT_MEMBER,
  FAILED_PRECONDITION,
  ABORTED,
]);
const SHARD_RPCS: ReadonlySet<OxiaRpc> = new Set<OxiaRpc>(["Read", "List", "RangeScan"]);

/** grpc-js 1.14.5's deadline texts for a call that never had a stream; only these say the request never left. */
const PRE_SEND_DEADLINE_MARKERS: readonly string[] = [
  "waiting for name resolution",
  "waiting for metadata filters",
  "Waiting for LB pick",
];
/** The two receive-cap texts, on the wire and inflated. */
const RECEIVE_CAP_TEXTS: readonly string[] = ["Received message larger than max", "decompresses to a size larger than"];
/** A too_many_pings GOAWAY that dropped the connection; never the receive cap. */
const PING_GOAWAY = "Bandwidth exhausted or memory limit exceeded";
/** What the keepalive raises for a silently dropped connection. */
const CONNECTION_DROPPED = "Connection dropped";
const CHANNEL_CLOSED = "Channel closed before call started";
const NAME_RESOLUTION_FAILED = "Name resolution failed";
const NO_CONNECTION = "No connection established";

/** TLS causes inside "No connection established. Last error: ...", in Node's and Bun's texts; the first match decides. */
const TLS_CAUSES: ReadonlyArray<readonly [RegExp, OxiaTlsFailure | undefined]> = [
  [/alert certificate expired/, "client-certificate-expired"],
  [/alert certificate required/, "client-certificate-required"],
  [/alert (?:unknown ca|bad certificate)/, "client-certificate-refused"],
  [/does not match certificate's altnames/, "name"],
  [/unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate/, "chain"],
  [/wrong version number|WRONG_VERSION_NUMBER|packet length too long/, "not-tls"],
  [/certificate has expired|Setting the TLS ServerName to an IP address is not permitted/, undefined],
];

/** Node's codes for a socket or TLS failure raised outside a gRPC status. */
const SYSTEM_ERRORS: ReadonlyMap<string, readonly [OxiaErrorCategory, OxiaTlsFailure?]> = new Map<
  string,
  readonly [OxiaErrorCategory, OxiaTlsFailure?]
>([
  ["ECONNREFUSED", ["refused"]],
  ["ENOTFOUND", ["dns"]],
  ["EAI_AGAIN", ["dns"]],
  ["EHOSTUNREACH", ["not-connected"]],
  ["ENETUNREACH", ["not-connected"]],
  ["ETIMEDOUT", ["not-connected"]],
  ["ECONNRESET", ["unavailable"]],
  ["EPIPE", ["unavailable"]],
  ["ERR_TLS_CERT_ALTNAME_INVALID", ["tls", "name"]],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", ["tls", "chain"]],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", ["tls", "chain"]],
  ["SELF_SIGNED_CERT_IN_CHAIN", ["tls", "chain"]],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", ["tls", "chain"]],
  ["CERT_HAS_EXPIRED", ["tls"]],
  ["ERR_SSL_WRONG_VERSION_NUMBER", ["tls", "not-tls"]],
]);

/** SB1-6.4: the closed prefix list of UNAUTHENTICATED's `details`, matched with `startsWith`; no match is `other`. */
const UNAUTHENTICATED_PREFIXES: ReadonlyArray<readonly [string, OxiaUnauthenticatedCause]> = [
  ["empty token", "empty-token"],
  ["malformed token", "malformed-token"],
  ["unknown issuer", "unknown-issuer"],
  ["forbidden audience", "forbidden-audience"],
  ["failed to verify signature", "bad-signature"],
  ["oidc: token is expired", "expired"],
  ["username not found", "no-username"],
];

interface GrpcStatus {
  readonly code: number;
  readonly details: string;
}

/** The shard the adapter called: its id and the admitted address. */
interface CalledShard {
  readonly id: OxiaInt64;
  readonly leader: string;
}

/** The facts one classification reads besides the status. */
interface Classifying {
  readonly rpc: OxiaRpc;
  readonly shard?: CalledShard;
}

function isGrpcStatus(error: unknown): error is GrpcStatus {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; details?: unknown };
  return typeof candidate.code === "number" && typeof candidate.details === "string";
}

/**
 * grpc-js's ServiceError for a compressed answer flagged under the identity encoding: `code` and `details` are present
 * and neither a number nor a string, where a runtime error's code is a string.
 */
function isServiceErrorWithoutCode(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || !("details" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code !== "number" && typeof code !== "string";
}

/** An answer of a shard category: the shard and its leader travel with it when the adapter gave them. */
function onShard(category: OxiaErrorCategory, fields: OxiaErrorFields, facts: Classifying): OxiaError {
  const shard = facts.shard === undefined ? {} : { shardId: facts.shard.id, leader: facts.shard.leader };
  return new OxiaError(category, { ...fields, ...shard });
}

function unavailableCategory(details: string): readonly [OxiaErrorCategory, OxiaTlsFailure?] {
  if (details.startsWith(CONNECTION_DROPPED)) return ["connection-dropped"];
  if (details.startsWith(CHANNEL_CLOSED)) return ["closed"];
  if (details.startsWith(NAME_RESOLUTION_FAILED)) return ["dns"];
  // Any other 14 is the server's own: NOT_INITIALIZED or RESOURCE_UNAVAILABLE on 0.17.
  if (!details.includes(NO_CONNECTION)) return ["not-initialized"];
  const cause = TLS_CAUSES.find(([pattern]) => pattern.test(details));
  if (cause !== undefined) return cause[1] === undefined ? ["tls"] : ["tls", cause[1]];
  if (details.includes("ECONNREFUSED")) return ["refused"];
  if (details.includes("ENOTFOUND") || details.includes("EAI_AGAIN")) return ["dns"];
  return ["not-connected"];
}

function authCause(details: string): OxiaUnauthenticatedCause {
  return UNAUTHENTICATED_PREFIXES.find(([prefix]) => details.startsWith(prefix))?.[1] ?? "other";
}

/** SB1-6.3, keyed by the code and the RPC. */
function classifyStatus({ code, details }: GrpcStatus, facts: Classifying): OxiaError {
  const fields = { grpcCode: code, rpc: facts.rpc };
  const sharded = facts.shard !== undefined;
  if (code === NOT_INITIALIZED) return new OxiaError("not-initialized", fields);
  if (LEADER_CHANGING.has(code)) {
    return sharded ? onShard("leader-changing", fields, facts) : new OxiaError("unknown", fields);
  }
  if (code === NODE_IS_NOT_LEADER) {
    return sharded ? onShard("not-leader", fields, facts) : new OxiaError("unknown", fields);
  }
  if (code === CANCELLED_BY_SERVER || code === CANCELLED) return new OxiaError("server-cancelled", fields);
  if (STATE_ERRORS.has(code)) return new OxiaError("server-state", fields);
  if (code === NAMESPACE_NOT_FOUND) return new OxiaError("namespace-not-found", fields);
  switch (code) {
    case NOT_FOUND:
      if (facts.rpc === "GetShardAssignments") return new OxiaError("namespace-not-found", fields);
      if (SHARD_RPCS.has(facts.rpc) && sharded) return onShard("shard-not-found", fields, facts);
      return new OxiaError("unknown", fields);
    case INVALID_ARGUMENT:
      return new OxiaError("invalid-argument", fields);
    case PERMISSION_DENIED:
      return new OxiaError("permission-denied", fields);
    case UNIMPLEMENTED:
      return new OxiaError("unimplemented", fields);
    case UNAUTHENTICATED:
      return new OxiaError("unauthenticated", { ...fields, authCause: authCause(details) });
    case DEADLINE_EXCEEDED: {
      const preSend =
        !details.includes("remote_addr=") && PRE_SEND_DEADLINE_MARKERS.some((marker) => details.includes(marker));
      if (preSend) return new OxiaError("not-connected", fields);
      if (facts.rpc === "GetShardAssignments") return new OxiaError("silent-assignments", fields);
      return onShard("deadline-exceeded", fields, facts);
    }
    case RESOURCE_EXHAUSTED:
      if (RECEIVE_CAP_TEXTS.some((text) => details.includes(text))) return new OxiaError("receive-cap", fields);
      return new OxiaError(details === PING_GOAWAY ? "connection-dropped" : "unknown", fields);
    case UNAVAILABLE: {
      const [category, tlsFailure] = unavailableCategory(details);
      return new OxiaError(category, tlsFailure === undefined ? fields : { ...fields, tlsFailure });
    }
    default:
      return new OxiaError("unknown", fields);
  }
}

/**
 * The adapter's half. `shard` is given on every Read, List and RangeScan call; the shard categories are produced only
 * when it is given. An aborted `signal` answers `cancelled`: since the deadline travels apart from the signal, that is
 * only ever the user's cancel or the session's end.
 */
export function toOxiaError(
  error: unknown,
  rpc: OxiaRpc,
  signal?: AbortSignal,
  shard?: { readonly id: OxiaInt64; readonly leader: string },
): OxiaError {
  if (error instanceof OxiaError) return error;
  if (signal?.aborted === true && ((isGrpcStatus(error) && error.code === CANCELLED) || error === signal.reason)) {
    // The signal's own reason is thrown before the request is handed to the channel, so it, too, never left.
    const unsent = error instanceof OxiaUnsentStatus || error === signal.reason;
    return new OxiaError("cancelled", {
      rpc,
      ...(isGrpcStatus(error) ? { grpcCode: error.code } : {}),
      ...(unsent ? { unsent: true as const } : {}),
    });
  }
  if (isGrpcStatus(error)) return classifyStatus(error, { rpc, ...(shard === undefined ? {} : { shard }) });
  if (isServiceErrorWithoutCode(error)) return new OxiaError("unknown", { rpc });
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
    const known = SYSTEM_ERRORS.get((error as Error & { code: string }).code);
    if (known === undefined) return new OxiaError("unknown", { rpc });
    return new OxiaError(known[0], known[1] === undefined ? { rpc } : { rpc, tlsFailure: known[1] });
  }
  return new OxiaError("unknown", { rpc });
}

// -- the provider's half ---------------------------------------------------------------------------------------------

export interface OxiaErrorConnection {
  readonly host: string;
  readonly port: number;
  readonly sentAuthority: string;
  readonly loopback: boolean;
  readonly tunnelled: boolean;
  /** `ca`: a CA is pasted under SSL / TLS; without one the chain is checked against this machine's trust store. */
  readonly tls?: { readonly serverName: string; readonly clientCertificate: boolean; readonly ca: boolean };
  readonly runtimeReportsTlsCause: boolean;
  readonly receiveCapBytes: number;
  readonly timeoutMs: number;
  readonly namespace: string;
  /** The token's own `exp` claim as ISO 8601, read locally from the configured token. */
  readonly tokenExpiry?: string;
  /** The connection lists Data servers, so a TLS name failure may be a data server's (SB1-6.6's cluster clause). */
  readonly listsDataServers: boolean;
}

export interface OxiaErrorContext {
  readonly operation: string;
  readonly connection: OxiaErrorConnection;
}

/** A byte count as the sentences write it: a whole number of MiB. */
function mebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

/** SB1-9.2. */
export const OXIA_STALLED_PAGE_SENTENCE =
  "A shard's keys are too large for one page of the Keys panel: narrow the walk with a prefix.";
/** SB1-9.3. */
export const OXIA_LIST_RECEIVE_CAP_SENTENCE = `The server sent a list message larger than the ${mebibytes(OXIA_RECEIVE_CAP_BYTES)} receive cap: narrow the walk with a prefix.`;
/** SB1-9.5. */
export const OXIA_HEALTH_NO_SHARD_MAP = "The server answers health but serves no shard map";
/** SB1-4.9, the adapter's half of C10. */
export const OXIA_ADAPTER_INTERNAL_KEY_SENTENCE =
  "Keys under __oxia/ are Oxia's own internal records, which Studio does not read.";
/** SB1-4.9. */
export const OXIA_LONE_SURROGATE_SENTENCE =
  "The key holds a lone UTF-16 surrogate, which is not text and names no Oxia key: type it again.";
/** SB1-4.9. */
export const OXIA_INDEX_NAME_SENTENCE = `An index name is one word without "/", at most ${OXIA_LEADER_MAX_BYTES} bytes.`;

/** SB1-9.3a: the run-budget stop of a console run; `rows` is the number of rows the result holds. */
export function runBudgetNotice(verb: "range-scan" | "list", rows: number): string {
  const budget = mebibytes(OXIA_RUN_BYTE_BUDGET);
  return verb === "range-scan"
    ? `The result stopped after ${rows} records, at the ${budget} of keys and values a console result holds: narrow the range, or list the keys and get the values one by one.`
    : `The result stopped after ${rows} keys, at the ${budget} of keys a console result holds: narrow the range.`;
}

/** SB1-9.3a: the receive-cap stop of a range-scan. */
export function receiveCapNotice(rows: number): string {
  return `A record in this range is larger than the ${mebibytes(OXIA_RECEIVE_CAP_BYTES)} receive cap, so range-scan stopped after ${rows} records: list the keys with list, then read each with get, which shows such a value's version and withholds the value.`;
}

/** SB1-6.3, SB1-7.6. */
export function recordChangedSentence(operation: string): string {
  return `The record this ${operation} selected changed while this command ran: run it again.`;
}

/** SB1-6.6: the silent-assignments sentence; `seconds` is the deadline in whole seconds. */
export function silentAssignmentsSentence(seconds: number): string {
  return `The server accepted the connection but its shard map did not arrive within ${seconds} s, so nothing was read. A data server that has not yet received its shard assignments from the coordinator answers this way: check the coordinator, then try again.`;
}

/** Ruling R4: the one rounding rule of every sentence that states a deadline in seconds, the honest upper bound. */
export function deadlineSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** SB1-6.5. */
export function namespaceNotFoundSentence(namespace: string): string {
  return `No namespace ${namespace} on this server (names are case sensitive). Namespace is set on the connection; empty means default, the only namespace of oxia standalone. A cluster's namespaces are in its coordinator configuration.`;
}

/** SB1-5.2, with the no-shards addition; `too-large` is SB1-9.3's receive cap on the shard map. */
export function snapshotInvalidSentence(problem: OxiaSnapshotProblem): string {
  const reason =
    problem === "too-large"
      ? `the shard map is larger than ${mebibytes(OXIA_RECEIVE_CAP_BYTES)}`
      : SNAPSHOT_PROBLEM_REASONS[problem];
  const sentence = `The server's shard map is not one Studio can route by (${reason}), so nothing was read.`;
  return problem === "no-shards" ? `${sentence} The namespace may still be starting: try again shortly.` : sentence;
}

const NOT_INITIALIZED_SENTENCE =
  "Oxia is not ready to serve this namespace yet: its data server has no shard assignments from the coordinator. Try again shortly.";
const CONTAINER_LOOPBACK =
  " If Studio runs in a container, localhost is the container itself: use the address of the machine Oxia runs on (with Docker Desktop, host.docker.internal).";
const CLUSTER_NAME_CLAUSE = " A cluster's certificate must also name every data server's advertised host.";

/** SB1-6.4's sentence for each cause. */
function unauthenticatedSentence(cause: OxiaUnauthenticatedCause | undefined, connection: OxiaErrorConnection): string {
  switch (cause) {
    case "empty-token":
      return "This Oxia server requires a token: paste one under Token.";
    case "malformed-token":
      return "Oxia could not read the Token as a JWT: paste the whole token under Token.";
    case "unknown-issuer":
      return "Oxia does not trust the issuer of the Token: use a token from an issuer this server is configured for.";
    case "forbidden-audience":
      return "The Token was issued for an audience this Oxia server does not accept: use a token issued for this server.";
    case "bad-signature":
      return "Oxia could not verify the Token's signature: use a token signed by a key this server trusts.";
    case "expired": {
      const at = connection.tokenExpiry === undefined ? "" : ` at ${connection.tokenExpiry}`;
      return `The Token expired${at}: paste a current token under Token.`;
    }
    case "no-username":
      return "Oxia accepted the Token's signature but found no user name in it: use a token that carries the claim this server reads as the user name.";
    default:
      return "Oxia refused the Token.";
  }
}

function notConnectedSentence(connection: OxiaErrorConnection, endpoint: string): string {
  if (connection.tls === undefined) {
    return `No Oxia answered a plaintext connection at ${endpoint}. If this Oxia serves TLS, choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel.`;
  }
  if (connection.runtimeReportsTlsCause) {
    return `No Oxia answered a TLS connection at ${endpoint}: check the host, the port, the SSL mode and the tunnel.`;
  }
  const unreported = `No TLS connection to Oxia at ${endpoint} was established, and this runtime does not report why`;
  return connection.tls.clientCertificate
    ? `${unreported}: check the host, the port, the SSL mode, the client certificate and the tunnel.`
    : `${unreported}. No client certificate is configured: if this Oxia requires one, add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel.`;
}

function tlsSentence(failure: OxiaTlsFailure | undefined, connection: OxiaErrorConnection): string {
  switch (failure) {
    case "chain":
      return connection.tls?.ca === true
        ? "The server's certificate is not signed by the CA under SSL / TLS: paste the CA that issued Oxia's certificate."
        : "The server's certificate is not signed by a CA this machine trusts: paste the CA that issued Oxia's certificate under SSL / TLS.";
    case "name": {
      const name = `The certificate does not name ${connection.tls?.serverName ?? connection.host}: connect by a name or address the certificate carries.`;
      return connection.listsDataServers ? `${name}${CLUSTER_NAME_CLAUSE}` : name;
    }
    case "not-tls":
      return "This port did not answer TLS: set SSL mode to disable, or use Oxia's TLS port.";
    case "client-certificate-required":
      return connection.tls?.clientCertificate === true
        ? "Oxia asked for a client certificate and did not accept the one configured under SSL / TLS."
        : "This Oxia requires a client certificate, and none is configured: add the client certificate and key under SSL / TLS.";
    case "client-certificate-refused":
      return "Oxia refused the client certificate under SSL / TLS: it must be issued for client authentication by the CA Oxia trusts.";
    case "client-certificate-expired":
      return "Oxia refused the client certificate under SSL / TLS because it has expired (client certificate expired): paste a current one.";
    default:
      return "The TLS connection to Oxia failed.";
  }
}

/** The provider's half: one closed table to the repository's error classes (C8). */
export function toProviderError(error: unknown, context: OxiaErrorContext): Error {
  if (error instanceof DatabaseConfigError && error.provider === undefined) {
    return new DatabaseConfigError(error.message, OXIA_TYPE);
  }
  if (!(error instanceof OxiaError)) {
    // A local refusal, or a defect, surfaces as itself and is never dressed up as Oxia's answer.
    if (error instanceof Error) return error;
    return new Error("The Oxia provider received a thrown value that is not an Error.");
  }
  const { operation, connection } = context;
  const { host, port } = connection;
  const endpoint = `${host}:${port}`;
  const connectionError = (message: string) => new ConnectionError(message, OXIA_TYPE, host, port);
  const queryError = (message: string) => new QueryError(message, OXIA_TYPE);
  // toOxiaError sets shardId and leader whenever it produces a shard category (the adapter always gives the shard).
  const shard = error.shardId as OxiaInt64;
  switch (error.category) {
    case "not-initialized":
      return connectionError(NOT_INITIALIZED_SENTENCE);
    case "leader-changing":
      return queryError(
        `Shard ${shard}'s leadership is changing on the server, so the ${operation} stopped: run it again.`,
      );
    case "not-leader":
      return queryError(
        `The data server at ${error.leader as string} is no longer the leader of shard ${shard}, so the ${operation} stopped: run it again, and Studio reads the shard map afresh.`,
      );
    case "server-cancelled":
      return queryError(`The server cancelled the ${operation}: run it again.`);
    case "server-state":
      return queryError(
        `Oxia answered the ${operation} with state error ${error.grpcCode as number}, which a read does not expect.`,
      );
    case "namespace-not-found":
      return new DatabaseConfigError(namespaceNotFoundSentence(connection.namespace), OXIA_TYPE);
    case "shard-not-found":
      return queryError(
        `Shard ${shard} is not on the server any more (the shard map changed, for example by a split): run it again, and Studio reads the shard map afresh.`,
      );
    case "invalid-argument":
      return queryError(`Oxia refused the ${operation}'s request as invalid.`);
    case "permission-denied":
      return connectionError(
        `This Oxia server checks the address clients dial and refused ${connection.sentAuthority}: connect by an address its operator allows.`,
      );
    case "unimplemented":
      return connectionError(
        `The server at ${endpoint} does not serve Oxia's client API: check that Port is the data server's public port (${OXIA_DEFAULT_PORT} by default), not the admin port (${OXIA_ADMIN_PORT}) or the metrics port.`,
      );
    case "not-connected":
      return connectionError(notConnectedSentence(connection, endpoint));
    case "refused": {
      const refused = `Nothing accepted a connection at ${endpoint}: check Host and Port, and that Oxia's public port (${OXIA_DEFAULT_PORT} by default) is published.`;
      return connectionError(connection.loopback ? `${refused}${CONTAINER_LOOPBACK}` : refused);
    }
    case "dns":
      return connectionError(
        `Studio could not resolve ${host}: check Host. If Studio runs in a container, the name must resolve inside that container.`,
      );
    case "tls":
      return connectionError(tlsSentence(error.tlsFailure, connection));
    case "unauthenticated":
      return new AuthenticationError(unauthenticatedSentence(error.authCause, connection), OXIA_TYPE);
    case "deadline-exceeded":
      return new TimeoutError(
        `The ${operation} reached its deadline of ${connection.timeoutMs.toLocaleString("en-US")} ms.`,
        OXIA_TYPE,
        connection.timeoutMs,
      );
    case "cancelled":
      return new QueryCancelledError(
        error.unsent === true
          ? `The ${operation} was cancelled before Studio sent it.`
          : `The ${operation} was cancelled.`,
        OXIA_TYPE,
      );
    case "receive-cap":
      return queryError(
        error.rpc === "List"
          ? OXIA_LIST_RECEIVE_CAP_SENTENCE
          : `The server sent a message larger than the ${mebibytes(OXIA_RECEIVE_CAP_BYTES)} receive cap during the ${operation}.`,
      );
    case "connection-dropped":
    case "unavailable":
      return connectionError(`The connection to Oxia was lost during the ${operation}: run it again.`);
    case "closed":
      return connectionError("This connection to Oxia is closed: connect again.");
    case "silent-assignments":
      return connectionError(silentAssignmentsSentence(deadlineSeconds(connection.timeoutMs)));
    case "snapshot-invalid":
      return queryError(snapshotInvalidSentence(error.snapshotProblem as OxiaSnapshotProblem));
    case "leader-refused":
      return queryError(error.sentence as string);
    case "malformed":
      return queryError(`Oxia's answer to the ${operation} was not in the form Studio reads, so nothing was shown.`);
    case "record-changed":
      return queryError(recordChangedSentence(operation));
    case "unknown":
      if (error.grpcCode === RESOURCE_EXHAUSTED) {
        return queryError(`Oxia refused the ${operation} for lack of resources (gRPC code ${RESOURCE_EXHAUSTED}).`);
      }
      return queryError(
        error.grpcCode === undefined
          ? `The ${operation} failed, and the failure carried no gRPC code.`
          : `The ${operation} failed with gRPC code ${error.grpcCode}.`,
      );
  }
}
