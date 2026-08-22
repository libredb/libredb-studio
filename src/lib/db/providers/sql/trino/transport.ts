/**
 * Trino transport seam (issue #424, Phase 2)
 *
 * Provider logic never talks to the coordinator directly. It goes through this
 * interface, so a second client - PrestoDB, which is the same protocol under a
 * different header prefix, or a future JDBC/Arrow route - is an additive change
 * rather than a rewrite of the provider, the introspection and the explain
 * strategy. This is the sibling of the Druid seam in
 * `providers/sql/druid/transport.ts` and of the two-product search seam in
 * `providers/sql/search/transport.ts`.
 *
 * WHY A DIALECT DESCRIPTOR AND NOT A CONSTANT. Every one of Trino's ~18 request
 * headers is GENERATED from a product name: `io.trino.client.ProtocolHeaders`
 * builds each as `"X-" + protocolName + "-" + headerName`, with
 * `TRINO_HEADERS = new ProtocolHeaders("Trino")`, and PrestoDB's equivalent
 * constructs `X-Presto-`. There is no negotiation and no content-type
 * discriminator: a coordinator sent the wrong prefix sees NO user header at all
 * and answers HTTP 401 before it looks at the statement. So the prefix has to be
 * decided before the first byte, and the only way `presto` stays a follow-up of
 * one descriptor rather than a rewrite is if no file below ever spells a whole
 * header name. {@link TrinoDialect} is that decision, expressed as data.
 *
 * The result types are deliberately NEUTRAL. Everything the client protocol
 * invented - `/v1/statement`, the `nextUri` chain the loop follows, the
 * positional `data` rows, `updateType`/`updateCount`, `stats.state`, the
 * `errorName`/`errorType` pair, the `warningCode` envelope, the retry statuses -
 * stays inside `http-transport.ts`, and `seam-guard.test.ts` fails the build the
 * moment that vocabulary appears anywhere else in the directory.
 *
 * Two protocol facts shape almost every type below, both measured against a live
 * Trino 476 on 2026-08-20:
 *
 * - A FAILED STATEMENT IS AN HTTP 200. `SELEKT 1`, a missing table and an
 *   unsupported DDL all answer 200 with a failure inside the document. Nothing
 *   above this seam ever sees a status code, precisely so nothing above it can be
 *   tempted to trust one.
 * - THE EXCHANGE IS A LOOP, NOT A REQUEST. Even `SELECT version()` takes five
 *   pages, and the answer terminates on the ABSENCE of the next link, never on a
 *   state: a page can report FINISHED and still carry a link to the page holding
 *   the rows (measured). That is a wire concern in full, so the seam exposes one
 *   completed result and no notion of paging at all.
 *
 * Apart from the error type this file is purely structural: no I/O.
 */

/**
 * Which product a connection points at.
 *
 * A union of one today: `presto` is a separate canonical type-id and a separate
 * doc/test triad (CLAUDE.md's tri-sync invariant), so it is deliberately NOT part
 * of this change. The union exists anyway because the alternative - hardcoding
 * the name - is what makes adding the second product expensive, and the header
 * argument above is the measured reason it would be.
 */
export type TrinoDialectId = "trino";

/**
 * Everything about a product that the wire needs and the provider may read.
 *
 * Only fields that a second product would genuinely differ on belong here.
 * Anything the protocol fixes - the endpoint paths, the body's content type, the
 * retry statuses - is a constant in the implementation, so this stays a list of
 * real product differences rather than a duplicated configuration of the whole
 * protocol.
 */
export interface TrinoDialect {
  /** The canonical type-id, so a message can name the connection's own kind. */
  readonly id: TrinoDialectId;

  /**
   * The product name the protocol headers are generated from: `Trino` yields
   * `X-Trino-User`, `X-Trino-Catalog` and the rest of the family.
   *
   * A prefix rather than a set of finished header names, because the server side
   * generates them the same way. The compatibility shim that would let one prefix
   * serve both products (`protocol.v1.alternate-header-name`) is `@Deprecated` in
   * `io.trino.server.ProtocolConfig` and off by default, so "send one prefix and
   * hope" would be building on a deprecation.
   */
  readonly headerPrefix: string;

  /** How the product spells its own name in text a user reads. */
  readonly displayName: string;

  /**
   * The coordinator's HTTP port when the connection does not say.
   *
   * One default for both schemes on purpose: a TLS deployment serves on whatever
   * port its operator chose, and inventing a well-known HTTPS port would send
   * credentials somewhere nothing is listening.
   */
  readonly defaultPort: number;

  /**
   * The statement that identifies the server.
   *
   * Per-product because the ANSWER is per-product and un-parseable in common:
   * measured on 476, Trino's `version()` returns the bare string `"476"` - not
   * semver, not a product name, just the integer - while PrestoDB returns a
   * `0.2xx`-shaped string. Anything that tries to read a major.minor out of either
   * is wrong, so the query travels with the descriptor and the answer is carried
   * as text.
   */
  readonly versionQuery: string;
}

/** The one product this change ships. */
export const TRINO_DIALECT: TrinoDialect = Object.freeze({
  id: "trino",
  headerPrefix: "Trino",
  displayName: "Trino",
  defaultPort: 8080,
  versionQuery: "SELECT version()",
});

/**
 * Every product the transport can speak to, keyed by type-id.
 *
 * Exported as a table rather than as the single descriptor so the provider
 * selects by its own `config.type` and gains nothing to change when the union
 * widens.
 */
export const TRINO_DIALECTS: Readonly<Record<TrinoDialectId, TrinoDialect>> = Object.freeze({
  trino: TRINO_DIALECT,
});

/** One result row, keyed by the names in {@link TrinoQueryResult.fieldNames}. */
export type TrinoRow = Record<string, unknown>;

/**
 * A non-fatal remark the engine attached to a statement that SUCCEEDED.
 *
 * Measured: a redundant `ORDER BY` in a subquery answers with rows plus
 * `REDUNDANT_ORDER_BY`, "ORDER BY in subquery may have no effect". Losing that
 * would hide the one place the engine tells a user their statement does not mean
 * what they think. The list is de-duplicated by the implementation, because the
 * same remark is repeated on every page of the exchange (measured on all six
 * pages of one statement) and a caller must not render it six times.
 */
export interface TrinoWarning {
  /** The engine's own stable name for the remark, e.g. `REDUNDANT_ORDER_BY`. */
  code: string;
  message: string;
}

/**
 * What the server reported about executing this statement.
 *
 * Unlike Druid (#265), where the timing had to be measured client-side because
 * the endpoint reports none, every number here is the COORDINATOR's own. Carrying
 * a measured wall clock beside them would invite a caller to compare two numbers
 * that mean different things, so this transport reports the server's and nothing
 * else.
 *
 * Every field is nullable and null means "the server did not say", never zero:
 * the numbers are absent from the early pages of an exchange, and a zero there
 * would claim a statement processed no rows while it was still planning.
 */
export interface TrinoExecutionStats {
  /**
   * The engine's last word on the statement, e.g. `FINISHED`, `RUNNING`,
   * `QUEUED`.
   *
   * Carried for DISPLAY only, and the seam says so because the protocol does:
   * "The `status` field of the JSON document is for human consumption only ... It
   * cannot be used to tell if the query is finished." A caller that branched on
   * this would be re-deriving a completion signal the implementation already
   * resolved - and would get it wrong, because a page reporting `FINISHED` can
   * still be followed by the page that carries the rows (measured).
   */
  state: string | null;
  /** Wall-clock milliseconds from submission to the last page. */
  elapsedMs: number | null;
  /** CPU milliseconds burned across the cluster, which can far exceed elapsed. */
  cpuMs: number | null;
  /** Milliseconds spent waiting for cluster resources before execution began. */
  queuedMs: number | null;
  processedRows: number | null;
  processedBytes: number | null;
  peakMemoryBytes: number | null;
}

/** Normalized outcome of one statement, after the whole exchange has completed. */
export interface TrinoQueryResult {
  rows: TrinoRow[];

  /**
   * Column order as the server declared it, or null when it never described the
   * rows.
   *
   * Declared order is authoritative and object keys are not: rows arrive
   * POSITIONALLY, as arrays aligned to the declaration by index, with no field
   * names on the wire at all.
   *
   * INVARIANT the implementation must uphold: these names are UNIQUE and are
   * exactly the key set of every row. This is not theoretical - measured on 476,
   * `SELECT 1 AS c, 2 AS c` really declares two columns both named `c`, and a
   * duplicate cannot survive into a {@link TrinoRow}, so the second column would
   * vanish BEFORE this seam unless the implementation disambiguates while it
   * rebuilds the row.
   *
   * An EMPTY array is meaningfully different from null: a statement that changes
   * something rather than returning something - `CREATE TABLE`, `SET SESSION` -
   * answers with a declaration of no columns at all (measured), which is the
   * server describing an empty shape rather than declining to describe one.
   */
  fieldNames: string[] | null;

  /**
   * The engine's rendered type per column, keyed by the name in `fieldNames`:
   * `bigint`, `varchar(25)`, `decimal(15,2)`, `array(integer)`,
   * `row(x integer, y varchar)`.
   *
   * The rendered text, not a parsed structure. It is the vocabulary a user reads
   * in their own DDL and in `SHOW COLUMNS`, so it is the honest label for a
   * column; the parsed form the wire also carries is strictly more detail than a
   * label needs, and pretending to normalize it across connectors would be a
   * claim this transport cannot back.
   *
   * A `Record` is lossless only because `fieldNames` is unique. Null exactly when
   * `fieldNames` is null.
   */
  columnTypes: Record<string, string> | null;

  /**
   * The coordinator's id for this statement, e.g.
   * `20260820_101112_00001_abcde`.
   *
   * Neutral despite looking like a wire detail: it is the handle a user needs to
   * find the statement in the cluster's own UI and in `system.runtime.queries`,
   * and it is the argument {@link TrinoTransport.cancel} takes. Every client of
   * every protocol version learns it.
   */
  queryId: string;

  /**
   * The operation the server says this statement performed - `CREATE TABLE`,
   * `INSERT`, `SET SESSION`, `USE` - or null for an ordinary query.
   *
   * Carried because it is the ONLY way a stateless client can notice that a
   * statement silently did nothing. This transport sends each statement
   * independently and does not accumulate the session the server offers to hand
   * back, so `SET SESSION`, `USE` and `PREPARE` all answer success and then have
   * no effect on the next statement. A caller that surfaces a notice for those
   * needs this field; there is nothing else in the answer that distinguishes them.
   */
  operation: string | null;

  /**
   * Rows the statement changed, or null when it changed nothing / said nothing.
   *
   * Deliberately not defaulted to zero. Measured: `INSERT INTO t VALUES (1),(2),
   * (3)` reports 3 while `CREATE TABLE` reports no count at all, and "created a
   * table" is not "changed zero rows".
   */
  affectedRows: number | null;

  /** Every distinct remark the engine attached, in the order first seen. */
  warnings: TrinoWarning[];

  /** What the server reported about executing this statement. */
  stats: TrinoExecutionStats;
}

/** Per-statement options. */
export interface TrinoQueryOptions {
  /**
   * The catalog to resolve unqualified names against, overriding the
   * connection's own.
   *
   * A per-statement override rather than connection-only state because
   * introspection legitimately reads a catalog other than the pinned one, and the
   * alternative - `USE catalog.schema` - is exactly the session mutation this
   * stateless transport discards.
   */
  catalog?: string;

  /** The schema to resolve unqualified names against, overriding the connection's. */
  schema?: string;

  /**
   * Aborts the exchange.
   *
   * The ONE deadline knob, deliberately, unlike the Druid seam's pair. The
   * protocol has no per-statement server-side deadline to set from a header, so
   * there is no second thing to configure - and the client abort is not merely a
   * client concern here, because the implementation owes the cluster a
   * cancellation on every exit path. Abandoning the loop without one leaves the
   * statement consuming cluster resources to completion.
   *
   * A caller wanting a timeout composes `AbortSignal.timeout(ms)`; the
   * implementation reports that as a timeout rather than a cancellation, because
   * the signal - not the thrown value - is what knows which happened.
   */
  signal?: AbortSignal;

  /**
   * Called once with the statement's id, as soon as the coordinator has accepted
   * it and before the answer is complete.
   *
   * The result carries the id too, but only when there IS a result. A caller that
   * needs to cancel a statement from somewhere else - a UI button, a component
   * unmount - has to learn the id while the statement is still running, and this
   * is the only moment that exists.
   */
  onQueryStarted?: (queryId: string) => void;
}

/**
 * Why a statement or a request failed, in terms the provider maps onto this
 * repo's error classes without knowing anything about HTTP or about the client
 * protocol.
 *
 * Categorisation is BODY-driven, and here that is not a preference learned from
 * another engine (#264, #424 Phase 1) but a hard protocol rule: a failed
 * statement is an HTTP 200 with the failure inside the document. The status is
 * consulted for exactly one thing - a request the coordinator refused before it
 * became a statement at all - and the implementation owes that distinction.
 */
export type TrinoErrorCategory =
  /** The statement is not valid for the engine's grammar. */
  | "syntax"
  /** The statement is valid but names a catalog, schema, table, column or function that does not exist. */
  | "unknown-object"
  /** The grammar accepts it; this engine or this connector does not implement it. */
  | "unsupported"
  /** Credentials were absent, wrong, refused, or lack the privilege. */
  | "auth"
  /** Nothing answered, or what answered was not the coordinator's client protocol. */
  | "unreachable"
  /** The caller aborted, or the statement was cancelled on the cluster. */
  | "cancelled"
  /** The exchange outlived its deadline. */
  | "timeout"
  /** The cluster could not spare what the statement asked for: memory, time, splits, stages. */
  | "resources"
  /** Reached, understood, and refused for a reason none of the above covers. */
  | "engine";

/** Where in the submitted statement the engine says the fault is. 1-based, as the engine reports it. */
export interface TrinoSourceLocation {
  line: number;
  column: number;
}

/**
 * A failure that crossed the seam.
 *
 * Carries the engine's own wording verbatim, because rewriting it would throw
 * away the only text that locates the fault: measured, a mistyped keyword answers
 * `line 1:1: mismatched input 'SELEKT'. Expecting: 'ALTER', 'ANALYZE', ...` and a
 * missing table answers `line 1:15: Table 'tpch.sf1.no_such_table' does not
 * exist`. Nothing we could synthesize is better than either.
 *
 * `code` is the engine's stable fault name (`SYNTAX_ERROR`, `TABLE_NOT_FOUND`,
 * `NOT_SUPPORTED`, `USER_CANCELED`) when it sent one. It is DIAGNOSTIC: the
 * category is what a caller branches on, so a fault name a later release adds
 * arrives as text without needing this file to change. Note the engine also sends
 * an integer code beside the name; it is deliberately dropped, because it is the
 * less stable of the two and no call site should be tempted to compare integers.
 *
 * `location` is what an editor needs to underline the offending token. It is
 * legitimately absent - measured, `NOT_SUPPORTED` on a `CREATE TABLE` reports the
 * location as null and `USER_CANCELED` omits the field entirely - so a consumer
 * must treat "no location" as ordinary rather than as a parse failure.
 */
export class TrinoTransportError extends Error {
  constructor(
    readonly category: TrinoErrorCategory,
    message: string,
    readonly code: string | null = null,
    readonly location: TrinoSourceLocation | null = null,
  ) {
    super(message);
    this.name = "TrinoTransportError";
    // Subclassing a builtin loses the prototype under a downlevel emit, which
    // would make every instanceof check in the provider quietly fall through.
    Object.setPrototypeOf(this, TrinoTransportError.prototype);
  }
}

/**
 * The seam itself.
 *
 * Three methods, and `cancel` is one of them for a reason the other HTTP
 * providers in this repo did not face: on Trino, abandoning a request does NOT
 * stop the work. A closed tab, an aborted fetch or an expired deadline leaves the
 * statement running on the cluster until it finishes, so terminating it is an
 * explicit act the seam has to be able to perform - both internally, on every
 * exit path of a statement it started, and on demand for a statement whose id a
 * caller learned through {@link TrinoQueryOptions.onQueryStarted}.
 */
export interface TrinoTransport {
  /** Which product this transport speaks to. */
  readonly dialect: TrinoDialect;

  /** Run one statement to completion. */
  query(sql: string, options?: TrinoQueryOptions): Promise<TrinoQueryResult>;

  /**
   * Terminate a statement on the cluster.
   *
   * Idempotent and forgiving by design, which matches what the server does:
   * measured, cancelling a statement that has already finished - and even
   * cancelling an id that never existed - is accepted silently rather than
   * reported as an error. So a caller may cancel without first proving the
   * statement is still running, and must not read success here as proof that it
   * was.
   */
  cancel(queryId: string, signal?: AbortSignal): Promise<void>;

  close(): Promise<void>;
}
