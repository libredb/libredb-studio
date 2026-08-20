/**
 * Trino HTTP transport (issue #424, Phase 2)
 *
 * The only implementation of the {@link TrinoTransport} seam, and the only file
 * in the provider allowed to know the client protocol: its endpoint paths, the
 * generated `X-<Product>-*` header family, the `nextUri` chain a statement is
 * answered through, the positional `data` rows and their declaration, the
 * `updateType`/`updateCount` pair, the `stats` block, the failure document, the
 * warning envelope, and the statuses the protocol says to retry.
 * `seam-guard.test.ts` fails the build the moment any of that appears elsewhere
 * in the directory, which is what keeps "PrestoDB is one descriptor" true rather
 * than aspirational.
 *
 * Zero runtime dependency: everything below goes through the runtime's own
 * `fetch`.
 *
 * SIX MEASURED FACTS drive nearly every decision here, all verified against a
 * live Trino 476 on 2026-08-20, and each is the opposite of what a JSON API
 * teaches:
 *
 * 1. A FAILED STATEMENT ANSWERS HTTP 200. A mistyped keyword, a missing table, an
 *    unsupported DDL - every one is a 200 whose document carries a failure. Success
 *    is therefore never inferred from a status, and the failure is read from the
 *    body of a response that `Response.ok` calls fine.
 * 2. THE LOOP TERMINATES ON THE ABSENCE OF THE NEXT LINK, NEVER ON A STATE. Even
 *    `SELECT version()` takes five pages. A page reporting FINISHED can still carry
 *    a link, and measured, the page that finally holds the rows was one of those.
 *    A page with no `data` is mid-flight, not the end.
 * 3. THE DECLARATION AND THE ROWS ARRIVE ON DIFFERENT PAGES. The first three pages
 *    of a statement typically carry neither. The declaration is captured from the
 *    first page that has one and held for the whole exchange.
 * 4. `Authorization: Basic` OVER PLAIN HTTP IS REFUSED, even by a coordinator with
 *    authentication switched off entirely: HTTP 401, `Password not allowed for
 *    insecure authentication`. So a password is a TLS-only credential here, and
 *    sending it over `http://` breaks a connection that would otherwise have worked.
 * 5. A REQUEST THE COORDINATOR REFUSES BEFORE IT IS A STATEMENT ANSWERS PLAIN TEXT.
 *    A missing user header answers 401 with `Basic authentication or
 *    X-Trino-Original-User or X-Trino-User must be sent` - not JSON. Parsing that as
 *    JSON would throw a second, misleading error on top of the first.
 * 6. ABANDONING THE LOOP DOES NOT STOP THE WORK. An aborted exchange leaves the
 *    statement running on the cluster to completion, so every exit path that is not
 *    a completed answer terminates it explicitly.
 */

import type { DatabaseConnection } from "@/lib/db/types";
import {
  type TrinoDialect,
  type TrinoErrorCategory,
  type TrinoExecutionStats,
  type TrinoQueryOptions,
  type TrinoQueryResult,
  type TrinoRow,
  type TrinoSourceLocation,
  type TrinoTransport,
  TrinoTransportError,
  type TrinoWarning,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOST = "localhost";

/**
 * The user a statement runs as when the connection names none.
 *
 * Not optional and not omittable: measured, a request with no user header is
 * refused with HTTP 401 before the statement is parsed, so "no user" is not a
 * configuration this protocol has. The coordinator also reports this name in its
 * own UI and in `system.runtime.queries`, which is why it is a recognisable word
 * rather than a blank.
 */
const DEFAULT_USER = "libredb";

/** Where a statement is submitted. */
const STATEMENT_PATH = "/v1/statement";

/**
 * Where a statement is terminated by id.
 *
 * The protocol offers two cancellations and they are not interchangeable. A
 * DELETE to the current next link ends the statement, but it needs a link the
 * loop may already have consumed; this endpoint needs only the id, which is why
 * it is the one the seam exposes. Measured, it builds a session from the request,
 * so unlike a link DELETE it requires the user header.
 */
const QUERY_PATH = "/v1/query";

/** The statement travels as its own text: no JSON envelope, no trailing semicolon. */
const SQL_CONTENT_TYPE = "text/plain";
const JSON_ACCEPT = "application/json";

/**
 * The header family, spelled as SUFFIXES only.
 *
 * Every finished header name is generated as `X-<prefix>-<suffix>` from the
 * dialect, exactly the way `io.trino.client.ProtocolHeaders` generates it server
 * side. No whole header name is written down anywhere in this file, because the
 * moment one is, the second product stops being a descriptor.
 */
const HEADER_SUFFIXES = Object.freeze({
  USER: "User",
  SOURCE: "Source",
  CATALOG: "Catalog",
  SCHEMA: "Schema",
  TIME_ZONE: "Time-Zone",
} as const);

/**
 * What the cluster records as the origin of every statement.
 *
 * Not decoration: it is what appears in `system.runtime.queries.source`, which is
 * how an operator attributes load and how resource groups route it. A cluster
 * whose queries all say "unknown" cannot be operated.
 */
const CLIENT_SOURCE = "libredb-studio";

/**
 * Timestamps render in this zone rather than the cluster's.
 *
 * The protocol's default is "the timezone of the Trino cluster, and not the
 * timezone of the client", so leaving it unset makes the same statement produce
 * different text depending on where the coordinator happens to run. Pinned, so
 * the rendering is a property of the tool rather than of the deployment.
 */
const CLIENT_TIME_ZONE = "UTC";

/**
 * The statuses the protocol names as intermittent, verbatim: "If the client
 * request returns an HTTP 502, 503, or 504, that means there was an intermittent
 * problem processing request and the client should try again in 50-100 ms."
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** "if the request returns a 429 status code, the client should retry the request using the Retry-After header value provided." */
const THROTTLED_STATUS = 429;
const RETRY_AFTER_HEADER = "Retry-After";

const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;

/** The middle of the protocol's own 50-100 ms window. */
const RETRY_DELAY_MS = 75;

/**
 * Attempts per REQUEST, not per statement.
 *
 * Bounded because the protocol's retry advice has no bound of its own, and an
 * unbounded one turns a coordinator that is down into a client that never
 * returns. Four attempts spans roughly a quarter second of intermittency, which
 * is what "intermittent" means here; anything longer is an outage the caller
 * should hear about.
 */
const MAX_ATTEMPTS = 4;

/**
 * The longest a throttling instruction is honoured before it is treated as an
 * outage.
 *
 * The header is the server's, and a server asking a browser-driven client to
 * sleep for an hour is a refusal wearing a retry's clothes.
 */
const MAX_RETRY_AFTER_MS = 30_000;
const MILLIS_PER_SECOND = 1_000;

/**
 * A runaway guard on the page loop, not a result limit.
 *
 * The loop's real bound is the caller's signal: the server long-polls each page
 * for about a second, so a legitimately slow statement produces hundreds of
 * pages, and a low cap here would truncate honest work. This exists only so a
 * coordinator that keeps handing out links forever cannot spin a request
 * indefinitely, and hitting it is REPORTED rather than silently accepted - the
 * failure mode being avoided is a truncation nobody was told about.
 */
const MAX_PAGES = 5_000;

/** How much of a plain-text refusal is quoted back to the user. */
const MESSAGE_LIMIT = 300;

/**
 * The members of a result document. Frozen and named so no call site spells one
 * twice, and so the seam guard can prove that only this file reads them.
 */
const RESULT_FIELDS = Object.freeze({
  ID: "id",
  /**
   * The whole termination condition. "If present, the URL to use for subsequent
   * GET or DELETE requests. If not present, the query is complete or ended in
   * error."
   */
  NEXT: "nextUri",
  COLUMNS: "columns",
  DATA: "data",
  STATS: "stats",
  ERROR: "error",
  WARNINGS: "warnings",
  UPDATE_TYPE: "updateType",
  UPDATE_COUNT: "updateCount",
  /**
   * Deliberately NOT read. It cancels the running stage rather than the
   * statement, which would leave a half-finished query looking cancelled while
   * the coordinator kept it alive. Recorded here because this file is the record
   * of what the wire contains.
   */
  PARTIAL_CANCEL: "partialCancelUri",
} as const);

/** One declared column. */
const COLUMN_FIELDS = Object.freeze({
  NAME: "name",
  /** The rendered type: `varchar(25)`, `array(integer)`, `row(x integer, y varchar)`. */
  TYPE: "type",
  /**
   * The same type as a parsed tree. Deliberately NOT read: the rendered form is
   * what a user reads in their own DDL, and a label does not need the tree.
   */
  SIGNATURE: "typeSignature",
} as const);

/** The failure document, present exactly when the statement failed. */
const ERROR_FIELDS = Object.freeze({
  MESSAGE: "message",
  /** The stable fault name, e.g. `TABLE_NOT_FOUND`. The classifier. */
  NAME: "errorName",
  /** The coarse family, e.g. `USER_ERROR`. The fallback classifier. */
  TYPE: "errorType",
  LOCATION: "errorLocation",
  LINE: "lineNumber",
  COLUMN: "columnNumber",
  /**
   * The Java exception chain, with a stack. Deliberately NOT surfaced here: a
   * `io.trino.spi.TrinoException` and forty frames of ANTLR tell the person who
   * mistyped a keyword nothing, and the message already carries the line and
   * column. Recorded because a later change may want the deepest cause, which is
   * where a connector's own failure hides.
   */
  FAILURE: "failureInfo",
} as const);

/** The execution report the coordinator attaches to every page. */
const STATS_FIELDS = Object.freeze({
  STATE: "state",
  ELAPSED: "elapsedTimeMillis",
  CPU: "cpuTimeMillis",
  QUEUED: "queuedTimeMillis",
  PROCESSED_ROWS: "processedRows",
  PROCESSED_BYTES: "processedBytes",
  PEAK_MEMORY: "peakMemoryBytes",
} as const);

/** One non-fatal remark. */
const WARNING_FIELDS = Object.freeze({
  CODE: "warningCode",
  NAME: "name",
  MESSAGE: "message",
} as const);

/**
 * Fault name -> category, exact match. Only names observed on the live server, or
 * documented as part of the engine's own enum, appear.
 *
 * Measured on 476, one probe per entry that carries a measured note:
 * `SELEKT 1` -> SYNTAX_ERROR; `FROM nosuchcatalog...` -> CATALOG_NOT_FOUND;
 * `tpch.sf1.no_such_table` -> TABLE_NOT_FOUND; a bad projection ->
 * COLUMN_NOT_FOUND; `CREATE TABLE` on the tpch connector -> NOT_SUPPORTED;
 * a DELETE to the running statement -> USER_CANCELED; `CALL
 * system.runtime.kill_query` against one -> ADMINISTRATIVELY_KILLED.
 */
const FAULT_CATEGORIES: Readonly<Record<string, TrinoErrorCategory>> = Object.freeze({
  SYNTAX_ERROR: "syntax",
  CATALOG_NOT_FOUND: "unknown-object",
  SCHEMA_NOT_FOUND: "unknown-object",
  TABLE_NOT_FOUND: "unknown-object",
  COLUMN_NOT_FOUND: "unknown-object",
  FUNCTION_NOT_FOUND: "unknown-object",
  NOT_SUPPORTED: "unsupported",
  PERMISSION_DENIED: "auth",
  USER_CANCELED: "cancelled",
  // The other way a statement stops, and it must not read as an engine fault: its
  // `errorType` is USER_ERROR, so without this row it falls through to the family
  // table and categorises as `engine`. Measured on 476 - a long join killed with
  // `CALL system.runtime.kill_query(query_id => …, message => 'probe')` reports
  // `"errorName":"ADMINISTRATIVELY_KILLED"`, `"errorCode":38`, message "Query killed.
  // Message: probe". That procedure is this provider's own `kill` maintenance
  // operation, so the wrong category would make the monitoring panel report the query
  // it had just stopped as a failure.
  ADMINISTRATIVELY_KILLED: "cancelled",
  EXCEEDED_TIME_LIMIT: "timeout",
});

/**
 * The coarse family a fault name this table has never seen falls back to.
 *
 * `USER_ERROR` becomes `engine` rather than anything more specific on purpose:
 * the family says whose fault it is, not what went wrong, and measured, a
 * mismatched INSERT column list (`TYPE_MISMATCH`) lands here. "The engine refused
 * this statement, and here is what it said" is the honest report; inferring a
 * cause from a blame label would not be.
 */
const FAULT_TYPE_CATEGORIES: Readonly<Record<string, TrinoErrorCategory>> = Object.freeze({
  USER_ERROR: "engine",
  INSUFFICIENT_RESOURCES: "resources",
  INTERNAL_ERROR: "engine",
  EXTERNAL: "engine",
});

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

/** A member the document reported as usable text, or null when it reported none. */
function textField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A member the document reported as a usable number, or null.
 *
 * Non-finite is refused along with the wrong type: a caller renders these, and
 * `NaN ms` is worse than "unknown".
 */
function numberField(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One line of a server's own words, short enough to render.
 *
 * Refusals arrive as plain text of unbounded length, and a stack trace pasted
 * into a toast is not a message. Collapsing the whitespace first keeps a
 * multi-line body readable on one line.
 */
function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MESSAGE_LIMIT ? `${collapsed.slice(0, MESSAGE_LIMIT)}...` : collapsed;
}

/** `<reason>` appended to a message, or nothing when the server said nothing. */
function withDetail(message: string, text: string): string {
  const detail = summarize(text);
  return detail === "" ? message : `${message}: ${detail}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    // A retry instruction can ask for tens of seconds, and a caller who aborts
    // must not have to wait out the server's advice before hearing about it.
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

// ============================================================================
// Reading a page
// ============================================================================

/**
 * The declared names, made unique, with their rendered types.
 *
 * Measured on 476: `SELECT 1 AS c, 2 AS c` really declares
 * `[{name:"c",...},{name:"c",...}]`, and a row is a record, so the repeat has to
 * be disambiguated while the row is built or the second column disappears BEFORE
 * the seam rather than after it. The suffix keeps climbing because
 * `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal too, and uniqueness is the
 * invariant the seam states.
 */
function readColumns(page: Record<string, unknown>): { names: string[]; types: Record<string, string> } | null {
  const declared = page[RESULT_FIELDS.COLUMNS];
  if (!Array.isArray(declared)) return null;

  const names: string[] = [];
  const types: Record<string, string> = {};
  const taken = new Set<string>();

  for (const entry of declared) {
    const column = asRecord(entry) ?? {};
    const declaredName = textField(column, COLUMN_FIELDS.NAME) ?? "";
    let unique = declaredName;
    for (let repeat = 2; taken.has(unique); repeat += 1) unique = `${declaredName} (${repeat})`;
    taken.add(unique);
    names.push(unique);
    types[unique] = textField(column, COLUMN_FIELDS.TYPE) ?? "";
  }

  return { names, types };
}

/**
 * The positional rows on this page.
 *
 * A page with no rows is the ordinary mid-flight case, not the end of anything.
 * A `data` member that is not an array is the spooling protocol: the client opts
 * into that by advertising an encoding, this one never does, and if a server ever
 * sends it anyway the honest answer is a refusal rather than rows silently read
 * out of a segment index. The alternative is failing later as
 * "rows.map is not a function".
 */
function readData(dialect: TrinoDialect, page: Record<string, unknown>): unknown[] {
  const data = page[RESULT_FIELDS.DATA];
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) {
    throw new TrinoTransportError(
      "unsupported",
      `${dialect.displayName} answered with spooled result segments, which this client does not request and cannot read`,
    );
  }

  return data;
}

/** One positional row, rebuilt as the record the seam promises. */
function toRow(fieldNames: readonly string[], row: unknown): TrinoRow {
  const values = Array.isArray(row) ? (row as unknown[]) : [];
  return Object.fromEntries(fieldNames.map((name, column) => [name, values[column] ?? null]));
}

function readStats(page: Record<string, unknown>): TrinoExecutionStats | null {
  const stats = asRecord(page[RESULT_FIELDS.STATS]);
  if (stats === null) return null;

  return {
    state: textField(stats, STATS_FIELDS.STATE),
    elapsedMs: numberField(stats, STATS_FIELDS.ELAPSED),
    cpuMs: numberField(stats, STATS_FIELDS.CPU),
    queuedMs: numberField(stats, STATS_FIELDS.QUEUED),
    processedRows: numberField(stats, STATS_FIELDS.PROCESSED_ROWS),
    processedBytes: numberField(stats, STATS_FIELDS.PROCESSED_BYTES),
    peakMemoryBytes: numberField(stats, STATS_FIELDS.PEAK_MEMORY),
  };
}

/** What a statement whose pages never carried an execution report can honestly say. */
const UNREPORTED_STATS: TrinoExecutionStats = Object.freeze({
  state: null,
  elapsedMs: null,
  cpuMs: null,
  queuedMs: null,
  processedRows: null,
  processedBytes: null,
  peakMemoryBytes: null,
});

/**
 * The remarks on this page.
 *
 * Measured: the same remark is repeated on every page of the exchange, so these
 * are accumulated into a keyed map by the caller rather than concatenated. A
 * remark with no readable message is dropped - an empty row in a warning list
 * tells a user nothing and looks like a bug.
 */
function readWarnings(page: Record<string, unknown>): TrinoWarning[] {
  const warnings = page[RESULT_FIELDS.WARNINGS];
  if (!Array.isArray(warnings)) return [];

  return warnings.flatMap((entry) => {
    const warning = asRecord(entry);
    const message = warning === null ? null : textField(warning, WARNING_FIELDS.MESSAGE);
    if (message === null) return [];

    const code = textField(asRecord(warning?.[WARNING_FIELDS.CODE]) ?? {}, WARNING_FIELDS.NAME);
    return [{ code: code ?? "", message }];
  });
}

function readLocation(error: Record<string, unknown>): TrinoSourceLocation | null {
  // Measured: legitimately null on a NOT_SUPPORTED and absent entirely on a
  // USER_CANCELED, so "no location" is ordinary rather than a parse failure.
  const location = asRecord(error[ERROR_FIELDS.LOCATION]);
  if (location === null) return null;

  const line = numberField(location, ERROR_FIELDS.LINE);
  const column = numberField(location, ERROR_FIELDS.COLUMN);
  return line === null || column === null ? null : { line, column };
}

/**
 * The category the failure document describes.
 *
 * The fault name first, because it says WHAT went wrong; the family second,
 * because it only says whose fault it was. A document with neither becomes
 * `engine`: the engine refused the statement, and that is all that was observed.
 */
function categorize(name: string | null, family: string | null): TrinoErrorCategory {
  if (name !== null && name in FAULT_CATEGORIES) return FAULT_CATEGORIES[name] as TrinoErrorCategory;
  if (family !== null && family in FAULT_TYPE_CATEGORIES) return FAULT_TYPE_CATEGORIES[family] as TrinoErrorCategory;

  return "engine";
}

/**
 * The failure this page reports, or null when it reports none.
 *
 * Nothing here reads a status code, because there is none worth reading: the
 * response carrying this document is an HTTP 200 (fact 1 in the header).
 */
function pageFailure(dialect: TrinoDialect, page: Record<string, unknown>): TrinoTransportError | null {
  const error = asRecord(page[RESULT_FIELDS.ERROR]);
  if (error === null) return null;

  const name = textField(error, ERROR_FIELDS.NAME);
  return new TrinoTransportError(
    categorize(name, textField(error, ERROR_FIELDS.TYPE)),
    // The engine's own wording, verbatim: it is the only text that locates the
    // fault for the user, and rewriting it would throw away "line 1:15: Table
    // 'tpch.sf1.no_such_table' does not exist".
    textField(error, ERROR_FIELDS.MESSAGE) ?? `${dialect.displayName} refused the statement`,
    name,
    readLocation(error),
  );
}

// ============================================================================
// Failures that are not statements
// ============================================================================

/**
 * The failure a non-OK response describes.
 *
 * The body is treated as TEXT throughout, never parsed as JSON, because at this
 * layer it is not JSON: measured, a missing user header answers 401 with the
 * plain sentence `Basic authentication or X-Trino-Original-User or X-Trino-User
 * must be sent`, and a wrong path answers 404 with `Error 404 Not Found: HTTP 404
 * Not Found`. Parsing either would throw a second, misleading error on top of the
 * first and lose the sentence that says what to fix.
 */
function responseFailure(dialect: TrinoDialect, status: number, text: string): TrinoTransportError {
  const name = dialect.displayName;
  if (status === UNAUTHORIZED_STATUS || status === FORBIDDEN_STATUS) {
    return new TrinoTransportError("auth", withDetail(`${name} refused the credentials (HTTP ${status})`, text));
  }
  if (status === NOT_FOUND_STATUS) {
    return new TrinoTransportError(
      "unreachable",
      withDetail(`${name} has no client protocol endpoint at this address (HTTP 404)`, text),
    );
  }

  return new TrinoTransportError("engine", withDetail(`${name} rejected the request with HTTP ${status}`, text));
}

/**
 * The failure a thrown `fetch` describes.
 *
 * The SIGNAL is consulted before the thrown value, because the thrown value is
 * not reliably abort-shaped. `controller.abort()` throws a DOMException named
 * `AbortError`, `AbortSignal.timeout()` one named `TimeoutError`, but
 * `controller.abort(new Error("the tab closed"))` throws that Error verbatim -
 * and attaching a reason is the normal way to say why a request was cancelled. A
 * name-only test would have reported a deliberate cancellation as an unreachable
 * cluster.
 */
function requestFailure(dialect: TrinoDialect, cause: unknown, signal?: AbortSignal): TrinoTransportError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (signal?.aborted) {
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    return timedOut
      ? new TrinoTransportError("timeout", `${dialect.displayName} did not answer before the deadline`)
      : new TrinoTransportError("cancelled", `The request to ${dialect.displayName} was cancelled`);
  }

  return new TrinoTransportError("unreachable", `${dialect.displayName} could not be reached: ${reason}`);
}

/**
 * How long to wait before retrying this response, or null when it must not be
 * retried.
 *
 * The attempt bound is checked FIRST, so a coordinator that answers 503 forever
 * surfaces its own last 503 rather than a client-invented timeout.
 */
function retryDelayMs(status: number, retryAfter: string | null, attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  if (RETRY_STATUSES.has(status)) return RETRY_DELAY_MS;
  if (status !== THROTTLED_STATUS) return null;

  // The header is expressed in seconds. A server may also send an HTTP date, and
  // anything unreadable falls back to the protocol's own interval rather than to
  // no wait at all - a 429 answered instantly is a 429 again.
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds < 0) return RETRY_DELAY_MS;

  return Math.min(seconds * MILLIS_PER_SECOND, MAX_RETRY_AFTER_MS);
}

// ============================================================================
// Transport
// ============================================================================

/** One drained HTTP response. */
interface HttpOutcome {
  status: number;
  text: string;
}

export class TrinoHttpTransport implements TrinoTransport {
  public readonly dialect: TrinoDialect;

  private readonly origin: string;
  private readonly user: string;
  private readonly catalog: string | undefined;
  private readonly authorization: string | undefined;

  constructor(dialect: TrinoDialect, config: DatabaseConnection) {
    this.dialect = dialect;
    // `ssl` is a first-class connection field and independent of the form's
    // `connectionFields`, and an explicit `disable` has to turn TLS OFF as well as
    // an explicit mode turns it on (the #264 lesson).
    const secure = config.ssl !== undefined && config.ssl.mode !== "disable";
    const host = formatHost(config.host ?? DEFAULT_HOST);
    this.origin = `${secure ? "https" : "http"}://${host}:${config.port ?? dialect.defaultPort}`;
    this.user = config.user ?? DEFAULT_USER;
    // The connection's `database` holds the CATALOG, the way a PostgreSQL
    // connection pins one database. It is a default for unqualified names, not a
    // boundary: a fully qualified statement still reaches any catalog the session
    // can see.
    this.catalog = config.database;

    if (config.password === undefined || config.password === "") {
      this.authorization = undefined;
      return;
    }

    // Fact 4, measured: a password over plain HTTP is refused by the coordinator
    // itself - HTTP 401, "Password not allowed for insecure authentication" - even
    // with authentication switched off, because "All authentication requires
    // secure connections using TLS". Both other options are worse than refusing
    // here. Sending it anyway turns a connection that would have worked into a 401
    // on every statement; dropping it silently lets a user believe a credential is
    // in force when nothing is authenticating them at all.
    if (!secure) {
      throw new TrinoTransportError(
        "auth",
        `${dialect.displayName} refuses a password over plain HTTP. Enable TLS on the connection, or remove the password to connect as an unauthenticated user.`,
      );
    }

    this.authorization = `Basic ${Buffer.from(`${this.user}:${config.password}`).toString("base64")}`;
  }

  public async query(sql: string, options: TrinoQueryOptions = {}): Promise<TrinoQueryResult> {
    const first = await this.submit(sql, options);
    const queryId = textField(first, RESULT_FIELDS.ID);
    if (queryId === null) {
      throw new TrinoTransportError(
        "unreachable",
        `${this.dialect.displayName} accepted the statement without identifying it, so this is not a coordinator`,
      );
    }

    // Announced before the answer exists, because a caller that wants to cancel
    // has to learn the id while the statement is still running.
    options.onQueryStarted?.(queryId);

    try {
      return await this.follow(first, queryId, options.signal);
    } catch (error) {
      // Fact 6: abandoning the loop leaves the statement running on the cluster to
      // completion. Every exit path that is not a completed answer - an abort, a
      // deadline, a failure this client raised, a runaway page count - owes the
      // cluster a termination.
      await this.abandon(queryId);
      throw error;
    }
  }

  public async cancel(queryId: string, signal?: AbortSignal): Promise<void> {
    await this.send(
      `${this.origin}${QUERY_PATH}/${encodeURIComponent(queryId)}`,
      { method: "DELETE", headers: this.sessionHeaders() },
      signal,
    );
  }

  /**
   * Nothing to release: one exchange per statement, no session pinned and no
   * socket owned, so this exists only because every implementation of the seam has
   * to be closeable.
   */
  public close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Follow the chain until the server stops offering a next link.
   *
   * Facts 2 and 3 in the header are the whole of this loop. The declaration is
   * captured from the first page that carries one; the rows are accumulated
   * POSITIONALLY and rebuilt at the end, so a page that somehow carried rows ahead
   * of the declaration cannot silently lose them; the execution report is taken
   * from the latest page that has one, which is the most complete; and the remarks
   * are keyed, because the same remark repeats on every page.
   */
  private async follow(
    first: Record<string, unknown>,
    queryId: string,
    signal?: AbortSignal,
  ): Promise<TrinoQueryResult> {
    const positional: unknown[] = [];
    const warnings = new Map<string, TrinoWarning>();
    let fieldNames: string[] | null = null;
    let columnTypes: Record<string, string> | null = null;
    let operation: string | null = null;
    let affectedRows: number | null = null;
    let stats: TrinoExecutionStats = UNREPORTED_STATS;
    let page = first;

    for (let visited = 1; ; visited += 1) {
      const failure = pageFailure(this.dialect, page);
      if (failure !== null) throw failure;

      const declared = readColumns(page);
      if (declared !== null && fieldNames === null) {
        fieldNames = declared.names;
        columnTypes = declared.types;
      }

      positional.push(...readData(this.dialect, page));
      for (const warning of readWarnings(page)) warnings.set(`${warning.code}\u0000${warning.message}`, warning);
      operation = textField(page, RESULT_FIELDS.UPDATE_TYPE) ?? operation;
      affectedRows = numberField(page, RESULT_FIELDS.UPDATE_COUNT) ?? affectedRows;
      stats = readStats(page) ?? stats;

      const next = textField(page, RESULT_FIELDS.NEXT);
      if (next === null) break;
      if (visited >= MAX_PAGES) {
        throw new TrinoTransportError(
          "engine",
          `${this.dialect.displayName} kept the statement open past ${MAX_PAGES} pages, so the answer was abandoned rather than reported as complete`,
        );
      }

      page = await this.request(next, { method: "GET", headers: this.pollHeaders() }, signal);
    }

    if (fieldNames === null && positional.length > 0) {
      throw new TrinoTransportError(
        "engine",
        `${this.dialect.displayName} sent rows it never declared columns for, so they cannot be read`,
      );
    }

    return {
      rows: fieldNames === null ? [] : positional.map((row) => toRow(fieldNames, row)),
      fieldNames,
      columnTypes,
      queryId,
      operation,
      affectedRows,
      warnings: [...warnings.values()],
      stats,
    };
  }

  private async submit(sql: string, options: TrinoQueryOptions): Promise<Record<string, unknown>> {
    return await this.request(
      `${this.origin}${STATEMENT_PATH}`,
      { method: "POST", headers: this.submitHeaders(options), body: sql },
      options.signal,
    );
  }

  /** Terminate a statement this transport started, without letting the attempt mask the real failure. */
  private async abandon(queryId: string): Promise<void> {
    try {
      // Deliberately no signal: the caller's is very likely the aborted one that
      // brought us here, and passing it would abort the cleanup too.
      await this.cancel(queryId);
    } catch {
      // Best effort by construction. The statement's own failure is what the
      // caller asked about, and replacing it with "and the cancellation also
      // failed" would hide it.
    }
  }

  /**
   * Protocol headers, generated from the dialect's prefix exactly the way the
   * server generates them.
   *
   * Sent only on the submission: the protocol states the headers "are only
   * required in the initial POST request, and not when following the nextUri
   * links".
   */
  private submitHeaders(options: TrinoQueryOptions): Record<string, string> {
    const catalog = options.catalog ?? this.catalog;
    return {
      ...this.sessionHeaders(),
      "content-type": SQL_CONTENT_TYPE,
      [this.header(HEADER_SUFFIXES.TIME_ZONE)]: CLIENT_TIME_ZONE,
      ...(catalog === undefined || catalog === "" ? {} : { [this.header(HEADER_SUFFIXES.CATALOG)]: catalog }),
      ...(options.schema === undefined || options.schema === ""
        ? {}
        : { [this.header(HEADER_SUFFIXES.SCHEMA)]: options.schema }),
    };
  }

  /** What identifies the session: the user, who we are, and the credential if there is one. */
  private sessionHeaders(): Record<string, string> {
    return {
      accept: JSON_ACCEPT,
      [this.header(HEADER_SUFFIXES.USER)]: this.user,
      [this.header(HEADER_SUFFIXES.SOURCE)]: CLIENT_SOURCE,
      ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
    };
  }

  /**
   * What a follow-up needs.
   *
   * The credential travels on every request, unlike the protocol headers: the
   * "first POST only" rule is about the `X-<Product>-*` family, and a coordinator
   * behind TLS authenticates each request on its own.
   */
  private pollHeaders(): Record<string, string> {
    return {
      accept: JSON_ACCEPT,
      ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
    };
  }

  /** `X-<Product>-<Suffix>`, never written down whole. */
  private header(suffix: string): string {
    return `X-${this.dialect.headerPrefix}-${suffix}`;
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const outcome = await this.send(url, init, signal);
    const page = asRecord(parseJson(outcome.text));
    if (page === null) {
      throw new TrinoTransportError(
        "unreachable",
        withDetail(
          `${this.dialect.displayName} answered something that is not a client protocol document`,
          outcome.text,
        ),
      );
    }

    return page;
  }

  /**
   * One request, retried while the protocol says the failure was intermittent.
   *
   * The body is drained as text before anything is decided, so a refusal and a
   * result are read the same way.
   */
  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<HttpOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
        text = await response.text();
      } catch (error) {
        // A refused socket, an unresolvable host, an abort and a body that stopped
        // arriving all land here, and all have to leave as the seam's error type.
        throw requestFailure(this.dialect, error, signal);
      }

      if (response.ok) return { status: response.status, text };

      const wait = retryDelayMs(response.status, response.headers.get(RETRY_AFTER_HEADER), attempt);
      if (wait === null) throw responseFailure(this.dialect, response.status, text);

      try {
        await delay(wait, signal);
      } catch (error) {
        throw requestFailure(this.dialect, error, signal);
      }
    }
  }
}
