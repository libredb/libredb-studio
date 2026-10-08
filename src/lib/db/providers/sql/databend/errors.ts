/**
 * The Databend error table (design 3.13 and 6.3; X02, X07): every way a statement fails, as one `DatabendError`
 * category and the sentence a person reads, and the house class each category becomes.
 *
 * Classification reads Databend's code, the gateway kind, the HTTP status, the transport kind and Studio's own cancel
 * and deadline state, never message text. 1043 means "aborted" whoever aborted it, so it is told apart only by what
 * Studio itself did: under our cancel it is `cancelled`, under our deadline `timeout`, and otherwise Databend's own
 * statement error (a `KILL QUERY` from elsewhere, a shutdown).
 *
 * This module is the `serverText` entry: every server text passes `serverText` with the connection's secret forms
 * (the password and `user:password`, design 3.13) before any sentence is built from it, and is cut afterwards, so a
 * text that holds a form is withheld whole and never shown in part. Pure: no I/O, no clock.
 */
import {
  AuthenticationError,
  ConnectionError,
  type DatabaseError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import type { TransportError } from "@/lib/db/http/node-transport";
import { serverText } from "@/lib/db/utils/server-text";
import type { DatabendAnswerError, DatabendRefusal } from "./answer";
import { DatabendError, type StatementOrigin } from "./transport";

const PROVIDER = "databend";

/** The longest server text a refusal's sentence carries (design 3.13). */
const MAX_REFUSAL_TEXT = 300;
/** The longest in-body message a statement error carries (design 3.13). */
const MAX_STATEMENT_TEXT = 1000;

/**
 * Every fixed sentence of design 3.13 and 6.3, templates as functions, so the provider doc can quote them and a test
 * read them back. `unavailable` is the plan's own: 3.13 words the resuming sentence for a named warehouse only, and a
 * GET 503 or 429 can reach a self-hosted server through an intermediary.
 */
export const DATABEND_ERROR_SENTENCES = Object.freeze({
  latched: (at: string, until: string) =>
    `Databend refused this sign-in at ${at} UTC, so this Studio server will not send this password again before ${until} UTC, or until it changes.`,
  signInRefused: "Databend refused the sign-in for this user.",
  possibleLockout:
    "Under a password policy, five failed sign-ins lock the user for 15 minutes for every client, and the right password is refused until then.",
  cloudSqlUser: "On Databend Cloud, sign in with a SQL user of the warehouse; the console login is not a SQL user.",
  statementForbidden: (text: string) => `Databend Cloud refused this statement for this user: ${text}.`,
  signInMissing:
    "No sign-in reached Databend Cloud: a proxy between Studio and Databend may drop the Authorization header.",
  followUpRefused: "Databend refused a follow-up request of this statement.",
  warehouseRefused: (name: string) =>
    `Databend Cloud refused the warehouse "${name}": check Warehouse against the DSN on the warehouse's Connect page.`,
  warehouseRequired: "Databend Cloud needs a warehouse: set Warehouse from the DSN on the warehouse's Connect page.",
  hostRefused: "Databend Cloud does not know this host: check Host against the DSN on the warehouse's Connect page.",
  middlewareRefused: (text: string) =>
    text === ""
      ? "Databend refused the request before running it."
      : `Databend refused the request before running it: ${text}.`,
  nothingRan: "Nothing ran.",
  resuming: (name: string, seconds: string) =>
    `Warehouse "${name}" did not answer within ${seconds} seconds; it may be resuming. Try again in a minute, or resume it in the Databend Cloud console.`,
  unavailable: (words: string, seconds: string) =>
    `Databend did not answer within ${seconds} seconds (${words}). Try again in a minute.`,
  noAnswer: (words: string) =>
    `No answer arrived from Databend (${words}). If the request reached it, Databend may have run the statement: check before running it again.`,
  warehouseStarting: "A suspended warehouse may still be starting.",
  cancelledBeforeAnswer: "cancelled before its first answer",
  deadlineBeforeAnswer: (seconds: string) => `no first answer within ${seconds} seconds`,
  cancelUnanswered: "Studio asked Databend to stop the statement and got no answer, so it may still finish.",
  deadline: (seconds: string) => `The statement did not finish within ${seconds} seconds, so Studio cancelled it.`,
  deadlineUnacknowledged: (seconds: string) =>
    `The statement did not finish within ${seconds} seconds, and Databend did not acknowledge Studio's request to stop it, so it may still finish: check before running it again.`,
  cancelled: "The query was cancelled.",
  protocol: (what: string) =>
    `Databend's answer did not follow its HTTP protocol (${what}), so Studio stopped and cancelled the statement.`,
  server: (status: number, text: string) => `Databend answered HTTP ${status} before the statement finished: ${text}.`,
  tls: (transportWords: string) =>
    `${transportWords}. Self-hosted Databend serves plain HTTP on 8000 unless TLS is configured: set SSL mode to disable, or enable TLS on the query node; a certificate error means the CA or host name does not match.`,
  network: (host: string, port: number, words: string) =>
    `The server at ${host}:${port} did not answer Databend's HTTP API (${words}). It listens on 8000 self-hosted and 443 on Databend Cloud; 3307 (MySQL) and 8900 (Flight SQL) are not used.`,
  currentDatabase: "Database is the current database for unqualified names: check it, or leave it empty.",
});

/**
 * What the protocol sentence names, never a link, an id or a value. The last four name the bound of one answer
 * (design 3.12) that an answer passed, so what was too large is named, never a type.
 */
export const DATABEND_PROTOCOL_FAULTS = Object.freeze({
  notAnswer: "a 200 answer that is not JSON",
  notJson: "a body that does not parse as JSON",
  prototypeKey: "a key named __proto__",
  field: (name: string) => `the field ${name} of the wrong type`,
  cell: "a cell that is neither text nor null",
  width: (cells: number, columns: number) => `a row of ${cells} cells for ${columns} columns`,
  link: "a link Studio does not follow",
  queryId: "an answer for another statement",
  sessionId: "an answer for another session",
  proxySession: "an answer for another session; a proxy may drop the X-DATABEND-SESSION header",
  pageSchema: "a later page with another schema",
  pollBound: "more answers than one statement may take",
  rows: "more rows than the page Studio asked for",
  schema: "a schema larger than a result can keep",
  values: "more values than one answer may hold",
  depth: "nesting deeper than one answer may have",
});

/** Codes a query node signs a refused sign-in with over HTTP 401: wrong password, two token codes, unknown user (L10). */
const SIGN_IN_CODES: ReadonlySet<number> = new Set([5100, 5101, 5103, 2201]);
/** The lockout of a password policy, which refuses over HTTP 500 and never in a body, where it is also a complexity error. */
const LOCKOUT_CODE = 2215;
/** Fail-to-start code naming a setting Studio sent (07 M08d). */
const SETTING_CODE = 2803;
const UNKNOWN_DATABASE_CODE = 1003;
const ABORTED_CODE = 1043;

/** The Databend Cloud gateway's kinds for a refused credential. */
const GATEWAY_AUTH: ReadonlySet<string | undefined> = new Set([
  "AuthorizationFailed",
  "PasswordAuthFailed",
  "JWTVerificationFailed",
]);
/** A valid sign-in refused one statement (I19): never latched, so a statement a user may not run locks nothing. */
const GATEWAY_FORBIDDEN = "ForbiddenAccessUser";
/** No credential reached the gateway, though Studio always sends Basic (I10): something between dropped it. */
const GATEWAY_NO_SIGN_IN = "AuthorizationRequired";
const GATEWAY_WAREHOUSE: ReadonlySet<string> = new Set([
  "WarehouseNotFound",
  "BadWarehouse",
  "WarehouseHeaderRequired",
]);
const GATEWAY_HOST: ReadonlySet<string> = new Set(["TenantNotFound", "BadTenant", "IllegalHostName"]);
const GATEWAY_RESUMING = "ProvisionWarehouseTimeout";
/** Statuses that say nothing about whether the POST reached Databend (design 3.11). */
const NO_ANSWER_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504, 520]);
/** Of those, the ones a provider statement reads as the 6.3 network sentence; a 503 or 429 stays outcome-unknown. */
const GATEWAY_FAILURE_STATUSES: ReadonlySet<number> = new Set([502, 504, 520]);
/** Statuses a GET is retried on and, past its retries, reads as a warehouse that did not come up (design 3.11). */
const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * The part of an answer that decides a sign-in: its status, Databend's code, a gateway's kind, and the query node's
 * status and code when the gateway wrapped its refusal (I19).
 */
export interface SignInAnswer {
  readonly status: number;
  readonly code?: number;
  readonly gatewayKind?: string;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: number;
}

/** A 401 signed with a sign-in code, or the lockout over HTTP 500. */
function signedSignIn(status: number | undefined, code: number | undefined): boolean {
  return (status === 401 && SIGN_IN_CODES.has(code ?? 0)) || (status === 500 && code === LOCKOUT_CODE);
}

/**
 * Whether an answer refuses the credential itself (design 3.5, 3.13): a gateway's credential kind, or a 401 signed
 * with a sign-in code or the lockout over HTTP 500, direct or wrapped by the gateway. Any one is enough, so a code
 * still counts beside an unrelated gateway kind, but never beside ForbiddenAccessUser, which refuses a statement for a
 * valid sign-in (I19). This is the one rule: `refusalError` makes exactly these `auth`, and
 * the sign-in latch of `auth-latch.ts` latches exactly these (I18).
 */
export function latchesSignIn(answer: SignInAnswer): boolean {
  if (answer.gatewayKind === GATEWAY_FORBIDDEN) return false;
  return (
    GATEWAY_AUTH.has(answer.gatewayKind) ||
    signedSignIn(answer.status, answer.code) ||
    signedSignIn(answer.upstreamStatus, answer.upstreamCode)
  );
}

/**
 * The sign-in part of a refusal, upstream status and code included: the transport settles the latch with exactly what
 * `refusalError` classifies, so the two cannot drift (I18).
 */
export function signInAnswerOf(refusal: DatabendRefusal): SignInAnswer {
  return {
    status: refusal.status,
    code: refusal.code ?? undefined,
    gatewayKind: refusal.gatewayKind ?? undefined,
    upstreamStatus: refusal.upstreamStatus,
    upstreamCode: refusal.upstreamCode,
  };
}

/** What every classification needs to know about the request that failed. */
export interface DatabendFailureContext {
  /** The statement's POST, or one of its GETs (a page, the final link, the kill). */
  readonly request: "post" | "get";
  readonly origin: StatementOrigin;
  readonly sql: string;
  /** Set for Databend Cloud; absent or empty for self-hosted. */
  readonly warehouse?: string;
  /** The endpoint as configured: the far end under an SSH tunnel. */
  readonly endpoint: { readonly host: string; readonly port: number };
  /** The statement deadline. */
  readonly timeoutMs: number;
  /** The connection's `secretForms`. */
  readonly secretForms: readonly string[];
}

/** A stop of Studio's own: the user's cancel, or the statement deadline. */
export type DatabendStop = "cancel" | "deadline";

/** What the run knew when it stopped (design 3.10). */
export interface DatabendStopState {
  /** True once the server answered the POST, so the statement is registered. */
  readonly answered: boolean;
  /** True when Databend acknowledged the kill: a 200 that is not a gateway's refusal. */
  readonly killAcknowledged: boolean;
}

const sentences = DATABEND_ERROR_SENTENCES;

/** A deadline in seconds as a sentence says it, exactly: 10000 ms is "10", 1500 ms is "1.5", 40 ms is "0.04". */
function seconds(ms: number): string {
  return String(ms / 1000);
}

/** A JSON string escape: `\\uXXXX` or a backslash before one of `"\\/bfnrt`. */
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const CONTROL_ESCAPES: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
/** How many times a text is unescaped: a gateway wrapper nests its JSON once per hop. */
const MAX_ESCAPE_LEVELS = 8;

/**
 * A text with its JSON string escapes undone, once per level until nothing changes: JSON a gateway left inside a
 * message, a wrapper that did not unwrap among it, holds a form with a quote or a backslash escaped, where the form
 * itself is not found (I19).
 */
function unescapedLevels(text: string): string[] {
  const levels: string[] = [];
  let current = text;
  for (let level = 0; level < MAX_ESCAPE_LEVELS; level++) {
    const next = current.replace(JSON_ESCAPE, (_match, hex: string | undefined, char: string) =>
      hex === undefined ? (CONTROL_ESCAPES[char] ?? char) : String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    levels.push(next);
    current = next;
  }
  return levels;
}

/**
 * `serverText` first, then the cut, so a form is never cut in half and shown. `decoded` is a JSON refusal's strings
 * as parsed: its raw text holds them escaped, where a form with a quote, a backslash, a slash or a non-ASCII
 * character is not found, so a form in any of them withholds the text too.
 */
function scrubbed(text: string, secretForms: readonly string[], max: number, decoded: readonly string[] = []): string {
  const leak = [...decoded, ...unescapedLevels(text)].find((value) => serverText(value, secretForms) !== value);
  const safe = serverText(leak ?? text, secretForms);
  return safe.length > max ? `${safe.slice(0, max)}...` : safe;
}

/**
 * A server text a sentence names on its own, such as an echoed setting or the name of one: withheld whole when it
 * holds a secret form, escaped or not, and cut as a refusal's text is, before the sentence is built (design 3.13).
 */
export function serverWords(text: string, secretForms: readonly string[]): string {
  return scrubbed(text, secretForms, MAX_REFUSAL_TEXT);
}

/** The server's words as a sentence of their own, so the sentence after them does not run on from them. */
function asSentence(text: string): string {
  return text === "" || /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A UTC time as the latched sentence says it: `2026-10-08 01:20`. */
function utc(time: Date): string {
  return time.toISOString().slice(0, 16).replace("T", " ");
}

/** The 1-based character offset `--> SQL:<line>:<col>` points at in the statement Studio sent, when it has one. */
function positionOf(message: string, sql: string): number | undefined {
  const match = /--> SQL:(\d+):(\d+)/.exec(message);
  if (!match) return undefined;
  const lines = sql.split("\n");
  const line = Number(match[1]);
  if (line < 1 || line > lines.length) return undefined;
  // A caret may stand just past the line's last character, never before its first or further out.
  const column = Number(match[2]);
  if (column < 1 || column > lines[line - 1].length + 1) return undefined;
  return lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0) + column;
}

function withWarehouseStart(message: string, ctx: DatabendFailureContext): string {
  return ctx.warehouse ? `${message} ${sentences.warehouseStarting}` : message;
}

function noAnswerError(words: string, ctx: DatabendFailureContext, cause?: unknown): DatabendError {
  return new DatabendError("outcome-unknown", withWarehouseStart(sentences.noAnswer(words), ctx), { cause });
}

function unavailableError(words: string, ctx: DatabendFailureContext, details: object): DatabendError {
  const wait = seconds(ctx.timeoutMs);
  const message = ctx.warehouse ? sentences.resuming(ctx.warehouse, wait) : sentences.unavailable(words, wait);
  return new DatabendError("unavailable", message, details);
}

/** The sign-in a latched key refuses with no request (design 3.5); `until` is the latch's own expiry. */
export function latchedError(at: Date, until: Date): DatabendError {
  return new DatabendError("auth", sentences.latched(utc(at), utc(until)));
}

/** The protocol failure, naming what was wrong with one of `DATABEND_PROTOCOL_FAULTS`. */
export function protocolError(what: string, cause?: unknown, status?: number): DatabendError {
  return new DatabendError("protocol", sentences.protocol(what), { cause, status });
}

/**
 * An answer that is not a 200 JSON answer, after any retries design 3.11 allows. Every `auth` it returns is also a
 * signal that sets the sign-in latch (design 3.5).
 */
export function refusalError(refusal: DatabendRefusal, ctx: DatabendFailureContext): DatabendError {
  const { status, gatewayKind } = refusal;
  const code = refusal.code ?? refusal.upstreamCode;
  // A wrapped refusal shows the query node's own message, not the gateway's wrapper (I19).
  const detail = scrubbed(refusal.upstreamMessage ?? refusal.text, ctx.secretForms, MAX_REFUSAL_TEXT, refusal.decoded);
  const details = { code, status, detail };

  if (gatewayKind === GATEWAY_RESUMING) return unavailableError(gatewayKind, ctx, details);
  const gatewayAuth = GATEWAY_AUTH.has(gatewayKind ?? undefined);
  if (latchesSignIn(signInAnswerOf(refusal))) {
    const parts = [sentences.signInRefused, asSentence(detail)];
    if (code === LOCKOUT_CODE) parts.push(sentences.possibleLockout);
    if (gatewayAuth || ctx.warehouse) parts.push(sentences.cloudSqlUser);
    return new DatabendError("auth", parts.filter((part) => part !== "").join(" "), details);
  }
  if (gatewayKind === GATEWAY_FORBIDDEN) {
    return new DatabendError("statement", sentences.statementForbidden(detail), details);
  }
  if (gatewayKind === GATEWAY_NO_SIGN_IN) return new DatabendError("config", sentences.signInMissing, details);
  if (gatewayKind !== null && GATEWAY_WAREHOUSE.has(gatewayKind)) {
    const message = ctx.warehouse ? sentences.warehouseRefused(ctx.warehouse) : sentences.warehouseRequired;
    return new DatabendError("config", message, details);
  }
  if (gatewayKind !== null && GATEWAY_HOST.has(gatewayKind)) {
    return new DatabendError("config", sentences.hostRefused, details);
  }
  if (status === 401) {
    // The POST was refused before anything ran; only a request after it follows up a running statement.
    const message = ctx.request === "post" ? sentences.middlewareRefused(detail) : sentences.followUpRefused;
    return new DatabendError("protocol", message, details);
  }
  if (ctx.request === "post" && status === 400 && code === 400) {
    return new DatabendError("config", sentences.middlewareRefused(detail), details);
  }
  if (ctx.request === "post" && NO_ANSWER_STATUSES.has(status)) {
    const words = `HTTP ${status}`;
    if (ctx.origin === "provider" && GATEWAY_FAILURE_STATUSES.has(status)) {
      return new DatabendError("network", sentences.network(ctx.endpoint.host, ctx.endpoint.port, words), details);
    }
    return noAnswerError(words, ctx);
  }
  if (ctx.request === "get" && BUSY_STATUSES.has(status)) return unavailableError(`HTTP ${status}`, ctx, details);
  return new DatabendError("server", sentences.server(status, detail), details);
}

/**
 * Studio's own cancel or deadline, with what the run knew when it stopped (design 3.10; X02, X07). After the first
 * answer a cancel, and a user statement's deadline, stopped the statement only when Databend acknowledged the kill;
 * otherwise it may still finish, and the failure is `outcome-unknown`. A statement Studio sends itself is not an
 * unknown outcome at its deadline whatever the kill answered, since checking before running it again means nothing
 * for Studio's own reads: on a named warehouse it is X07's resuming outcome, `unavailable` as a gateway's
 * `ProvisionWarehouseTimeout` is, so a route shows its sentence rather than a timeout's; otherwise it is `timeout`.
 */
export function stopError(stop: DatabendStop, state: DatabendStopState, ctx: DatabendFailureContext): DatabendError {
  const provider = ctx.origin === "provider";
  if (!provider && !state.answered && !state.killAcknowledged) {
    // Before the first answer the kill can miss a statement that is already running (design 3.10).
    const words =
      stop === "cancel" ? sentences.cancelledBeforeAnswer : sentences.deadlineBeforeAnswer(seconds(ctx.timeoutMs));
    return noAnswerError(words, ctx);
  }
  if (stop === "cancel") {
    return state.killAcknowledged
      ? new DatabendError("cancelled", sentences.cancelled)
      : new DatabendError("outcome-unknown", sentences.cancelUnanswered);
  }
  // A probe or surface read that outlasts its budget on a named warehouse is most likely a resume (X07).
  const wait = seconds(ctx.timeoutMs);
  if (provider && ctx.warehouse) return new DatabendError("unavailable", sentences.resuming(ctx.warehouse, wait));
  // After the first answer a user statement's deadline stopped it only when Databend acknowledged the kill [X02].
  if (!provider && state.answered && !state.killAcknowledged) {
    return new DatabendError("outcome-unknown", sentences.deadlineUnacknowledged(wait));
  }
  return new DatabendError("timeout", sentences.deadline(wait));
}

/**
 * Studio's own cancel or deadline before anything was sent, such as a sign-in latch wait cut short: nothing can still
 * run, so a cancel is `cancelled` and a deadline `timeout`, or Studio's own read's resuming outcome on a named
 * warehouse, never `outcome-unknown`.
 */
export function unsentStopError(stop: DatabendStop, ctx: DatabendFailureContext): DatabendError {
  return stopError(stop, { answered: true, killAcknowledged: true }, ctx);
}

/**
 * An answer's in-body `error`: a fail-to-start answer (`id` empty, nothing ran), a 1043 told apart by our own `stop`
 * (null when Studio stopped nothing), or the statement's own error with its position.
 */
export function answerError(
  answer: { readonly id: string; readonly error: DatabendAnswerError },
  ctx: DatabendFailureContext,
  stop: DatabendStop | null,
): DatabendError {
  const { code, message: raw, detail: rawDetail } = answer.error;
  if (code === ABORTED_CODE && stop !== null) {
    return stopError(stop, { answered: true, killAcknowledged: true }, ctx);
  }
  const text = scrubbed(raw.trimEnd(), ctx.secretForms, MAX_STATEMENT_TEXT);
  const detail = rawDetail === null ? undefined : scrubbed(rawDetail, ctx.secretForms, MAX_STATEMENT_TEXT);
  if (answer.id === "") {
    const category = code === SETTING_CODE ? "config" : "statement";
    return new DatabendError(category, `${text} ${sentences.nothingRan}`, { code, detail });
  }
  // Only a user statement can miss the connection's Database: a provider statement names the database it reads.
  const message =
    code === UNKNOWN_DATABASE_CODE && ctx.origin === "user" ? `${text} ${sentences.currentDatabase}` : text;
  return new DatabendError("statement", message, { code, detail, position: positionOf(raw, ctx.sql) });
}

/**
 * The shared transport's failure, by kind: `aborted` is our cancel and `timeout` our deadline; `network` on a user
 * statement may have run it; `tls` and `network` on a provider statement get 6.3's sentences; the rest keep the
 * transport's words, which never carry a header, a key or a body.
 */
export function transportFailure(
  error: TransportError,
  state: DatabendStopState,
  ctx: DatabendFailureContext,
): DatabendError {
  switch (error.kind) {
    case "aborted":
      return stopError("cancel", state, ctx);
    case "timeout":
      return stopError("deadline", state, ctx);
    case "network":
      if (ctx.origin === "user") return noAnswerError(error.message, ctx, error);
      return new DatabendError("network", sentences.network(ctx.endpoint.host, ctx.endpoint.port, error.message), {
        cause: error,
      });
    case "tls":
      return new DatabendError("tls", sentences.tls(error.message), { cause: error });
    default:
      return new DatabendError(error.kind, error.message, { cause: error });
  }
}

/** The house class of each category (design 3.13): the provider's boundary. */
export function toDatabaseError(error: DatabendError, ctx: DatabendFailureContext): DatabaseError {
  switch (error.category) {
    case "auth":
      return new AuthenticationError(error.message, PROVIDER);
    case "config":
      return new DatabaseConfigError(error.message, PROVIDER);
    case "timeout":
      return new TimeoutError(error.message, PROVIDER, ctx.timeoutMs, ctx.sql);
    case "cancelled":
      return new QueryCancelledError(error.message, PROVIDER, ctx.sql);
    case "statement":
    case "too-large":
      return new QueryError(error.message, PROVIDER, ctx.sql, error.position, error.detail);
    default:
      return new ConnectionError(error.message, PROVIDER, ctx.endpoint.host, ctx.endpoint.port);
  }
}
