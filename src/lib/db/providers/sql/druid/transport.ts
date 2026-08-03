/**
 * Druid transport seam (issue #265, design spec section 0)
 *
 * Provider logic never talks to the cluster directly. It goes through this
 * interface, so adopting Druid's Avatica JDBC driver later - or any client that
 * is not the SQL HTTP endpoint - is an additive change (one new file
 * implementing the same contract) rather than a rewrite of the provider, the
 * introspection and the explain strategy. This is the sibling of the ClickHouse
 * seam in `providers/sql/clickhouse/transport.ts`.
 *
 * The types below are deliberately NEUTRAL: they describe what a caller needs,
 * not how one source encodes it. Everything Druid's HTTP endpoint invented - the
 * result-format flags, the header rows it prepends, its two error envelopes, its
 * query context - stays inside `http-transport.ts`, and `seam-guard.test.ts`
 * fails the build when that vocabulary appears anywhere else in the provider
 * directory. That is what keeps the "one new file" estimate for a second
 * implementation true.
 *
 * Apart from the error type this file is purely structural: no I/O.
 */

/**
 * One result row.
 *
 * Unlike Couchbase SQL++ - where `SELECT RAW` yields bare scalars and the
 * equivalent declaration is a known unsoundness - Druid SQL has no projection
 * that produces a non-object row, so this type is honest rather than a cast.
 *
 * The rows are nonetheless REBUILT by the implementation rather than parsed as
 * objects: spec section 2 requires the wire's array form, whose rows are
 * positional, because the object form silently drops duplicate columns. That is
 * an encoding detail, so it does not reach this type - but it is the reason the
 * invariant on `fieldNames` below is the implementation's obligation.
 */
export type DruidRow = Record<string, unknown>;

/**
 * Normalized outcome of one statement.
 *
 * There is deliberately NO mutation count. Spec section 8, all live-verified on
 * 37.0.0: Druid SQL has no statement that mutates. `UPDATE` and `DELETE` are not
 * in the grammar at all, and `INSERT`/`REPLACE` are rejected by the native
 * engine ("not supported by requested SQL engine [native], consider using
 * MSQ"). A count here could therefore only ever be zero, and a field that is
 * always zero reads as "nothing changed" rather than "this cannot happen".
 */
export interface DruidQueryResult {
  rows: DruidRow[];

  /**
   * Column order as the server declared it, or null when the source could not
   * describe the rows. Declared order matters and is authoritative here, which
   * it is not for object keys: an all-null first row cannot be trusted to carry
   * every key.
   *
   * INVARIANT the implementation must uphold: these names are UNIQUE and are
   * exactly the key set of every row. Live-verified (spec section 2),
   * `SELECT 1 AS c, 2 AS c` really declares `["c","c"]`, and a duplicate cannot
   * survive into a `DruidRow` - so the loss would happen BEFORE this seam unless
   * the implementation disambiguates the repeat while it rebuilds the row. The
   * seam requires uniqueness and leaves the spelling to the implementation.
   *
   * The originally declared names are not carried alongside: a column can only
   * be labelled with the key its value is looked up by (`QueryResult.fields` is
   * a `string[]` of row keys), so a second list would be a field with no
   * consumer that every future implementation would still have to produce.
   */
  fieldNames: string[] | null;

  /**
   * The SQL type per column - `BIGINT`, `VARCHAR`, `TIMESTAMP`, `BOOLEAN`,
   * `ARRAY`, `OTHER`, ... - keyed by the name in `fieldNames`.
   *
   * This is the type the UI labels a column with. Spec section 2, live-verified:
   * it is the accurate one of the two, because the native type LIES for
   * `CURRENT_TIMESTAMP` (native `LONG`, actually an ISO timestamp string) and for
   * `(1 = 1)` (native `LONG`, actually `true`).
   *
   * A `Record` is lossless only because `fieldNames` is unique; that invariant is
   * what keeps a duplicated output column's type from being overwritten too.
   * Null when the source could not describe the rows.
   */
  sqlTypes: Record<string, string> | null;

  /**
   * Druid's own type name per column - `LONG`, `DOUBLE`, `FLOAT`, `STRING`,
   * `ARRAY<LONG>`, `COMPLEX<HLLSketch>` - keyed the same way.
   *
   * Kept alongside the SQL type rather than instead of it: it is the vocabulary a
   * Druid user reads in the web console and in a segment's dimension list, so
   * dropping it would make the editor describe columns in words the user's other
   * tools never use. It is carried, not trusted - see `sqlTypes`. Null when the
   * source could not describe the rows.
   */
  nativeTypes: Record<string, string> | null;

  /**
   * How long the exchange took, in milliseconds.
   *
   * Measured by the implementation rather than reported: live-verified on 37.0.0,
   * the SQL endpoint answers with the rows and nothing else - no timing anywhere
   * in the body or in the response metadata, only query ids. Any implementation
   * can time its own exchange, so the field stays neutral; what it must not do is
   * pretend the number came from the server.
   */
  executionTimeMs: number;
}

/** Per-statement options. */
export interface DruidQueryOptions {
  /**
   * Server-side deadline for this one statement, in milliseconds.
   *
   * Druid takes a per-query deadline of its own (spec section 6, verified: a
   * 1 ms deadline answers 504 with `category: TIMEOUT` on a statement that
   * otherwise takes milliseconds). Asking the server to stop is what actually
   * frees the cluster's resources - abandoning the request client-side leaves the
   * query running - which is why this is a distinct knob and not a duplicate of
   * the one below. Neutral: every Druid client can set a query deadline.
   */
  timeoutMs?: number;

  /**
   * Wall-clock deadline for the whole exchange, client side.
   *
   * Not a duplicate of `timeoutMs`: a server-side deadline only starts counting
   * once the server has accepted the statement, so it cannot bound a stalled
   * connect, a TLS handshake, or a response body that stops arriving part-way
   * (the #264 lesson - headers can arrive promptly and the stream stall
   * afterwards). The provider advertises a query timeout, and this is what makes
   * that promise cover the transport rather than only the query.
   */
  clientDeadlineMs?: number;

  /**
   * Values for the `?` placeholders in the statement, in order.
   *
   * Spec section 13, live-verified: positional parameters really execute on
   * Druid, so unlike ClickHouse (#264, where the endpoint has no equivalent and
   * the provider throws) a parameterized statement is a first-class case here.
   * Values stay raw JS: mapping each one onto the type name the server expects is
   * an encoding concern, and an unmappable value is the implementation's error to
   * raise - sending something the server would misread is worse than refusing it.
   */
  parameters?: readonly unknown[];
}

/**
 * How much later than `timeoutMs` a caller should set `clientDeadlineMs`.
 *
 * The two deadlines above are a race unless the client one is deliberately the
 * later: if both fire at the same instant the client abort wins, because the
 * server's own 504 still has to travel back over the network. Losing that race
 * costs real information - the abort surfaces a bare transport failure instead of
 * Druid's classified `TIMEOUT` envelope with its message - so every caller that
 * sets both must add this grace to the client half. Exported so the provider and
 * the introspection reads cannot drift apart on it.
 */
export const DRUID_CLIENT_DEADLINE_GRACE_MS = 5_000;

/**
 * The seam itself.
 *
 * There is no management method next to `query()`, unlike Couchbase: every Druid
 * metric, task and storage statistic the provider needs is a `sys.*` table
 * reachable by SQL (spec section 10), so a second entry point would be a
 * permanent HTTP dependency for nothing.
 */
export interface DruidTransport {
  /** Widen when a non-HTTP implementation appears. */
  readonly kind: "http";
  query(sql: string, opts?: DruidQueryOptions): Promise<DruidQueryResult>;
  close(): Promise<void>;
}

/**
 * The categories Druid classifies a failure into, and the only thing the
 * provider branches on.
 *
 * Read back from the live cluster (37.0.0) rather than transcribed from
 * documentation: spec section 5 records both envelopes it observed, and
 * `category` is the one field present in both - the modern `druidException`
 * shape and the legacy wrapper a data server produces. Exported frozen so the
 * provider, the transport and the tests share one definition instead of
 * repeating literals that drift apart.
 *
 * Key and value coincide because the category IS the token the server sends;
 * the table exists so a call site indexes it instead of spelling the token, and
 * so a category that Druid ever renames stays a one-line change here.
 */
export const DRUID_ERROR_CATEGORIES = Object.freeze({
  /** The statement was wrong: unknown datasource, syntax, an unplannable query. */
  INVALID_INPUT: "INVALID_INPUT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CAPACITY_EXCEEDED: "CAPACITY_EXCEEDED",
  CANCELED: "CANCELED",
  RUNTIME_FAILURE: "RUNTIME_FAILURE",
  TIMEOUT: "TIMEOUT",
  /** A statement Druid's native engine does not implement, such as `UPDATE`. */
  UNSUPPORTED: "UNSUPPORTED",
  NOT_FOUND: "NOT_FOUND",
  /**
   * Druid's own bucket for a failure it did not classify. Live-verified and the
   * reason the HTTP status must never be trusted on its own: `SELECT 1/0`
   * answers HTTP 500 with `persona: "ADMIN"` and this category for what is an
   * ordinary user mistake (spec section 5, point 3).
   */
  UNCATEGORIZED: "UNCATEGORIZED",
  /** An internal invariant Druid checks defensively; a bug, not a user error. */
  DEFENSIVE: "DEFENSIVE",
} as const);

export type DruidErrorCategory = keyof typeof DRUID_ERROR_CATEGORIES;

/**
 * Stand-in for a failure that never reached the server, or reached it and came
 * back with nothing to classify - a refused socket, an aborted request, a
 * proxy's HTML error page, an empty body (spec section 5, point 4).
 *
 * It is deliberately NOT a member of `DRUID_ERROR_CATEGORIES`: reusing one of
 * Druid's own categories - `UNCATEGORIZED` most temptingly, since that is what
 * it means in English - would let a caller believe the server had spoken and
 * classified the failure when nothing ever answered. It stands in for the
 * `errorCode` as well, and its shouty spelling cannot be mistaken for one of
 * Druid's camelCase codes (`invalidInput`, `general`, `legacyQueryException`).
 */
export const DRUID_TRANSPORT_FAILURE = "TRANSPORT_FAILURE";

/**
 * Categories that mean "this surface is not available here", as opposed to
 * "this request was wrong".
 *
 * Spec section 5: a cluster running `druid-basic-security`, a role without the
 * permissions the `sys` schema needs, and a build where the table is simply
 * absent are all ordinary, expected configurations, so every monitoring read
 * degrades to an empty panel on these three categories and only these three.
 * Anything else is the user's own mistake and must keep propagating - hiding an
 * unplannable query behind an empty panel is the failure mode this list exists
 * to prevent.
 */
const MONITORING_UNAVAILABLE_CATEGORIES: readonly string[] = [
  DRUID_ERROR_CATEGORIES.UNAUTHORIZED,
  DRUID_ERROR_CATEGORIES.FORBIDDEN,
  DRUID_ERROR_CATEGORIES.NOT_FOUND,
];

/**
 * Normalized transport failure.
 *
 * `category` is the only field callers should branch on, and it is typed as a
 * plain string rather than the closed union so a category a later Druid adds
 * arrives verbatim instead of being flattened onto `UNCATEGORIZED` - which is
 * itself a real category. `is()` takes the union, so a call site still cannot
 * misspell one.
 *
 * `errorCode` is secondary (`invalidInput`, `general`, `legacyQueryException`):
 * it is coarser than the category, and the same code arrives with different
 * categories. `persona` is Druid's guess at WHO should read the message
 * (`USER`, `OPERATOR`, `ADMIN`) and is carried for display only - never
 * branched on, because live evidence shows it is wrong in exactly the case that
 * matters: `SELECT 1/0` is reported as `ADMIN`.
 *
 * The message is always the envelope's `errorMessage`, resolved by the
 * implementation. Spec section 5, point 1: the envelope's `error` field is a
 * discriminator whose value is the literal string `druidException`, so showing
 * it would print that to the user.
 */
export class DruidTransportError extends Error {
  constructor(
    message: string,
    public readonly category: string = DRUID_TRANSPORT_FAILURE,
    public readonly errorCode: string = DRUID_TRANSPORT_FAILURE,
    public readonly persona: string | null = null,
  ) {
    super(message);
    this.name = "DruidTransportError";
    // Subclassing a builtin loses the prototype under a downlevel emit, which
    // would make every instanceof check in the provider quietly fall through.
    Object.setPrototypeOf(this, DruidTransportError.prototype);
  }

  /** True when this failure is the named one. Keyed by name so no call site spells a token. */
  is(category: DruidErrorCategory): boolean {
    return this.category === DRUID_ERROR_CATEGORIES[category];
  }

  /** True when a monitoring read should degrade to empty instead of surfacing this. */
  isMonitoringUnavailable(): boolean {
    return MONITORING_UNAVAILABLE_CATEGORIES.includes(this.category);
  }
}
