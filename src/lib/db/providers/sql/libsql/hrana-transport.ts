/**
 * libSQL Hrana HTTP transport (issue #424 Phase 5)
 *
 * The only implementation of the `LibSQLTransport` seam, and the only file in the
 * provider allowed to know how Hrana encodes a request or a result: its
 * `/v2/pipeline` endpoint, its request/response envelope, its `baton` and its
 * `{ type, value }` value encoding. `seam-guard.test.ts` fails the build the
 * moment any of that vocabulary appears elsewhere in the directory, which is what
 * keeps "a WebSocket or embedded implementation is one new file" true rather than
 * aspirational.
 *
 * Zero runtime dependency: the statement is JSON in the body of a POST and the
 * answer comes back through the runtime's own `fetch`. `@libsql/client` would add
 * a dependency to speak a protocol that is three JSON shapes wide.
 *
 * Four measured shapes drive nearly every decision below (2026-08-27, against
 * `ghcr.io/tursodatabase/libsql-server` running sqld 0.24.33 and against a Turso
 * Cloud database, both SQLite 3.47.0), and each is the opposite of what a JSON
 * API teaches:
 *
 * - A failed statement answers HTTP **200**. `response.ok` says the pipeline was
 *   accepted, never that the statement ran, so the failure is read out of
 *   `results[]` (the same trap Trino's provider documents).
 * - An AUTH failure uses a different envelope entirely - `{"error": "<string>"}`
 *   under 401 with no token and under **400** with a malformed one - so the error
 *   path must not assume the `{ message, code }` object shape.
 * - Every integer arrives as a decimal STRING, including `last_insert_rowid`.
 *   That is the protocol protecting 64-bit values from a double, and reading them
 *   with `Number()` throws that protection away.
 * - `GET /version` is a sqld route that Turso Cloud does not have. A deployment
 *   that publishes no version is not a broken one.
 */

import type { DatabaseConnection } from "@/lib/db/types";
import {
  type LibSQLBatchOutcome,
  type LibSQLExecuteOptions,
  type LibSQLRow,
  type LibSQLStatement,
  type LibSQLStatementResult,
  type LibSQLTransport,
  LibSQLTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOST = "localhost";
/** sqld's own default HTTP port. */
const DEFAULT_PORT = 8080;
/**
 * 443, and not a libSQL-specific number: the TLS deployment this reaches is Turso
 * Cloud, which serves every database on the ordinary HTTPS port of a hostname
 * that identifies the database.
 */
const DEFAULT_TLS_PORT = 443;

const PIPELINE_PATH = "/v2/pipeline";
const VERSION_PATH = "/version";

const NOT_AN_ENVELOPE = "The server answered with a body that is not a libSQL answer";
const NO_RESULT = "The server accepted the pipeline and returned no result for the statement";

// ============================================================================
// Wire shapes
// ----------------------------------------------------------------------------
// Documented in full because this file is the record of what the wire looks like.
// Members are `unknown` where the code guards them: the shape is what the server
// promised, not what a proxy in front of it is guaranteed to deliver.
// ============================================================================

/** A value as Hrana spells it, in either direction. */
interface HranaValue {
  type?: unknown;
  value?: unknown;
  base64?: unknown;
}

interface HranaColumn {
  name?: unknown;
  decltype?: unknown;
}

interface HranaStatementResult {
  cols?: unknown;
  rows?: unknown;
  affected_row_count?: unknown;
  last_insert_rowid?: unknown;
  query_duration_ms?: unknown;
  /**
   * Declared and deliberately NOT surfaced, so this file stays the record of what
   * the wire carries (the seam guard checks that every one of these is named here
   * and nowhere else):
   *
   * - `replication_index` is the primary's frame number, and it is one of the two
   *   places the deployments differ - "1" on a self-hosted sqld, null on Turso
   *   Cloud. Nothing in the product consumes it, and widening the neutral result
   *   for it would force an embedded implementation to fabricate a value.
   * - `rows_read` and `rows_written` are Turso's BILLING counters for the
   *   statement. They are honest numbers about work done, but not about the result:
   *   `SELECT COUNT(*)` reads 2000 rows and returns one, so surfacing either as a
   *   row count would report the wrong number in the one place a user checks.
   */
  replication_index?: unknown;
  rows_read?: unknown;
  rows_written?: unknown;
}

/**
 * The pipeline envelope itself, declared for the same reason.
 *
 * `baton` is the handle for a server-side stream and `base_url` is where a
 * continuation must be sent. Both are answered on every call and both are ignored:
 * this transport closes its stream in the same request, so there is never a
 * continuation to route. An interactive transaction is exactly the feature that
 * would consume them, and `supportsTransactions: false` in the provider is the
 * other half of that decision.
 */
interface HranaPipelineEnvelope {
  baton?: unknown;
  base_url?: unknown;
  results?: unknown;
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

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * An integer the protocol sent as a decimal string, as a number where a double
 * holds it exactly and as that same string where it does not.
 *
 * SQLite integers and rowids are 64-bit, and Hrana quotes them for exactly this
 * reason. `Number("9007199254740993")` answers 9007199254740992 - a corruption
 * nothing downstream can detect, which is why Trino's provider quotes wide
 * integers before parsing (#460). Here the wire has already done that work, so
 * the only mistake available is undoing it.
 */
function decodeInteger(raw: unknown): number | string | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : String(raw);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Number.isSafeInteger(parsed) ? parsed : raw;
}

/** Base64 as bytes. Blobs are the one SQLite type JSON cannot carry directly. */
function decodeBlob(raw: unknown): Uint8Array | null {
  if (typeof raw !== "string") return null;
  return Uint8Array.from(Buffer.from(raw, "base64"));
}

/**
 * One wire value as a JavaScript one.
 *
 * An unrecognised `type` decodes to null rather than to its raw envelope: a
 * future value type rendered as `{"type":"vector","value":…}` in a results grid
 * would look like data the engine returned, and null at least reads as "nothing
 * this build understands". Hrana has added types before (`blob` and `float` were
 * not in the first version), so this branch is reachable by design.
 */
function decodeValue(raw: unknown): unknown {
  const value = asRecord(raw);
  if (!value) return null;

  switch (value.type) {
    case "null":
      return null;
    case "integer":
      return decodeInteger(value.value);
    case "float":
      return typeof value.value === "number" ? value.value : Number(value.value);
    case "text":
      return typeof value.value === "string" ? value.value : String(value.value ?? "");
    case "blob":
      return decodeBlob(value.base64);
    default:
      return null;
  }
}

/**
 * One JavaScript parameter as a wire value.
 *
 * `bigint` is encoded from its own decimal form rather than through `Number`, for
 * the reason `decodeInteger` states in the other direction. A boolean becomes 1
 * or 0 because that is what SQLite stores - it has no boolean type - and a `Date`
 * becomes an ISO 8601 string because that is the only form SQLite's own date
 * functions read.
 */
function encodeValue(param: unknown): HranaValue {
  if (param === null || param === undefined) return { type: "null" };
  if (typeof param === "bigint") return { type: "integer", value: param.toString() };
  if (typeof param === "boolean") return { type: "integer", value: param ? "1" : "0" };
  if (typeof param === "number") {
    return Number.isInteger(param) ? { type: "integer", value: param.toString() } : { type: "float", value: param };
  }
  if (param instanceof Uint8Array) return { type: "blob", base64: Buffer.from(param).toString("base64") };
  if (param instanceof Date) return { type: "text", value: param.toISOString() };
  return { type: "text", value: String(param) };
}

/** The column names and the types the engine declared for them. */
function readColumns(cols: unknown): { fieldNames: string[]; columnTypes: Record<string, string> } {
  const fieldNames: string[] = [];
  const columnTypes: Record<string, string> = {};
  if (!Array.isArray(cols)) return { fieldNames, columnTypes };

  for (const [index, raw] of cols.entries()) {
    const col = (asRecord(raw) ?? {}) as HranaColumn;
    // A column the engine did not name still occupies a position, so it gets a
    // positional name rather than being dropped - dropping one would shift every
    // later value into the wrong key.
    const name = typeof col.name === "string" && col.name !== "" ? col.name : `column_${index + 1}`;
    fieldNames.push(name);
    if (typeof col.decltype === "string" && col.decltype !== "") columnTypes[name] = col.decltype;
  }

  return { fieldNames, columnTypes };
}

function readRows(rows: unknown, fieldNames: string[]): LibSQLRow[] {
  if (!Array.isArray(rows)) return [];

  return rows.map((raw) => {
    const values = Array.isArray(raw) ? raw : [];
    const row: LibSQLRow = {};
    for (const [index, name] of fieldNames.entries()) {
      row[name] = decodeValue(values[index]);
    }
    return row;
  });
}

function toNumber(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * One step of an answered pipeline as an outcome.
 *
 * A step the server did not send becomes that statement's OWN failure rather
 * than shifting every later result onto the wrong statement - the shape a short
 * answer would otherwise silently produce.
 */
function readOutcome(raw: unknown): LibSQLBatchOutcome {
  const step = asRecord(raw);
  if (!step) return { ok: false, error: new LibSQLTransportError(NO_RESULT, 200) };

  if (step.type === "error") {
    const error = asRecord(step.error);
    const message = typeof error?.message === "string" ? error.message : "the statement failed";
    const code = typeof error?.code === "string" ? error.code : null;
    // Status 200 is the truth here and is carried deliberately: the provider maps
    // this to a QueryError so the user reads SQLite's own wording, and a reader of
    // the raw error should see that the transport itself succeeded.
    return { ok: false, error: new LibSQLTransportError(message, 200, code) };
  }

  return { ok: true, result: toStatementResult(asRecord(step.response)?.result) };
}

function toStatementResult(raw: unknown): LibSQLStatementResult {
  const result = (asRecord(raw) ?? {}) as HranaStatementResult;
  const { fieldNames, columnTypes } = readColumns(result.cols);

  return {
    rows: readRows(result.rows, fieldNames),
    fieldNames,
    columnTypes,
    affectedRowCount: toNumber(result.affected_row_count, 0),
    lastInsertRowId: result.last_insert_rowid === null ? null : decodeInteger(result.last_insert_rowid),
    executionTimeMs: toNumber(result.query_duration_ms, 0),
  };
}

/**
 * The error a non-2xx response carried.
 *
 * Two envelopes, both measured: the auth failures answer `{"error": "<string>"}`
 * while other refusals may answer the `{ message, code }` object the statement
 * path uses. Anything else falls back to the raw body, trimmed, because a proxy's
 * HTML page is more use to a reader than "request failed".
 */
function httpError(status: number, text: string): LibSQLTransportError {
  const body = asRecord(parseJson(text));
  const bare = typeof body?.error === "string" ? body.error : null;
  const nested = asRecord(body?.error);
  const message =
    bare ??
    (typeof nested?.message === "string" ? nested.message : null) ??
    (text.trim() === "" ? `HTTP ${status}` : text.trim());
  const code = typeof nested?.code === "string" ? nested.code : null;

  return new LibSQLTransportError(`libSQL request failed: ${message}`, status, code);
}

// ============================================================================
// Transport
// ============================================================================

export class LibSQLHranaTransport implements LibSQLTransport {
  public readonly kind = "hrana-http" as const;

  private readonly origin: string;
  private readonly authorization: string | undefined;

  constructor(config: DatabaseConnection) {
    const secure = config.ssl !== undefined && config.ssl.mode !== "disable";
    const port = config.port ?? (secure ? DEFAULT_TLS_PORT : DEFAULT_PORT);
    this.origin = `${secure ? "https" : "http"}://${formatHost(config.host ?? DEFAULT_HOST)}:${port}`;
    // The credential is a token, not a password: libSQL has no user names, and
    // Turso mints a JWT per database. A connection with no token sends no header,
    // which is what an unauthenticated local sqld expects - sending an empty
    // bearer to it is a 400 rather than an anonymous connection.
    this.authorization = config.password ? `Bearer ${config.password}` : undefined;
  }

  public async execute(sql: string, options: LibSQLExecuteOptions = {}): Promise<LibSQLStatementResult> {
    const [outcome] = await this.pipeline([{ sql, params: options.params }], options.timeoutMs);
    // A single statement raises its own failure rather than handing one back: the
    // caller asked one question, so there is no other panel for the answer to
    // cost. `executeBatch` is the shape for the other case.
    if (!outcome || !outcome.ok) throw outcome?.error ?? new LibSQLTransportError(NO_RESULT, 200);
    return outcome.result;
  }

  public async executeBatch(
    statements: LibSQLStatement[],
    options: LibSQLExecuteOptions = {},
  ): Promise<LibSQLBatchOutcome[]> {
    if (statements.length === 0) return [];
    return this.pipeline(statements, options.timeoutMs);
  }

  /**
   * One round trip carrying every statement, and one outcome per statement.
   *
   * `close` travels with the statements instead of following them. Hrana keeps a
   * server-side stream alive between requests and hands back a `baton` to
   * continue it; a provider that never continues one must close it in the same
   * request, or every call leaves a stream for the server to time out.
   */
  private async pipeline(statements: LibSQLStatement[], timeoutMs?: number): Promise<LibSQLBatchOutcome[]> {
    const requests: Record<string, unknown>[] = statements.map((statement) => {
      const stmt: Record<string, unknown> = { sql: statement.sql };
      // Omitted rather than sent empty: an `args` member on a statement with no
      // placeholders is accepted, but sending one makes every log and every
      // capture of a plain statement look parameterised.
      if (statement.params && statement.params.length > 0) stmt.args = statement.params.map(encodeValue);
      return { type: "execute", stmt };
    });
    requests.push({ type: "close" });

    const text = await this.send(PIPELINE_PATH, JSON.stringify({ requests }), timeoutMs);

    const envelope = asRecord(parseJson(text)) as HranaPipelineEnvelope | null;
    const results = envelope?.results;
    // The envelope is the transport's own contract, so a body that is not one
    // fails the whole call: there is no per-statement answer to hand back.
    if (!Array.isArray(results)) throw new LibSQLTransportError(NOT_AN_ENVELOPE, 200);

    return statements.map((_statement, index) => readOutcome(results[index]));
  }

  public async serverVersion(): Promise<string | null> {
    try {
      const response = await fetch(`${this.origin}${VERSION_PATH}`, {
        method: "GET",
        headers: this.headers(),
      });
      if (!response.ok) return null;
      const text = (await response.text()).trim();
      return text === "" ? null : text;
    } catch {
      // A deployment without the route, and a deployment that could not be
      // reached at all, are both "no version to show" for this call. The version
      // panel's connection has already been established by the time it runs, so a
      // failure here cannot mean the server is down.
      return null;
    }
  }

  /** Nothing to release: every pipeline closes its own stream. */
  public async close(): Promise<void> {
    return Promise.resolve();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.authorization) headers.authorization = this.authorization;
    return headers;
  }

  private async send(path: string, body: string, timeoutMs?: number): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method: "POST",
        headers: this.headers(),
        body,
        // A statement that hangs would otherwise hang the request forever: fetch
        // has no default timeout. The signal covers the connect and the read,
        // which a timer wrapped around the promise would not.
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new LibSQLTransportError(`libSQL request failed: ${reason}`, 0);
    }

    const text = await response.text();
    if (!response.ok) throw httpError(response.status, text);
    return text;
  }
}
