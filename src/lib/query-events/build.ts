/**
 * The query event builder (spec 7.2, 7.9): one executed unit, or one refused request, as a row of `query_events_v1`.
 *
 * `buildQueryEvent()` is the only maker of query event rows. It copies the fields `QueryEventInput` names and nothing
 * else, so a bind parameter value, a result row or a credential has no field to land in, and it keeps of the
 * statement only what `queryLog.statementCapture` allows (docs/GOVERNANCE.md, "Query events"):
 *
 * - `none`, the default: no statement, no fingerprint and no error text.
 * - `redacted`: `redactStatement()`, the statement with every literal, number and comment replaced by `?`, and its
 *   fingerprint, the SHA-256 of the whole redacted text.
 * - `full`: the statement and the error text through `maskCredentials()`, which masks the value after `PASSWORD` or
 *   `IDENTIFIED BY` and the userinfo of every URI, with the error text cut to 1000 characters.
 *
 * A stored statement is cut at `queryLog.maxStatementBytes` UTF-8 bytes on a character boundary, with
 * `statement_truncated` set. A refused request whose connection did not resolve keeps no statement and no error text
 * in any mode, because the engine that would read them is unknown.
 *
 * Every row has exactly the columns of the manifest and keeps their rules, so the governance source never refuses a
 * row for its shape: a bounded text column is cut to its limit by character, the unit PostgreSQL's `char_length`
 * counts, a NUL, which no PostgreSQL text value holds, becomes U+FFFD, and a client address that is not an IP address
 * is left out. An input no row can be made of, such as a connection id outside the `seed:` namespace or a duration
 * measured across two clocks, is the caller's defect and throws.
 */
import { isIP } from "node:net";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import type { ExplainMode } from "@/lib/explain";
import { runtimeSetting } from "@/lib/governance/settings";
import { readsSqlText } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";
import { maskCredentials, redactStatement } from "./redact";
import type {
  QueryEventContext,
  QueryEventInput,
  QueryEventPolicy,
  QueryEventRow,
  QueryEventStart,
  StatementCapture,
  StatementType,
} from "./types";
import { uuidv7 } from "./uuidv7";

/** The contract version of `query_events_v1`, whose check option admits only rows of version 1. */
const CONTRACT_VERSION = 1;

/** What Studio captures when the control plane set no valid `queryLog.statementCapture`: the registry's default. */
const DEFAULT_STATEMENT_CAPTURE: StatementCapture = "none";
/** The byte cap when the control plane set no valid `queryLog.maxStatementBytes`: the registry's default. */
const DEFAULT_MAX_STATEMENT_BYTES = 4096;

/** Studio's namespace for the connections its routes resolve: `seed:<connection id>`. */
const SEED_PREFIX = "seed:";
/** The format of a `connections_v1` id, as the contract publishes it (spec 7.2). */
const CONNECTION_ID = /^[a-z0-9-]{1,64}$/;

/** The CHECK on `statement`, in every capture mode: at most this many UTF-8 bytes. */
const STATEMENT_MAX_BYTES = 65536;
/** The largest PostgreSQL `integer`, the type of `unit_index` and `duration_ms`. */
const INTEGER_MAX = 2_147_483_647;

/**
 * The limit of each bounded text column in characters, as the manifest's CHECKs give them. `studio_instance` and
 * `subject` say where and by whom a unit ran, so a value outside them is refused rather than cut.
 */
const LIMITS = {
  studio_instance: 128,
  subject: 512,
  username: 320,
  connection_name: 128,
  error_code: 64,
  error_message: 1000,
  correlation_id: 128,
  transaction_id: 128,
} as const;

/** The `explain` column of each plan mode a request can ask for. */
const EXPLAIN: Readonly<Record<ExplainMode, QueryEventRow["explain"]>> = { estimate: "plan", analyze: "analyze" };

/** What a row keeps of its statement. */
interface CapturedStatement {
  readonly statement: string | null;
  readonly truncated: boolean;
  readonly fingerprint: string | null;
}

const NOTHING_CAPTURED: CapturedStatement = { statement: null, truncated: false, fingerprint: null };

/** When a unit starts, on both clocks: call it before the unit runs and hand the result to `buildQueryEvent()`. */
export function queryEventStart(): QueryEventStart {
  return { wallClockMs: Date.now(), monotonicMs: performance.now() };
}

/**
 * The capture policy in force: the valid runtime values of `queryLog.statementCapture` and
 * `queryLog.maxStatementBytes`, else the registry's defaults, which is all it ever answers with governance off.
 */
export function queryEventPolicy(): QueryEventPolicy {
  return {
    statementCapture: runtimeSetting("queryLog.statementCapture") ?? DEFAULT_STATEMENT_CAPTURE,
    maxStatementBytes: runtimeSetting("queryLog.maxStatementBytes") ?? DEFAULT_MAX_STATEMENT_BYTES,
  };
}

/**
 * The `connections_v1` id of the connection Studio names `id`, which `query_events_v1.connection_id` holds so every
 * row joins the control plane's connections (spec 7.2), or null when `id` names none: outside the `seed:` namespace
 * every route resolves a governed connection in, or with an id the contract's format does not admit. A route records
 * a refused request only for an id this answers, because a row cannot be made without one.
 */
export function contractConnectionId(id: string): string | null {
  if (!id.startsWith(SEED_PREFIX)) return null;
  const connectionId = id.slice(SEED_PREFIX.length);
  return CONNECTION_ID.test(connectionId) ? connectionId : null;
}

/** `text` with every NUL replaced by U+FFFD, since a PostgreSQL text value cannot hold one and the insert would fail. */
function storable(text: string): string {
  return text.replaceAll("\u0000", "�");
}

/** `text` cut to its first `max` characters: code points, the unit PostgreSQL's `char_length` counts in UTF-8. */
function clampCharacters(text: string, max: number): string {
  let count = 0;
  let end = 0;
  for (const character of text) {
    if (count === max) return text.slice(0, end);
    count += 1;
    end += character.length;
  }
  return text;
}

/** The UTF-8 length of one character as `for...of` yields it. A lone surrogate is sent as U+FFFD, three bytes. */
function utf8Length(character: string): number {
  if (character.length === 2) return 4;
  const unit = character.charCodeAt(0);
  if (unit < 0x80) return 1;
  return unit < 0x800 ? 2 : 3;
}

/** `text` cut to at most `maxBytes` UTF-8 bytes without splitting a character, and whether anything was cut. */
function cutToBytes(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += utf8Length(character);
    if (bytes > maxBytes) return { text: text.slice(0, end), truncated: true };
    end += character.length;
  }
  return { text, truncated: false };
}

/** An optional text column: an absent value is NULL, and a present one is made storable and cut to `max` characters. */
function boundedText(value: string | null | undefined, max: number): string | null {
  return value === undefined || value === null ? null : clampCharacters(storable(value), max);
}

/** A text column that says where or by whom: made storable, and refused when empty or longer than `max` characters. */
function requiredText(column: string, value: string, max: number): string {
  const text = storable(value);
  if (text === "" || clampCharacters(text, max) !== text) {
    throw new RangeError(`${column} must be 1 to ${max} characters`);
  }
  return text;
}

/** A count: a whole number from 0 to `max`, or refused. */
function wholeNumber(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be a whole number from 0 to ${max}, got ${value}`);
  }
  return value;
}

/**
 * The client address when PostgreSQL's `inet` reads it, else NULL: `clientAddress()` answers `unknown` without a
 * trusted proxy header, and a forwarded entry can carry a port, brackets or an IPv6 zone index, which `inet` refuses.
 */
function clientIp(address: string | undefined): string | null {
  return address !== undefined && isIP(address) !== 0 && !address.includes("%") ? address : null;
}

/**
 * What the statement is as `analyzeQuery()` reads it under the engine's grammar, and OTHER for a unit without text and
 * for an engine whose statements are not SQL. A refused request whose connection did not resolve is read under the
 * compatibility grammar, because its engine is unknown.
 */
function statementType(text: string | null, engine: DatabaseType | null): StatementType {
  if (text === null || (engine !== null && !readsSqlText(engine))) return "OTHER";
  return analyzeQuery(text, engine ?? undefined).type;
}

/** What the capture mode keeps of the statement, read the way `engine` reads it. */
function captureStatement(
  text: string | null,
  engine: DatabaseType | null,
  policy: QueryEventPolicy,
): CapturedStatement {
  if (policy.statementCapture === "none" || text === null || engine === null) return NOTHING_CAPTURED;
  if (policy.statementCapture === "redacted") {
    const redacted = redactStatement(text, engine);
    const cut = cutToBytes(redacted.statement, policy.maxStatementBytes);
    return { statement: cut.text, truncated: cut.truncated, fingerprint: redacted.statement_fingerprint };
  }
  const cut = cutToBytes(maskCredentials(text, engine), policy.maxStatementBytes);
  return { statement: cut.text, truncated: cut.truncated, fingerprint: null };
}

/** The error text, which only capture `full` keeps: masked as the statement is, then cut to its column's limit. */
function captureErrorMessage(
  message: string | undefined,
  engine: DatabaseType | null,
  policy: QueryEventPolicy,
): string | null {
  if (policy.statementCapture !== "full" || message === undefined || engine === null) return null;
  return clampCharacters(maskCredentials(storable(message), engine), LIMITS.error_message);
}

/**
 * The row of `query_events_v1` for one executed unit, or one refused request, under `policy`, recorded by the Studio
 * instance `context` names. Call it when the unit has ended: `finished_at` is the wall clock now, never before
 * `started_at`, and `duration_ms` is the monotonic time since `input.started`. Each call makes a new `event_id`.
 */
export function buildQueryEvent(
  input: QueryEventInput,
  policy: QueryEventPolicy,
  context: QueryEventContext,
): QueryEventRow {
  const finishedMs = Date.now();
  const durationMs = Math.round(performance.now() - input.started.monotonicMs);
  const { connection, principal } = input;
  const connectionId = contractConnectionId(connection.id);
  if (connectionId === null) {
    throw new Error(
      "connection_id: a query event names its connection as seed:<id>, with an id of 1 to 64 lowercase letters, digits and hyphens",
    );
  }
  if (input.status !== "refused" && (connection.engine === null || connection.accessLevel === null)) {
    throw new Error(
      `A ${input.status} event needs the engine and access level of its connection; only a refused request may lack them`,
    );
  }
  wholeNumber("queryLog.maxStatementBytes", policy.maxStatementBytes, STATEMENT_MAX_BYTES);
  const statement = input.statement === null ? null : storable(input.statement);
  const captured = captureStatement(statement, connection.engine, policy);
  return {
    event_id: uuidv7(),
    started_at: new Date(input.started.wallClockMs).toISOString(),
    // A wall clock stepped back while the unit ran would date the end before the start, which the table refuses.
    finished_at: new Date(Math.max(finishedMs, input.started.wallClockMs)).toISOString(),
    contract_version: CONTRACT_VERSION,
    studio_instance: requiredText("studio_instance", context.studioInstance, LIMITS.studio_instance),
    subject: requiredText("subject", principal.subject, LIMITS.subject),
    username: boundedText(principal.username, LIMITS.username),
    session_role: principal.role,
    connection_id: connectionId,
    connection_name: boundedText(connection.name, LIMITS.connection_name),
    engine: connection.engine,
    access_level: connection.accessLevel,
    source: input.source,
    statement_type: input.statementType ?? statementType(statement, connection.engine),
    explain: input.explain === undefined ? null : EXPLAIN[input.explain],
    statement_capture: policy.statementCapture,
    statement: captured.statement,
    statement_truncated: captured.truncated,
    statement_fingerprint: captured.fingerprint,
    unit_index: input.unitIndex === undefined ? null : wholeNumber("unit_index", input.unitIndex, INTEGER_MAX),
    row_count: input.rowCount === undefined ? null : wholeNumber("row_count", input.rowCount, Number.MAX_SAFE_INTEGER),
    duration_ms: wholeNumber("duration_ms", durationMs, INTEGER_MAX),
    status: input.status,
    error_code: boundedText(input.errorCode, LIMITS.error_code),
    error_message: captureErrorMessage(input.errorMessage, connection.engine, policy),
    correlation_id: boundedText(input.correlationId, LIMITS.correlation_id),
    transaction_id: boundedText(input.transactionId, LIMITS.transaction_id),
    transaction_outcome: input.transactionOutcome ?? null,
    client_ip: clientIp(input.clientIp),
  };
}
