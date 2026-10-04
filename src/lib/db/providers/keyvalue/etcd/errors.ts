/**
 * The one error table of the etcd provider (spec 5.6), in two halves.
 *
 * `toEtcdError` is the adapter's half: a grpc-js status, a runtime socket or TLS error, or the
 * call's own abort, to an `EtcdError` whose category is decided by the gRPC code and etcd's message
 * together (SRC `etcd__api_v3rpc_rpctypes_error.go`, R06 section 5), never by the message alone.
 * `toProviderError` is the provider's half: an `EtcdError` to the repository's error classes, with
 * the provider's words first and etcd's after (spec E16), so each answers the HTTP status and
 * `retryable` that `createErrorResponse` gives its class.
 *
 * The rule that decides most rows is whether a write could have been applied: a failure before
 * the request left the client is a connection failure, an answer on the closed list of spec 4.5
 * was refused before apply, and every other answer to a write carries the sentence that it may
 * have been applied, and is never a `ConnectionError` or a `TimeoutError`, whose 503 and 408 both
 * say `retryable: true`.
 *
 * This file imports only the seam and the repository's error classes (plan Task 11): a token, a
 * password or a key's value never reaches it, and the texts it places in a message are etcd's
 * answer and the runtime's, the runtime's without the address it names (`withoutAddress`).
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/db/types";
import { EtcdError, type EtcdErrorCategory, type EtcdTlsFailure, type EtcdWatchEnd } from "./client";

const PROVIDER: DatabaseType = "etcd";

// gRPC status codes (grpc/grpc `doc/statuscodes.md`), the numbers grpc-js reports.
const CANCELLED = 1;
const UNKNOWN = 2;
const INVALID_ARGUMENT = 3;
const DEADLINE_EXCEEDED = 4;
const NOT_FOUND = 5;
const PERMISSION_DENIED = 7;
const RESOURCE_EXHAUSTED = 8;
const FAILED_PRECONDITION = 9;
const OUT_OF_RANGE = 11;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

/** grpc-go's code names, as a watch `cancel_reason` spells them ("rpc error: code = <Name> desc = ..."). */
const GRPC_CODE_NAMES: ReadonlyMap<string, number> = new Map([
  ["Canceled", CANCELLED],
  ["Unknown", UNKNOWN],
  ["InvalidArgument", INVALID_ARGUMENT],
  ["DeadlineExceeded", DEADLINE_EXCEEDED],
  ["NotFound", NOT_FOUND],
  ["AlreadyExists", 6],
  ["PermissionDenied", PERMISSION_DENIED],
  ["ResourceExhausted", RESOURCE_EXHAUSTED],
  ["FailedPrecondition", FAILED_PRECONDITION],
  ["Aborted", 10],
  ["OutOfRange", OUT_OF_RANGE],
  ["Unimplemented", 12],
  ["Internal", 13],
  ["Unavailable", UNAVAILABLE],
  ["DataLoss", 15],
  ["Unauthenticated", UNAUTHENTICATED],
]);

/** etcd's own answers this table names, each with the one code etcd gives it (`error.go`). */
const ETCD_ANSWERS: ReadonlyArray<readonly [number, string, EtcdErrorCategory]> = [
  [UNAVAILABLE, "etcdserver: no leader", "no-leader"],
  [UNAUTHENTICATED, "etcdserver: invalid auth token", "unauthenticated"],
  [INVALID_ARGUMENT, "etcdserver: user name is empty", "unauthenticated"],
  [INVALID_ARGUMENT, "etcdserver: revision of auth store is old", "unauthenticated"],
  [INVALID_ARGUMENT, "etcdserver: authentication failed, invalid user ID or password", "auth-failed"],
  [PERMISSION_DENIED, "etcdserver: permission denied", "permission-denied"],
  [OUT_OF_RANGE, "etcdserver: mvcc: required revision has been compacted", "compacted"],
  [OUT_OF_RANGE, "etcdserver: mvcc: required revision is a future revision", "future-revision"],
  [INVALID_ARGUMENT, "etcdserver: request is too large", "request-too-large"],
  [INVALID_ARGUMENT, "etcdserver: too many operations in txn request", "too-many-ops"],
  [INVALID_ARGUMENT, "etcdserver: duplicate key given in txn request", "duplicate-key"],
  [RESOURCE_EXHAUSTED, "etcdserver: too many requests", "too-many-requests"],
  [RESOURCE_EXHAUSTED, "etcdserver: mvcc: database space exceeded", "no-space"],
  [NOT_FOUND, "etcdserver: requested lease not found", "lease-not-found"],
];

/**
 * grpc-js 1.14.5's deadline texts for a call that never had a stream to go out on
 * (`resolving-call.ts` and `load-balancing-call.ts` getDeadlineInfo). Only these are evidence
 * that a request was never sent; any other deadline may have met a sent request (spec 5.6).
 */
const PRE_SEND_DEADLINE_MARKERS: readonly string[] = [
  "waiting for name resolution",
  "waiting for metadata filters",
  "Waiting for LB pick",
];

/**
 * grpc-js 1.14.5's UNAVAILABLE texts for a call that never started, by how they begin: its DNS resolver's
 * failure (`resolver-dns.ts` defaultResolutionError), and a call that `close()` found still waiting for its
 * pick (`internal-channel.ts` close), which only the client's own close makes.
 */
const NAME_RESOLUTION_FAILED = "Name resolution failed for target ";
const UNSTARTED_ANSWERS: ReadonlyArray<readonly [string, EtcdErrorCategory]> = [
  [NAME_RESOLUTION_FAILED, "not-connected"],
  ["Channel closed before call started", "closed"],
];

/** Answers named by how they begin, because they carry sizes: [code, prefix, category]. */
const PREFIXED_ANSWERS: ReadonlyArray<readonly [number, string, EtcdErrorCategory]> = [
  // The server's receive cap refused the request before any handler ran (R06 section 8, item 15).
  [RESOURCE_EXHAUSTED, "grpc: received message larger than max", "request-too-large"],
  // This client's receive cap refused the answer (grpc-js `stream-decoder.ts`; R07 M8).
  [RESOURCE_EXHAUSTED, "Received message larger than max", "resource-exhausted"],
  // A user created with no password, which etcd does not map to a gRPC code (R06 section 8, item 2).
  [UNKNOWN, "auth: authentication failed", "auth-failed"],
];

/**
 * TLS causes grpc-js carries inside "No connection established. Last error: ...", in Node's and
 * OpenSSL's texts (R07 M6) and in Bun's and BoringSSL's ("self signed certificate",
 * "WRONG_VERSION_NUMBER", measured in tls-handshake.test.ts). The first match decides; `undefined` is a TLS failure of no named part.
 * "not-tls" is a port that answered with bytes that are not TLS. A socket closed before the handshake
 * ("Client network socket disconnected before secure TLS connection was established") names no cause
 * and stays a failure to connect: etcd's plaintext port closes it on a TLS hello (KE6,
 * etcd/error-tls-to-plaintext), and so does a listener that accepts and closes, such as an SSH
 * tunnel's forward whose far end refused, under Bun and Node alike (measured in Task 13's repair).
 */
const TLS_CAUSES: ReadonlyArray<readonly [RegExp, EtcdTlsFailure | undefined]> = [
  [/alert certificate required/, "client-certificate-required"],
  [/alert (?:unknown ca|bad certificate)/, "client-certificate-refused"],
  [/does not match certificate's altnames/, "name"],
  [/unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate/, "chain"],
  [/wrong version number|WRONG_VERSION_NUMBER|packet length too long/, "not-tls"],
  [/certificate has expired|Setting the TLS ServerName to an IP address is not permitted/, undefined],
];

/** Node's error codes for a socket or TLS failure raised outside a gRPC status. */
const SYSTEM_ERRORS: ReadonlyMap<string, readonly [EtcdErrorCategory, EtcdTlsFailure?]> = new Map<
  string,
  readonly [EtcdErrorCategory, EtcdTlsFailure?]
>([
  ["ECONNREFUSED", ["not-connected"]],
  ["ENOTFOUND", ["not-connected"]],
  ["EHOSTUNREACH", ["not-connected"]],
  ["ENETUNREACH", ["not-connected"]],
  ["EAI_AGAIN", ["not-connected"]],
  ["ECONNRESET", ["unavailable"]],
  ["EPIPE", ["unavailable"]],
  ["ETIMEDOUT", ["unavailable"]],
  ["ERR_TLS_CERT_ALTNAME_INVALID", ["tls", "name"]],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", ["tls", "chain"]],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", ["tls", "chain"]],
  ["SELF_SIGNED_CERT_IN_CHAIN", ["tls", "chain"]],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", ["tls", "chain"]],
  ["CERT_HAS_EXPIRED", ["tls"]],
  ["ERR_SSL_WRONG_VERSION_NUMBER", ["tls", "not-tls"]],
]);

/**
 * A runtime error's system code, in the two forms Node writes one, either after "Error: ": a socket
 * error's `<syscall> <code>`, followed by the address it dialled ("connect ECONNREFUSED 127.0.0.1:2379",
 * "getaddrinfo ENOTFOUND etcd.test"), and a Node error's `<name> [<code>]` ("Error
 * [ERR_TLS_CERT_ALTNAME_INVALID]: ...", followed by the certificate's names).
 */
const RUNTIME_ERROR_CODE = /^(?:\w*Error \[([A-Z][A-Z0-9_]*)\]|(?:Error: )?[a-z]+ (E[A-Z0-9_]+)\b)/;

function runtimeCode(text: string): string | undefined {
  const match = RUNTIME_ERROR_CODE.exec(text);
  return match === null ? undefined : (match[1] ?? match[2]);
}

function classifyStatus(code: number, details: string): EtcdError {
  const answer = ETCD_ANSWERS.find(([answerCode, text]) => answerCode === code && text === details);
  if (answer) return new EtcdError(answer[2], details, code);
  const prefixed = PREFIXED_ANSWERS.find(([answerCode, prefix]) => answerCode === code && details.startsWith(prefix));
  if (prefixed) return new EtcdError(prefixed[2], details, code);
  switch (code) {
    case CANCELLED:
      // The caller's own cancel is decided by its signal, in toEtcdError; this one is not it.
      return new EtcdError("cancelled-elsewhere", details, code);
    case DEADLINE_EXCEEDED: {
      // Pre-send only on positive evidence: a pre-send marker, and no subchannel peer, which
      // grpc-js names once the request has a stream (`subchannel-call.ts` getDeadlineInfo).
      const preSend =
        !details.includes("remote_addr=") && PRE_SEND_DEADLINE_MARKERS.some((marker) => details.includes(marker));
      return new EtcdError(preSend ? "not-connected" : "deadline-exceeded", details, code);
    }
    case UNAVAILABLE: {
      const unstarted = UNSTARTED_ANSWERS.find(([prefix]) => details.startsWith(prefix));
      if (unstarted) return new EtcdError(unstarted[1], details, code);
      if (!details.includes("No connection established")) return new EtcdError("unavailable", details, code);
      const cause = TLS_CAUSES.find(([pattern]) => pattern.test(details));
      return cause ? new EtcdError("tls", details, code, cause[1]) : new EtcdError("not-connected", details, code);
    }
    case PERMISSION_DENIED:
      return new EtcdError("permission-denied", details, code);
    case INVALID_ARGUMENT:
    case OUT_OF_RANGE:
      return new EtcdError("invalid-argument", details, code);
    case FAILED_PRECONDITION:
      return new EtcdError("failed-precondition", details, code);
    default:
      return new EtcdError("unknown", details, code);
  }
}

function isGrpcStatus(error: unknown): error is { readonly code: number; readonly details: string } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; details?: unknown };
  return typeof candidate.code === "number" && typeof candidate.details === "string";
}

/**
 * grpc-js's failure of a call that its own signal ended before grpc-js gave it a transport, so its request never left
 * the client. grpc-js words that cancel "Cancelled on client" whether or not the request had left, so the transport
 * raises this in its place (src/lib/db/grpc/channel.ts `callFailure`), with grpc-js's code, text and message.
 */
export class EtcdUnsentStatus extends Error {
  declare readonly code: number;
  declare readonly details: string;
  constructor(status: { readonly code: number; readonly details: string; readonly message: string }) {
    super(status.message);
    this.name = "EtcdUnsentStatus";
    this.code = status.code;
    this.details = status.details;
  }
}

/**
 * The adapter's half. `signal` is the call's own: grpc-js reports the call's abort by timeout and
 * by `cancelQuery` alike as CANCELLED "Cancelled on client" (R07, `07-MEASUREMENTS-grpc.md` near
 * 1727), so the signal's reason tells them apart. A timeout that ended a call grpc-js never gave a
 * transport (`EtcdUnsentStatus`) is a failure to connect, as grpc-js's pre-send deadline texts are,
 * because the request never left (spec 5.6); a cancel stays the caller's whether it left or not.
 */
export function toEtcdError(error: unknown, signal?: AbortSignal): EtcdError {
  if (error instanceof EtcdError) return error;
  const aborted = signal?.aborted === true;
  if (aborted && ((isGrpcStatus(error) && error.code === CANCELLED) || error === signal.reason)) {
    const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
    const detail = isGrpcStatus(error) ? error.details : (error as Error).message;
    const code = isGrpcStatus(error) ? error.code : undefined;
    if (timedOut && error instanceof EtcdUnsentStatus) return new EtcdError("not-connected", detail, code);
    return new EtcdError(timedOut ? "deadline-exceeded" : "cancelled", detail, code);
  }
  if (isGrpcStatus(error)) return classifyStatus(error.code, error.details);
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as Error & { code: string }).code;
    const known = SYSTEM_ERRORS.get(code);
    // The runtime's code alone: its message names the dialled address, which is the tunnel's forward.
    if (known) return new EtcdError(known[0], code, undefined, known[1]);
    // Another code keeps its message, unless the message is a socket error's, whose words after the code are the address.
    return new EtcdError("unknown", runtimeCode(error.message) === code ? code : `${code}: ${error.message}`);
  }
  return new EtcdError("unknown", error instanceof Error ? error.message : String(error));
}

/**
 * A watch's in-band `cancel_reason` (spec 5.3, E4). etcd writes it as grpc-go's
 * "rpc error: code = <Name> desc = <message>" for the auth answers and the permission refusal,
 * and as the bare message for a compacted start revision (SRC
 * `etcd__server_etcdserver_api_v3rpc_watch.go` near 270-310); both are classified by the table.
 */
export function cancelReasonToEtcdError(cancelReason: string): EtcdError {
  const wrapped = /^rpc error: code = (\w+) desc = ([\s\S]*)$/.exec(cancelReason);
  if (wrapped) return classifyStatus(GRPC_CODE_NAMES.get(wrapped[1]) ?? UNKNOWN, wrapped[2]);
  const answer = ETCD_ANSWERS.find(([, text]) => text === cancelReason);
  if (answer) return new EtcdError(answer[2], cancelReason, answer[0]);
  return new EtcdError("unknown", cancelReason);
}

/**
 * The renewal answers of spec E4 that KE12 measured as leaving a write unapplied, in etcd's words: a
 * write that met one is on 4.5's closed list, so the adapter sends it once more after its one renewal
 * succeeds, unless the write's own signal has aborted by then.
 */
export const ETCD_RENEWAL_ANSWERS_NOT_APPLIED: ReadonlySet<string> = new Set([
  // Measured by Task 22 on 2026-10-01 (KE12, etcd 3.7.2 on etcd-auth-password): a value edit's Txn that met
  // the first and a put sent with no token that met the second were read back as root, and neither was
  // applied. "etcdserver: revision of auth store is old" stays off: a simple token takes the auth store's
  // revision at each call, so no write could be made to meet it, and one that does keeps the unknown outcome.
  "etcdserver: invalid auth token",
  "etcdserver: user name is empty",
]);

/**
 * True when a write that met `error` was certainly not applied: it never left the client, or etcd
 * answered it from the closed list of spec 4.5, which etcd gives before a write can be applied.
 * A renewal answer of spec E4 is on it only where KE12 showed, live, that a write meeting it was not
 * applied (`ETCD_RENEWAL_ANSWERS_NOT_APPLIED`), and "database space exceeded" never is, because etcd
 * applies the write first.
 */
export function writeNotApplied(error: EtcdError): boolean {
  switch (error.category) {
    case "unauthenticated":
      return ETCD_RENEWAL_ANSWERS_NOT_APPLIED.has(error.detail);
    case "not-connected":
    case "tls":
    case "closed":
    case "no-leader":
    case "permission-denied":
    case "request-too-large":
    case "too-many-ops":
    case "duplicate-key":
    case "too-many-requests":
      return true;
    default:
      return false;
  }
}

export interface EtcdErrorConnection {
  /** The endpoint as the connection names it, never the tunnel's local forward. */
  readonly host: string;
  readonly port: number;
  /** Absent on a plaintext channel. `serverName` is the identity the certificate is checked against (spec E5). */
  readonly tls?: { readonly serverName: string; readonly clientCertificate: boolean };
  /**
   * False under Bun, where a handshake the server refused carries no cause, while a chain, name or not-TLS failure is
   * named (spec E5, R07).
   */
  readonly runtimeReportsTlsCause: boolean;
  /** The channel's maximum receive size `M` (spec 5.4, KE4). */
  readonly receiveCapBytes: number;
  /** The deadline the call ran under. */
  readonly timeoutMs: number;
}

export interface EtcdErrorContext {
  /** The command in etcdctl's words ("get", "put", "lease revoke"), or the surface's own ("the Users listing"). */
  readonly command: string;
  /** True when the command can change the key space or a lease (guard.ts's class): its outcome after a send is unknown. */
  readonly write: boolean;
  /** The key or range the command asked for, as the user reads it. */
  readonly range?: string;
  /** What the user may read, when the walks of spec 4.7 read the grants. */
  readonly readable?: { readonly user: string; readonly ranges: string };
  readonly connection: EtcdErrorConnection;
}

const UNKNOWN_OUTCOME = "The write may have been applied: read the key again before you run the command again.";
const NO_SPACE_RECOVERY =
  "An admin compacts history, defragments every member that alarm list names, one at a time through a connection to each member, and then disarms the alarm, from the Global Operations cards of Admin > Operations.";

/** Where grpc-js 1.14.5 places the runtime's error in its text for a channel that never connected (pick_first, round_robin). */
const LAST_ERROR = "No connection established. Last error: ";

/** A deadline's subchannel peer, the address the call went out on (grpc-js 1.14.5 `subchannel-call.ts` getDeadlineInfo). */
const DEADLINE_PEER = /,remote_addr=[^,]*/g;

/**
 * A runtime's or grpc-js's text without the address it carries (D-T11-12): through an SSH tunnel the
 * dialled address is the tunnel's local forward, so the provider's sentence names the configured
 * endpoint and the text after it names none. grpc-js 1.14.5 carries one in three places: the runtime's
 * error after LAST_ERROR, reduced to its system code as toEtcdError writes a system error, a deadline's
 * peer, dropped, and the target a name lookup failed for, dropped. Any other text is kept as it is, and
 * a last error that names no code names no address either (the TLS causes, Bun's "Failed to connect").
 */
function withoutAddress(detail: string): string {
  const lastError = detail.indexOf(LAST_ERROR);
  const code = lastError < 0 ? undefined : runtimeCode(detail.slice(lastError + LAST_ERROR.length));
  if (code !== undefined) return code;
  if (detail.startsWith(NAME_RESOLUTION_FAILED)) return "Name resolution failed";
  return detail.replace(DEADLINE_PEER, "");
}

/** etcd's words after the provider's (spec E16), without etcd's own "etcdserver: " prefix; any other text without its address. */
function answered(detail: string): string {
  return detail.startsWith("etcdserver: ")
    ? ` (etcd: ${detail.slice("etcdserver: ".length)})`
    : ` (${withoutAddress(detail)})`;
}

/**
 * etcd's words as this table places them after the provider's (spec E16): " (etcd: <message>)" for
 * etcd's own "etcdserver: " text, and " (<text>)" for the runtime's. It is for the sentences a surface
 * words itself, which this table does not raise: the folder refusals of spec 4.3, a member whose alarms
 * could not be read, and a compaction that overtook a walk pinned to its revision (plan Review Focus 2).
 */
export function etcdWords(error: EtcdError): string {
  return answered(error.detail);
}

function endpointOf(connection: EtcdErrorConnection): string {
  const host = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
  return `${host}:${connection.port}`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function notConnectedSentence(connection: EtcdErrorConnection): string {
  const endpoint = endpointOf(connection);
  if (connection.tls === undefined) {
    return `No etcd answered a plaintext connection at ${endpoint}. If this etcd serves TLS (kubeadm and k3s always do), choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel.`;
  }
  if (connection.runtimeReportsTlsCause) {
    return `No etcd answered a TLS connection at ${endpoint}: check the host, the port, the SSL mode and the tunnel.`;
  }
  const unreported = `No TLS connection to etcd at ${endpoint} was established, and this runtime does not report why`;
  return connection.tls.clientCertificate
    ? `${unreported}: check the host, the port, the SSL mode, the certificates and the tunnel.`
    : `${unreported}. No client certificate is configured: if this etcd requires one (--client-cert-auth), add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel.`;
}

function tlsSentence(failure: EtcdTlsFailure | undefined, connection: EtcdErrorConnection): string {
  switch (failure) {
    case "chain":
      return "The server's certificate is not signed by the CA under SSL / TLS: paste the etcd CA.";
    case "name":
      return `The certificate does not name ${connection.tls?.serverName ?? connection.host}: connect by a name or address the certificate carries.`;
    case "not-tls":
      return "This port did not answer TLS: set SSL mode to disable, or use etcd's TLS port.";
    case "client-certificate-required":
      return connection.tls?.clientCertificate === true
        ? "etcd asked for a client certificate and did not accept the one configured under SSL / TLS."
        : "This etcd requires a client certificate (--client-cert-auth), and none is configured: add the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).";
    case "client-certificate-refused":
      return "etcd refused the client certificate under SSL / TLS: it must be issued by the CA etcd trusts for clients (--trusted-ca-file).";
    case undefined:
      return "The TLS connection to etcd failed.";
  }
}

function receiveCapSentence(context: EtcdErrorContext): string {
  const cap = formatBytes(context.connection.receiveCapBytes);
  if (!context.write) {
    return `etcd's answer to the ${context.command} is larger than this connection's receive cap of ${cap}: narrow the read.`;
  }
  return context.command === "txn"
    ? `One branch of the txn ran, but etcd's answer, which names the branch, is larger than this connection's receive cap of ${cap} and was not read.`
    : `etcd applied the ${context.command}, but its answer is larger than this connection's receive cap of ${cap} and was not read.`;
}

/** A QueryError in etcd's words; a write it answers carries the unknown-outcome sentence unless the closed list holds it. */
function answerError(error: EtcdError, context: EtcdErrorContext, lead: string, instruction?: string): QueryError {
  const parts = [lead + answered(error.detail)];
  if (instruction !== undefined) parts.push(instruction);
  if (context.write && !writeNotApplied(error)) parts.push(UNKNOWN_OUTCOME);
  return new QueryError(parts.join(" "), PROVIDER);
}

function unknownOutcome(error: EtcdError, lead: string): QueryError {
  return new QueryError(`${lead}${answered(error.detail)} ${UNKNOWN_OUTCOME}`, PROVIDER);
}

function connectionError(error: EtcdError, context: EtcdErrorContext, lead: string): ConnectionError {
  const { host, port } = context.connection;
  return new ConnectionError(lead + answered(error.detail), PROVIDER, host, port);
}

/** The provider's half: the one table from an etcd failure to the repository's classes (spec 5.6). */
export function toProviderError(error: unknown, context: EtcdErrorContext): Error {
  if (error instanceof DatabaseConfigError && error.provider === undefined) {
    return new DatabaseConfigError(error.message, PROVIDER);
  }
  if (!(error instanceof EtcdError)) {
    // A local refusal, or a defect, surfaces as itself and is never dressed up as etcd's answer.
    if (error instanceof Error) return error;
    return new Error(`The etcd provider received a thrown value that is not an Error: ${String(error)}`);
  }
  const { command } = context;
  switch (error.category) {
    case "not-connected":
      return connectionError(error, context, notConnectedSentence(context.connection));
    case "tls":
      return connectionError(error, context, tlsSentence(error.tlsFailure, context.connection));
    case "no-leader":
      return connectionError(
        error,
        context,
        "The etcd member this connection reaches has no leader: the cluster has lost quorum, so nothing was applied. Bring the stopped members back, then run the command again.",
      );
    case "closed":
      return connectionError(error, context, "This connection to etcd is closed: connect again.");
    case "unavailable":
      return context.write
        ? unknownOutcome(
            error,
            `etcd did not confirm the ${command}: the connection failed after the request was sent.`,
          )
        : connectionError(error, context, `etcd did not answer the ${command}.`);
    case "deadline-exceeded": {
      if (context.write) return unknownOutcome(error, `The ${command} reached its deadline before etcd answered.`);
      const { timeoutMs } = context.connection;
      return new TimeoutError(
        `The ${command} reached its deadline of ${timeoutMs.toLocaleString("en-US")} ms.${answered(error.detail)}`,
        PROVIDER,
        timeoutMs,
      );
    }
    case "cancelled":
      return context.write
        ? unknownOutcome(error, `The ${command} was cancelled after it was sent.`)
        : new QueryCancelledError(`The ${command} was cancelled.`, PROVIDER);
    case "cancelled-elsewhere":
      // Not the caller's cancelQuery, so never a QueryCancelledError, which the client reads as its own.
      return context.write
        ? unknownOutcome(error, `The ${command} was cancelled after it was sent.`)
        : new QueryError(`The ${command} was cancelled before etcd answered.${answered(error.detail)}`, PROVIDER);
    case "unauthenticated":
      // Raised by the adapter once it has started its one renewal, or at once on a connection with no
      // password, which has no token to renew (spec E4). A write meeting one is an unknown outcome
      // unless KE12 showed, answer by answer, that such a write was not applied; one that was not is
      // raised with its own answer, either after its one retry meets such an answer again or, with no
      // retry, when its renewal fails with an answer outside 4.5's closed list or its own abort ends
      // the wait (grpc-client.ts `bounded`).
      return context.write && !writeNotApplied(error)
        ? unknownOutcome(error, `etcd did not accept this connection's sign-in for the ${command}.`)
        : new AuthenticationError(
            `etcd did not accept this connection's sign-in for the ${command}: connect again.${answered(error.detail)}`,
            PROVIDER,
          );
    case "auth-failed":
      return new AuthenticationError(
        `etcd refused the sign-in: the user is unknown or the password is wrong.${answered(error.detail)}`,
        PROVIDER,
      );
    case "permission-denied": {
      const target = context.range === undefined ? command : `${command} on ${context.range}`;
      const readable = context.readable
        ? ` etcd user ${context.readable.user} may read: ${context.readable.ranges}.`
        : "";
      return new QueryError(
        `etcd refused the ${target}: this connection's etcd user is not granted all of it.${answered(error.detail)}${readable}`,
        PROVIDER,
      );
    }
    case "resource-exhausted": {
      // Never the unknown-outcome sentence: etcd sends a write's answer only after applying it (spec E14).
      const readBack = context.write ? " Read the keys back to see the result." : "";
      return new QueryError(`${receiveCapSentence(context)}${answered(error.detail)}${readBack}`, PROVIDER);
    }
    case "no-space":
      return answerError(error, context, "etcd's database is over its space quota.", NO_SPACE_RECOVERY);
    case "compacted":
      return answerError(
        error,
        context,
        `The ${command} asked for a revision etcd has compacted: ask for a later revision.`,
      );
    case "future-revision":
      return answerError(error, context, `The ${command} asked for a revision etcd has not reached yet.`);
    case "request-too-large":
      return answerError(error, context, `etcd refused the ${command}: the request is larger than etcd accepts.`);
    case "too-many-ops":
      return answerError(
        error,
        context,
        `etcd refused the ${command}: a txn list holds more operations than etcd accepts (--max-txn-ops, 128 by default).`,
      );
    case "duplicate-key":
      return answerError(error, context, `etcd refused the ${command}: a txn branch modifies one key twice.`);
    case "too-many-requests":
      return answerError(
        error,
        context,
        `etcd refused the ${command}: it is too far behind applying requests; run the command again shortly.`,
      );
    case "lease-not-found":
      return answerError(error, context, `etcd answered the ${command}: lease not found or expired.`);
    case "invalid-argument":
    case "failed-precondition":
      return answerError(error, context, `etcd refused the ${command}.`);
    case "unknown":
      return answerError(error, context, `The ${command} failed.`);
  }
}

/**
 * The answers that arrive as data (spec 5.6): a keep-alive TTL of 0 and a `TimeToLive` TTL of -1
 * are etcd's answer for a lease it does not hold (SRC `etcd__server_etcdserver_api_v3rpc_lease.go`
 * near 67-72 and 137-140), read in the same words as the NotFound answer above.
 */
export function leaseNotFoundError(leaseHex: string, command: string): QueryError {
  return new QueryError(`etcd answered the ${command}: lease ${leaseHex} not found or expired.`, PROVIDER);
}

/**
 * How a watch ended, as an error, or `undefined` for a window that closed or the caller's own abort,
 * which the caller's signal decides (spec 5.3). A compacted start revision arrives with an empty
 * `cancel_reason` and the compact revision (SRC `etcd__server_etcdserver_api_v3rpc_watch.go` near
 * 459-465); a non-empty `cancel_reason` is raised by the table, after the adapter's one renewal.
 */
export function watchEndError(end: EtcdWatchEnd, context: EtcdErrorContext): Error | undefined {
  switch (end.reason) {
    case "stopped":
    case "aborted":
      return undefined;
    case "compacted":
      return new QueryError(
        `The watch starts at a revision etcd has compacted: watch from revision ${end.compactRevision} or later. (etcd: mvcc: required revision has been compacted)`,
        PROVIDER,
      );
    case "canceled":
      return toProviderError(cancelReasonToEtcdError(end.cancelReason), context);
  }
}

/**
 * A failure the adapter raised for a watch whose window had closed (spec 5.3). The adapter raises the window's timeout
 * only for a watch whose create etcd never answered, as a member that went silent with its connection open leaves it,
 * so that watch watched nothing: a read's deadline, the window's and not the query timeout's, and never a quiet window
 * (plan Review Focus 3). Any other failure is the table's own.
 */
export function watchWindowError(error: unknown, windowMs: number, context: EtcdErrorContext): Error {
  if (!(error instanceof EtcdError) || error.category !== "deadline-exceeded") return toProviderError(error, context);
  return new TimeoutError(
    `etcd did not answer the watch's create within its window of ${windowMs.toLocaleString("en-US")} ms: nothing was watched.${answered(error.detail)}`,
    PROVIDER,
    windowMs,
  );
}

/**
 * The steps of the connect sequence whose refusal is worded here (spec 6.1): "authenticate" words
 * step 1's "authentication is not enabled"; "credential-required" is step 3's local refusal, which
 * no etcd answer carries; "certificate-user" words step 4's "user name not found" with the Common
 * Name, and its "user name is empty". index.ts holds no error table (spec 3.5), so the sentences
 * live here with the rest.
 */
export type EtcdConnectStep = "authenticate" | "credential-required" | "certificate-user";

const AUTH_NOT_ENABLED = "etcdserver: authentication is not enabled";
const USER_NOT_FOUND = "etcdserver: user name not found";
const USER_NAME_EMPTY = "etcdserver: user name is empty";

/**
 * etcd's InvalidArgument "user name is empty". Step 2 of the connect sequence reads it as
 * authentication on: below 3.7 `AuthStatus` answers the root role alone, so a caller etcd reads no user
 * for meets this answer, and 3.7 is the release that answers it without authentication (spec 6.1). Code
 * and message together, as every row of this table is read.
 */
export function isUserNameEmpty(error: unknown): boolean {
  return error instanceof EtcdError && error.grpcCode === INVALID_ARGUMENT && error.detail === USER_NAME_EMPTY;
}

/**
 * A connect step's refusal, the provider's words first and etcd's after (spec E16). An answer the
 * step does not word, a wrong password or a lost quorum among them, is the table's own.
 */
export function connectStepError(
  step: EtcdConnectStep,
  error: EtcdError | undefined,
  context: EtcdErrorContext,
  commonName?: string,
): Error {
  if (step === "credential-required") {
    return new AuthenticationError(
      "This etcd has authentication enabled. Enter a User and Password, or add a client certificate under SSL / TLS whose Common Name is an etcd user.",
      PROVIDER,
    );
  }
  if (error === undefined) {
    throw new TypeError(`The connect step "${step}" words an etcd answer, and none was given`);
  }
  if (step === "authenticate" && error.grpcCode === FAILED_PRECONDITION && error.detail === AUTH_NOT_ENABLED) {
    // etcd's own client drops the token in silence here; this says why the fields are refused (spec 6.1).
    return new DatabaseConfigError(
      `Authentication is not enabled on this etcd, so the User and Password would not be used. Clear them to connect.${answered(error.detail)}`,
      PROVIDER,
    );
  }
  if (step === "certificate-user" && error.grpcCode === FAILED_PRECONDITION && error.detail === USER_NOT_FOUND) {
    if (commonName === undefined) {
      throw new TypeError(`The connect step "${step}" names the Common Name, and none was given`);
    }
    return new AuthenticationError(
      `The client certificate's Common Name ${JSON.stringify(commonName)} is not an etcd user.${answered(error.detail)}`,
      PROVIDER,
    );
  }
  if (step === "certificate-user" && isUserNameEmpty(error)) {
    return new AuthenticationError(
      `etcd did not read the client certificate: the server must run with --client-cert-auth.${answered(error.detail)}`,
      PROVIDER,
    );
  }
  return toProviderError(error, context);
}
