/**
 * Every failure of the Apache Spark provider: its category, its sentence, and the mapping onto the repository's error
 * classes at the provider boundary (the Snowflake pattern of toDatabaseError).
 *
 * Every server text passes `serverText` with the connection's secret forms before it reaches a sentence, so the token
 * is never echoed, and a text is cut only after that pass, so no cut leaves part of a token behind, and by code points,
 * so no cut leaves half of a surrogate pair. A value that is not a gRPC status is never quoted at all: a local error of
 * the client can repeat a header value. The ErrorInfo of a Spark error is read by status-details.ts, a bounded decoder.
 * Pure: no I/O, no logger.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { serverText } from "@/lib/db/utils/server-text";
import { SPARK_ERROR_CAUSE_MAX_CHARS, SPARK_ERROR_CAUSES_MAX, SPARK_VERSION_TEXT_MAX_CHARS } from "./constants";
import { readStatusDetails, type SparkErrorInfo } from "./status-details";

export type SparkErrorCategory =
  | "config"
  | "unsent"
  | "not-connected"
  | "tls"
  | "unauthenticated"
  | "connection-dropped"
  | "stream-failed"
  | "ping-goaway"
  | "receive-cap"
  | "command-batch-bound"
  | "batch-too-large"
  | "deadline"
  | "cancelled"
  | "session-closed"
  | "session-changed"
  | "unimplemented"
  | "spark"
  | "version"
  | "unreadable"
  | "refused";

/** The one error every module of the provider raises; `toDatabaseError` turns it into the repository's class. */
export class SparkError extends Error {
  readonly category: SparkErrorCategory;
  constructor(category: SparkErrorCategory, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SparkError";
    this.category = category;
  }
}

/** What a sentence names, and the secret forms no sentence may echo. */
export interface SparkErrorConnection {
  readonly host: string;
  readonly port: number;
  readonly secretForms: readonly string[];
}

/** What a FetchErrorDetails answer adds to a Spark error. */
export interface SparkErrorDetails {
  readonly errorClass?: string;
  readonly cause?: string;
}

export interface SparkErrorContext {
  readonly connection: SparkErrorConnection;
  /** `setup` is a session setup statement (SET CATALOG or USE NAMESPACE); the session's Config set is `control`. */
  readonly phase: "connect" | "command" | "relation" | "control" | "setup";
  /**
   * The connection's query timeout, which the deadline sentences of a statement and of a setup statement name; required
   * in the command, relation and setup phases.
   */
  readonly timeoutMs?: number;
  /** The setup statement that a setup statement's failure names; required in the setup phase. */
  readonly step?: string;
  readonly details?: SparkErrorDetails;
}

/**
 * The article before a type's name: "an" before a vowel sound, "a" before any other. Every type a cell refusal names
 * (values.ts) is a lowercase Spark name said as its first letter reads, so that letter decides: "an int", "an array",
 * "a year-month interval", "a geometry".
 */
const articleOf = (type: string): "a" | "an" => (/^[aeiou]/.test(type) ? "an" : "a");

/** The sentences of the provider's failures and connect warnings; docs/providers/spark.md quotes each word for word. */
export const SPARK_ERROR_SENTENCES = Object.freeze({
  notConnected: (host: string, port: number) =>
    `No Spark Connect server answered at ${host}:${port}. Start it with sbin/start-connect-server.sh, or check Host and Port (15002 by default).`,
  tlsPlaintextServer: (host: string, port: number) =>
    `TLS was chosen, but ${host}:${port} answered without TLS. Spark Connect has no TLS of its own: point Host at a TLS proxy in front of it, or set SSL mode to disable and use an SSH tunnel.`,
  tlsPortExpected: (host: string, port: number) =>
    `${host}:${port} did not answer as a plaintext gRPC server: it expects TLS (choose an SSL mode under SSL / TLS), or it is not the Spark Connect port (15002 by default).`,
  // It never suggests SSL mode require, which would send a token to a server whose certificate Studio did not verify.
  tlsUntrusted:
    "The server's certificate is not signed by a CA Studio trusts. Paste the CA of the TLS proxy under SSL / TLS (verify-ca or verify-full).",
  tlsNameMismatch: (host: string) =>
    `The server's certificate does not name ${host}. Set Host to a name or address the certificate lists.`,
  tlsCertificateDates:
    "The server's certificate has expired or is not yet valid. Renew the TLS proxy's certificate, or check this machine's clock.",
  tlsClientCertificateRequired:
    "The TLS proxy asked for a client certificate and did not get one it accepts. Add the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).",
  tlsClientCertificateRefused:
    "The TLS proxy refused the client certificate under SSL / TLS: it must be issued by a CA the proxy trusts for clients.",
  tokenMissing:
    "This Spark Connect server requires a token. Set Token to the server's spark.connect.authenticate.token.",
  tokenWrong: "Spark refused the token. Set Token to the server's spark.connect.authenticate.token.",
  // Both version sentences quote the AnalyzePlan spark_version answer only after sparkVersionText has read it.
  versionTooOld: (version: string) =>
    `This server runs Spark ${version}. Studio connects to Spark 4.1 and later, the first release that splits large results into chunks Studio can read.`,
  versionUnreadable: (text: string) => `Studio could not read this server's Spark version (${text}).`,
  notSparkConnect: (host: string, port: number) =>
    `The gRPC server at ${host}:${port} does not answer Spark Connect's AnalyzePlan, so it is not a Spark Connect server.`,
  tokenlessCaution: (host: string, port: number) =>
    `This connection sends no token, and the server ran its calls: any client that reaches ${host}:${port} can run statements on this Spark server. Set spark.connect.authenticate.token on the server and in Token.`,
  tokenUnchecked: (host: string, port: number) =>
    `This connection sends a token, but the server also ran a call sent without one: it does not check tokens, so any client that reaches ${host}:${port} can run statements on this Spark server. Set spark.connect.authenticate.token on the server.`,
  unsent: "The statement was cancelled before it was sent.",
  localClientError: "The Spark client stopped the call before it reached the server. Nothing was sent.",
  connectionDropped:
    "The connection to Spark dropped while the statement ran. Studio asked Spark to stop it; run it again.",
  streamFailed: (statusText: string) =>
    statusText === ""
      ? "The connection to Spark failed while the statement ran. Studio asked Spark to stop it; run it again."
      : `The connection to Spark failed while the statement ran (${statusText}). Studio asked Spark to stop it; run it again.`,
  setupFailed: (step: string, statusText: string) =>
    statusText === ""
      ? `The connection to Spark failed while Studio set up the session with ${step}. Run it again.`
      : `The connection to Spark failed while Studio set up the session with ${step} (${statusText}). Run it again.`,
  pingGoaway:
    "The connection to Spark was closed by the server's keepalive rule while the statement ran. Studio asked Spark to stop the statement; run it again.",
  receiveCapCommand:
    "Spark answered this command in one message larger than Studio reads (16 MiB), and a command's answer cannot be split. Narrow it, for example with LIKE or IN.",
  receiveCapRelation:
    "Spark sent a result message larger than 16 MiB because result chunking is off in this session (spark.connect.session.resultChunking.maxChunkSize is 0 or less). Run SET spark.connect.session.resultChunking.maxChunkSize=4194304, or leave the setting out.",
  receiveCapControl:
    "Spark sent an answer larger than Studio reads in one message (16 MiB), so this request could not complete.",
  commandBatchBound:
    "Spark answers a command in one Arrow batch, and this answer is larger than the batch size this server allows (spark.connect.grpc.arrow.maxBatchSize). Narrow it, for example with LIKE or IN.",
  batchTooLarge: (mib: number) =>
    `Spark sends this result in Arrow batches of about ${mib} MiB, and the first one does not fit in the 32 MiB Studio reads for one statement, so no row is shown. Add a smaller LIMIT, or select fewer or narrower columns.`,
  deadline: (timeoutMs: number) =>
    `The statement ran past the connection's query timeout (${timeoutMs} ms); Studio asked Spark to stop it.`,
  deadlineBeforeSend: (timeoutMs: number) =>
    `The statement was not sent: the connection's query timeout (${timeoutMs} ms) passed before Studio could send it.`,
  setupDeadline: (step: string, timeoutMs: number) =>
    `Spark did not finish setting up the session with ${step} within the connection's query timeout (${timeoutMs} ms); the catalog may be slow to answer. Run it again, or raise Query Timeout in the connection.`,
  cancelled: "The query was cancelled.",
  sessionChanged: "The Spark server restarted during this request, and the session it held is gone. Run it again.",
  sessionClosed:
    "Spark closed the session this request was using (it idled out, or the server restarted). Run it again.",
  metadataSessionLost:
    "Studio's Spark session for the tree and the panels was closed by the server (it idled out or the server restarted), and a new one could not complete the read.",
  timeTypeOff: "TIME values are switched off on this Spark server; CAST the column to STRING to read it.",
  maxResultSize:
    "The result is larger than the server's spark.driver.maxResultSize; add a LIMIT or select fewer columns.",
  unknownEmpty:
    "Spark stopped this statement with an internal error and reported no reason (gRPC UNKNOWN). A statement nested thousands of levels deep is one known cause; the Spark driver log has the rest.",
  emptyStatus: (codeName: string) =>
    `The server ended this call with gRPC ${codeName} and gave no reason. The Spark driver log, or the log of a proxy in front of Spark, has the rest.`,
  compressed: (codec: string) =>
    `Spark compressed this result (spark.sql.execution.arrow.compression.codec is ${codec} in this session), and Studio reads only uncompressed results. Run SET spark.sql.execution.arrow.compression.codec=none, or leave the setting out.`,
  largeVarTypes:
    "Spark sent this result with large string and binary types (spark.sql.execution.arrow.useLargeVarTypes is true in this session), and Studio reads only the standard ones. Run SET spark.sql.execution.arrow.useLargeVarTypes=false, or leave the setting out.",
  unreadable: (what: string) => `Spark sent a result Studio could not read (${what}), so it is not shown.`,
  cellUnreadable: (type: string, column: string) =>
    `Spark sent ${articleOf(type)} ${type} value in column "${column}" that Studio could not read, so the result is not shown.`,
});

// gRPC status codes (grpc/grpc `doc/statuscodes.md`), the numbers grpc-js reports.
const CANCELLED = 1;
const UNKNOWN = 2;
const DEADLINE_EXCEEDED = 4;
const RESOURCE_EXHAUSTED = 8;
const UNIMPLEMENTED = 12;
const UNAVAILABLE = 14;
const UNAUTHENTICATED = 16;
/** Every name of that table, OK through UNAUTHENTICATED, by number: what a status that came with no text is called. */
const STATUS_NAMES: readonly string[] = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
];
const statusName = (code: number): string => STATUS_NAMES[code] ?? String(code);

/** grpc-js's deadline texts for a call still waiting before its request left (resolving-call.ts, load-balancing-call.ts). */
const PRE_SEND_DEADLINE = ["waiting for name resolution", "waiting for metadata filters", "Waiting for LB pick"];
const SYSTEM_NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);
const PLAINTEXT_SERVER = /wrong version number|WRONG_VERSION_NUMBER|packet length too long/;
const TLS_PORT_EXPECTED = /Protocol error/;
const UNTRUSTED =
  /unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate/;
// Measured under Bun and Node: a certificate that does not name the TLS identity, a name or an IP, and one outside its
// dates. A TLS proxy's two client-certificate alerts reach the text under Node, in OpenSSL's words, and under Bun from
// 1.4.4, in BoringSSL's capitals; Bun 1.4.2 said "Failed to connect", which reads as not-connected (tls-handshake.test.ts).
const NAME_MISMATCH = /does not match certificate's altnames|ERR_TLS_CERT_ALTNAME_INVALID/;
const CERTIFICATE_DATES = /certificate has expired|certificate is not yet valid/;
const CLIENT_CERTIFICATE_REQUIRED = /alert certificate required|ALERT_CERTIFICATE_REQUIRED/;
const CLIENT_CERTIFICATE_REFUSED = /alert (?:unknown ca|bad certificate)|ALERT_(?:UNKNOWN_CA|BAD_CERTIFICATE)/;
/** grpc-js's own text for its client's call.cancel() (call.ts); a peer's RST_STREAM CANCEL is "Call cancelled". */
const CLIENT_CANCEL = "Cancelled on client";
const PROXY_ANSWER = /^Received (?:RST_STREAM with code \d+|HTTP status code \d+)/;
const RECEIVE_CAP = "Received message larger than max";
const PING_GOAWAY = "Bandwidth exhausted or memory limit exceeded";
const BATCH_BOUND = "assertion failed: remaining batches:";

interface GrpcStatusLike {
  readonly code: number;
  readonly details: string;
  /** grpc-js's Metadata on a real status; a status-shaped value may carry anything, or nothing, here. */
  readonly metadata?: { readonly get?: (key: string) => readonly unknown[] | undefined } | null;
}

function isStatus(error: unknown): error is GrpcStatusLike {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "number" &&
    typeof (error as { details?: unknown }).details === "string"
  );
}

function errorInfoOf(status: GrpcStatusLike): SparkErrorInfo | undefined {
  const raw: unknown = status.metadata?.get?.("grpc-status-details-bin")?.[0];
  return raw instanceof Uint8Array ? readStatusDetails(raw) : undefined;
}

const inStatement = (context: SparkErrorContext) => context.phase === "command" || context.phase === "relation";

/** A message larger than the receive cap: a result message, a command's answer, or the answer of any other request. */
const RECEIVE_CAP_SENTENCES: Readonly<Record<SparkErrorContext["phase"], string>> = {
  connect: SPARK_ERROR_SENTENCES.receiveCapControl,
  control: SPARK_ERROR_SENTENCES.receiveCapControl,
  setup: SPARK_ERROR_SENTENCES.receiveCapControl,
  command: SPARK_ERROR_SENTENCES.receiveCapCommand,
  relation: SPARK_ERROR_SENTENCES.receiveCapRelation,
};

/** What a setup statement's sentences name, the statement and the timeout, which its context must carry. */
function setupOf(context: SparkErrorContext): { readonly step: string; readonly timeoutMs: number } {
  if (context.step === undefined || context.timeoutMs === undefined) {
    throw new TypeError("toSparkError: a setup statement's failure needs context.step and context.timeoutMs");
  }
  return { step: context.step, timeoutMs: context.timeoutMs };
}

/** The first `max` code points of `text`, so a cut never leaves half of a surrogate pair. */
function firstCodePoints(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count === max) return text.slice(0, end);
    end += point.length;
    count += 1;
  }
  return text;
}

function sparkMessage(status: GrpcStatusLike, info: SparkErrorInfo | undefined, context: SparkErrorContext): string {
  const forms = context.connection.secretForms;
  const text = serverText(status.details.trim(), forms);
  if (status.code === UNKNOWN && text === "" && info === undefined) return SPARK_ERROR_SENTENCES.unknownEmpty;
  // An empty text adds no line, so a message never starts with a blank one.
  const lines = text === "" ? [] : [text];
  // Cut only after serverText has read the whole cause, so a token that crosses the cut is still found.
  const cause =
    context.details?.cause === undefined
      ? ""
      : firstCodePoints(serverText(context.details.cause, forms), SPARK_ERROR_CAUSE_MAX_CHARS);
  if (cause !== "" && !text.includes(cause)) lines.push(`Cause: ${cause}`);
  if (lines.length === 0) lines.push(SPARK_ERROR_SENTENCES.emptyStatus(statusName(status.code)));
  if ((info?.errorClass ?? context.details?.errorClass) === "UNSUPPORTED_TIME_TYPE") {
    lines.push(SPARK_ERROR_SENTENCES.timeTypeOff);
  }
  if (text.includes("spark.driver.maxResultSize")) lines.push(SPARK_ERROR_SENTENCES.maxResultSize);
  return lines.join("\n");
}

/**
 * The category and sentence of any failure the provider meets. A `SparkError` is returned unchanged. The throws are a
 * caller's defect, a context without what the sentence names: a statement's deadline without `context.timeoutMs`, and a
 * setup statement's deadline or failed connection without `context.step` and `context.timeoutMs`.
 */
export function toSparkError(error: unknown, context: SparkErrorContext): SparkError {
  if (error instanceof SparkError) return error;
  if (error instanceof DatabaseConfigError) return new SparkError("config", error.message, { cause: error });
  const { host, port, secretForms } = context.connection;
  const options = { cause: error };
  const notConnected = () => new SparkError("not-connected", SPARK_ERROR_SENTENCES.notConnected(host, port), options);
  if (!isStatus(error)) {
    const code = (error as { readonly code?: unknown } | null | undefined)?.code;
    if (typeof code === "string" && SYSTEM_NOT_CONNECTED.has(code)) return notConnected();
    // Never its own message: a local error of grpc-js can repeat a header value, and `authorization` holds the token.
    return new SparkError("spark", SPARK_ERROR_SENTENCES.localClientError, options);
  }
  const { code, details } = error;
  const statusText = () => serverText(details.trim(), secretForms);
  const streamFailed = () => new SparkError("stream-failed", SPARK_ERROR_SENTENCES.streamFailed(statusText()), options);
  const setupFailed = () =>
    new SparkError("stream-failed", SPARK_ERROR_SENTENCES.setupFailed(setupOf(context).step, statusText()), options);
  // A setup statement follows the session's Config set, which the server answered, so its failure is never read as a
  // server that did not answer.
  const unreachable = () => (context.phase === "setup" ? setupFailed() : notConnected());
  // Outside a statement of the user's none was asked to stop: in connect and control such a failure reads as
  // not-connected, and in a setup statement as the setup's failed connection.
  const inStatementOr = (failure: () => SparkError) => (inStatement(context) ? failure() : unreachable());
  switch (code) {
    case CANCELLED:
      // Only grpc-js's own client cancel is the user's; any other is a peer's reset of the stream.
      if (details === CLIENT_CANCEL) return new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled, options);
      return inStatementOr(streamFailed);
    case DEADLINE_EXCEEDED:
      // A setup statement's deadline is the query timeout from the setup's start, whether or not the statement left.
      if (context.phase === "setup") {
        const { step, timeoutMs } = setupOf(context);
        return new SparkError("deadline", SPARK_ERROR_SENTENCES.setupDeadline(step, timeoutMs), options);
      }
      if (!details.includes("remote_addr=") && PRE_SEND_DEADLINE.some((marker) => details.includes(marker))) {
        return notConnected();
      }
      if (!inStatement(context)) return notConnected();
      if (context.timeoutMs === undefined) {
        throw new TypeError("toSparkError: a statement's deadline needs context.timeoutMs");
      }
      return new SparkError("deadline", SPARK_ERROR_SENTENCES.deadline(context.timeoutMs), options);
    case UNAUTHENTICATED:
      return new SparkError(
        "unauthenticated",
        details.includes("No authentication token provided")
          ? SPARK_ERROR_SENTENCES.tokenMissing
          : SPARK_ERROR_SENTENCES.tokenWrong,
        options,
      );
    case UNIMPLEMENTED:
      return new SparkError("unimplemented", SPARK_ERROR_SENTENCES.notSparkConnect(host, port), options);
    case RESOURCE_EXHAUSTED:
      if (details.includes(RECEIVE_CAP)) {
        return new SparkError("receive-cap", RECEIVE_CAP_SENTENCES[context.phase], options);
      }
      if (details === PING_GOAWAY) {
        return inStatementOr(() => new SparkError("ping-goaway", SPARK_ERROR_SENTENCES.pingGoaway, options));
      }
      return new SparkError("spark", sparkMessage(error, undefined, context), options);
    case UNAVAILABLE:
      if (details.startsWith("Connection dropped")) {
        return inStatementOr(
          () => new SparkError("connection-dropped", SPARK_ERROR_SENTENCES.connectionDropped, options),
        );
      }
      if (PLAINTEXT_SERVER.test(details)) {
        return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsPlaintextServer(host, port), options);
      }
      if (TLS_PORT_EXPECTED.test(details)) {
        return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsPortExpected(host, port), options);
      }
      if (UNTRUSTED.test(details)) return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsUntrusted, options);
      if (NAME_MISMATCH.test(details)) {
        return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsNameMismatch(host), options);
      }
      if (CERTIFICATE_DATES.test(details)) {
        return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsCertificateDates, options);
      }
      if (CLIENT_CERTIFICATE_REQUIRED.test(details)) {
        return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsClientCertificateRequired, options);
      }
      if (CLIENT_CERTIFICATE_REFUSED.test(details)) {
        return new SparkError("tls", SPARK_ERROR_SENTENCES.tlsClientCertificateRefused, options);
      }
      if (details.includes("No connection established") || details.startsWith("Name resolution failed")) {
        return unreachable();
      }
      return inStatementOr(streamFailed);
  }
  const info = errorInfoOf(error);
  // A proxy's answer carries no ErrorInfo; tested before the spark row, which also claims INTERNAL.
  if (info === undefined && PROXY_ANSWER.test(details)) return inStatementOr(streamFailed);
  // Spark's own bound on a command answer: one Arrow batch (captured as command-over-batch-bound).
  if (
    context.phase === "command" &&
    info?.reason === "java.lang.AssertionError" &&
    info.errorClass === undefined &&
    info.sqlState === undefined &&
    details.trim().startsWith(BATCH_BOUND)
  ) {
    return new SparkError("command-batch-bound", SPARK_ERROR_SENTENCES.commandBatchBound, options);
  }
  const errorClass = info?.errorClass ?? context.details?.errorClass;
  if (errorClass === "OPERATION_CANCELED" || info?.sqlState === "HY008") {
    return new SparkError("cancelled", SPARK_ERROR_SENTENCES.cancelled, options);
  }
  if (errorClass === "INVALID_HANDLE.SESSION_CLOSED" || errorClass === "INVALID_HANDLE.SESSION_NOT_FOUND") {
    return new SparkError("session-closed", SPARK_ERROR_SENTENCES.sessionClosed, options);
  }
  if (errorClass === "INVALID_HANDLE.SESSION_CHANGED") {
    return new SparkError("session-changed", SPARK_ERROR_SENTENCES.sessionChanged, options);
  }
  return new SparkError("spark", sparkMessage(error, info, context), options);
}

interface FetchedError {
  readonly message?: unknown;
  readonly cause_idx?: unknown;
  readonly spark_throwable?: { readonly error_class?: unknown } | null;
}

/**
 * The FetchErrorDetails answer's root class and innermost cause, trimmed, at most `SPARK_ERROR_CAUSES_MAX` causes
 * walked; never a stack frame. The cause is kept whole: `toSparkError` cuts it to `SPARK_ERROR_CAUSE_MAX_CHARS` after
 * `serverText` has read all of it.
 */
export function errorDetailsFromResponse(response: object): SparkErrorDetails {
  const { root_error_idx: rootIndex, errors } = response as {
    readonly root_error_idx?: unknown;
    readonly errors?: unknown;
  };
  if (!Array.isArray(errors)) return {};
  const at = (index: unknown): FetchedError | undefined => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= errors.length) return undefined;
    const error: unknown = errors[index];
    return typeof error === "object" && error !== null ? (error as FetchedError) : undefined;
  };
  const root = at(rootIndex ?? 0);
  if (root === undefined) return {};
  const errorClass = root.spark_throwable?.error_class;
  let current = root;
  let innermost: FetchedError | undefined;
  for (let step = 0; step < SPARK_ERROR_CAUSES_MAX; step += 1) {
    const next = at(current.cause_idx);
    if (next === undefined) break;
    innermost = next;
    current = next;
  }
  const cause = typeof innermost?.message === "string" ? innermost.message.trim() : "";
  return {
    ...(typeof errorClass === "string" && errorClass !== "" ? { errorClass } : {}),
    ...(cause === "" ? {} : { cause }),
  };
}

/**
 * A server's version text as a version sentence may quote it: trimmed, passed through `serverText`, then cut to
 * `SPARK_VERSION_TEXT_MAX_CHARS` code points. A text `serverText` withheld comes back whole: the cut is for the
 * server's own text, and would leave half of the withheld sentence.
 */
export function sparkVersionText(raw: string, secretForms: readonly string[]): string {
  const trimmed = raw.trim();
  const text = serverText(trimmed, secretForms);
  return text === trimmed ? firstCodePoints(text, SPARK_VERSION_TEXT_MAX_CHARS) : text;
}

/** The repository's error class for a failure, at the provider boundary. */
export function toDatabaseError(error: unknown, sql?: string): Error {
  if (!(error instanceof SparkError))
    return error instanceof Error ? error : new QueryError(String(error), "spark", sql);
  switch (error.category) {
    case "config":
      return new DatabaseConfigError(error.message, "spark");
    case "unsent":
    case "cancelled":
      return new QueryCancelledError(error.message, "spark", sql);
    case "not-connected":
    case "tls":
    case "connection-dropped":
    case "stream-failed":
    case "unimplemented":
    case "version":
      return new ConnectionError(error.message, "spark");
    case "unauthenticated":
      return new AuthenticationError(error.message, "spark");
    default:
      return new QueryError(error.message, "spark", sql);
  }
}
