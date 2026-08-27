/**
 * libSQL transport seam (issue #424 Phase 5)
 *
 * Provider logic never talks to a libSQL server directly. It goes through this
 * interface, so a second implementation - Hrana over WebSocket, the embedded
 * `@tursodatabase/database` engine, or `@libsql/client` if a driver is ever
 * warranted - is one new file rather than a rewrite of the provider, the
 * introspection and the explain strategy. Sibling of the ClickHouse seam in
 * `providers/sql/clickhouse/transport.ts` and the Couchbase one.
 *
 * The types below are deliberately NEUTRAL: they describe what a caller needs,
 * not how one protocol encodes it. Everything Hrana invented - its
 * `/v2/pipeline` endpoint, its request/response envelope, its `baton`, its
 * `{ type, value }` value encoding - stays inside `hrana-transport.ts`, and
 * `seam-guard.test.ts` fails the build when that vocabulary appears anywhere
 * else in this directory. That is what keeps the "one new file" estimate true.
 *
 * Apart from the error type this file is purely structural: no I/O.
 */

/**
 * One result row, keyed by the column name the engine declared.
 *
 * libSQL answers a statement with declared columns and positional rows, so an
 * object row is a mapping this layer performs rather than a shape the wire
 * carries. Duplicate column names collapse - `SELECT 1 AS a, 2 AS a` keeps the
 * last - which is SQLite's own behaviour through every driver here and is why
 * `fieldNames` is carried separately.
 */
export type LibSQLRow = Record<string, unknown>;

/** Normalized outcome of one statement. */
export interface LibSQLStatementResult {
  rows: LibSQLRow[];

  /**
   * Column order exactly as the engine declared it. Never null: libSQL declares
   * columns for every statement, answering an empty list for one that projects
   * nothing (a `CREATE TABLE`), which is a declaration rather than an absence.
   */
  fieldNames: string[];

  /**
   * SQLite's declared type per column, verbatim - `TEXT`, `INTEGER`, `NUMERIC`.
   *
   * Populated only for the columns that have one. SQLite declares a type for a
   * column read straight out of a table and NOTHING for a computed one, which
   * is not this transport's gap to fill: `SELECT name FROM t` declares `TEXT`
   * while `SELECT sqlite_version()` and every `PRAGMA` column declare nothing
   * (measured on sqld 0.24.33 and Turso Cloud, both SQLite 3.47.0). An empty
   * record therefore means "the engine declared no types", never "the transport
   * did not look".
   */
  columnTypes: Record<string, string>;

  /** Rows a write changed, as the engine counted them. */
  affectedRowCount: number;

  /**
   * The rowid the last INSERT produced, or null when the statement produced none.
   *
   * A number where the value is exactly representable and a decimal STRING where
   * it is not, for the reason `decodeInteger` states: a rowid past 2^53 that
   * arrives rounded is a silent corruption, and SQLite rowids are 64-bit.
   */
  lastInsertRowId: number | string | null;

  executionTimeMs: number;
}

/** One statement and the parameters it binds. */
export interface LibSQLStatement {
  sql: string;
  /** Positional parameters, in the order the statement's `?` placeholders appear. */
  params?: unknown[];
}

/**
 * What one statement of a batch produced: its result, or the failure that is
 * ITS failure alone.
 *
 * A discriminated outcome rather than a result array plus a throw, and that is
 * the whole point of the shape. Measured on both deployments: a batch whose
 * second statement fails still runs the third, and each statement carries its own
 * outcome. Collapsing that onto a single rejection is how one refused read costs
 * a whole monitoring dashboard (#477, BACKLOG D22) - so the transport hands the
 * failures back individually and the provider decides, per panel, what an absent
 * reading means.
 */
export type LibSQLBatchOutcome =
  | { ok: true; result: LibSQLStatementResult }
  | { ok: false; error: LibSQLTransportError };

/** Options a caller may attach to one statement. */
export interface LibSQLExecuteOptions {
  /** Positional parameters, in the order the statement's `?` placeholders appear. */
  params?: unknown[];
  timeoutMs?: number;
}

/**
 * What the provider is allowed to ask of a libSQL server.
 *
 * Narrow on purpose: everything else the provider needs it builds out of
 * statements, because SQLite's introspection is SQL (`sqlite_master`, the
 * `pragma_*` table-valued functions) rather than a management API.
 */
export interface LibSQLTransport {
  readonly kind: "hrana-http";

  execute(sql: string, options?: LibSQLExecuteOptions): Promise<LibSQLStatementResult>;

  /**
   * Several statements in ONE round trip, each with its own outcome.
   *
   * Not an optimisation dressed up as a contract: SQLite introspection is
   * per-table (`pragma_table_info`, `pragma_index_list`, `pragma_foreign_key_list`
   * and a `COUNT(*)` for every table), so a schema read that issues one request
   * per statement is four round trips per table - and a libSQL server is normally
   * across a network rather than on the filesystem, which is the difference
   * between this provider and the SQLite one it shares a dialect with. An
   * implementation without a batch protocol may honestly satisfy this by looping.
   *
   * An empty list answers an empty list without touching the network.
   */
  executeBatch(statements: LibSQLStatement[], options?: LibSQLExecuteOptions): Promise<LibSQLBatchOutcome[]>;

  /**
   * The server's own version string, or null when the deployment publishes none.
   *
   * Null is a real answer here rather than a failure, and this is the one place
   * the two deployments measurably disagree: a self-hosted sqld answers
   * `sqld 0.24.33 (f8fb14f3 2026-08-11)`, while Turso Cloud has no such route at
   * all (`{"error":"route not found: [\\"version\\"]"}`, measured 2026-08-27).
   * The provider renders the absence as absent - never as an invented version and
   * never as a failed connection.
   */
  serverVersion(): Promise<string | null>;

  close(): Promise<void>;
}

/**
 * A failure that is the transport's to report: the request never reached a
 * libSQL server, or what came back was not a libSQL answer.
 *
 * A statement the ENGINE rejected is not one of these - it arrives as an HTTP
 * 200 carrying the engine's own message, and the provider maps it to a
 * `QueryError` so a user sees SQLite's wording rather than a transport failure.
 */
export class LibSQLTransportError extends Error {
  public readonly status: number;
  /** The engine's own error code where it sent one (`SQLITE_UNKNOWN`), else null. */
  public readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "LibSQLTransportError";
    this.status = status;
    this.code = code;
  }
}
