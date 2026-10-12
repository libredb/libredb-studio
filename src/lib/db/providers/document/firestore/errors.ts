/**
 * Every failure of a Firestore request in the user's words (spec 8.1).
 *
 * `readGoogleError` reads Google's error envelope, including the error element of a streamed answer;
 * `mapGoogleError` tries the rows in order and the first match wins; every sentence leads with Google's message and
 * reason when Google sent them. The first row of spec 8.1, a token endpoint refusal, belongs to the token source;
 * the two probe rows are 200 answers and live in `databaseResourceRefusal`. A transport failure is matched by its
 * name and kind, so this module imports no transport and stays browser-safe.
 */
import {
  AuthenticationError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { FIRESTORE_TYPE, type FirestoreTarget, LIMITS, SENTENCES } from "./constants";

/**
 * `FirestoreRequest["kind"]`, spelt here so this module imports nothing from `requests.ts`; requests.test.ts pins the
 * two equal.
 */
export type RequestKind =
  | "database"
  | "get"
  | "listDocuments"
  | "listCollectionIds"
  | "runQuery"
  | "runAggregationQuery"
  | "batchGet";

export interface GoogleError {
  readonly httpStatus: number;
  readonly status?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly links?: readonly string[];
  /** Google's `RetryInfo.retryDelay`, such as "30s". */
  readonly retryDelay?: string;
  /** The `Retry-After` header as sent (seconds or an HTTP date); the transport fills it, since only it sees headers. */
  readonly retryAfter?: string;
  readonly permission?: string;
  /** The envelope's numeric `error.code`; it names the failure when a 2xx stream ends in an error element. */
  readonly code?: number;
}

export type CallPhase = "connect" | "statement" | "listing";

export interface ErrorContext {
  readonly phase: CallPhase;
  readonly credential: "service_account" | "authorized_user" | "access_token" | "metadata" | "emulator";
  readonly target: FirestoreTarget;
  readonly aggregation?: boolean;
  readonly surface?: "console" | "keys" | "source" | "tree";
  /** The credential's forms (`secretForms` of the server-text module); a message holding one is withheld. */
  readonly secretForms?: readonly string[];
  /** The request that failed; a `get` too large for its cap gets the one-document sentence. */
  readonly requestKind?: RequestKind;
}

/** Index creation links are long, so a message keeps up to this many characters. */
const GOOGLE_MESSAGE_MAX_CHARS = 2_000;
const PERMISSION = /\bdatastore\.[a-zA-Z]+\.[a-zA-Z]+\b/;
const QUOTA_PROJECT = /quota project/i;
const EMULATOR_DATASTORE_MODE = "Database mode not set to Firestore Mode";

export const ERROR_SENTENCES = Object.freeze({
  withheld: "Google's message was withheld because it quotes the credential",
  httpStatus: (status: number): string => `Firestore answered HTTP ${status}`,
  emulatorDatastoreMode:
    "The Firestore emulator was started in Datastore mode; start it in Firestore mode and connect again",
  databaseNotFound: (target: FirestoreTarget): string =>
    `Google found no Firestore database "${target.databaseId}" in project "${target.projectId}"; check the Project ID and Database ID fields`,
  accessTokenRefused:
    "The pasted access token was refused; tokens from gcloud auth print-access-token last about an hour: paste a new one, or use a service-account key",
  credentialRefused:
    "Google refused the credential; check that it is current and that its principal can reach this project",
  apiDisabled: (projectId: string, link: string | undefined): string =>
    `The Firestore API is disabled on project "${projectId}"; enable it${link === undefined ? "" : ` at ${link}`} and connect again`,
  quotaProject: (projectId: string): string =>
    `This authorized-user credential needs a quota project: run gcloud auth application-default set-quota-project ${projectId}, then paste the file again`,
  permission: (permission: string | undefined): string =>
    `${permission === undefined ? "The credential lacks a Firestore permission this read needs" : `The credential lacks the Firestore permission ${permission}`}; grant its principal roles/datastore.viewer, which holds every permission Studio's reads need`,
  quotaExhausted: (retryDelay: string | undefined): string =>
    `Firestore's quota or rate limit for this project is exhausted${retryDelay === undefined ? "" : `; retry after ${retryDelay}`}`,
  documentTooLarge: `This document's answer passed Studio's ${LIMITS.smallResponseBytes / 1024 / 1024} MiB cap for a single document read, so Studio cannot show it`,
  timeout: "The statement ran past the connection's query timeout",
  aggregationTimeout: `Firestore stops an aggregation at ${LIMITS.aggregationServerSeconds} seconds`,
  cancelled: "The Firestore request was cancelled",
  datastoreMode: "This database is in Datastore mode, which the Firestore API does not serve",
  dataAccessDisabled:
    "Firestore API access is off on this database; turn it on or connect through its MongoDB-compatible endpoint with the MongoDB connection type",
  probeUnreadable: "Firestore answered the database probe with a body Studio cannot read",
});

/**
 * True when a 2xx answer is a stream that failed after it began: runQuery, runAggregationQuery and batchGet answer a
 * JSON array, and a failure past the first element arrives as an element holding Google's error envelope.
 */
export function endsInError(answer: unknown): boolean {
  return Array.isArray(answer) && answer.some((element) => isRecord(element) && isRecord(element.error));
}

export function readGoogleError(httpStatus: number, text: string): GoogleError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { httpStatus };
  }
  const envelope = Array.isArray(parsed)
    ? parsed.find((element) => isRecord(element) && isRecord(element.error))
    : parsed;
  if (!isRecord(envelope) || !isRecord(envelope.error)) return { httpStatus };
  const body = envelope.error;
  const details = Array.isArray(body.details) ? body.details.filter(isRecord) : [];
  const info = details.find((detail) => detailType(detail, "google.rpc.ErrorInfo"));
  const retry = details.find((detail) => detailType(detail, "google.rpc.RetryInfo"));
  const metadata = info !== undefined && isRecord(info.metadata) ? info.metadata : {};
  const helpUrls = details
    .filter((detail) => detailType(detail, "google.rpc.Help"))
    .flatMap((detail) => (Array.isArray(detail.links) ? detail.links : []))
    .filter(isRecord)
    .map((link) => link.url);
  const links = [...new Set([metadata.activationUrl, ...helpUrls])].filter(
    (url): url is string => typeof url === "string" && url.startsWith("https://"),
  );
  return {
    httpStatus,
    ...(typeof body.code === "number" ? { code: body.code } : {}),
    ...(typeof body.status === "string" ? { status: body.status } : {}),
    ...(typeof body.message === "string" ? { message: body.message } : {}),
    ...(typeof info?.reason === "string" ? { reason: info.reason } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(typeof retry?.retryDelay === "string" ? { retryDelay: retry.retryDelay } : {}),
    ...(typeof metadata.permission === "string" ? { permission: metadata.permission } : {}),
  };
}

/** Each error `mapGoogleError` returned, keyed to the Google error it was read from; weak, so a dropped error frees both. */
const GOOGLE_ERRORS = new WeakMap<Error, GoogleError>();

export function mapGoogleError(error: GoogleError, context: ErrorContext): Error {
  const mapped = mapGoogleErrorRow(error, context);
  GOOGLE_ERRORS.set(mapped, error);
  return mapped;
}

/**
 * The Google error `mapGoogleError` read to produce `error`; undefined for any other value. A caller that picks its
 * sentence after the client has mapped the failure (an expired page token, a missing document) reads the status here,
 * never from the message. `httpStatus` is the status as answered; a failure at the end of a 2xx stream is in `code`.
 */
export function googleErrorOf(error: unknown): GoogleError | undefined {
  return error instanceof Error ? GOOGLE_ERRORS.get(error) : undefined;
}

/** The rows of spec 8.1 in order; the first match wins. */
function mapGoogleErrorRow(error: GoogleError, context: ErrorContext): Error {
  // A runQuery or runAggregationQuery stream that fails after its first element answers 2xx with a trailing error
  // element; its own code then names the failure.
  const status =
    error.httpStatus >= 200 && error.httpStatus < 300 && error.code !== undefined ? error.code : error.httpStatus;
  const head = lead(error, status, context.secretForms ?? []);
  const connect = context.phase === "connect";
  const P = FIRESTORE_TYPE;
  if (context.credential === "emulator" && (error.message ?? "").includes(EMULATOR_DATASTORE_MODE))
    return new DatabaseConfigError(compose(head, ERROR_SENTENCES.emulatorDatastoreMode), P);
  if (status === 404 && connect)
    return new DatabaseConfigError(compose(head, ERROR_SENTENCES.databaseNotFound(context.target)), P);
  if (status === 401)
    return new AuthenticationError(
      compose(
        head,
        context.credential === "access_token" ? ERROR_SENTENCES.accessTokenRefused : ERROR_SENTENCES.credentialRefused,
      ),
      P,
    );
  if (status === 403 && error.reason === "SERVICE_DISABLED")
    return new DatabaseConfigError(
      compose(head, ERROR_SENTENCES.apiDisabled(context.target.projectId, error.links?.[0])),
      P,
    );
  if (
    status === 403 &&
    (error.reason === "USER_PROJECT_DENIED" ||
      (context.credential === "authorized_user" && QUOTA_PROJECT.test(error.message ?? "")))
  )
    return new AuthenticationError(compose(head, ERROR_SENTENCES.quotaProject(context.target.projectId)), P);
  if (status === 403) {
    const sentence = compose(
      head,
      ERROR_SENTENCES.permission(error.permission ?? error.message?.match(PERMISSION)?.[0]),
    );
    return connect ? new AuthenticationError(sentence, P) : new QueryError(sentence, P);
  }
  if (status === 404 || status === 400) return new QueryError(head, P);
  if (status === 429 || error.status === "RESOURCE_EXHAUSTED")
    return new QueryError(compose(head, ERROR_SENTENCES.quotaExhausted(retryClause(error))), P);
  if (status === 504 || error.status === "DEADLINE_EXCEEDED")
    return new TimeoutError(compose(head, timeoutSentence(context)), P);
  // 5xx and every status no row names.
  return new QueryError(hasMessage(error) ? compose(head, ERROR_SENTENCES.httpStatus(status)) : head, P);
}

export function mapTransportFailure(error: unknown, context: ErrorContext): Error {
  if (isTransportFailure(error)) {
    if (error.kind === "timeout") return new TimeoutError(`${timeoutSentence(context)}.`, FIRESTORE_TYPE);
    if (error.kind === "too-large") return new QueryError(`${tooLargeSentence(context)}.`, FIRESTORE_TYPE);
    if (error.kind === "aborted") return new QueryCancelledError(`${ERROR_SENTENCES.cancelled}.`, FIRESTORE_TYPE);
    return error;
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/** The probe's two refusals of a database resource Google did answer (spec 4.4); null for a Firestore database. */
export function databaseResourceRefusal(resource: unknown): DatabaseConfigError | null {
  if (!isRecord(resource)) return new DatabaseConfigError(`${ERROR_SENTENCES.probeUnreadable}.`, FIRESTORE_TYPE);
  if (resource.type === "DATASTORE_MODE")
    return new DatabaseConfigError(`${ERROR_SENTENCES.datastoreMode}.`, FIRESTORE_TYPE);
  if (resource.firestoreDataAccessMode === "DATA_ACCESS_MODE_DISABLED")
    return new DatabaseConfigError(`${ERROR_SENTENCES.dataAccessDisabled}.`, FIRESTORE_TYPE);
  return null;
}

/**
 * Google's message without its closing full stop, then the reason (or status) in parentheses, then a full stop.
 * The secret forms are checked against the whole message before it is cut, so a form straddling the cut is caught;
 * a high surrogate the cut leaves at the end is dropped, so an astral character is never split.
 */
function lead(error: GoogleError, status: number, forms: readonly string[]): string {
  const code = error.reason ?? error.status;
  const suffix = code === undefined ? "." : ` (${code}).`;
  if (!hasMessage(error)) return `${ERROR_SENTENCES.httpStatus(status)}${suffix}`;
  const raw = (error.message ?? "").trim();
  const message = forms.some((form) => form !== "" && raw.includes(form))
    ? ERROR_SENTENCES.withheld
    : raw.slice(0, GOOGLE_MESSAGE_MAX_CHARS).replace(/[\ud800-\udbff]$/, "");
  return `${message.replace(/[.\s]+$/u, "")}${suffix}`;
}

/** RetryInfo's delay when Google sent one, else the Retry-After header: a number of seconds gains "s", a date stays. */
function retryClause(error: GoogleError): string | undefined {
  if (error.retryDelay !== undefined) return error.retryDelay;
  if (error.retryAfter === undefined) return undefined;
  return /^\d+$/.test(error.retryAfter) ? `${error.retryAfter}s` : error.retryAfter;
}

/** The Keys panel's sentence, the one-document sentence for a document read, else the limit-and-select advice. */
function tooLargeSentence(context: ErrorContext): string {
  if (context.surface === "keys") return SENTENCES.keysTooLarge;
  if (context.surface === "source" || context.requestKind === "get") return ERROR_SENTENCES.documentTooLarge;
  return SENTENCES.answerTooLarge;
}

function compose(head: string, sentence: string): string {
  return `${head} ${sentence}.`;
}

function hasMessage(error: GoogleError): boolean {
  return (error.message ?? "").trim() !== "";
}

function timeoutSentence(context: ErrorContext): string {
  return context.aggregation === true
    ? `${ERROR_SENTENCES.timeout}. ${ERROR_SENTENCES.aggregationTimeout}`
    : ERROR_SENTENCES.timeout;
}

function detailType(detail: Readonly<Record<string, unknown>>, name: string): boolean {
  const type = detail["@type"];
  return typeof type === "string" && type.endsWith(name);
}

/** The shared transport's error, recognised by shape so this module stays free of the transport. */
function isTransportFailure(error: unknown): error is Error & { readonly kind: string } {
  return (
    error instanceof Error && error.name === "TransportError" && typeof (error as { kind?: unknown }).kind === "string"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
