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
import { MilvusError, type MilvusErrorCategory, type MilvusTlsFailure, type WireStatus } from "./client";

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
    const extra = isGrpcStatus(error) ? { grpcCode: error.code } : {};
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
