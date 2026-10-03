/**
 * The one error table of the Milvus provider (vector-family spec 5.10), in two halves.
 *
 * `toMilvusError` and `statusFailure` are the adapter's half: a grpc-js status, a runtime socket or TLS error, the
 * call's own abort, or a `common.Status` that is not success, to a `MilvusError` whose category the gRPC code and the
 * text decide together, never the text alone. `toProviderError` is the provider's half: a `MilvusError` to the
 * repository's error classes, Studio's sentence first and Milvus's text after it, every server text through
 * `serverText` first (E20, VF9).
 *
 * The TLS cause table, the pre-send deadline markers, the unstarted answers and the system codes are copies of the
 * etcd provider's (src/lib/db/providers/keyvalue/etcd/errors.ts), made under the isolation rule (decision Q1a), plus
 * the row etcd's table lacks: alert 45, a client certificate the server read as expired (R42 F7).
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { serverText } from "@/lib/db/utils/server-text";
import type { DatabaseType } from "@/lib/types";
import { MilvusError, type MilvusErrorCategory, type MilvusTlsFailure, type WireStatus } from "./client";

const PROVIDER: DatabaseType = "milvus";

// gRPC status codes (grpc/grpc `doc/statuscodes.md`), the numbers grpc-js reports.
const CANCELLED = 1;
const DEADLINE_EXCEEDED = 4;
const PERMISSION_DENIED = 7;
const RESOURCE_EXHAUSTED = 8;
const UNIMPLEMENTED = 12;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;

/** The common.Status code whose reason may carry the server-side deadline (R41 F7). */
const STATUS_TASK_CONDITION = 10001;
const CONTEXT_DEADLINE = "context deadline exceeded";

/** grpc-js 1.14.5's deadline texts for a call that never had a stream; only these say the request never left. */
const PRE_SEND_DEADLINE_MARKERS: readonly string[] = [
  "waiting for name resolution",
  "waiting for metadata filters",
  "Waiting for LB pick",
];

const NAME_RESOLUTION_FAILED = "Name resolution failed for target ";
const UNSTARTED_ANSWERS: ReadonlyArray<readonly [string, MilvusErrorCategory]> = [
  [NAME_RESOLUTION_FAILED, "not-connected"],
  ["Channel closed before call started", "closed"],
];

/** What the keepalive raises for a silently dropped connection (R41 M6). */
const CONNECTION_DROPPED = "Connection dropped";
/** The two receive-cap texts, on the wire and inflated (R41 M25); the halved retry fires on these and nothing else. */
const RECEIVE_CAP_TEXTS: readonly string[] = ["Received message larger than max", "decompresses to a size larger than"];
/** A too_many_pings GOAWAY that dropped the connection (R41 F5); never the receive cap. */
const PING_GOAWAY = "Bandwidth exhausted or memory limit exceeded";

/** TLS causes inside "No connection established. Last error: ...", in Node's and Bun's texts; the first match decides. */
const TLS_CAUSES: ReadonlyArray<readonly [RegExp, MilvusTlsFailure | undefined]> = [
  [/alert certificate expired/, "client-certificate-expired"],
  [/alert certificate required/, "client-certificate-required"],
  [/alert (?:unknown ca|bad certificate)/, "client-certificate-refused"],
  [/does not match certificate's altnames/, "name"],
  [/unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate/, "chain"],
  [/wrong version number|WRONG_VERSION_NUMBER|packet length too long/, "not-tls"],
  [/certificate has expired|Setting the TLS ServerName to an IP address is not permitted/, undefined],
];

/** Node's codes for a socket or TLS failure raised outside a gRPC status. */
const SYSTEM_ERRORS: ReadonlyMap<string, readonly [MilvusErrorCategory, MilvusTlsFailure?]> = new Map<
  string,
  readonly [MilvusErrorCategory, MilvusTlsFailure?]
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

/** A runtime error's system code, in Node's two forms: `<syscall> <CODE> <address>` and `<Name> [<CODE>]: ...`. */
const RUNTIME_ERROR_CODE = /^(?:\w*Error \[([A-Z][A-Z0-9_]*)\]|(?:Error: )?[a-z]+ (E[A-Z0-9_]+)\b)/;

function runtimeCode(text: string): string | undefined {
  const match = RUNTIME_ERROR_CODE.exec(text);
  return match === null ? undefined : (match[1] ?? match[2]);
}

function classifyStatus(code: number, details: string): MilvusError {
  const extra = { grpcCode: code };
  switch (code) {
    case CANCELLED:
      // The caller's own cancel is decided by its signal in toMilvusError; this one is the server's deadline firing
      // first on the native TLS port (R41 F7).
      return new MilvusError("deadline-exceeded", details, extra);
    case DEADLINE_EXCEEDED: {
      const preSend =
        !details.includes("remote_addr=") && PRE_SEND_DEADLINE_MARKERS.some((marker) => details.includes(marker));
      return new MilvusError(preSend ? "not-connected" : "deadline-exceeded", details, extra);
    }
    case PERMISSION_DENIED:
      return new MilvusError("permission-denied", details, extra);
    case RESOURCE_EXHAUSTED:
      if (RECEIVE_CAP_TEXTS.some((text) => details.includes(text)))
        return new MilvusError("receive-cap", details, extra);
      if (details === PING_GOAWAY) return new MilvusError("ping-goaway", details, extra);
      return new MilvusError("unknown", details, extra);
    case UNIMPLEMENTED:
      return new MilvusError("unimplemented", details, extra);
    case UNAUTHENTICATED:
      return new MilvusError("unauthenticated", details, extra);
    case UNAVAILABLE: {
      if (details.startsWith(CONNECTION_DROPPED)) return new MilvusError("connection-dropped", details, extra);
      const unstarted = UNSTARTED_ANSWERS.find(([prefix]) => details.startsWith(prefix));
      if (unstarted) return new MilvusError(unstarted[1], details, extra);
      if (!details.includes("No connection established")) return new MilvusError("unavailable", details, extra);
      const cause = TLS_CAUSES.find(([pattern]) => pattern.test(details));
      if (cause === undefined) return new MilvusError("not-connected", details, extra);
      return new MilvusError("tls", details, cause[1] === undefined ? extra : { ...extra, tlsFailure: cause[1] });
    }
    default:
      return new MilvusError("unknown", details, extra);
  }
}

function isGrpcStatus(error: unknown): error is { readonly code: number; readonly details: string } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; details?: unknown };
  return typeof candidate.code === "number" && typeof candidate.details === "string";
}

/**
 * grpc-js's ServiceError for a compressed answer flagged under the identity encoding: `code` and `details` are present
 * and undefined (R41 F12), where a runtime error's code is a string.
 */
function isServiceErrorWithoutCode(error: unknown): error is Error {
  if (!(error instanceof Error) || !("code" in error) || !("details" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code !== "number" && typeof code !== "string";
}

/**
 * grpc-js's failure of a call that its own signal ended before grpc-js gave it a transport, so its request never
 * left; the transport raises this in place of grpc-js's "Cancelled on client" (grpc-client.ts `callFailure`).
 */
export class MilvusUnsentStatus extends Error {
  declare readonly code: number;
  declare readonly details: string;
  constructor(status: { readonly code: number; readonly details: string; readonly message: string }) {
    super(status.message);
    this.name = "MilvusUnsentStatus";
    this.code = status.code;
    this.details = status.details;
  }
}

/**
 * The adapter's half. `signal` is the call's own: grpc-js reports its abort by timeout and by cancelQuery alike as
 * CANCELLED "Cancelled on client", so the signal's reason tells them apart.
 */
export function toMilvusError(error: unknown, signal?: AbortSignal): MilvusError {
  if (error instanceof MilvusError) return error;
  if (signal?.aborted === true && ((isGrpcStatus(error) && error.code === CANCELLED) || error === signal.reason)) {
    const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
    const detail = isGrpcStatus(error) ? error.details : error instanceof Error ? error.message : String(error);
    // The signal's own reason is thrown before the request is handed to the channel, so it, too, never left.
    const unsent = error instanceof MilvusUnsentStatus || error === signal.reason;
    const extra = {
      ...(isGrpcStatus(error) ? { grpcCode: error.code } : {}),
      ...(unsent ? { unsent: true as const } : {}),
    };
    if (timedOut && error instanceof MilvusUnsentStatus) return new MilvusError("not-connected", detail, extra);
    return new MilvusError(timedOut ? "deadline-exceeded" : "cancelled", detail, extra);
  }
  if (isServiceErrorWithoutCode(error)) return new MilvusError("transport", error.message);
  if (isGrpcStatus(error)) return classifyStatus(error.code, error.details);
  if (error instanceof Error && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as Error & { code: string }).code;
    const known = SYSTEM_ERRORS.get(code);
    if (known) return new MilvusError(known[0], code, known[1] === undefined ? {} : { tlsFailure: known[1] });
    return new MilvusError("unknown", runtimeCode(error.message) === code ? code : `${code}: ${error.message}`);
  }
  return new MilvusError("unknown", error instanceof Error ? error.message : String(error));
}

/**
 * The failure a `common.Status` carries, or undefined for success, which is `code == 0` and `error_code == "Success"`
 * together (E20): 2.6.25 answers a missing collection with code 0 and `CollectionNotExists` (R42 F9).
 */
export function statusFailure(status: WireStatus | null | undefined, rpc: string): MilvusError | undefined {
  if (status === null || status === undefined) {
    return new MilvusError("malformed", `Milvus answered ${rpc} with no status`);
  }
  if (status.code === 0 && status.error_code === "Success") return undefined;
  const reason = status.reason !== "" ? status.reason : status.detail;
  const extra = { status: { code: status.code, errorCode: status.error_code } };
  if (status.code === STATUS_TASK_CONDITION && reason.includes(CONTEXT_DEADLINE)) {
    return new MilvusError("deadline-exceeded", reason, extra);
  }
  return new MilvusError("status", reason, extra);
}

/** Whether a failure is the client's receive cap, the one failure part C's query and get retry with half the limit. */
export function isReceiveCapError(error: unknown): boolean {
  return error instanceof MilvusError && error.category === "receive-cap";
}

// -- the provider's half ---------------------------------------------------------------------------------------------

export interface MilvusErrorConnection {
  /** The endpoint as the connection names it (the tunnel's far end when there is one), never the local forward. */
  readonly host: string;
  readonly port: number;
  /** Absent on a plaintext channel; `serverName` is the identity the certificate is checked against (E6). */
  readonly tls?: { readonly serverName: string; readonly clientCertificate: boolean };
  /** False under Bun, which reports no TLS alert (R42 F5). */
  readonly runtimeReportsTlsCause: boolean;
  readonly receiveCapBytes: number;
  /** The deadline the call ran under. */
  readonly timeoutMs: number;
}

export interface MilvusErrorContext {
  /** What ran, in Studio's words: "query", "search", "Load of docs_int64", "connection test". */
  readonly operation: string;
  /** True for Load and Release: after the send, the outcome is unknown and is never resent (E7). */
  readonly write: boolean;
  readonly database?: string;
  readonly collection?: string;
  /** The load state, when the caller read it, for the not-loaded sentence. */
  readonly loadState?: string;
  readonly connection: MilvusErrorConnection;
  /** `secretForms` of the configured credential (connection-options.ts); every text passes `serverText` with them. */
  readonly secretForms: readonly string[];
}

const UNKNOWN_OUTCOME = "It may have been applied: read the collection's load state before you run it again.";
const QUERY_NODE_CODES: ReadonlySet<number> = new Set([2000, 2001, 2099]);
/** The one place a query-node rejection's text is read: a closed list of fragments in Studio's own words (E20, R43). */
const QUERY_NODE_FRAGMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/vector dimension mismatch/, "the query vector's dimension does not match the field's"],
  [/for group by operator/, "the group-by field's type cannot be grouped"],
  [/metric type not match/, "the metric does not match the index's"],
  [/\b(?:radius|range_filter)\b/, "the range search parameters were refused"],
];
/** The categories whose request may have left and been applied: a Load or Release meeting one has an unknown outcome. */
const AFTER_SEND: ReadonlySet<MilvusErrorCategory> = new Set([
  "connection-dropped",
  "ping-goaway",
  "unavailable",
  "transport",
  "deadline-exceeded",
  "cancelled",
  "receive-cap",
  "unknown",
]);

const LAST_ERROR = "No connection established. Last error: ";
const DEADLINE_PEER = /,remote_addr=[^,]*/g;

/** A runtime's or grpc-js's text without the address it carries, which through a tunnel is the local forward. */
function withoutAddress(detail: string): string {
  const lastError = detail.indexOf(LAST_ERROR);
  const code = lastError < 0 ? undefined : runtimeCode(detail.slice(lastError + LAST_ERROR.length));
  if (code !== undefined) return code;
  if (detail.startsWith(NAME_RESOLUTION_FAILED)) return "Name resolution failed";
  return detail.replace(DEADLINE_PEER, "");
}

/** The server's words after Studio's, withheld whole when they hold any form of the secret (VF9). */
function serverWords(error: MilvusError, context: MilvusErrorContext): string {
  return ` (Milvus: ${serverText(error.detail, context.secretForms)})`;
}

/** The runtime's words after Studio's, without the address, and withheld like a server's. */
function runtimeWords(error: MilvusError, context: MilvusErrorContext): string {
  return ` (${withoutAddress(serverText(error.detail, context.secretForms))})`;
}

function endpointOf(connection: MilvusErrorConnection): string {
  const host = connection.host.includes(":") ? `[${connection.host}]` : connection.host;
  return `${host}:${connection.port}`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function notConnectedSentence(connection: MilvusErrorConnection): string {
  const endpoint = endpointOf(connection);
  if (connection.tls === undefined) {
    return `No Milvus answered a plaintext connection at ${endpoint}. If this Milvus serves TLS, choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel.`;
  }
  if (connection.runtimeReportsTlsCause) {
    return `No Milvus answered a TLS connection at ${endpoint}: check the host, the port, the SSL mode and the tunnel.`;
  }
  const unreported = `No TLS connection to Milvus at ${endpoint} was established, and this runtime does not report why`;
  return connection.tls.clientCertificate
    ? `${unreported}: check the host, the port, the SSL mode, the client certificate and the tunnel.`
    : `${unreported}. No client certificate is configured: if this Milvus requires one (tlsMode 2), add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel.`;
}

function tlsSentence(failure: MilvusTlsFailure | undefined, connection: MilvusErrorConnection): string {
  switch (failure) {
    case "chain":
      return "The server's certificate is not signed by the CA under SSL / TLS: paste the CA that issued Milvus's certificate.";
    case "name":
      return `The certificate does not name ${connection.tls?.serverName ?? connection.host}: connect by a name or address the certificate carries.`;
    case "not-tls":
      return "This port did not answer TLS: set SSL mode to disable, or use Milvus's TLS port.";
    case "client-certificate-required":
      return connection.tls?.clientCertificate === true
        ? "Milvus asked for a client certificate and did not accept the one configured under SSL / TLS."
        : "This Milvus requires a client certificate (tlsMode 2), and none is configured: add the client certificate and key under SSL / TLS.";
    case "client-certificate-refused":
      return "Milvus refused the client certificate under SSL / TLS: it must be issued for client authentication by the CA Milvus trusts.";
    case "client-certificate-expired":
      return "Milvus refused the client certificate under SSL / TLS because it has expired (client certificate expired): paste a current one.";
    case undefined:
      return "The TLS connection to Milvus failed.";
  }
}

function notLoadedSentence(context: MilvusErrorContext): string {
  const subject = context.collection === undefined ? "The collection" : `Collection ${context.collection}`;
  const state = context.loadState === undefined ? "" : ` (state ${context.loadState})`;
  return `${subject} is not loaded${state}. Query, get, count and search need a loaded collection, and loading uses query-node memory that every client of this cluster shares. An admin can load it from Operations; Studio never loads a collection on its own.`;
}

function statusError(error: MilvusError, context: MilvusErrorContext): QueryError {
  const status = error.status ?? { code: -1, errorCode: "" };
  const { operation } = context;
  if (status.code === 101) return new QueryError(notLoadedSentence(context), PROVIDER);
  if (status.code === 1100) {
    return new QueryError(
      `Milvus refused the ${operation}'s input: correct the request and run it again.${serverWords(error, context)}`,
      PROVIDER,
    );
  }
  if (status.code === 100 || status.errorCode === "CollectionNotExists") {
    const name = context.collection ?? "named";
    const database = context.database ?? "default";
    return new QueryError(
      `Collection ${name} does not exist in database ${database}.${serverWords(error, context)}`,
      PROVIDER,
    );
  }
  if (status.code === 800) {
    return new QueryError(
      `Database ${context.database ?? "named"} does not exist.${serverWords(error, context)}`,
      PROVIDER,
    );
  }
  if (QUERY_NODE_CODES.has(status.code)) {
    // The raw text carries the knowhere configuration, a trace id and a C++ path, and may echo a value (E20).
    const fragment = QUERY_NODE_FRAGMENTS.find(([pattern]) => pattern.test(error.detail));
    return new QueryError(
      `Milvus rejected the request on the query node${fragment === undefined ? "" : `: ${fragment[1]}`}.`,
      PROVIDER,
    );
  }
  return new QueryError(
    `Milvus refused the ${operation} with code ${status.code} (${status.errorCode}).${serverWords(error, context)}`,
    PROVIDER,
  );
}

function unknownOutcome(error: MilvusError, context: MilvusErrorContext, lead: string): QueryError {
  return new QueryError(`${lead}${runtimeWords(error, context)} ${UNKNOWN_OUTCOME}`, PROVIDER);
}

/** The provider's half: the one table from a Milvus failure to the repository's classes (5.10). */
export function toProviderError(error: unknown, context: MilvusErrorContext): Error {
  if (error instanceof DatabaseConfigError && error.provider === undefined) {
    return new DatabaseConfigError(error.message, PROVIDER);
  }
  if (!(error instanceof MilvusError)) {
    // A local refusal, or a defect, surfaces as itself and is never dressed up as Milvus's answer.
    if (error instanceof Error) return error;
    return new Error(`The Milvus provider received a thrown value that is not an Error: ${String(error)}`);
  }
  const { operation, connection } = context;
  if (context.write && AFTER_SEND.has(error.category) && error.unsent !== true) {
    return unknownOutcome(error, context, `Milvus did not confirm the ${operation}: the call ended after it was sent.`);
  }
  const { host, port } = connection;
  switch (error.category) {
    case "not-connected":
      return new ConnectionError(notConnectedSentence(connection) + runtimeWords(error, context), PROVIDER, host, port);
    case "tls":
      return new ConnectionError(
        tlsSentence(error.tlsFailure, connection) + runtimeWords(error, context),
        PROVIDER,
        host,
        port,
      );
    case "closed":
      return new ConnectionError("This connection to Milvus is closed: connect again.", PROVIDER, host, port);
    case "connection-dropped":
      return new ConnectionError(
        `The connection to Milvus was lost; run it again.${runtimeWords(error, context)}`,
        PROVIDER,
        host,
        port,
      );
    case "ping-goaway":
      return new ConnectionError(
        `The Milvus server dropped the connection (a keepalive GOAWAY); run it again.${runtimeWords(error, context)}`,
        PROVIDER,
        host,
        port,
      );
    case "transport":
      return new ConnectionError(
        `A transport failure ended the ${operation} at ${endpointOf(connection)}.`,
        PROVIDER,
        host,
        port,
      );
    case "unavailable":
      return new ConnectionError(
        `Milvus did not answer the ${operation}.${runtimeWords(error, context)}`,
        PROVIDER,
        host,
        port,
      );
    case "unauthenticated":
      return new AuthenticationError(
        `Milvus refused the user name or password (or token).${serverWords(error, context)}`,
        PROVIDER,
      );
    case "permission-denied":
      return new QueryError(
        `The Milvus user lacks the privilege for the ${operation}.${serverWords(error, context)}`,
        PROVIDER,
      );
    case "unimplemented":
      return new QueryError(
        `The ${operation} is not supported by this server version.${serverWords(error, context)}`,
        PROVIDER,
      );
    case "receive-cap":
      return new QueryError(
        `Milvus's answer to the ${operation} is larger than this connection's receive cap of ${formatBytes(connection.receiveCapBytes)}: narrow the request.${runtimeWords(error, context)}`,
        PROVIDER,
      );
    case "deadline-exceeded":
      return new TimeoutError(
        `The ${operation} reached its deadline of ${connection.timeoutMs.toLocaleString("en-US")} ms.${runtimeWords(error, context)}`,
        PROVIDER,
        connection.timeoutMs,
      );
    case "cancelled":
      return new QueryCancelledError(`The ${operation} was cancelled.`, PROVIDER);
    case "status":
      return statusError(error, context);
    case "malformed":
      return new QueryError(
        `Milvus's answer to the ${operation} carried no status, so Studio does not read it.`,
        PROVIDER,
      );
    case "unknown":
      return new QueryError(`The ${operation} failed.${runtimeWords(error, context)}`, PROVIDER);
  }
}

/** A FieldData column of a type this provider does not decode: named, never guessed (E20). */
export function unsupportedDataTypeError(dataType: number | string): QueryError {
  return new QueryError(
    `Milvus returned a field of unsupported type ${dataType}, which Studio does not read rather than guess.`,
    PROVIDER,
  );
}
