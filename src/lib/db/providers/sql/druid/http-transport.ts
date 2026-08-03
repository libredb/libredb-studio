/**
 * Druid HTTP transport (issue #265, design spec sections 2, 3, 5, 6, 11 and 13)
 *
 * The only implementation of the DruidTransport seam, and the only file in the
 * provider allowed to know how Druid's SQL endpoint encodes a request and a
 * result: its `resultFormat`, its three header flags, the header ROWS it prepends,
 * its query context, its two error envelopes and its parameter type names.
 * `seam-guard.test.ts` fails the build the moment any of that vocabulary appears
 * elsewhere in the directory, which is what keeps "an Avatica JDBC client is one
 * new file" true rather than aspirational.
 *
 * Zero runtime dependency: the statement is one JSON POST and the answer comes
 * back through the runtime's own `fetch`.
 *
 * Four live-verified shapes drive nearly every decision below, and each is the
 * opposite of what a JSON API teaches (all on Apache Druid 37.0.0):
 *
 * - `resultFormat: "object"` LOSES data - `SELECT 1 AS c, 2 AS c` keeps only the
 *   last `c` - so the wire form is the positional `array` one, and the rows are
 *   rebuilt here from the declared names (spec section 2).
 * - A 64-bit integer arrives as an UNQUOTED JSON number, and there is no
 *   server-side setting to quote it, so the raw body is rewritten before it is
 *   parsed (spec section 3, `quoteUnsafeIntegers`).
 * - The error body's `error` field is a DISCRIMINATOR whose value is the literal
 *   string "druidException"; the message lives in `errorMessage`, and the HTTP
 *   status misclassifies - `SELECT 1/0` is a 500 for a user's typo (spec 5).
 * - Druid can fail AFTER committing a 200: a cancelled streamed query simply
 *   stops mid-value. It signals that by withholding a response TRAILER, which
 *   `fetch` cannot read, so a truncated body is the only evidence there is.
 */

import type { DatabaseConnection } from "@/lib/db/types";
// Shared with `lib/explain/druid-native.ts`, which parses the EXPLAIN plan columns:
// those arrive as JSON *text* inside this body, so the pass below correctly leaves
// their digits alone and the inner parse is a second chance to round the same value.
// An explain strategy may not import from a provider directory, which is why this
// lives in db/utils rather than here.
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import {
  DRUID_TRANSPORT_FAILURE,
  type DruidQueryOptions,
  type DruidQueryResult,
  type DruidRow,
  type DruidTransport,
  DruidTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOST = "localhost";

/**
 * The Router's port. One default for both schemes on purpose: a TLS Druid serves
 * on whatever `druid.tlsPort` the deployment chose, so there is no well-known
 * HTTPS port to fall back to, and inventing one would send credentials to a port
 * nothing is listening on. The connection form prefills this, so it is a floor
 * rather than a guess.
 */
const DEFAULT_PORT = 8888;

/** Spec section 11: the Broker serves this same path, and so does the Router. */
const SQL_PATH = "/druid/v2/sql";

/** Live-verified: without this header the endpoint answers 400 before parsing the SQL. */
const JSON_CONTENT_TYPE = "application/json";

/**
 * Spec section 2, a correctness decision rather than a preference. Live-verified:
 * `SELECT 1 AS c, 2 AS c` with `resultFormat: "object"` answers
 * `[{"c":{...}},{"c":2}]` - the object form silently drops every duplicate column
 * but the last, and duplicate output names are legal SQL that real joins produce.
 * The array form is positional, so it keeps both, and column order becomes
 * authoritative.
 */
const RESULT_FORMAT = "array";

/**
 * Asked for on every statement. Without them the positional rows carry no names
 * and no types at all, so there would be nothing to rebuild a row object from.
 */
const HEADER_FLAGS = Object.freeze({ header: true, typesHeader: true, sqlTypesHeader: true });

/**
 * Exactly three rows precede the data when all three flags above are set - one
 * per flag, in this order. Live-verified, including for a result set with NO rows
 * (`WHERE id = -1` still answers `[["id"],["LONG"],["BIGINT"]]`), which is why a
 * shorter payload cannot be data.
 */
const NAME_ROW = 0;
const NATIVE_TYPE_ROW = 1;
const SQL_TYPE_ROW = 2;
const HEADER_ROW_COUNT = 3;

/**
 * The fields the two envelopes carry (spec section 5), read back from the live
 * cluster. Frozen and named so no call site spells one twice, and so the seam
 * guard can prove that only this file reads them.
 */
const ERROR_FIELDS = Object.freeze({
  /**
   * A DISCRIMINATOR in the modern shape, a real message in the legacy one - which
   * is why it is only ever the fallback, and never when it holds the token below.
   */
  DISCRIMINATOR: "error",
  MESSAGE: "errorMessage",
  /** The classifier: present in BOTH shapes, and a closed enum. */
  CATEGORY: "category",
  CODE: "errorCode",
  /** Druid's guess at who should read the message. Carried for display only. */
  PERSONA: "persona",
  /**
   * Legacy-shape-only and deliberately NOT surfaced: the Java exception class and
   * the data server's address. Recorded here because this file is the record of
   * what the wire contains, but a `org.apache.druid.query.QueryTimeoutException`
   * and a container IP tell the person who wrote the statement nothing.
   */
  CLASS: "errorClass",
  HOST: "host",
} as const);

/**
 * The value `error` holds in the modern envelope. Spec section 5, point 1: it is a
 * discriminator, so falling back to it would print "druidException" to the person
 * who mistyped a datasource name.
 */
const ERROR_DISCRIMINATOR = "druidException";

/** The Druid SQL type names a positional parameter may declare (spec section 13). */
const PARAMETER_TYPES = Object.freeze({
  VARCHAR: "VARCHAR",
  BIGINT: "BIGINT",
  DOUBLE: "DOUBLE",
  BOOLEAN: "BOOLEAN",
  TIMESTAMP: "TIMESTAMP",
} as const);

const UNREADABLE_PAYLOAD = "Druid ended the response before it was complete, so the result is incomplete";
const NOT_AN_ARRAY = "Druid answered a SQL result that is not the array it was asked for";

// ============================================================================
// Wire shapes
// ============================================================================

/** One positional parameter as the endpoint takes it. */
interface DruidParameter {
  type: string;
  /** `unknown` because a bigint reaches the body as a raw JSON literal. */
  value: unknown;
}

/** One HTTP response, already drained so the body can be inspected twice. */
interface HttpOutcome {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * Serialize the parameters array by hand, so a bigint reaches Druid as a bare
 * literal.
 *
 * `JSON.stringify` cannot help: it throws outright on a bigint, and it has no way to
 * emit an unquoted literal wider than a double. `JSON.rawJSON` can, but it is the
 * ES2025 JSON source-text proposal - V8 12.4 / Node 22.2 - while this package declares
 * `engines.node: ">=20.9.0"`, so depending on it would throw a bare TypeError on a
 * runtime the package claims to support.
 *
 * Building the array as text is what remains, and it is deliberately STRUCTURAL rather
 * than a marker-and-substitute pass. An earlier version wrapped the digits in a
 * sentinel and unquoted it with a regex over the finished body; that is unsound,
 * because the sentinel is only as private as the values flowing through it - a caller
 * whose VARCHAR parameter happened to contain the sentinel would have had that string
 * silently unquoted into a number. Emitting the literal in the first place cannot
 * collide with anything, because no marker ever exists.
 *
 * Everything that is not a bigint still goes through `JSON.stringify`, so the escaping
 * of user strings is the runtime's, not ours.
 */
function serializeParameters(parameters: readonly DruidParameter[]): string {
  const encoded = parameters.map((parameter) =>
    typeof parameter.value === "bigint"
      ? `{"type":${JSON.stringify(parameter.type)},"value":${parameter.value.toString()}}`
      : JSON.stringify(parameter),
  );

  return `[${encoded.join(",")}]`;
}

// ============================================================================
// Pure helpers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Bracket a bare IPv6 literal, which is otherwise not a legal URL authority. */
function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** A field the envelope reported as usable text, or null when it reported none. */
function textField(envelope: Record<string, unknown>, field: string): string | null {
  const value = envelope[field];
  return typeof value === "string" && value !== "" ? value : null;
}

// ============================================================================
// The result (spec section 2)
// ============================================================================

/** What a payload with no header row can honestly say about its columns. */
const UNDESCRIBED = Object.freeze({ fieldNames: null, sqlTypes: null, nativeTypes: null });

/**
 * The declared names, made unique.
 *
 * `SELECT 1 AS c, 2 AS c` really declares `["c","c"]` (live-verified), and a row
 * is a record, so the repeat has to be disambiguated as the row is built or the
 * second column disappears BEFORE the seam rather than after it. The suffix keeps
 * climbing because `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal too, and
 * uniqueness is the invariant the seam states.
 */
function disambiguate(declared: readonly string[]): string[] {
  const taken = new Set<string>();

  return declared.map((name) => {
    let unique = name;
    for (let repeat = 2; taken.has(unique); repeat += 1) unique = `${name} (${repeat})`;
    taken.add(unique);
    return unique;
  });
}

/**
 * One type per column, keyed by the disambiguated name.
 *
 * A column the header row did not reach is left OUT rather than given a
 * placeholder: an invented type name would be indistinguishable from one the
 * server sent.
 */
function typesByName(fieldNames: readonly string[], row: unknown): Record<string, string> {
  const declared = Array.isArray(row) ? (row as unknown[]) : [];

  return Object.fromEntries(
    fieldNames.flatMap((name, column) => (column < declared.length ? [[name, String(declared[column])]] : [])),
  );
}

/** One positional row, rebuilt as the record the seam promises. */
function toRow(fieldNames: readonly string[], row: unknown): DruidRow {
  const values = Array.isArray(row) ? (row as unknown[]) : [];

  return Object.fromEntries(fieldNames.map((name, column) => [name, values[column] ?? null]));
}

function toQueryResult(payload: unknown[], executionTimeMs: number): DruidQueryResult {
  const names = payload[NAME_ROW];
  // A payload shorter than the header, or one whose first row is not the name array,
  // CANNOT be a healthy answer to the request this transport sends - and it must not
  // be reported as an empty one.
  //
  // Live-verified: with all three header flags set, even a result set with no rows
  // answers exactly `[["id"],["LONG"],["BIGINT"]]`, and a bare `SET` (the only other
  // statement form Druid's grammar accepts) is rejected outright rather than answering
  // short. So there is no legitimate way to receive fewer than three rows.
  //
  // What can produce one is a truncated body, or a proxy that rewrote the response.
  // Returning `{ rows: [] }` there would render the most convincing possible lie: a
  // successful query over the right datasource that happens to have found nothing.
  // Data loss has to surface as a failure, which is the same reason the streamed
  // mid-response case above raises rather than returns.
  if (payload.length < HEADER_ROW_COUNT || !Array.isArray(names)) {
    throw new DruidTransportError(UNREADABLE_PAYLOAD);
  }

  const fieldNames = disambiguate((names as unknown[]).map(String));
  return {
    rows: payload.slice(HEADER_ROW_COUNT).map((row) => toRow(fieldNames, row)),
    fieldNames,
    sqlTypes: typesByName(fieldNames, payload[SQL_TYPE_ROW]),
    nativeTypes: typesByName(fieldNames, payload[NATIVE_TYPE_ROW]),
    executionTimeMs,
  };
}

// ============================================================================
// Failures (spec section 5)
// ============================================================================

/**
 * The failure an envelope describes, or `fallback` when it described none.
 *
 * Nothing here reads the HTTP status except to name it in that fallback. Spec
 * section 5, point 3, live-verified: `SELECT 1/0` answers HTTP 500 with
 * `persona: "ADMIN"` and `category: "UNCATEGORIZED"` for what is an ordinary user
 * mistake, so classifying on the status would tell the user the cluster is broken
 * when they divided by zero. `category` is the classifier because it is present in
 * BOTH envelopes and is a closed enum; the stand-in below means "nothing
 * classified this", which is not the same as Druid's own `UNCATEGORIZED`.
 */
function envelopeError(payload: unknown, fallback: string): DruidTransportError {
  const envelope = asRecord(payload) ?? {};
  const discriminated = textField(envelope, ERROR_FIELDS.DISCRIMINATOR);

  return new DruidTransportError(
    textField(envelope, ERROR_FIELDS.MESSAGE) ??
      (discriminated === ERROR_DISCRIMINATOR ? null : discriminated) ??
      fallback,
    textField(envelope, ERROR_FIELDS.CATEGORY) ?? DRUID_TRANSPORT_FAILURE,
    textField(envelope, ERROR_FIELDS.CODE) ?? DRUID_TRANSPORT_FAILURE,
    textField(envelope, ERROR_FIELDS.PERSONA),
  );
}

/** A failure that never reached the cluster, or never came back from it. */
function transportError(cause: unknown): DruidTransportError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new DruidTransportError(`Druid request failed: ${reason}`);
}

/**
 * The rows, or the reason the body could not be read as rows.
 *
 * The unparseable case is not defensive padding: live-reproduced on 37.0.0, a
 * large streamed result cancelled through `DELETE /druid/v2/sql/{sqlQueryId}`
 * answers HTTP **200**, streams 3.6 MB and then simply stops, its body cut
 * mid-value. Druid signals that by WITHHOLDING the `X-Druid-Response-Complete`
 * trailer it otherwise sends, and an HTTP trailer is unreachable through `fetch`,
 * so the truncated body is the only evidence a client has. Reporting a JSON parse
 * complaint would tell the person who ran the query nothing; reporting an empty
 * success would be worse.
 *
 * Verified NOT to happen, and therefore deliberately not handled: a failure the
 * Broker learns of before it commits the status - `1/(id-1005)` after 35 MB of
 * rows had already crossed the cluster - still answers a clean 500 whose body is
 * the error envelope ALONE, with no partial result in front of it. That is the
 * opposite of ClickHouse's buffered case (#264), so there is nothing to cut off.
 */
function parseRows(text: string): unknown[] {
  let payload: unknown;
  try {
    payload = JSON.parse(quoteUnsafeIntegers(text)) as unknown;
  } catch {
    throw new DruidTransportError(UNREADABLE_PAYLOAD);
  }

  // An object where an array was promised is either an error Druid committed after
  // the status or a proxy rewriting the body; reading it as an error beats
  // reporting no rows.
  if (!Array.isArray(payload)) throw envelopeError(payload, NOT_AN_ARRAY);
  return payload;
}

// ============================================================================
// Parameters (spec section 13)
// ============================================================================

/** The most specific name available for a value the mapping refuses. */
function typeName(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  return value.constructor?.name ?? "object";
}

function unmappable(detail: string): DruidTransportError {
  return new DruidTransportError(`Druid has no parameter type for ${detail}`);
}

/**
 * `Infinity` and `NaN` have no JSON form: `JSON.stringify` turns both into `null`,
 * which the server would read as a null comparison. Refusing beats sending a value
 * it will misread.
 *
 * An integral `number` outside the safe range is refused for a subtler reason: by the
 * time it arrives here it is ALREADY wrong. A caller writing `9007199254740993`
 * as a number literal handed us `9007199254740992` - JavaScript rounded it before the
 * transport existed - and there is nothing here that can recover the digit. Sending it
 * would filter on a value the user never wrote and return a plausible wrong row set,
 * so the refusal names the fix: pass a `bigint`, which this transport binds exactly.
 * The same check catches an integral double far past Druid's own BIGINT range.
 */
function numberParameter(value: number): DruidParameter {
  if (!Number.isFinite(value)) throw unmappable(`the non-finite number ${value}`);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw unmappable(`the integer ${value}, which JavaScript has already rounded - pass a bigint instead`);
  }

  return Number.isInteger(value) ? { type: PARAMETER_TYPES.BIGINT, value } : { type: PARAMETER_TYPES.DOUBLE, value };
}

/** Live-verified: `{"type":"TIMESTAMP","value":0}` against `__time > ?` matches every row. */
function timestampParameter(value: Date): DruidParameter {
  const millis = value.getTime();
  if (Number.isNaN(millis)) throw unmappable("an invalid Date");

  return { type: PARAMETER_TYPES.TIMESTAMP, value: millis };
}

/**
 * A bigint reaches the body as a RAW, UNQUOTED literal, because the obvious
 * encoding is refused by the server. Live-verified on 37.0.0:
 *
 *     {"type":"BIGINT","value":"9007199254740993"}   -> RUNTIME_FAILURE, "Cannot handle query"
 *     {"type":"BIGINT","value":9007199254740993}     -> matches the row exactly
 *
 * Design spec section 13 says a bigint goes over "as a string value"; that is the
 * one line of the spec the live cluster contradicts, so the unquoted form is what
 * is implemented and this is the record of why.
 *
 * The bigint is carried through as a bigint and emitted as a literal by
 * `serializeParameters`, which is where the reason `JSON.stringify` and
 * `JSON.rawJSON` are both unusable is recorded.
 */
function bigintParameter(value: bigint): DruidParameter {
  return { type: PARAMETER_TYPES.BIGINT, value };
}

function toParameter(value: unknown): DruidParameter {
  if (typeof value === "string") return { type: PARAMETER_TYPES.VARCHAR, value };
  if (typeof value === "boolean") return { type: PARAMETER_TYPES.BOOLEAN, value };
  if (typeof value === "number") return numberParameter(value);
  if (typeof value === "bigint") return bigintParameter(value);
  if (value instanceof Date) return timestampParameter(value);
  // Live-verified: a VARCHAR parameter with a null value executes and matches the
  // rows a null comparison should, which is the honest encoding for "no value".
  if (value === null || value === undefined) return { type: PARAMETER_TYPES.VARCHAR, value: null };

  throw unmappable(`a value of type ${typeName(value)}`);
}

// ============================================================================
// Transport
// ============================================================================

export class DruidHttpTransport implements DruidTransport {
  public readonly kind = "http" as const;

  private readonly endpoint: string;
  private readonly authorization: string | undefined;

  constructor(config: DatabaseConnection) {
    // `ssl` is a first-class connection field and independent of the form's
    // `connectionFields`, and an explicit `disable` has to turn TLS OFF as well as
    // an explicit mode turns it on (the #264 lesson).
    const secure = config.ssl !== undefined && config.ssl.mode !== "disable";
    const host = formatHost(config.host ?? DEFAULT_HOST);
    this.endpoint = `${secure ? "https" : "http"}://${host}:${config.port ?? DEFAULT_PORT}${SQL_PATH}`;
    // Spec section 1, live-verified: a default install loads no security extension
    // and IGNORES this header entirely - a bogus Basic header still answers 200 -
    // so credentials are optional, and sending none is the normal case. When they
    // are configured they are for the `druid-basic-security` extension.
    this.authorization = config.user
      ? `Basic ${Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")}`
      : undefined;
  }

  public async query(sql: string, opts: DruidQueryOptions = {}): Promise<DruidQueryResult> {
    // Built before the clock starts: an unmappable parameter must be refused
    // without anything leaving the process.
    const body = this.requestBody(sql, opts);

    const startedAt = performance.now();
    const outcome = await this.send(body, opts.clientDeadlineMs);
    // Measured, never reported: live-verified, the endpoint answers with the rows
    // and nothing else - no timing in the body and none in the response metadata,
    // only query ids - so timing the exchange here is the only honest number
    // available, and it must not pretend to have come from the server.
    const executionTimeMs = performance.now() - startedAt;

    if (!outcome.ok) throw envelopeError(parseJson(outcome.text), `Druid request failed with HTTP ${outcome.status}`);

    return toQueryResult(parseRows(outcome.text), executionTimeMs);
  }

  /**
   * Nothing to release: one HTTP request per statement and no session pinned, so
   * this exists only because every implementation of the seam has to be closeable.
   */
  public close(): Promise<void> {
    return Promise.resolve();
  }

  private requestBody(sql: string, opts: DruidQueryOptions): string {
    const parameters = (opts.parameters ?? []).map(toParameter);
    const envelope = JSON.stringify({
      query: sql,
      resultFormat: RESULT_FORMAT,
      ...HEADER_FLAGS,
      // Spec section 6, first half: verified, a `timeout` of 1 ms answers 504 with
      // `category: TIMEOUT` on a statement that otherwise takes milliseconds.
      // Asking the server to stop is what actually frees the cluster's resources;
      // abandoning the request client-side leaves the query running.
      ...(opts.timeoutMs === undefined ? {} : { context: { timeout: opts.timeoutMs } }),
    });

    if (parameters.length === 0) return envelope;

    // Spliced structurally - at the envelope's closing brace, whose position is known
    // because `JSON.stringify` just produced it - rather than by matching anything in
    // the text. `parameters` is the only member that can contain a bigint, and
    // `serializeParameters` records why that cannot go through `JSON.stringify`.
    return `${envelope.slice(0, -1)},"parameters":${serializeParameters(parameters)}}`;
  }

  private async send(body: string, clientDeadlineMs?: number): Promise<HttpOutcome> {
    // Spec section 6, second half: one signal for the request AND the body read. A
    // response whose headers arrive promptly can still stall mid-body, and awaiting
    // text() below is otherwise unbounded - which a server-side deadline cannot
    // help with, since it only starts counting once the statement was accepted.
    const signal = clientDeadlineMs === undefined ? undefined : AbortSignal.timeout(clientDeadlineMs);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": JSON_CONTENT_TYPE,
          ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
        },
        body,
        ...(signal ? { signal } : {}),
      });

      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      // A refused socket, an abort and a truncated body all arrive here, and all
      // have to leave as the seam's own error type.
      throw transportError(error);
    }
  }
}
