/**
 * Apache Cassandra Database Provider (issue #424, Phase 4)
 *
 * CQL over the native protocol through `cassandra-driver` 4.9.0, with every
 * statement, catalog read and metric going through the `CassandraTransport` seam -
 * so this file names no driver class and `seam-guard.test.ts` fails the build if it
 * starts to. The driver lives in `driver-transport.ts`; the catalog and
 * `system_views` reads live in `introspect.ts`.
 *
 * It extends `SQLBaseProvider` rather than `BaseDatabaseProvider` because what the
 * editor holds IS the statement text and the shared helpers are right about the
 * points they cover: CQL quotes identifiers with `"` (measured: `SELECT "id"` returns
 * the column, a backtick is "no viable alternative at character '`'", and a
 * double-quoted string is a syntax error) and `LIMIT n` is correct CQL. `prepareQuery`
 * is the one override, and it carries three traps rather than one.
 *
 * Everything below was measured against a live Apache Cassandra 5.0.9 on 2026-08-20,
 * before this file existed. The behaviours that shape it, each of which produces a
 * wrong answer or a hard failure if forgotten:
 *
 * - `OFFSET` IS NOT IN THE GRAMMAR. `… LIMIT 5 OFFSET 5` is "line 1:45 mismatched
 *   input 'OFFSET' expecting EOF", and `OFFSET` alone is refused too. So no page
 *   after the first can be requested, and asking is REFUSED rather than answered
 *   with page one.
 * - `ALLOW FILTERING` IS THE LAST CLAUSE. `… LIMIT 3 ALLOW FILTERING` returns rows;
 *   `… ALLOW FILTERING LIMIT 3` is a syntax error. The shared limiter appends, so the
 *   two clauses are transposed.
 * - A LINE COMMENT NEEDS A NEWLINE TO CLOSE IT. `SELECT … LIMIT 3 -- note` with
 *   nothing after it is "line 1:45 mismatched character '<EOF>' expecting set null",
 *   and `-- note\n` returns rows. `sql.trim()` inside the shared limiter drops that
 *   newline, so a statement that would end inside a comment is left alone here. CQL's
 *   THIRD comment form, `//`, used to be part of this trap and no longer is: it is a
 *   grammar fact (`doubleSlashComment`) that every shared reader now honours, so this
 *   file no longer scans for it - see `endsInsideLineComment`.
 * - THERE IS NO EXPLAIN. `EXPLAIN SELECT …` is "line 1:0 no viable alternative at
 *   input 'EXPLAIN'". The only substitute is `{traceQuery: true}` plus
 *   `system_traces.events`, which profiles a statement that has ALREADY RUN - so it
 *   is not a plan, and it is deliberately not exposed here.
 * - THERE IS NO CANCELLATION, so `cancelQuery` is deliberately NOT implemented. The
 *   native protocol has no cancellation frame, CQL has no `KILL`, and the driver's own
 *   client publishes no cancel, abort or kill method (checked against its API
 *   surface). Both routes detect the method by name (`"cancelQuery" in provider`), so
 *   its ABSENCE is what makes them answer "cancellation is not supported for this
 *   database type" - which is true - rather than reporting a cancellation that failed.
 *   `search/index.ts` declined the same method for the same reason (#424 Phase 1).
 *   The only bound on a running statement is the client-side `readTimeout`, after
 *   which this client stops WAITING and the coordinator carries on.
 * - THERE IS NO MAINTENANCE STATEMENT. Compaction, repair, flush and cleanup are
 *   `nodetool`/JMX operations. `TRUNCATE` exists and is not in `MaintenanceType`.
 * - EVERY CONNECT-TIME FAULT ARRIVES AS ONE ERROR CLASS. See `driver-transport.ts`.
 */

import { SQLBaseProvider } from "../sql-base";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  type ActiveSessionDetails,
  type DatabaseConnection,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type MaintenanceResult,
  type MaintenanceType,
  type PerformanceMetrics,
  type PreparedQuery,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderOptions,
  type QueryPrepareOptions,
  type QueryResult,
  type SlowQueryStats,
  type StorageStats,
  type TableSchema,
  type TableStats,
} from "@/lib/db/types";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { CASSANDRA_DEFAULT_PORT, CassandraDriverTransport } from "./driver-transport";
import {
  CASSANDRA_IDENTITY_CQL,
  CASSANDRA_INDEX_STATS_REFUSAL,
  CASSANDRA_STORAGE_STATS_REFUSAL,
  CASSANDRA_TABLE_STATS_REFUSAL,
  cassandraVirtualTableRefusal,
  type CassandraServerFacts,
  getActiveSessions as readActiveSessions,
  getHealth as readHealth,
  getOverview as readOverview,
  getPerformanceMetrics as readPerformanceMetrics,
  getSchema as readSchema,
  getSlowQueries as readSlowQueries,
  readServerFacts,
} from "./introspect";
import { CassandraTransportError, type CassandraTransport } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The statements that change what the schema tree would show.
 *
 * `TRUNCATE` is deliberately absent, unlike the shared default: it empties a table
 * that still exists, so the tree cannot have changed - and re-reading the whole
 * catalog after one is a cost for nothing. `INSERT` is absent for the same reason.
 */
const SCHEMA_REFRESH_PATTERN = "\\b(CREATE|DROP|ALTER)\\b";

/**
 * `ALLOW FILTERING` at the very end of a statement, followed by the bound the shared
 * limiter just appended.
 *
 * The inner whitespace is captured rather than normalised, so transposing the two
 * clauses does not silently reformat the user's own statement. This only ever runs on
 * a statement the limiter REWROTE, so the `LIMIT n` it matches is always the appended
 * one: a statement carrying its own bound is returned untouched before this is
 * reached, and CQL has no subquery for a second `ALLOW FILTERING` to hide in.
 */
const APPENDED_AFTER_ALLOW_FILTERING = /\bALLOW(\s+)FILTERING\s+(LIMIT\s+\d+)/i;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Whether this text ends INSIDE a line comment - i.e. whether CQL would refuse it.
 *
 * CQL needs TWO facts about comments that most dialects here do not, and only one of
 * them is still local to this provider. `//` being a line comment as well as `--` IS
 * a grammar fact - and not this engine's alone, since ClickHouse reads it the same way
 * (both measured) - so it is `grammar.ts`'s `doubleSlashComment` now and this function
 * no longer carries a private scan for it: it asks the shared span reader, which reads
 * both forms under the `cassandra` grammar. The fact that stays local is the other -
 * that NEITHER form may be closed by end of input. Measured on 5.0.9,
 * `SELECT * FROM probe.customers LIMIT 3 -- note` with nothing after it is "line 1:45
 * mismatched character '<EOF>' expecting set null" while the same text plus a newline
 * returns the rows. That is a fact about where a statement may END, not about what a
 * run is: `SqlSpan` calls a line comment closed by end of input terminated, which is
 * correct everywhere else and is the answer every reader over it wants.
 *
 * The private scan was not merely redundant, and dropping it is why this is a fix
 * rather than a tidy-up: while `//` was invisible to the shared readers, the row
 * limiter appended the bound INSIDE the comment on this engine and on ClickHouse
 * (measured there: `SELECT number FROM numbers(1000) // note` limited to 5 was
 * emitted as `… // note LIMIT 5` and returned 1000 rows while reporting
 * `wasLimited: true`), and the statement splitter cut a bare DROP out of one CQL read.
 *
 * Walking with the shared reader is also what keeps a `--` or `//` inside a string
 * literal or a quoted name from being mistaken for a comment - `WHERE url =
 * 'http://x'` is an ordinary statement - and keeps the walk linear rather than
 * backtracking.
 */
function endsInsideLineComment(sql: string, grammar: SqlGrammar): boolean {
  let open = false;

  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null) {
      // Either comment form, whichever the grammar recognised. It is only UNCLOSED if
      // it reaches the end of the text with no newline to close it.
      open = span.kind === "line-comment" && span.end === sql.length && !sql.endsWith("\n");
      at = span.end;
      continue;
    }

    open = false;
    at++;
  }

  return open;
}

// ============================================================================
// Cassandra Provider
// ============================================================================

export class CassandraProvider extends SQLBaseProvider {
  private transport: CassandraTransport | null;

  /**
   * What this connection established about the server, once, at connect time.
   *
   * One fact today - whether this build has the `system_views` keyspace - and it is
   * held here rather than asked per read because it cannot change while the session
   * lives: a virtual keyspace appears with a node restart, and a restart drops the
   * session. Cleared in `disconnect()` with the transport it describes, so a reused
   * connection object never carries the previous server's answer.
   */
  private facts: CassandraServerFacts | null;

  /**
   * The transport is injectable, and this is the only production-visible seam: the
   * factory passes two arguments, so a real connection always builds its own driver
   * session. The integration suite passes one built over a session that replays a
   * live cluster's ResultSets, which is what makes the driver adapter's own mapping -
   * the hex blob, the stringified `Long`, the unwrapped `NoHostAvailableError` -
   * testable against what the server really said.
   */
  constructor(config: DatabaseConnection, options: ProviderOptions = {}, transport?: CassandraTransport) {
    super(config, options);
    this.transport = transport ?? null;
    this.facts = null;
    this.validate();
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // There is no EXPLAIN to offer: `EXPLAIN SELECT * FROM probe.customers WHERE id
      // = 1` is "line 1:0 no viable alternative at input 'EXPLAIN'", and no `ExplainFormat`
      // is registered, so the button and the tab stay hidden rather than dead. The
      // only substitute the engine has is `{traceQuery: true}` plus
      // `system_traces.events`, which describes a statement that has already RUN -
      // calling that a plan would be a claim the engine does not make.
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      // In the grammar - `CREATE TABLE probe.t (id int PRIMARY KEY, name text)` works
      // - but what `CreateTableModal` EMITS is not: its default column is `id SERIAL
      // PRIMARY KEY` ("Unknown type probe.serial"), its type list offers
      // `VARCHAR(255)` and `DECIMAL(10,2)` (both syntax errors, CQL types carry no
      // length) and `INTEGER` and `JSONB` (both "Unknown type"), and its NOT NULL,
      // UNIQUE and DEFAULT options are each "no viable alternative at input" - none
      // of the three exists in a CQL column definition. A control that can only
      // produce invalid input is not a supported capability; DDL typed into the
      // editor works normally.
      supportsCreateTable: false,
      // Not a missing feature but a missing GUARANTEE. The inline editor builds
      // `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` against one column it
      // guessed from the result fields (`id` or `*_id`), and CQL requires the WHOLE
      // primary key restricted by equality: measured, `UPDATE probe.events SET v =
      // 'x' WHERE ck = 0` is "Some partition key parts are missing: pk" and `UPDATE
      // probe.orders SET amount = 1 WHERE customer_id = 3` - a plausible guess on a
      // real table - is "Some partition key parts are missing: id". Editing a key
      // column is refused outright ("PRIMARY KEY part id found in SET part").
      supportsInlineRowEdit: false,
      // CQL has no transaction; BATCH is not one.
      supportsTransactions: false,
      // There is no referential constraint in the model at all: `ALTER TABLE … ADD
      // CONSTRAINT … FOREIGN KEY …` is a syntax error, because the clause does not
      // exist. An empty relations list is the engine's answer and not the schema's
      // (#414).
      declaresForeignKeys: false,
      // Nothing in `MaintenanceType` has a statement behind it. Compaction, repair,
      // flush, cleanup and snapshot are `nodetool`/JMX operations rather than CQL;
      // there is no `KILL`, because the protocol has no cancellation at all; and
      // `TRUNCATE`, which CQL does have, is not one of these operations.
      supportsMaintenance: false,
      maintenanceOperations: [],
      // The driver takes contact points plus a REQUIRED `localDataCenter`, and no URI
      // convention carries the second. `connection-string-parser.ts` has no branch
      // for a `cassandra://` scheme, so advertising this would reject everything a
      // user pastes.
      supportsConnectionString: false,
      defaultPort: CASSANDRA_DEFAULT_PORT,
      // `identifierQuoting` is deliberately ABSENT: the field exists for engines whose
      // port cannot answer for their dialect, and 9042 is Cassandra's alone. The
      // generators' default branch is already measured-correct here - `SELECT "id"
      // FROM probe.customers` returns the column and the bare form works too.
      //
      // `statementTerminator` is absent for the same reason: measured, `SELECT id FROM
      // probe.customers WHERE id = 1;` returns the row, so the `;` the generators
      // already emit is valid CQL.
      schemaRefreshPattern: SCHEMA_REFRESH_PATTERN,
    };
  }

  /**
   * Table, row and index are all CQL's own words, so only the maintenance blurbs and
   * the statement language are rewritten.
   *
   * The blurbs must still be strings even though no operation is offered, and leaving
   * the inherited copy would promise a user that this panel updates planner
   * statistics and reclaims space. Cassandra does both - as `nodetool` operations on
   * a node, not as statements a client can send.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeGlobalLabel: "Update Statistics",
      analyzeGlobalTitle: "Statistics Belong to nodetool",
      analyzeGlobalDesc:
        "Cassandra recomputes table statistics during compaction, and `nodetool` is what triggers one. There is no CQL statement for it, so nothing runs from here.",
      vacuumGlobalLabel: "Reclaim Space",
      vacuumGlobalTitle: "Compaction Belongs to nodetool",
      vacuumGlobalDesc:
        "Space is reclaimed by compaction and by `nodetool cleanup` / `garbagecollect`, all of which run against a node rather than through a session. Nothing runs from here.",
      // A model asked for "a statement" against a connection called Cassandra writes
      // SQL - a JOIN, a subquery, an OFFSET - and every one of those is a syntax
      // error here (each measured). The two search engines declare this field for the
      // same reason.
      statementLanguage: "CQL (Cassandra Query Language) - no JOIN, no subquery, no OFFSET",
      // `getSlowQueries()` is empty by design here (introspect.ts), so this panel is
      // ALWAYS empty on Cassandra - and it used to name a PostgreSQL extension (#463).
      slowQueriesEmptyState:
        "Cassandra keeps no aggregate of finished statements: the slow-query threshold writes to the node's log file rather than to a table.",
    };
  }

  /**
   * The shared limiter is right about WHERE the bound goes and wrong about three
   * things CQL alone cares about.
   *
   * 1. `OFFSET` does not exist, so a second page cannot be requested at all and the
   *    request is REFUSED - for every SELECT, including one that arrives with its own
   *    `LIMIT n` and is therefore never rewritten here. The alternatives are worse in
   *    a way that matters: sending the clause fails with an engine message about a
   *    keyword the user never typed, and dropping it silently returns page ONE while
   *    the editor appends it to what it already shows - duplicate rows presented as
   *    new ones, which is a wrong ANSWER. `search/index.ts` refuses Elasticsearch's
   *    identical gap the same way.
   * 2. `ALLOW FILTERING` must stay the last clause, so the appended bound is moved in
   *    front of it. Measured both ways: `… LIMIT 3 ALLOW FILTERING` returns rows,
   *    `… ALLOW FILTERING LIMIT 3` is "line 1:60 mismatched input 'LIMIT' expecting
   *    EOF".
   * 3. A statement that would END inside a line comment is left alone. The limiter
   *    inserts before trailing trivia and re-attaches it (#280), which is right
   *    everywhere else; here the trim drops the newline that CLOSED the comment, and
   *    CQL refuses a line comment at end of input. The statement then runs unbounded,
   *    which `wasLimited: false` reports honestly - and the alternative was turning a
   *    valid statement into a syntax error.
   *
   * One shape is knowingly left unbounded: a statement whose last clause is `PER
   * PARTITION LIMIT n`. The shared reader sees a trailing `LIMIT n` and calls it
   * already bounded, so nothing is injected. `… PER PARTITION LIMIT 2 LIMIT 3` is
   * valid CQL (measured), but forcing a bound would mean stripping the clause the
   * reader matched, which would corrupt the statement - so this is documented rather
   * than half-fixed.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const prepared = super.prepareQuery(query, options);

    // The refusal is read from the statement KIND, not from whether the shared limiter
    // was the one that added the bound. A SELECT that carries its own `LIMIT n` comes
    // back unrewritten, and so does one that ends in a line comment - answering either
    // with page one would let the editor append rows it is already showing, which the
    // user cannot tell from new ones.
    if (analyzeQuery(query, this.type).type === "SELECT" && prepared.offset > 0) {
      throw new QueryError(
        "CQL has no OFFSET clause, so results after the first page cannot be requested here. Narrow the statement with a WHERE clause on the partition key, or raise the row limit, instead of paging.",
        this.type,
        query,
      );
    }

    if (!prepared.wasLimited) return prepared;

    const grammar = resolveSqlGrammar(this.type);
    if (endsInsideLineComment(prepared.query, grammar)) return { ...prepared, query, wasLimited: false };

    return {
      ...prepared,
      query: prepared.query.replace(APPENDED_AFTER_ALLOW_FILTERING, "$2 ALLOW$1FILTERING"),
    };
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  /**
   * A host and a data centre.
   *
   * The data centre is the unusual one, and it is required because the DRIVER
   * requires it: measured, a client built without `localDataCenter` throws
   * `'localDataCenter' is not defined in Client options and also was not specified in
   * constructor. At least one is required. Available DCs are: [datacenter1]` before
   * any statement is sent. Refusing here names the field a user can fill instead of
   * surfacing a driver-internal sentence.
   *
   * The KEYSPACE is not required, deliberately: a connection with none still runs
   * every fully qualified statement, and what it cannot do is show a schema tree -
   * which `getSchema()` says in those words.
   */
  public override validate(): void {
    super.validate();
    if (!this.config.host) {
      throw new DatabaseConfigError("Apache Cassandra requires a host", this.type);
    }
    if (!this.config.localDataCenter) {
      throw new DatabaseConfigError(
        "Apache Cassandra requires a local data centre (localDataCenter): the driver refuses to connect without one. A stock single-node install reports datacenter1.",
        this.type,
      );
    }
  }

  /**
   * Open the session, then ask the cheapest question that proves it works.
   *
   * The identity read is not decoration: the driver's `connect()` already fails on a
   * refused socket, a wrong data centre, a bad credential and a keyspace that does
   * not exist (all measured), and one statement afterwards proves the session can
   * actually carry one.
   */
  public async connect(): Promise<void> {
    const transport = this.transport ?? new CassandraDriverTransport(this.config, this.queryTimeout);

    try {
      await transport.connect();
      await transport.execute(CASSANDRA_IDENTITY_CQL);
      // One extra statement per connection, and the last thing the attempt does: it
      // asks which virtual keyspaces this build has, which is what the monitoring
      // reads key their degradation on instead of the wording of a refusal. It never
      // throws, so it cannot turn a working connection into a failed one.
      this.facts = await readServerFacts(transport);
    } catch (error) {
      // `connect()` opens a pool with sockets and reconnection timers behind it, and
      // the identity read runs AFTER that - so a probe that fails leaks the pool
      // unless it is closed here, once per attempt, and the connection dialog retries.
      // Druid and Couchbase close before mapping for the same reason.
      await transport.close();
      const failure = this.describeConnectFailure(error);
      this.setError(failure);
      throw failure;
    }

    this.transport = transport;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.facts = null;
    if (transport !== null) await transport.close();
    this.setConnected(false);
  }

  private describeConnectFailure(error: unknown): Error {
    const mapped = this.mapCassandraError(error);
    // A refused credential and a missing data centre are not connectivity problems,
    // and saying so would send the user to check their host.
    if (mapped instanceof AuthenticationError || mapped instanceof DatabaseConfigError) return mapped;
    // The keyspace is pinned at connect time, so a keyspace that does not exist fails
    // HERE with the server's own sentence. Wrapping it in "failed to connect" would
    // bury the one word the user has to change.
    if (mapped instanceof QueryError) return mapped;

    return new ConnectionError(
      `Failed to connect to Apache Cassandra: ${mapped.message}`,
      this.type,
      this.config.host,
      this.config.port,
    );
  }

  private requireTransport(): CassandraTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false), so a
    // connected provider always has one.
    return this.transport!;
  }

  /**
   * The facts the connect-time probe established.
   *
   * Assigned in the same `try` as the identity read and cleared with the transport, so
   * a connected provider always has them - which is why `requireTransport()` is the
   * one that checks.
   */
  private requireFacts(): CassandraServerFacts {
    return this.facts!;
  }

  /**
   * The facts, or a refusal naming the virtual table this panel would have read.
   *
   * The gate is here rather than inside the read because the read is also what
   * `getHealth()` composes, and health must keep answering on a build with no virtual
   * tables: `POST /api/db/test-connection` calls it and the connection dialog's save is
   * gated on that request, so a throwing health check locks the whole ScyllaDB family
   * out of the product (#455). A monitoring panel has the opposite obligation - it is
   * the surface that must say what it could not read.
   */
  private requireVirtualTables(source: string): CassandraServerFacts {
    const facts = this.requireFacts();
    if (facts.virtualTablesAbsence !== undefined) {
      throw new QueryError(cassandraVirtualTableRefusal(source, facts.virtualTablesAbsence), this.type);
    }

    return facts;
  }

  /**
   * The keyspace every catalog read resolves against.
   *
   * The connection's `database` field, exactly as a PostgreSQL connection pins one
   * database and a Trino connection pins one catalog. A connection that names none
   * has no tree to show: measured, an unqualified table name then answers "No
   * keyspace has been specified. USE a keyspace, or explicitly specify
   * keyspace.tablename".
   */
  private requireKeyspace(): string {
    const keyspace = this.config.database;
    if (keyspace === undefined || keyspace === "") {
      throw new DatabaseConfigError(
        "This connection pins no keyspace, so there is no schema to list. Set the keyspace on the connection, or qualify every table name with its keyspace.",
        this.type,
      );
    }

    return keyspace;
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  /**
   * One statement.
   *
   * Positional parameters are REFUSED rather than interpolated. CQL binds them and so
   * does this driver, through a prepared statement the transport deliberately does
   * not send (`prepare: false`, so a one-shot statement costs one round trip and no
   * server-side cache entry). Splicing the values into the text instead would be the
   * one place this provider could inject SQL, and running the statement with its
   * placeholders unbound is worse than saying so.
   */
  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();
    if (params !== undefined && params.length > 0) {
      throw new QueryError(
        "Apache Cassandra binds parameters through a prepared statement, which this client does not send, so positional parameters cannot be used here",
        this.type,
        sql,
      );
    }

    return this.trackQuery(async () => {
      try {
        const { result, executionTime } = await this.measureExecution(() => transport.execute(sql));

        return {
          rows: result.rows,
          // An EMPTY declaration and no declaration at all both leave the grid with no
          // columns, but they are different facts and the seam keeps them apart: a
          // write answers `null` here (measured on INSERT, DELETE, ALTER and USE).
          fields: result.fieldNames ?? [],
          // The rows returned, and nothing else. The protocol reports no
          // affected-row count for a write - a write answers no declaration and no
          // rows - so a mutation count would be invented.
          rowCount: result.rows.length,
          // The wall clock this process measured. The protocol reports no server-side
          // duration for a statement, so there is nothing more precise to use.
          executionTime,
          ...(result.columnTypes === null ? {} : { columnTypes: result.columnTypes }),
        };
      } catch (error) {
        throw this.mapCassandraError(error, sql);
      }
    });
  }

  /**
   * A classified transport failure -> the provider error vocabulary.
   *
   * Keyed on the CATEGORY the seam resolved, never on the driver's error class: on
   * this protocol the class is almost always `NoHostAvailableError` and the code
   * `undefined`, with the fault that can be acted on nested inside `innerErrors`.
   *
   * Anything that is not a transport failure goes to the shared message-based
   * mapping, exactly as `clickhouse/index.ts` and `trino/index.ts` do: a bug in this
   * file's own mapping is not a database error and must not be dressed as one.
   */
  private mapCassandraError(error: unknown, sql?: string): Error {
    if (!(error instanceof CassandraTransportError)) return this.mapError(error, sql);

    switch (error.category) {
      case "auth":
        return new AuthenticationError(error.message, this.type);
      case "unreachable":
        return new ConnectionError(error.message, this.type, this.config.host, this.config.port);
      case "config":
        return new DatabaseConfigError(error.message, this.type);
      case "client-timeout":
      case "server-timeout":
        // Two different faults with one shared consequence for the user, and the
        // server's own sentence is what tells them apart: a client timeout says the
        // host did not reply in time, a server timeout says how many replicas
        // answered - and after a WRITE timeout the mutation may still have been
        // applied.
        return new TimeoutError(error.message, this.type, this.queryTimeout, sql);
      default:
        // `syntax`, `invalid`, `permission`, `unavailable` and `engine` all describe a
        // statement the cluster read and refused, and the engine's own wording is the
        // most useful thing that can be shown for any of them - "Cannot execute this
        // query as it might involve data filtering … use ALLOW FILTERING" is a
        // complete instruction, and nothing written here could improve it.
        return new QueryError(error.message, this.type, sql);
    }
  }

  /** Run a catalog or monitoring read whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapCassandraError(error);
    }
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  /**
   * The tables and materialized views of the pinned keyspace.
   *
   * `getSchemaList` and `getSchemaRelations` are deliberately NOT implemented. The
   * split exists so a slow relationship read cannot block the table list, and here
   * the relationships come from the same three-statement read as the columns: there
   * are no foreign keys to fetch, and the secondary-index list is one row per index
   * in the whole keyspace.
   */
  public async getSchema(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    const keyspace = this.requireKeyspace();
    return this.guarded(() => readSchema(transport, keyspace));
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    const transport = this.requireTransport();
    const keyspace = this.requireKeyspace();
    return this.guarded(() => readOverview(transport, keyspace, this.requireFacts()));
  }

  /**
   * ABSENT rather than empty on a build with no `system_views`.
   *
   * The key cache's hit ratio is this panel's only source, so a build that does not
   * publish `system_views.caches` cannot answer the panel at all - and an empty
   * `PerformanceMetrics` said the opposite, that every field was looked up and found
   * to have no value. `getMonitoringData` leaves a rejected panel absent with this
   * sentence under `errors`, which is what `PanelUnavailable` renders (#477).
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    const transport = this.requireTransport();
    const facts = this.requireVirtualTables("system_views.caches");
    return this.guarded(() => readPerformanceMetrics(transport, facts));
  }

  /**
   * Empty, and it asks the cluster nothing: there is no slow-query log to read.
   *
   * The one always-empty panel that stays empty. `QueriesTab` renders
   * `ProviderLabels.slowQueriesEmptyState` in its place, and this provider declares one
   * (`getLabels()` above), so Cassandra's own sentence already reaches the user here -
   * which is the thing the absence mechanism exists to deliver.
   */
  public getSlowQueries(): Promise<SlowQueryStats[]> {
    return Promise.resolve(readSlowQueries());
  }

  /** ABSENT rather than empty on a build with no `system_views`: see `getPerformanceMetrics`. */
  public async getActiveSessions(options: { limit?: number } = {}): Promise<ActiveSessionDetails[]> {
    const transport = this.requireTransport();
    const facts = this.requireVirtualTables("system_views.queries");
    return this.guarded(() => readActiveSessions(transport, facts, options));
  }

  /**
   * REFUSED on every build, with the reason, rather than answered empty.
   *
   * These three panels never had a source: the tables and the secondary indexes exist
   * and the schema tree lists them, so `[]` claimed a measurement of nothing where the
   * truth is that no honest figure is readable from CQL. The panels are absent with
   * their own sentence for the same reason the ScyllaDB ones above are - the rule
   * `MonitoringData` states, not a property of any one build.
   */
  public getTableStats(): Promise<TableStats[]> {
    return Promise.reject(new QueryError(CASSANDRA_TABLE_STATS_REFUSAL, this.type));
  }

  /** Refused with its reason: an index here has no size and no scan counter. */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.reject(new QueryError(CASSANDRA_INDEX_STATS_REFUSAL, this.type));
  }

  /** Refused with its reason: the only storage figures are whole mebibytes. */
  public getStorageStats(): Promise<StorageStats[]> {
    return Promise.reject(new QueryError(CASSANDRA_STORAGE_STATS_REFUSAL, this.type));
  }

  public async getHealth(): Promise<HealthInfo> {
    const transport = this.requireTransport();
    const keyspace = this.requireKeyspace();
    return this.guarded(() => readHealth(transport, keyspace, this.requireFacts()));
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * Nothing runs from here, and the refusal names where the work actually happens.
   *
   * Every member of `MaintenanceType` describes an operation Cassandra performs on a
   * NODE rather than through a session: compaction, cleanup, garbage collection,
   * flush and repair are all `nodetool` commands over JMX, and statistics are
   * recomputed as a side effect of compaction. There is no `KILL` to map `kill` onto,
   * because the protocol has no cancellation at all. Mapping any of them onto the
   * nearest-looking statement - `TRUNCATE` is the tempting one - would be a data-loss
   * hazard wearing a maintenance label.
   */
  public runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    return Promise.reject(
      new QueryError(
        `Apache Cassandra has no "${type}" statement. Compaction, cleanup, flush and repair are nodetool operations against a node over JMX, and statistics are recomputed by compaction itself, so nothing can be run from a CQL session.`,
        this.type,
      ),
    );
  }
}
