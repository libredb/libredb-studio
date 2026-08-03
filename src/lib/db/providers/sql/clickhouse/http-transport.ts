/**
 * ClickHouse HTTP transport (issue #264, design spec 1.1, 1.2, 2.1 and 2.2)
 *
 * The only implementation of the ClickHouseTransport seam, and the only file in
 * the provider allowed to know how ClickHouse's HTTP interface encodes a result:
 * its `default_format` parameter, its `X-ClickHouse-*` headers and the JSON
 * envelope it wraps rows in. `seam-guard.test.ts` fails the build the moment any
 * of that vocabulary appears elsewhere in the directory, which is what keeps
 * "a native-protocol client is one new file" true rather than aspirational.
 *
 * Zero runtime dependency: the statement is the body of a POST and the answer
 * comes back through the runtime's own `fetch`.
 *
 * Three live-verified shapes drive nearly every decision below, and all three are
 * the opposite of what a JSON API teaches:
 *
 * - Failures are real status codes, so `!response.ok` is the whole test and the
 *   body is never inspected to find out whether the statement failed (spec 1.1).
 * - An error body is plain TEXT even when the content type says
 *   `application/json`, so it must never reach `JSON.parse`.
 * - A successful write answers 200 with NO body, and its row count lives only in
 *   a header, so an empty body is success rather than an error (spec 2.2).
 */

import type { DatabaseConnection } from "@/lib/db/types";
import {
  type ClickHouseQueryOptions,
  type ClickHouseQueryResult,
  type ClickHouseRow,
  type ClickHouseTransport,
  ClickHouseTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8123;
const DEFAULT_TLS_PORT = 8443;

/**
 * The envelope this file parses. Requested per statement instead of appended to
 * the user's SQL, so what the editor sends is what the server parses (spec 1.2).
 */
const RESPONSE_FORMAT = "JSON";

/** Header names are matched case-insensitively by `Headers.get`, hence lower case. */
const SUMMARY_HEADER = "x-clickhouse-summary";
const FORMAT_HEADER = "x-clickhouse-format";
const EXCEPTION_CODE_HEADER = "x-clickhouse-exception-code";
/**
 * Sent on every response, successful ones included, so the client can tell a
 * genuine mid-stream exception trailer from result data that merely looks like
 * one. See `midstreamError`.
 */
const EXCEPTION_TAG_HEADER = "x-clickhouse-exception-tag";

const UNPARSABLE_JSON = "ClickHouse announced a JSON result the client could not parse";

/**
 * Trailing build metadata on an exception message: `... (SYNTAX_ERROR) (version
 * 26.7.1.1315 (official build))`. Optional, live-verified: an authentication
 * failure carries no version at all. It is noise to the person who mistyped a
 * table name, so it is stripped before the message is shown.
 */
const VERSION_SUFFIX = /\s*\(version [^()]*(?:\([^()]*\))?\)\s*$/;

/** `Code: 62.` at the head of every exception body. */
const CODE_PREFIX = /^Code:\s*(\d+)\./;

/**
 * The same marker anywhere in the body, used to drop a partial result that precedes
 * it.
 *
 * JSON output is buffered so the server can count `rows`, which means a statement
 * that fails part-way through can still be answered with a real error STATUS and the
 * half-built body in front of the exception. Live-verified on 26.7.1: that response is
 * `500` carrying `X-ClickHouse-Exception-Code: 395`, a `meta`/`data` prefix and -
 * unlike the streamed case - NO `__exception__` fence to cut on.
 *
 * Deliberately not anchored to a line start. Whether a newline precedes the exception
 * depends on how much of a row had already been written, so an anchored pattern
 * silently failed for exactly the longer bodies that most need trimming.
 */
const CODE_ANYWHERE = /Code:\s*\d+\./;

/** The exception name ClickHouse puts last: `... (UNKNOWN_TABLE)`. */
const EXCEPTION_NAME = /\(([A-Z][A-Z0-9_]*)\)\s*$/;

/** A header that is nothing but digits. */
const INTEGER_HEADER = /^\s*(\d+)\s*$/;

// ============================================================================
// Wire shapes
// ============================================================================

interface EnvelopeColumn {
  name: string;
  type: string;
}

/**
 * The JSON envelope, documented here in full because this file is the record of
 * what the wire looks like. Members are `unknown` where the code guards them: the
 * shape is what the server promised, not what a proxy is guaranteed to deliver.
 */
interface ClickHouseJsonEnvelope {
  meta?: unknown;
  data?: unknown;
  statistics?: { elapsed?: unknown };
  /**
   * Added by the server whenever the statement carries a LIMIT. Deliberately not
   * surfaced (spec 2.6): nothing in the UI consumes it, and widening the neutral
   * result for it would force a native implementation to fabricate the field.
   */
  rows_before_limit_at_least?: number;
}

/** What the summary header told us, with nulls where it told us nothing usable. */
interface ResponseSummary {
  mutationCount: number;
  elapsedMs: number | null;
}

const NO_SUMMARY: ResponseSummary = { mutationCount: 0, elapsedMs: null };

/** One HTTP response, already drained so the body can be read twice. */
interface HttpOutcome {
  ok: boolean;
  status: number;
  headers: Headers;
  text: string;
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

/** A counter the server reports as a string, or 0 when it reported nothing usable. */
function toCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Spec 2.2: the counters a write produces exist only in this header, and every
 * value in it is a STRING. A reverse proxy is free to drop or mangle it, so a
 * missing or unparsable header degrades to "the server did not say" rather than
 * failing the statement that already succeeded.
 */
function parseSummary(raw: string | null): ResponseSummary {
  const summary = asRecord(parseJson(raw ?? ""));
  if (!summary) return NO_SUMMARY;

  const elapsedNs = Number(summary.elapsed_ns);
  return {
    mutationCount: toCount(summary.written_rows),
    elapsedMs: Number.isFinite(elapsedNs) ? elapsedNs / 1e6 : null,
  };
}

/**
 * The header is authoritative because it is present on every response, including
 * the empty-bodied ones. The envelope's own number is the fallback for a stripped
 * header - it is in seconds where the header is in nanoseconds - and zero is the
 * last resort, since a fabricated duration is worse than an obvious absence.
 */
function executionTimeMs(summary: ResponseSummary, envelope: ClickHouseJsonEnvelope | null): number {
  if (summary.elapsedMs !== null) return summary.elapsedMs;

  const elapsed = envelope?.statistics?.elapsed;
  return typeof elapsed === "number" ? elapsed * 1000 : 0;
}

/**
 * Declared column order and types, or nulls when the envelope described neither.
 * Types are copied verbatim, wrappers included (spec 1.7): `Nullable(String)` is
 * what tells the user the column is nullable, and collapsing it would lose that.
 */
function describeColumns(envelope: ClickHouseJsonEnvelope): Pick<ClickHouseQueryResult, "fieldNames" | "columnTypes"> {
  if (!Array.isArray(envelope.meta)) return { fieldNames: null, columnTypes: null };

  const columns = envelope.meta as EnvelopeColumn[];
  return {
    fieldNames: columns.map((column) => column.name),
    columnTypes: Object.fromEntries(columns.map((column) => [column.name, column.type])),
  };
}

function parseEnvelope(text: string): ClickHouseJsonEnvelope {
  const envelope = asRecord(parseJson(text));
  // The server announced JSON, so a body that is not a JSON object means
  // something between here and it rewrote the response. Normalizing that keeps
  // the seam's promise that every throw is a ClickHouseTransportError - a raw
  // SyntaxError would slip past every `instanceof` branch in the provider.
  if (!envelope) throw new ClickHouseTransportError(UNPARSABLE_JSON, 0);

  return envelope as ClickHouseJsonEnvelope;
}

/** A result that describes no columns: a write, or a format the user chose. */
function untabulated(summary: ResponseSummary, rawText: string | null): ClickHouseQueryResult {
  return {
    rows: [],
    fieldNames: null,
    columnTypes: null,
    executionTimeMs: executionTimeMs(summary, null),
    mutationCount: summary.mutationCount,
    rawText,
  };
}

function toQueryResult(outcome: HttpOutcome): ClickHouseQueryResult {
  const summary = parseSummary(outcome.headers.get(SUMMARY_HEADER));

  // Spec 2.2: a write answers with no body, and a DDL statement answers with no
  // format header either, so the empty body has to be recognised as success
  // before anything asks what format it was in.
  if (outcome.text === "") return untabulated(summary, null);

  // Spec 2.8, and it must come BEFORE the format branch: the fence and its tag are
  // format-independent, so a statement carrying its own FORMAT that dies part-way
  // through streaming would otherwise be handed back as a successful short result
  // with the trailer buried in the text - live-reproduced as 805000 lost rows
  // reported as success. Authoritative on its own, too, because a body that still
  // parses can nonetheless be a failed statement's truncated output.
  const aborted = midstreamError(outcome);
  if (aborted) throw aborted;

  // Spec 1.2: an explicit FORMAT in the user's SQL beats the requested one, and this
  // header reports what the server actually used. Handing the text back beats parsing
  // it - the user asked for that format deliberately - and it beats guessing, which is
  // why nothing about the rows is described alongside it.
  if (outcome.headers.get(FORMAT_HEADER) !== RESPONSE_FORMAT) return untabulated(summary, outcome.text);

  const envelope = parseEnvelope(outcome.text);
  return {
    rows: Array.isArray(envelope.data) ? (envelope.data as ClickHouseRow[]) : [],
    ...describeColumns(envelope),
    executionTimeMs: executionTimeMs(summary, envelope),
    mutationCount: summary.mutationCount,
    rawText: null,
  };
}

/**
 * The numeric code, preferring the header because it is a discrete integer the
 * server sets, where the `Code: NN.` prefix has to be scraped out of prose. The
 * fallback matters: a proxy that strips unknown headers would otherwise turn
 * every failure into an unclassifiable one, and the provider branches on the code.
 */
function exceptionCode(header: string | null, message: string): number {
  return toCount(INTEGER_HEADER.exec(header ?? "")?.[1] ?? CODE_PREFIX.exec(message)?.[1]);
}

/**
 * Spec 1.1: the status code already said this failed, so the body is read only to
 * describe the failure, never to detect it. The body is plain text under an
 * `application/json` content type (live-verified), which is why it goes nowhere
 * near JSON.parse.
 */
function statementError(outcome: HttpOutcome): ClickHouseTransportError {
  const body = outcome.text.trim();
  // Keep only the exception itself when a partial result precedes it, so the reader
  // sees the failure and not the buffered rows that never arrived.
  const start = CODE_ANYWHERE.exec(body)?.index ?? 0;
  const message = body.slice(start).trim().replace(VERSION_SUFFIX, "");

  return new ClickHouseTransportError(
    message || `ClickHouse request failed with HTTP ${outcome.status}`,
    exceptionCode(outcome.headers.get(EXCEPTION_CODE_HEADER), message),
    EXCEPTION_NAME.exec(message)?.[1],
  );
}

/**
 * The exception a statement that had already started streaming reports at the end
 * of its own body.
 *
 * Spec 2.8, live-verified on 26.7.1: once the first block has been written the
 * status line is already committed as 200, so a failure part-way through arrives
 * as `200` with NO exception-code header, a body truncated mid-array, and the real
 * exception fenced in a trailer:
 *
 *     ...
 *     __exception__
 *     <tag>
 *     Code: 395. DB::Exception: boom: ... (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version ...)
 *     286 <tag>
 *     __exception__
 *
 * Without this the only symptom is a JSON parse complaint, which tells the person
 * who wrote the statement nothing about what actually went wrong.
 *
 * The fence is keyed on the per-request tag rather than on `__exception__` alone,
 * because `SELECT '__exception__'` is a legal statement whose result would
 * otherwise be read as a failure. The tag is server-generated per request, so
 * result data cannot forge it - which is precisely why the header exists.
 */
function midstreamError(outcome: HttpOutcome): ClickHouseTransportError | null {
  const tag = outcome.headers.get(EXCEPTION_TAG_HEADER);
  if (!tag) return null;

  const fence = `__exception__\n${tag}\n`;
  const start = outcome.text.indexOf(fence);
  if (start === -1) return null;

  const message = outcome.text
    .slice(start + fence.length)
    // Drop the closing `<byte count> <tag>\n__exception__` fence when it arrived;
    // a connection cut mid-trailer means it did not.
    .replace(new RegExp(`\\n\\d+ ${tag}\\n__exception__\\s*$`), "")
    .trim()
    .replace(VERSION_SUFFIX, "");

  return new ClickHouseTransportError(
    message || `ClickHouse aborted the response with HTTP ${outcome.status}`,
    exceptionCode(null, message),
    EXCEPTION_NAME.exec(message)?.[1],
  );
}

/** A failure that never reached the server, or never came back from it. */
function transportError(cause: unknown): ClickHouseTransportError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new ClickHouseTransportError(`ClickHouse request failed: ${reason}`, 0);
}

// ============================================================================
// Transport
// ============================================================================

export class ClickHouseHttpTransport implements ClickHouseTransport {
  public readonly kind = "http" as const;

  private readonly origin: string;
  private readonly database: string | undefined;
  private readonly authorization: string | undefined;

  constructor(config: DatabaseConnection) {
    const secure = config.ssl !== undefined && config.ssl.mode !== "disable";
    const port = config.port ?? (secure ? DEFAULT_TLS_PORT : DEFAULT_PORT);
    this.origin = `${secure ? "https" : "http"}://${formatHost(config.host ?? DEFAULT_HOST)}:${port}`;
    this.database = config.database;
    // Live-verified: an EMPTY Basic username fails hard - "Got an empty user name
    // from Authorization HTTP header", code 516 - while sending no header at all
    // resolves to the `default` user, which is what a stock local install
    // expects. So a connection with no user must send no header.
    this.authorization = config.user
      ? `Basic ${Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")}`
      : undefined;
  }

  public async query(sql: string, opts: ClickHouseQueryOptions = {}): Promise<ClickHouseQueryResult> {
    const outcome = await this.send(this.endpoint(opts), sql, opts.timeoutMs);
    if (!outcome.ok) throw statementError(outcome);

    return toQueryResult(outcome);
  }

  /**
   * Nothing to release: one HTTP request per statement and no session pinned
   * (spec 1.4), so this exists only because every implementation of the seam has
   * to be closeable.
   */
  public close(): Promise<void> {
    return Promise.resolve();
  }

  private endpoint(opts: ClickHouseQueryOptions): string {
    const params = new URLSearchParams();
    // Caller settings go first so they cannot reach the parameters below: this
    // file's parser assumes the envelope it asked for, and `settings` is
    // deliberately open-ended, so a caller could otherwise change the response
    // format out from under it.
    for (const [name, value] of Object.entries(opts.settings ?? {})) params.set(name, String(value));

    params.set("default_format", RESPONSE_FORMAT);
    // Spec 2.1: without this a UInt64 arrives as an unquoted JSON number and
    // JSON.parse silently rounds 18446744073709551615 to ...552000. Quoted, it
    // arrives as a string, which is what the `pg` driver already does for int8.
    params.set("output_format_json_quote_64bit_integers", "1");

    const database = opts.database ?? this.database;
    if (database) params.set("database", database);

    return `${this.origin}/?${params.toString()}`;
  }

  private async send(url: string, sql: string, timeoutMs?: number): Promise<HttpOutcome> {
    // One signal for the request AND the body read: a response whose headers
    // arrive promptly can still stall mid-body, and awaiting text() below is
    // otherwise unbounded. Passing the signal to fetch covers both, which a
    // timer around fetch alone would not.
    const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.authorization ? { authorization: this.authorization } : {},
        body: sql,
        ...(signal ? { signal } : {}),
      });

      return { ok: response.ok, status: response.status, headers: response.headers, text: await response.text() };
    } catch (error) {
      // A refused socket, an abort and a truncated body all arrive here, and all
      // have to leave as the seam's own error type.
      throw transportError(error);
    }
  }
}
