/**
 * Every failure of an S3 request in the user's words.
 *
 * `toProviderError` is the one entry point. Rows are tried in order and the first match wins. Classification reads the
 * raw code, message, region and region header, and only a value a chosen sentence quotes passes `serverText` with the
 * connection's secret forms: Garage's only discriminator for an unknown key is a message that contains the access key
 * ID, so withholding before classifying would turn every Garage unknown key into a permission refusal. A code is
 * quoted only when it is a plain token, a region only when it matches the region pattern, a message only cut to 300
 * characters and only by E10, E30 and E33, and a request id only by E33. No raw value is stored on the error this
 * returns: its message is the finished sentence. Nothing is retried.
 *
 * `S3ServerError` is internal: it extends `Error`, not `DatabaseError`, so row E0a never passes it through. The
 * client notes the bucket, key, prefix and response cap of every failed request in a side table, so a transport
 * failure is worded with the names of its operation while it stays the same instance.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { serverText } from "@/lib/db/utils/server-text";
import type { S3ClientContext, S3Operation } from "./client";
import {
  S3_CLOCK_WINDOW_MS,
  S3_CURSOR_TOKEN_MAX_CHARS,
  S3_REGION_PATTERN,
  S3_SERVER_TEXT_CHARS,
  S3_SURFACE_DEADLINE_MS,
  S3_TYPE,
  S3_XML_MAX_ELEMENTS,
} from "./constants";
import { firstHeader } from "./headers";
import { shownName } from "./names";
import type { XmlRefusal } from "./xml";

/** What was wrong with an answer itself, found by the client before any code was read. */
export type S3AnswerProblem =
  | { readonly kind: "compressed"; readonly contentEncoding: string }
  | { readonly kind: "not-s3"; readonly xml?: XmlRefusal }
  | { readonly kind: "page"; readonly what: string }
  | { readonly kind: "token" };

export interface S3ServerErrorFields {
  readonly operation: S3Operation;
  readonly method: "GET" | "HEAD";
  readonly status: number;
  /** From the XML `Code`, else `x-minio-error-code`. */
  readonly code?: string;
  /** The XML `Message`. */
  readonly message?: string;
  /** The XML `Region`. */
  readonly region?: string;
  /** `x-amz-bucket-region`. */
  readonly bucketRegion?: string;
  /** The `date` header. */
  readonly serverDate?: string;
  readonly deleteMarker?: boolean;
  /** `x-amz-request-id`, else `x-request-id`. */
  readonly requestId?: string;
  /** Whether the request carried a continuation token. */
  readonly sentToken?: boolean;
  readonly bucket?: string;
  readonly key?: string;
  /** The list prefix sent, for E27. */
  readonly prefix?: string;
  readonly problem?: S3AnswerProblem;
}

export class S3ServerError extends Error {
  declare readonly operation: S3Operation;
  declare readonly method: "GET" | "HEAD";
  declare readonly status: number;
  declare readonly code?: string;
  /** The server's `Message`; `Error.message` stays a fixed text, so no server text reaches a log through it. */
  declare readonly serverMessage?: string;
  declare readonly region?: string;
  declare readonly bucketRegion?: string;
  declare readonly serverDate?: string;
  declare readonly deleteMarker?: boolean;
  declare readonly requestId?: string;
  declare readonly sentToken?: boolean;
  declare readonly bucket?: string;
  declare readonly key?: string;
  declare readonly prefix?: string;
  declare readonly problem?: S3AnswerProblem;

  constructor(fields: S3ServerErrorFields) {
    super(`S3 ${fields.operation} answered HTTP ${fields.status}`);
    const { message, ...rest } = fields;
    Object.assign(this, rest, message === undefined ? {} : { serverMessage: message });
    this.name = "S3ServerError";
    Object.setPrototypeOf(this, S3ServerError.prototype);
  }
}

/** The fields an error was built from, the server's message under `message` again. */
export function fieldsOf(error: S3ServerError): S3ServerErrorFields {
  const fields: Record<string, unknown> = {};
  for (const name of [
    "operation",
    "method",
    "status",
    "code",
    "region",
    "bucketRegion",
    "serverDate",
    "deleteMarker",
    "requestId",
    "sentToken",
    "bucket",
    "key",
    "prefix",
    "problem",
  ] as const) {
    if (error[name] !== undefined) fields[name] = error[name];
  }
  if (error.serverMessage !== undefined) fields.message = error.serverMessage;
  return fields as unknown as S3ServerErrorFields;
}

/** The names and cap of the request a failure came from; the client notes them on every failure it passes on. */
export interface S3RequestNames {
  readonly bucket?: string;
  readonly key?: string;
  readonly prefix?: string;
  readonly capBytes?: number;
}

const REQUEST_NAMES = new WeakMap<object, S3RequestNames>();

/** Notes the names of the request a failure came from; the first note of one failure wins. */
export function noteRequestNames(error: unknown, names: S3RequestNames): void {
  if (typeof error === "object" && error !== null && !REQUEST_NAMES.has(error)) REQUEST_NAMES.set(error, names);
}

export interface S3FailureDetails {
  /** The session's lifetime: aborted by disconnect() (rows E0c and E3). */
  readonly lifetime?: AbortSignal;
  /** The signal the failed call ran under: a cancel's reason is the registry's QueryCancelledError (row E2). */
  readonly signal?: AbortSignal;
  /** The deadline the failed call ran under, for row E1. */
  readonly timeoutMs?: number;
}

interface Verb {
  /** `${op}`, given the shown bucket and key. */
  readonly op: (bucket: string, key: string) => string;
  /** `${action}`: the IAM action. */
  readonly action: string;
  readonly noun: "bucket" | "object";
  /** Whether E20 names the bucket or object. */
  readonly named: boolean;
}

/** "a bucket", "an object". */
function withArticle(noun: Verb["noun"]): string {
  return noun === "object" ? `an ${noun}` : `a ${noun}`;
}

const listBucket = (bucket: string): string => `list bucket ${bucket}`;
const readObject = (bucket: string, key: string): string => `read object ${key} in bucket ${bucket}`;

/** Each operation's words, IAM action and noun, in the order of `S3Operation`. */
export const S3_VERBS: Readonly<Record<S3Operation, Verb>> = Object.freeze({
  ListBuckets: { op: () => "list buckets", action: "s3:ListAllMyBuckets", noun: "bucket", named: false },
  HeadBucket: { op: listBucket, action: "s3:ListBucket", noun: "bucket", named: true },
  GetBucketLocation: {
    op: (bucket) => `read the location of bucket ${bucket}`,
    action: "s3:GetBucketLocation",
    noun: "bucket",
    named: true,
  },
  GetBucketVersioning: {
    op: (bucket) => `read the versioning of bucket ${bucket}`,
    action: "s3:GetBucketVersioning",
    noun: "bucket",
    named: true,
  },
  ListObjectsV2: { op: listBucket, action: "s3:ListBucket", noun: "bucket", named: true },
  ListObjectVersions: {
    op: (bucket) => `list object versions in bucket ${bucket}`,
    action: "s3:ListBucketVersions",
    noun: "bucket",
    named: true,
  },
  HeadObject: { op: readObject, action: "s3:GetObject", noun: "object", named: true },
  GetObject: { op: readObject, action: "s3:GetObject", noun: "object", named: true },
  GetObjectTagging: {
    op: (_bucket, key) => `read the tags of object ${key}`,
    action: "s3:GetObjectTagging",
    noun: "object",
    named: true,
  },
});

/** Every sentence this mapping writes, frozen, so the provider doc's test reads them back. */
export const S3_ERROR_SENTENCES = Object.freeze({
  timeout: (endpoint: string, op: string, seconds: string): string =>
    `The S3 server at ${endpoint} did not answer ${op} within ${seconds} seconds; nothing was retried.`,
  cancelled: "The query was cancelled.",
  closed: "The connection was closed while a request to the S3 server was in flight.",
  tooLarge: (op: string, cap: string): string =>
    `The server's answer to ${op} passed ${cap}, the most Studio reads for it, so it was dropped; narrow the prefix.`,
  bucketListTooLarge: (cap: string): string =>
    `The server's list of buckets passed ${cap}, the most Studio reads for it: set Bucket on the connection to read one bucket without listing them.`,
  bucketRegion: (region: string, signing: string): string =>
    `This bucket is in region ${region}, and this connection signs for ${signing}: set Region to ${region}.`,
  redirect: (op: string, status: number): string =>
    `The endpoint answered ${op} with a redirect (HTTP ${status}), which Studio does not follow. Check that Host and Port name the S3 API, not a web console: MinIO and RustFS serve their consoles on another port. An AWS bucket in another region answers this way when the server does not name the region: set Region to the bucket's region.`,
  unreachable: (endpoint: string, message: string): string =>
    `Could not reach the S3 server at ${endpoint}: ${message}`,
  compressed: (op: string, encoding: string): string =>
    `The server answered ${op} with a compressed body (${encoding}), which Studio does not decode: turn off compression in front of the S3 API.`,
  unsignedHeader:
    "The server refused a request header Studio did not sign. This is a defect in Studio; report it with the server's name and version.",
  signingRegion: (region: string, signing: string): string =>
    `This server expects requests signed for region ${region}, and this connection signs for ${signing}: set Region to ${region}.`,
  signingScope: (signing: string, message: string | undefined): string =>
    `The server refused this connection's signing scope (region ${signing}): check Region.${message === undefined ? "" : ` The server said: ${message}`}`,
  signature:
    "The server refused the request signature: check Secret access key. A proxy between Studio and the server that changes the Host header or the request path causes the same refusal.",
  unknownKey: "The server does not know this access key ID: check Access key ID.",
  skew: (minutes: number): string =>
    `This machine's clock and the server's differ by about ${minutes} minutes, more than the server accepts: correct the clock on this machine or on the server.`,
  skewUnmeasured:
    "This machine's clock and the server's differ by more than the server accepts: correct the clock on this machine or on the server.",
  anonymous: "This server takes no unsigned requests: fill in Access key ID and Secret access key.",
  noBucket: (bucket: string): string => `The server has no bucket ${bucket}.`,
  deleteMarker: (key: string, bucket: string): string =>
    `The latest version of ${key} in bucket ${bucket} is a delete marker: the object was deleted.`,
  noKey: (key: string, bucket: string): string => `The server has no object ${key} in bucket ${bucket}.`,
  headNotFound: (key: string, bucket: string): string =>
    `The server answered 404 Not Found for ${key} in bucket ${bucket}: the object, or the bucket, does not exist.`,
  notS3: (op: string): string =>
    `The endpoint answered ${op} with something that is not an S3 answer: check that Port is the S3 API port (MinIO and RustFS serve their consoles on another port).`,
  deniedSigned: (op: string, action: string, noun: Verb["noun"], name: string | undefined): string =>
    name === undefined
      ? `This access key may not ${op} (${action}). The server answers the same way for ${withArticle(noun)} that does not exist.`
      : `This access key may not ${op} (${action}). The server answers the same way for ${withArticle(noun)} that does not exist, so this does not say that ${noun} ${name} exists.`,
  deniedUnsigned: (op: string, action: string, noun: Verb["noun"]): string =>
    `An unsigned request may not ${op} (${action}): fill in Access key ID and Secret access key, or check that the ${noun} allows anonymous reads. The server answers the same way for ${withArticle(noun)} that does not exist.`,
  deniedBucketListHint: "A key limited to some buckets works with one of them under Bucket.",
  page: (op: string, what: string): string =>
    `The server answered ${op} with ${what}, which a page cannot hold, so the page was not shown.`,
  tokenTooLong: `The server's continuation token is longer than ${S3_CURSOR_TOKEN_MAX_CHARS.toLocaleString("en-US")} characters, so Studio cannot read on past this point: narrow the prefix.`,
  cursorTooLong:
    "The position of the next page is too long for a Keys panel cursor, so the Keys panel cannot page past this point: narrow the prefix.",
  tokenRefused: "The server refused this page's continuation token: list this folder again from its start.",
  noVersions: "This server does not keep object versions: it answered 501 Not Implemented to ListObjectVersions.",
  notImplemented: (op: string): string => `This server does not implement ${op}: it answered 501 Not Implemented.`,
  objectName: "The server refuses this object name: it holds characters or empty segments the server does not store.",
  dotSegment:
    "The server refuses a name with a . or .. segment or an empty segment, here in the key or the prefix: type it without such a segment.",
  archived: (key: string): string => `${key} is archived and must be restored before it can be read.`,
  overloaded: (code: string): string => `The server is overloaded (${code}); nothing was retried. Try again later.`,
  serverFailed: (op: string, code: string, message: string | undefined): string =>
    `The server failed while answering ${op} (${code}).${message === undefined ? "" : ` ${message}`}`,
  headBadRequest: (op: string, signing: string): string =>
    `The server refused ${op} with 400 Bad Request and no reason. Garage answers a wrong region this way: check Region (this connection signs for ${signing}).`,
  notS3Error: (status: number, op: string): string =>
    `The server answered HTTP ${status} to ${op} with a body that is not an S3 error document. Check that Host and Port name the S3 API.`,
  refused: (op: string, code: string, message: string | undefined, requestId: string | undefined): string =>
    `The server refused ${op}: ${code}${message === undefined ? "" : `: ${message}`}${requestId === undefined ? "" : ` (request id ${requestId})`}`,
  noReason: (status: number, op: string): string => `The server answered HTTP ${status} to ${op} with no reason.`,
});

const KIB = 1024;
const MIB = 1024 * 1024;
const CODE = /^[A-Za-z0-9.]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:+=/-]{1,128}$/;
const ENCODING = /^[A-Za-z0-9._-]{1,64}$/;
const ANONYMOUS = /anonymous access/i;
const XML_ELEMENTS_CAP = `${S3_XML_MAX_ELEMENTS.toLocaleString("en-US")} XML elements`;

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(1)));
}

function capWords(bytes: number): string {
  if (bytes > 0 && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes > 0 && bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return bytes === 1 ? "1 byte" : `${bytes.toLocaleString("en-US")} bytes`;
}

function opWords(operation: S3Operation, names: { readonly bucket?: string; readonly key?: string }): string {
  return S3_VERBS[operation].op(shownName(names.bucket ?? ""), shownName(names.key ?? ""));
}

/** A server-named region, when it may be quoted. */
function quotableRegion(raw: string | undefined, context: S3ClientContext): string | undefined {
  return raw !== undefined && S3_REGION_PATTERN.test(raw) && serverText(raw, context.secretForms) === raw
    ? raw
    : undefined;
}

function codeWords(code: string | undefined, status: number, context: S3ClientContext): string {
  if (code === undefined) return `HTTP ${status}`;
  return CODE.test(code) && serverText(code, context.secretForms) === code ? code : "an unnamed code";
}

function messageWords(message: string | undefined, context: S3ClientContext): string | undefined {
  if (message === undefined || message === "") return undefined;
  return Array.from(serverText(message, context.secretForms)).slice(0, S3_SERVER_TEXT_CHARS).join("");
}

function requestIdWords(requestId: string | undefined, context: S3ClientContext): string | undefined {
  return requestId !== undefined &&
    REQUEST_ID.test(requestId) &&
    serverText(requestId, context.secretForms) === requestId
    ? requestId
    : undefined;
}

function clockSkewMs(serverDate: string | undefined, clock: () => Date): number | undefined {
  if (serverDate === undefined) return undefined;
  const time = Date.parse(serverDate);
  return Number.isFinite(time) ? Math.abs(time - clock().getTime()) : undefined;
}

/** A ".", ".." or empty segment, the empty segment a trailing "/" leaves aside. */
function hasDotSegment(name: string | undefined): boolean {
  if (name === undefined) return false;
  const segments = name.split("/");
  if (segments[segments.length - 1] === "") segments.pop();
  return segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function timeoutError(op: string, context: S3ClientContext, details: S3FailureDetails): TimeoutError {
  const ms = details.timeoutMs ?? S3_SURFACE_DEADLINE_MS;
  return new TimeoutError(S3_ERROR_SENTENCES.timeout(context.endpointText, op, seconds(ms)), S3_TYPE, ms);
}

function transportFailure(
  error: TransportError,
  operation: S3Operation,
  names: S3RequestNames,
  context: S3ClientContext,
  details: S3FailureDetails,
): Error {
  const op = opWords(operation, names);
  switch (error.kind) {
    case "timeout":
      return timeoutError(op, context, details);
    case "aborted": {
      const reason: unknown = details.signal?.reason;
      if (reason instanceof QueryCancelledError) return reason;
      return new ConnectionError(S3_ERROR_SENTENCES.closed, S3_TYPE);
    }
    case "too-large": {
      const cap = capWords(names.capBytes ?? 0);
      return new QueryError(
        operation === "ListBuckets" ? S3_ERROR_SENTENCES.bucketListTooLarge(cap) : S3_ERROR_SENTENCES.tooLarge(op, cap),
        S3_TYPE,
      );
    }
    case "redirect": {
      const region = quotableRegion(firstHeader(error.redirect?.headers ?? [], "x-amz-bucket-region"), context);
      if (region !== undefined && region !== context.region)
        return new DatabaseConfigError(S3_ERROR_SENTENCES.bucketRegion(region, context.region), S3_TYPE);
      return new ConnectionError(S3_ERROR_SENTENCES.redirect(op, error.redirect?.status ?? 301), S3_TYPE);
    }
    default:
      return new ConnectionError(S3_ERROR_SENTENCES.unreachable(context.endpointText, error.message), S3_TYPE);
  }
}

function denied(error: S3ServerError, op: string, context: S3ClientContext): string {
  const verb = S3_VERBS[error.operation];
  const name = !verb.named
    ? undefined
    : verb.noun === "bucket"
      ? shownName(error.bucket ?? "")
      : shownName(error.key ?? "");
  const sentence = context.signs
    ? S3_ERROR_SENTENCES.deniedSigned(op, verb.action, verb.noun, name)
    : S3_ERROR_SENTENCES.deniedUnsigned(op, verb.action, verb.noun);
  return error.operation === "ListBuckets" ? `${sentence} ${S3_ERROR_SENTENCES.deniedBucketListHint}` : sentence;
}

/** Rows E7b to E34, in order. */
function serverFailure(error: S3ServerError, context: S3ClientContext): Error {
  const b = shownName(error.bucket ?? "");
  const k = shownName(error.key ?? "");
  const op = S3_VERBS[error.operation].op(b, k);
  const { status, code, problem } = error;
  const message = error.serverMessage ?? "";
  const signing = context.region;
  const sentence = S3_ERROR_SENTENCES;
  if (problem?.kind === "compressed") {
    const encoding = ENCODING.test(problem.contentEncoding) ? problem.contentEncoding : "an unnamed encoding";
    return new QueryError(sentence.compressed(op, encoding), S3_TYPE);
  }
  if (
    status === 400 &&
    ((code === "AccessDenied" && message.includes("not signed")) ||
      (code === "InvalidRequest" && message.includes("X-Amz-Content-Sha256")))
  )
    return new QueryError(sentence.unsignedHeader, S3_TYPE);
  if (context.signs) {
    const named = quotableRegion(error.region, context) ?? quotableRegion(error.bucketRegion, context);
    if (code === "AuthorizationHeaderMalformed" && named !== undefined && named !== signing)
      return new DatabaseConfigError(sentence.signingRegion(named, signing), S3_TYPE);
    const headRegion = quotableRegion(error.bucketRegion, context);
    if (
      error.method === "HEAD" &&
      (status === 301 || status === 400) &&
      code === undefined &&
      headRegion !== undefined &&
      headRegion !== signing
    )
      return new DatabaseConfigError(sentence.signingRegion(headRegion, signing), S3_TYPE);
  }
  if (code === "AuthorizationHeaderMalformed")
    return new DatabaseConfigError(sentence.signingScope(signing, messageWords(message, context)), S3_TYPE);
  if (
    code === "SignatureDoesNotMatch" ||
    (code === "AccessDenied" && message.startsWith("Forbidden: Invalid signature"))
  )
    return new AuthenticationError(sentence.signature, S3_TYPE);
  if (code === "InvalidAccessKeyId" || (code === "AccessDenied" && message.startsWith("Forbidden: No such key")))
    return new AuthenticationError(sentence.unknownKey, S3_TYPE);
  const skewMs = clockSkewMs(error.serverDate, context.clock);
  if (
    code === "RequestTimeTooSkewed" ||
    (code === "InvalidRequest" && message === "Date is too old") ||
    (status === 403 && code === undefined && skewMs !== undefined && skewMs > S3_CLOCK_WINDOW_MS)
  )
    return new AuthenticationError(
      skewMs === undefined ? sentence.skewUnmeasured : sentence.skew(Math.round(skewMs / 60_000)),
      S3_TYPE,
    );
  if (code === "AccessDenied" && ANONYMOUS.test(message)) return new AuthenticationError(sentence.anonymous, S3_TYPE);
  if (code === "NoSuchBucket" || (status === 404 && error.operation === "HeadBucket"))
    return new QueryError(sentence.noBucket(b), S3_TYPE);
  if (status === 404 && error.deleteMarker === true) return new QueryError(sentence.deleteMarker(k, b), S3_TYPE);
  if (code === "NoSuchKey") return new QueryError(sentence.noKey(k, b), S3_TYPE);
  if (status === 404 && error.operation === "HeadObject" && code === undefined)
    return new QueryError(sentence.headNotFound(k, b), S3_TYPE);
  if (problem?.kind === "not-s3" && status >= 200 && status < 300)
    return new QueryError(
      error.operation === "ListBuckets" && problem.xml === "too-many"
        ? sentence.bucketListTooLarge(XML_ELEMENTS_CAP)
        : sentence.notS3(op),
      S3_TYPE,
    );
  if (code === "AccessDenied" || (status === 403 && code === undefined))
    return new QueryError(denied(error, op, context), S3_TYPE);
  if (problem?.kind === "page") return new QueryError(sentence.page(op, problem.what), S3_TYPE);
  if (problem?.kind === "token") return new QueryError(sentence.tokenTooLong, S3_TYPE);
  if (
    error.sentToken === true &&
    (code === "NotImplemented" || ((code === "InvalidArgument" || code === "InvalidRequest") && /token/i.test(message)))
  )
    return new QueryError(sentence.tokenRefused, S3_TYPE);
  if (code === "NotImplemented")
    return new QueryError(
      error.operation === "ListObjectVersions" ? sentence.noVersions : sentence.notImplemented(op),
      S3_TYPE,
    );
  if (code === "XMinioInvalidObjectName") return new QueryError(sentence.objectName, S3_TYPE);
  if (code === "XMinioInvalidResourceName" || (code === "InvalidArgument" && hasDotSegment(error.key ?? error.prefix)))
    return new QueryError(sentence.dotSegment, S3_TYPE);
  if (code === "InvalidObjectState") return new QueryError(sentence.archived(k), S3_TYPE);
  if (code === "SlowDown" || status === 503)
    return new ConnectionError(sentence.overloaded(codeWords(code, status, context)), S3_TYPE);
  if (status >= 500 && status <= 599)
    return new QueryError(
      sentence.serverFailed(op, codeWords(code, status, context), messageWords(message, context)),
      S3_TYPE,
    );
  if (error.method === "HEAD" && status === 400 && code === undefined)
    return new QueryError(sentence.headBadRequest(op, signing), S3_TYPE);
  if (problem?.kind === "not-s3") return new QueryError(sentence.notS3Error(status, op), S3_TYPE);
  if (code !== undefined)
    return new QueryError(
      sentence.refused(
        op,
        codeWords(code, status, context),
        messageWords(message, context),
        requestIdWords(error.requestId, context),
      ),
      S3_TYPE,
    );
  return new QueryError(sentence.noReason(status, op), S3_TYPE);
}

/**
 * The one entry point: a failure of `operation` in the user's words. Rows E0a to E0d decide what is not a transport
 * failure or a server answer: a DatabaseError other than a TransportError passes as the same
 * instance; a permit wait the deadline ended is E1; any other rejection after the session's lifetime ended is E3;
 * anything else is a defect and is rethrown as the same value, never reworded.
 */
export function toProviderError(
  error: unknown,
  operation: S3Operation,
  context: S3ClientContext,
  details: S3FailureDetails = {},
): unknown {
  if (error instanceof DatabaseError && !(error instanceof TransportError)) return error;
  const names = typeof error === "object" && error !== null ? (REQUEST_NAMES.get(error) ?? {}) : {};
  if (error instanceof DOMException && error.name === "TimeoutError")
    return timeoutError(opWords(operation, names), context, details);
  if (error instanceof TransportError) return transportFailure(error, operation, names, context, details);
  if (error instanceof S3ServerError) return serverFailure(error, context);
  if (details.lifetime?.aborted === true) return new ConnectionError(S3_ERROR_SENTENCES.closed, S3_TYPE);
  return error;
}
