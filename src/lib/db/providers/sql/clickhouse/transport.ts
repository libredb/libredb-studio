/**
 * ClickHouse transport seam (issue #264, design spec section 3.3)
 *
 * Provider logic never talks to the server directly. It goes through this
 * interface, so adopting a native-protocol client later is an additive change
 * (one new file implementing the same contract) rather than a rewrite of the
 * provider, the introspection and the explain strategy. This is the sibling of
 * the Couchbase seam in `providers/document/couchbase/transport.ts`.
 *
 * The types below are deliberately NEUTRAL: they describe what a caller needs,
 * not how one source encodes it. Anything the HTTP interface invented - its
 * response envelope, its parameter names, its summary fields - stays inside
 * `http-transport.ts`, and `seam-guard.test.ts` fails the build when that
 * vocabulary appears anywhere else in the provider directory. That is what keeps
 * the "one new file" estimate for a second implementation true.
 *
 * Apart from the error type this file is purely structural: no I/O.
 */

/**
 * One result row.
 *
 * Unlike Couchbase SQL++ - where `SELECT RAW` yields bare scalars and the
 * equivalent declaration is a known unsoundness - ClickHouse has no projection
 * that produces a non-object row, so this type is honest rather than a cast.
 */
export type ClickHouseRow = Record<string, unknown>;

/**
 * Normalized outcome of one statement.
 *
 * `columnTypes` sits in the neutral type rather than behind the HTTP
 * implementation because *any* ClickHouse client knows the types of the columns
 * it received; it is not an artefact of one protocol. `rawText` is neutral for
 * the same reason - output formats are a server feature, not a REST feature.
 */
export interface ClickHouseQueryResult {
  rows: ClickHouseRow[];

  /**
   * Column order as the server declared it, or null when the source could not
   * describe the rows (see `rawText`). Declared order matters: it is the only
   * way to render columns the way the statement projected them, since object
   * keys of an all-null first row cannot be trusted to be complete.
   */
  fieldNames: string[] | null;

  /**
   * Declared type per column, verbatim as ClickHouse spells it - `Int32`,
   * `Nullable(String)`, `Map(String, UInt8)`, `Enum8('x' = 1)`,
   * `LowCardinality(String)`. Live-verified in spec 1.7: collapsing these onto a
   * generic family loses the wrapper, and the wrapper is exactly what tells a
   * user whether a column is nullable or low-cardinality. Null when the source
   * could not describe the rows.
   */
  columnTypes: Record<string, string> | null;

  executionTimeMs: number;

  /**
   * How many rows the server says the statement changed.
   *
   * Report this verbatim and never derive it. Live-verified (spec 2.2): an
   * `ALTER TABLE ... UPDATE` and a lightweight `DELETE FROM` both report zero
   * even though the mutation really applied, because they are queued as
   * background mutations. Fabricating a plausible count here would turn an
   * honest "the server did not say" into a wrong number on screen.
   */
  mutationCount: number;

  /**
   * The result verbatim as text, set only when the statement produced something
   * other than JSON.
   *
   * Live-verified (spec 1.2): an explicit `FORMAT` clause in the user's own SQL
   * wins over the format the transport asks for, so `SELECT 1 FORMAT TSV`
   * genuinely comes back as TSV. Surfacing the text beats throwing - the user
   * asked for that format deliberately - and it beats guessing, which is why
   * `fieldNames` and `columnTypes` are null whenever this is set.
   */
  rawText: string | null;
}

/** Per-statement options. */
export interface ClickHouseQueryOptions {
  /**
   * Run this one statement against a different database than the connection's.
   * Needed because the connection pins a default database and introspection or
   * a data preview may target another one without rewriting the user's SQL.
   */
  database?: string;

  /**
   * ClickHouse settings to apply to this statement only.
   *
   * Deliberately open-ended rather than a fixed list of knobs: settings are a
   * first-class server feature reachable from any client, and this is where a
   * caller expresses a deadline (`max_execution_time`), a read-only guard
   * (`readonly`) or a thread cap without the seam growing a field per concern.
   * Values are stringified by the implementation; booleans are accepted because
   * the server takes `true`/`false` for boolean settings (live-verified).
   */
  settings?: Record<string, string | number | boolean>;

  /**
   * Wall-clock deadline for the whole exchange, client side.
   *
   * Distinct from a server-side execution limit, and not a duplicate of one: an
   * execution limit only starts counting once the server has accepted the
   * statement, so it cannot bound a stalled connect, handshake, or a response body
   * that stops arriving part-way. The provider advertises a query timeout, and this
   * is what makes that promise cover the transport rather than only the query.
   *
   * Neutral rather than HTTP-specific: any implementation can honour a deadline.
   */
  timeoutMs?: number;
}

/**
 * The seam itself.
 *
 * There is no management method next to `query()`, unlike Couchbase: every
 * ClickHouse metric, session and storage statistic the provider needs is a
 * `system.*` table reachable by SQL, so a second entry point would be a
 * permanent HTTP dependency for nothing.
 */
export interface ClickHouseTransport {
  /** Widen when a native-protocol implementation appears. */
  readonly kind: "http";
  query(sql: string, opts?: ClickHouseQueryOptions): Promise<ClickHouseQueryResult>;
  close(): Promise<void>;
}

/**
 * The exception codes the provider branches on.
 *
 * Read back from the live server's own numbering rather than transcribed from
 * documentation (`SELECT number, errorCodeToName(toUInt32(number)) FROM
 * numbers(1500)` on 26.7.1.1315), and exported frozen so the provider, the
 * transport and the tests share one definition instead of repeating literals
 * that drift apart.
 */
export const CLICKHOUSE_ERROR_CODES = Object.freeze({
  /** A statement ClickHouse does not implement, such as a bare `UPDATE ... SET`. */
  NOT_IMPLEMENTED: 48,
  UNKNOWN_TABLE: 60,
  SYNTAX_ERROR: 62,
  UNKNOWN_DATABASE: 81,
  /** A user without the grant for the table it asked for. */
  ACCESS_DENIED: 497,
  AUTHENTICATION_FAILED: 516,
} as const);

export type ClickHouseErrorName = keyof typeof CLICKHOUSE_ERROR_CODES;

/**
 * Stand-in name for a failure that never reached the server, or reached it and
 * came back without an exception name to read - a refused socket, an aborted
 * request. There is nothing to scrape in those cases, and inventing a specific
 * name would let a caller believe the server had spoken.
 */
export const CLICKHOUSE_UNKNOWN_ERROR_NAME = "CLICKHOUSE_ERROR";

/**
 * Codes that mean "this surface is not available here", as opposed to "this
 * request was wrong".
 *
 * Spec 1.6 and 3.7: a user without monitoring grants and a deployment with
 * `query_log` switched off are both ordinary, expected configurations, so every
 * monitoring read degrades to an empty panel on these two codes and only these
 * two. Anything else is the user's own mistake and must keep propagating -
 * hiding a syntax error behind an empty panel is the failure mode this list
 * exists to prevent.
 */
const MONITORING_UNAVAILABLE_CODES: readonly number[] = [
  CLICKHOUSE_ERROR_CODES.ACCESS_DENIED,
  CLICKHOUSE_ERROR_CODES.UNKNOWN_TABLE,
];

/**
 * Normalized transport failure.
 *
 * `code` is ClickHouse's numeric exception code and is the only thing callers
 * should branch on: the server reports it as a discrete value, whereas the
 * symbolic name has to be recovered from the message prose and can be missing
 * or, on a wrapped exception, describe an inner failure. `name` carries that
 * symbol anyway - overriding the conventional class name - because it is the
 * vocabulary a ClickHouse user already reads in `clickhouse-client` output,
 * while the class itself stays recoverable through `instanceof`.
 */
export class ClickHouseTransportError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    name: string = CLICKHOUSE_UNKNOWN_ERROR_NAME,
  ) {
    super(message);
    this.name = name;
    // Subclassing a builtin loses the prototype under a downlevel emit, which
    // would make every instanceof check in the provider quietly fall through.
    Object.setPrototypeOf(this, ClickHouseTransportError.prototype);
  }

  /** True when this failure is the named one. Keyed by name so no call site spells a number. */
  is(errorName: ClickHouseErrorName): boolean {
    return this.code === CLICKHOUSE_ERROR_CODES[errorName];
  }

  /** True when a monitoring read should degrade to empty instead of surfacing this. */
  isMonitoringUnavailable(): boolean {
    return MONITORING_UNAVAILABLE_CODES.includes(this.code);
  }
}
