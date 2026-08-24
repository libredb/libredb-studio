/**
 * Apache Cassandra transport seam (issue #424, Phase 4)
 *
 * Provider logic never talks to `cassandra-driver`. It goes through this
 * interface, so the driver stays replaceable - and, more immediately, so the
 * provider and its introspection can be exercised against the payloads a live
 * 5.0.9 actually returned rather than against a mock of a mock.
 * `seam-guard.test.ts` fails the build if the driver is imported anywhere in this
 * directory except `driver-transport.ts`.
 *
 * The types are NEUTRAL: nothing here names a driver class, a Java marshaller or
 * a protocol frame. `pageState` is the one member that looks driver-shaped and is
 * not - server-side paging is a property of the native protocol, and every client
 * that speaks it has one - and it is declared as a STRING because that is what the
 * driver hands back (measured: `typeof rs.pageState === "string"`), so a caller can
 * put it in JSON without a second encoding decision.
 *
 * Apart from the error class this file is purely structural: no I/O.
 */

/**
 * What went wrong, as a caller can act on it.
 *
 * Keyed on category rather than on the driver's error CLASS because the class is
 * almost always the same one: measured on 5.0.9, a refused credential, a wrong
 * data centre, a refused socket, an unresolvable name and an unavailable replica
 * set ALL arrive as `NoHostAvailableError` with `code === undefined`, and the
 * actionable fault sits in `innerErrors[host]`. Categories are what survive that
 * flattening.
 *
 * - `auth` - the credential was refused, or the server wants one and the
 *   connection carries none.
 * - `permission` - the credential was accepted and the ROLE may not read this.
 *   Separate from `auth` because the answer is a grant, not a password, and
 *   because a monitoring read degrades on this and on nothing else.
 * - `unreachable` - nothing answered: a refused socket, a silent host, a name that
 *   resolves to nothing.
 * - `config` - the client refused before the wire: today only a missing or wrong
 *   `localDataCenter`, which this driver requires and no other engine here has.
 * - `client-timeout` - the client's own deadline expired (`readTimeout`).
 * - `server-timeout` - the coordinator gave up waiting for replicas (read or write
 *   timeout). A different fault from the one above and worth a different sentence:
 *   the statement may still have been applied.
 * - `unavailable` - not enough replicas were alive for the consistency level asked.
 * - `syntax` - the statement is not CQL.
 * - `invalid` - the statement is CQL and the server refuses it: an unknown
 *   keyspace, table or column, a query that needs `ALLOW FILTERING`, a primary key
 *   in a `SET` part, a materialized view on a server where they are disabled. One
 *   category because it is ONE protocol code (8704), and the server's own sentence
 *   is what tells the cases apart - inventing finer categories here would mean
 *   sniffing that sentence, which this repo forbids.
 * - `engine` - anything else the server or the client reported.
 */
export type CassandraFaultCategory =
  | "auth"
  | "permission"
  | "unreachable"
  | "config"
  | "client-timeout"
  | "server-timeout"
  | "unavailable"
  | "syntax"
  | "invalid"
  | "engine";

/** One result row, already reduced to values a grid and `JSON.stringify` can carry. */
export type CassandraRow = Record<string, unknown>;

/**
 * The normalized outcome of one statement.
 *
 * There is deliberately no execution time and no affected-row count. The protocol
 * reports neither: a write answers a result with no rows and no count at all
 * (measured on `INSERT`, `DELETE`, `ALTER` and `USE`), and the only duration
 * available is the one this process measured, which the provider does itself. A
 * zero in either field would read as a measurement.
 */
export interface CassandraQueryResult {
  rows: CassandraRow[];
  /**
   * Column order as the server declared it, or `null` when it declared nothing.
   *
   * `null` is a real answer rather than a missing one: measured, a statement that
   * changes something answers with `columns === null`, which is different from a
   * SELECT that matched no rows and still declared its columns.
   */
  fieldNames: string[] | null;
  /** Declared CQL type per column name, or `null` when the server declared no columns. */
  columnTypes: Record<string, string> | null;
  /**
   * The server's own cursor for the next page, when it sent one.
   *
   * Nothing in this provider resumes a page today - the editor's own paging is
   * offset-based and CQL has no OFFSET - so this is carried rather than used, and
   * it is here because the seam would otherwise have to grow a member to expose
   * it later. `null` means the server said there is no more.
   */
  pageState: string | null;
}

/** Per-statement options. */
export interface CassandraExecuteOptions {
  /**
   * How many rows the server puts in one page.
   *
   * The driver's own default is 5000 (measured). A caller that wants fewer rows
   * asks for fewer here; it is NOT a row LIMIT - the rest of the result is still
   * reachable through `pageState` - so nothing in this provider uses it to bound a
   * user's statement, which is what `LIMIT n` is for.
   */
  fetchSize?: number;
  /** Resume from a page the server described, as `CassandraQueryResult.pageState` reported it. */
  pageState?: string;
}

/**
 * The seam itself.
 *
 * `connect()` is separate from construction, unlike the HTTP transports in this
 * repo: this driver holds a real session with a pool behind it, and opening it is
 * where authentication, topology discovery and the data-centre check happen. A
 * constructor that could fail on the network would leave no object to close.
 */
export interface CassandraTransport {
  /** Widen when a second implementation appears; there is one, and it is the driver. */
  readonly kind: "native";
  connect(): Promise<void>;
  execute(cql: string, options?: CassandraExecuteOptions): Promise<CassandraQueryResult>;
  close(): Promise<void>;
}

/**
 * A normalized transport failure.
 *
 * `code` is the CQL protocol's own numeric error code when the SERVER reported one
 * and `null` otherwise - a client-side timeout, a refused socket, a missing data
 * centre. It is never invented: a `0` is a real code (`serverError`), so a
 * placeholder zero would be a claim about the server.
 */
export class CassandraTransportError extends Error {
  constructor(
    message: string,
    public readonly category: CassandraFaultCategory,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = "CassandraTransportError";
    // Subclassing a builtin loses the prototype under a downlevel emit, which
    // would make every instanceof check in the provider quietly fall through.
    Object.setPrototypeOf(this, CassandraTransportError.prototype);
  }

  /**
   * Whether a monitoring read should degrade to an empty panel instead of failing
   * the whole connection.
   *
   * `permission` alone, and that narrowness is the measured part: with a
   * least-privilege role, `system_views.clients` answered 8448 while
   * `system_schema` answered every table in every keyspace, so a denied monitoring
   * surface is the ORDINARY case for a restricted user. Every other category keeps
   * propagating - notably `invalid`, which is also what a typo in this provider's
   * own CQL would produce, and an empty panel that hides that hides it forever.
   */
  isMonitoringUnavailable(): boolean {
    return this.category === "permission";
  }

  /*
   * WHY THERE IS NO `absentKeyspace()` HERE ANY MORE (2026-08-24).
   *
   * There used to be one, reading the refused keyspace's NAME out of the server's
   * sentence, because the refusal carries nothing else: measured 2026-08-24 through
   * `cassandra-driver` 4.9.0 against cassandra:5.0.9 and scylladb/scylla:2026.2.4, all
   * four of these arrive as `ResponseError` with `code === 8704` and `keyspace`/`table`
   * both `undefined`:
   *
   * | Sent | Server | Message |
   * |---|---|---|
   * | `system_views.clients` | ScyllaDB | `Keyspace system_views does not exist` |
   * | `system_views.cliets` | 5.0.9 | `table cliets does not exist` |
   * | `system_views.caches` with a wrong column | 5.0.9 | `Undefined column name hit_ratioo in table system_views.caches` |
   * | `system_viewz.clients` | 5.0.9 | `keyspace system_viewz does not exist` |
   *
   * That is still true, and it is exactly why the discriminator moved OUT of the
   * refusal: a build that rephrases any of those sentences would have stopped matching
   * and taken five monitoring panels with it. The degradation now keys on a property
   * of the server asked once per connection - whether
   * `system_virtual_schema.keyspaces` lists `system_views`
   * ([`introspect.ts`](./introspect.ts)) - and the four spellings above are kept as a
   * regression pin in `tests/integration/db/cassandra-provider.test.ts` rather than as
   * a discriminator. Nothing in this provider reads a server's sentence to decide
   * anything.
   */
}
