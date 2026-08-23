/**
 * Apache Cassandra provider, end to end (issue #424, Phase 4)
 *
 * Every payload below was captured on 2026-08-20 from a live **Apache Cassandra
 * 5.0.9** (`system.local.release_version`) through `cassandra-driver` 4.9.0, on a
 * `probe` keyspace holding `customers` (500 rows), `orders` (2000), `events` (10
 * partitions x 50 clustering rows), a secondary index and a 28-column type matrix.
 * A second instance with `PasswordAuthenticator` + `CassandraAuthorizer` supplied
 * the authentication, permission and materialized-view payloads.
 *
 * The REAL provider, the REAL introspection and the REAL driver adapter all execute
 * here. Only the session is a stand-in, and it replays driver ResultSets - column
 * declarations with their type codes, rows carrying the driver's own `Long`,
 * `BigDecimal`, `Duration` and `Vector` instances - so the mapping under test is the
 * one a cluster feeds. `mock.module()` is not used: it is process-wide in bun and
 * poisons sibling files.
 *
 * Six measured behaviours drive what is asserted:
 *
 * 1. THERE IS NO HONEST ROW COUNT AND NO HONEST SIZE. `system.size_estimates` counts
 *    PARTITIONS per token range from flushed SSTables only, and measured it said 143
 *    for a 500-row clustered table; `system_views.disk_usage` and
 *    `max_partition_size` are whole mebibytes and both reported "1 MiB" for a
 *    19,476-byte table. So the schema tree carries no `rowCount` and no `size`, the
 *    overview reports no database size, and the table, index and storage panels are
 *    empty rather than wrong.
 * 2. `OFFSET` IS NOT IN THE GRAMMAR: `… LIMIT 5 OFFSET 5` is "line 1:45 mismatched
 *    input 'OFFSET' expecting EOF". Nothing after the first page can be requested.
 * 3. `ALLOW FILTERING` MUST STAY LAST: `… LIMIT 3 ALLOW FILTERING` returns rows,
 *    `… ALLOW FILTERING LIMIT 3` is a syntax error.
 * 4. A LINE COMMENT MUST BE CLOSED BY A NEWLINE. `SELECT * FROM probe.customers
 *    LIMIT 3 -- note` with nothing after it is "line 1:45 mismatched character
 *    '<EOF>' expecting set null", and CQL has a THIRD comment form, `//`, that the
 *    shared readers do not know at all.
 * 5. EVERY CONNECT-TIME FAULT IS A `NoHostAvailableError` with `code === undefined`
 *    and the real fault in `innerErrors`.
 * 6. `system_schema.columns.position` IS -1 FOR EVERY REGULAR COLUMN and the rows
 *    come back alphabetically, so declaration order is not recoverable - the tree
 *    orders partition key, then clustering, then the rest by name, and says so.
 */
import { describe, expect, test } from "bun:test";
import { types } from "cassandra-driver";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { CassandraDriverTransport, type CassandraSession } from "@/lib/db/providers/sql/cassandra/driver-transport";
import { CassandraProvider } from "@/lib/db/providers/sql/cassandra/index";
import { CassandraTransportError } from "@/lib/db/providers/sql/cassandra/transport";
import {
  CASSANDRA_CACHE_CQL,
  CASSANDRA_CLIENT_COUNT_CQL,
  CASSANDRA_IDENTITY_CQL,
  CASSANDRA_RUNNING_QUERY_CQL,
  CASSANDRA_SIZE_UNAVAILABLE,
  CASSANDRA_UNKNOWN_TEXT,
  cassandraColumnListCql,
  cassandraIndexCountCql,
  cassandraIndexListCql,
  cassandraTableCountCql,
  cassandraTableListCql,
  cassandraViewListCql,
} from "@/lib/db/providers/sql/cassandra/introspect";
import type { DatabaseConnection } from "@/lib/types";

const KEYSPACE = "probe";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "cassandra-1",
    name: "Probe ring",
    type: "cassandra",
    host: "cassandra.test",
    port: 9042,
    database: KEYSPACE,
    localDataCenter: "datacenter1",
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

// ============================================================================
// Wire payloads (captured from Apache Cassandra 5.0.9 over the native protocol)
// ============================================================================

type ColumnType = { code: number; info?: unknown };
type Declaration = { name: string; type: ColumnType };

const TEXT: ColumnType = { code: 13, info: null };
const INT: ColumnType = { code: 9, info: null };
const BIGINT: ColumnType = { code: 2, info: null };
const TIMESTAMP: ColumnType = { code: 11, info: null };
const MAP_TEXT_TEXT: ColumnType = { code: 33, info: [TEXT, TEXT] };
const DOUBLE: ColumnType = { code: 7, info: null };

function declare(...names: [string, ColumnType][]): Declaration[] {
  return names.map(([name, type]) => ({ name, type }));
}

function result(columns: Declaration[] | null, rows: Record<string, unknown>[] = []) {
  return { columns, rows, pageState: null };
}

/** A statement that changed something: no declaration and no rows (measured). */
const VOID_RESULT = result(null);

/**
 * `SELECT release_version, cluster_name, data_center, gossip_generation,
 * toTimestamp(now()) AS server_now FROM system.local`, verbatim.
 *
 * `gossip_generation` is the node's own start time in epoch SECONDS. Measured on two
 * independent instances: 1787249337 against a container started at 18:08:53.9Z (the
 * gossiper's first heartbeat, 3s later), and the second node's generation differed
 * from the first by 4997s against a container start difference of 4998s.
 */
const IDENTITY_ROW = {
  release_version: "5.0.9",
  cluster_name: "libredb-probe",
  data_center: "datacenter1",
  gossip_generation: 1787249337,
  server_now: new Date("2026-08-20T20:02:13.073Z"),
};

const IDENTITY_RESULT = result(
  declare(
    ["release_version", TEXT],
    ["cluster_name", TEXT],
    ["data_center", TEXT],
    ["gossip_generation", INT],
    ["server_now", TIMESTAMP],
  ),
  [IDENTITY_ROW],
);

/** `system_schema.tables`, the four tables the probe keyspace holds. */
const TABLE_LIST = result(declare(["table_name", TEXT]), [
  { table_name: "customers" },
  { table_name: "events" },
  { table_name: "orders" },
  { table_name: "type_matrix" },
]);

/**
 * `system_schema.columns` for the keyspace, exactly as the server ordered them:
 * alphabetically by table and then by column, with `position` -1 for every regular
 * column.
 */
const COLUMN_LIST = result(
  declare(
    ["table_name", TEXT],
    ["column_name", TEXT],
    ["type", TEXT],
    ["kind", TEXT],
    ["position", INT],
    ["clustering_order", TEXT],
  ),
  [
    {
      table_name: "customers",
      column_name: "country",
      type: "text",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "customers",
      column_name: "id",
      type: "int",
      kind: "partition_key",
      position: 0,
      clustering_order: "none",
    },
    {
      table_name: "customers",
      column_name: "name",
      type: "text",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    { table_name: "events", column_name: "ck", type: "int", kind: "clustering", position: 0, clustering_order: "asc" },
    {
      table_name: "events",
      column_name: "pk",
      type: "int",
      kind: "partition_key",
      position: 0,
      clustering_order: "none",
    },
    { table_name: "events", column_name: "v", type: "text", kind: "regular", position: -1, clustering_order: "none" },
    {
      table_name: "orders",
      column_name: "amount",
      type: "decimal",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "orders",
      column_name: "country",
      type: "text",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "orders",
      column_name: "customer_id",
      type: "int",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "orders",
      column_name: "id",
      type: "int",
      kind: "partition_key",
      position: 0,
      clustering_order: "none",
    },
    {
      table_name: "type_matrix",
      column_name: "c_vector",
      type: "vector<float, 3>",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "type_matrix",
      column_name: "id",
      type: "int",
      kind: "partition_key",
      position: 0,
      clustering_order: "none",
    },
    // A view's columns live in this same table, keyed by the VIEW name (measured on
    // the authenticated instance, where materialized views are enabled).
    {
      table_name: "orders_by_country",
      column_name: "amount",
      type: "decimal",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "orders_by_country",
      column_name: "country",
      type: "text",
      kind: "partition_key",
      position: 0,
      clustering_order: "none",
    },
    {
      table_name: "orders_by_country",
      column_name: "customer_id",
      type: "int",
      kind: "regular",
      position: -1,
      clustering_order: "none",
    },
    {
      table_name: "orders_by_country",
      column_name: "id",
      type: "int",
      kind: "clustering",
      position: 0,
      clustering_order: "asc",
    },
  ],
);

/** `system_schema.indexes`: one legacy secondary index per table, target in `options`. */
const INDEX_LIST = result(
  declare(["table_name", TEXT], ["index_name", TEXT], ["kind", TEXT], ["options", MAP_TEXT_TEXT]),
  [
    {
      table_name: "customers",
      index_name: "customers_country_idx",
      kind: "COMPOSITES",
      options: { target: "country" },
    },
    { table_name: "orders", index_name: "orders_country_idx", kind: "COMPOSITES", options: { target: "country" } },
  ],
);

/** `system_schema.views`, from the instance where materialized views are enabled. */
const VIEW_LIST = result(declare(["view_name", TEXT], ["base_table_name", TEXT]), [
  { view_name: "orders_by_country", base_table_name: "orders" },
]);

const EMPTY_VIEW_LIST = result(declare(["view_name", TEXT], ["base_table_name", TEXT]), []);

/** `SELECT COUNT(*)` answers a `Long`, never a number (measured). */
function countResult(count: string) {
  return result(declare(["count", BIGINT]), [{ count: types.Long.fromString(count) }]);
}

/** `system_views.caches`, all three rows, hit_ratio as the server reported it. */
const CACHE_RESULT = result(declare(["name", TEXT], ["hit_ratio", DOUBLE]), [
  { name: "counters", hit_ratio: null },
  { name: "keys", hit_ratio: 0.8305084745762712 },
  { name: "rows", hit_ratio: null },
]);

/** `system_views.queries` - "currently running queries", including this read itself. */
const RUNNING_QUERY_RESULT = result(
  declare(["thread_id", TEXT], ["queued_micros", BIGINT], ["running_micros", BIGINT], ["task", TEXT]),
  [
    {
      thread_id: "Native-Transport-Requests-1",
      queued_micros: types.Long.fromString("43"),
      running_micros: types.Long.fromString("1118"),
      task: "QUERY SELECT * FROM system_views.queries [pageSize = 5000] at consistency LOCAL_ONE",
    },
  ],
);

/** The same view with three rows, for the assertions a one-row reply cannot make. */
const MANY_RUNNING = result(
  declare(["thread_id", TEXT], ["queued_micros", BIGINT], ["running_micros", BIGINT], ["task", TEXT]),
  ["one", "two", "three"].map((name, index) => ({
    thread_id: `Native-Transport-Requests-${name}`,
    queued_micros: types.Long.fromString("43"),
    running_micros: types.Long.fromString(`${1118 + index}`),
    task: "QUERY SELECT * FROM system_views.queries [pageSize = 5000] at consistency LOCAL_ONE",
  })),
);

// ============================================================================
// The session stand-in
// ============================================================================

type Reply = ReturnType<typeof result> | Error;

/**
 * A session that answers exactly the statements it was given, and nothing else.
 *
 * An unknown statement THROWS rather than answering empty: a provider whose CQL
 * drifts must fail here rather than quietly reporting no rows, which is how a
 * mock-shaped test stops testing anything.
 */
function fakeSession(replies: Record<string, Reply>): CassandraSession & { asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    connect: async () => {},
    execute: async (cql: string) => {
      asked.push(cql);
      const reply = replies[cql];
      if (reply === undefined) throw new Error(`unexpected statement: ${cql}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    shutdown: async () => {},
  };
}

/** The catalog and monitoring answers a healthy connection gets. */
function healthyReplies(overrides: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    [CASSANDRA_IDENTITY_CQL]: IDENTITY_RESULT,
    [cassandraTableListCql(KEYSPACE)]: TABLE_LIST,
    [cassandraViewListCql(KEYSPACE)]: VIEW_LIST,
    [cassandraColumnListCql(KEYSPACE)]: COLUMN_LIST,
    [cassandraIndexListCql(KEYSPACE)]: INDEX_LIST,
    [cassandraTableCountCql(KEYSPACE)]: countResult("4"),
    [cassandraIndexCountCql(KEYSPACE)]: countResult("2"),
    [CASSANDRA_CLIENT_COUNT_CQL]: countResult("2"),
    [CASSANDRA_CACHE_CQL]: CACHE_RESULT,
    [CASSANDRA_RUNNING_QUERY_CQL]: RUNNING_QUERY_RESULT,
    ...overrides,
  };
}

async function connectedProvider(
  replies: Record<string, Reply> = healthyReplies(),
  overrides: Partial<DatabaseConnection> = {},
): Promise<{ provider: CassandraProvider; session: CassandraSession & { asked: string[] } }> {
  const config = makeConnection(overrides);
  const session = fakeSession(replies);
  const provider = new CassandraProvider(config, {}, new CassandraDriverTransport(config, 60_000, session));
  await provider.connect();

  return { provider, session };
}

/** A ResponseError as the driver builds one. */
function responseError(code: number, message: string): Error {
  const error = new Error(message) as Error & { code: number };
  error.name = "ResponseError";
  error.code = code;
  return error;
}

/** The envelope every connect-time fault arrives in. */
function noHostAvailable(inner: Record<string, unknown>): Error {
  const error = new Error("All host(s) tried for query failed. See innerErrors.");
  error.name = "NoHostAvailableError";
  Object.assign(error, { innerErrors: inner });
  return error;
}

// ============================================================================
// Capabilities and labels
// ============================================================================

describe("capabilities", () => {
  const capabilities = new CassandraProvider(makeConnection()).getCapabilities();

  test("CQL is SQL for the editor's purposes", () => {
    expect(capabilities.queryLanguage).toBe("sql");
    expect(capabilities.defaultPort).toBe(9042);
  });

  test("there is no EXPLAIN to offer, so none is claimed", () => {
    // `EXPLAIN SELECT * FROM probe.customers WHERE id = 1` is "line 1:0 no viable
    // alternative at input 'EXPLAIN'" - the keyword is not in the grammar at all.
    // The only substitute is post-hoc tracing, which profiles a statement already
    // RUN and is therefore not a plan; it is deliberately not exposed here.
    expect(capabilities.supportsExplain).toBe(false);
    expect(capabilities.explainFormat).toBeUndefined();
  });

  test("the inline row editor is off, because its one statement shape is not safe here", () => {
    // Two measurements. Editing a key column: `UPDATE probe.customers SET id = 2
    // WHERE id = 1` is "PRIMARY KEY part id found in SET part". And the editor names
    // ONE column it guessed from the result fields (`id` or `*_id`), while CQL needs
    // the WHOLE primary key restricted: `UPDATE probe.events SET v = 'x' WHERE ck = 0`
    // is "Some partition key parts are missing: pk", and `UPDATE probe.orders SET
    // amount = 1 WHERE customer_id = 3` - a plausible guess on a real table - is
    // "Some partition key parts are missing: id".
    expect(capabilities.supportsInlineRowEdit).toBe(false);
    // CQL has no transaction; BATCH is not one (#U13).
    expect(capabilities.supportsTransactions).toBe(false);
  });

  test("there are no foreign keys in the model at all", () => {
    // `ALTER TABLE probe.customers ADD CONSTRAINT … FOREIGN KEY …` is a syntax error:
    // the clause does not exist. An empty relations list is the engine's answer here,
    // not the schema's.
    expect(capabilities.declaresForeignKeys).toBe(false);
  });

  test("Create Table is off, because the modal cannot emit valid CQL", () => {
    // `CREATE TABLE probe.t (id int PRIMARY KEY, name text)` works, but what
    // CreateTableModal emits does not: its default column is `id SERIAL PRIMARY KEY`
    // ("Unknown type probe.serial"), its type list offers `VARCHAR(255)`,
    // `DECIMAL(10,2)`, `INTEGER` and `JSONB` - the first two are syntax errors and
    // the last two are "Unknown type" - and its NOT NULL, UNIQUE and DEFAULT
    // checkboxes each produce "no viable alternative at input". DDL typed into the
    // editor works normally, which is how a CQL user creates a table.
    expect(capabilities.supportsCreateTable).toBe(false);
  });

  test("no maintenance operation is claimed, because none is reachable from CQL", () => {
    // Compaction, repair, flush and cleanup are `nodetool`/JMX operations, not
    // statements. There is no `KILL` either: the protocol has no cancel and the
    // driver publishes no cancel method (measured on the client's own API surface).
    expect(capabilities.supportsMaintenance).toBe(false);
    expect(capabilities.maintenanceOperations).toEqual([]);
  });

  test("no connection string is offered, because no URI carries the data centre", () => {
    expect(capabilities.supportsConnectionString).toBe(false);
  });

  test("a trailing semicolon is accepted, so the generators keep emitting one", () => {
    // Measured: `SELECT id FROM probe.customers WHERE id = 1;` returns the row. Two
    // statements separated by `;` are refused, but that is the splitter's business.
    expect(capabilities.statementTerminator).toBeUndefined();
  });

  test("the schema tree reloads on the DDL that changes it", () => {
    const pattern = new RegExp(capabilities.schemaRefreshPattern, "i");

    expect(pattern.test("CREATE TABLE probe.t (id int PRIMARY KEY)")).toBe(true);
    expect(pattern.test("ALTER TABLE probe.customers ADD extra text")).toBe(true);
    expect(pattern.test("DROP TABLE probe.t")).toBe(true);
    expect(pattern.test("SELECT * FROM probe.customers")).toBe(false);
  });
});

describe("labels", () => {
  const labels = new CassandraProvider(makeConnection()).getLabels();

  test("table and row are CQL's own words, so they are left alone", () => {
    expect(labels.entityName).toBe("Table");
    expect(labels.rowName).toBe("row");
  });

  test("the maintenance blurbs say where the work actually happens", () => {
    // The cards do not render (no operations are offered), but the inherited copy
    // would promise a planner-statistics update and a space reclaim, and Cassandra
    // does neither from a statement.
    expect(labels.analyzeGlobalDesc).toContain("nodetool");
    expect(labels.vacuumGlobalDesc).toContain("nodetool");
  });

  test("the empty slow-query panel says Cassandra keeps no such aggregate", () => {
    // `getSlowQueries()` is empty by design here, so this panel is ALWAYS empty - and
    // until #U12 it told the reader to enable a PostgreSQL extension (#427's defect in
    // another panel). The log file is the fact, so it is what the sentence names.
    expect(labels.slowQueriesEmptyState).toContain("no aggregate of finished statements");
    expect(labels.slowQueriesEmptyState).toContain("log file");
    expect(labels.slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });

  test("the statement language is named, because CQL is not SQL", () => {
    // A model asked for "a statement" against a connection called Cassandra will
    // write SQL: a JOIN, a subquery, an OFFSET. Each is a syntax error here.
    expect(labels.statementLanguage).toContain("CQL");
  });
});

// ============================================================================
// Validation and connect
// ============================================================================

describe("validate", () => {
  test("a host is required", () => {
    expect(() => new CassandraProvider(makeConnection({ host: "" }))).toThrow(DatabaseConfigError);
  });

  test("the local data centre is required, because the driver refuses without one", () => {
    // Measured: `'localDataCenter' is not defined in Client options and also was not
    // specified in constructor. At least one is required. Available DCs are:
    // [datacenter1]`. Refusing here names the field a user can fill instead.
    expect(() => new CassandraProvider(makeConnection({ localDataCenter: undefined }))).toThrow(
      /localDataCenter|data cent/i,
    );
  });
});

describe("connect", () => {
  test("the identity read is the connect probe, and the version is recorded whole", async () => {
    const { provider, session } = await connectedProvider();

    expect(provider.isConnected()).toBe(true);
    expect(session.asked).toEqual([CASSANDRA_IDENTITY_CQL]);
    expect((await provider.getOverview()).version).toBe("Apache Cassandra 5.0.9");
  });

  test("a refused credential is an authentication failure, not a connectivity one", async () => {
    const config = makeConnection();
    const session = fakeSession({});
    session.connect = async () => {
      throw noHostAvailable({
        "127.0.0.1:19043": {
          name: "AuthenticationError",
          message: "Provided username cassandra and/or password are incorrect",
        },
      });
    };
    const provider = new CassandraProvider(config, {}, new CassandraDriverTransport(config, 60_000, session));

    await expect(provider.connect()).rejects.toThrow(AuthenticationError);
    expect(provider.isConnected()).toBe(false);
  });

  test("a refused socket is a connection failure naming host and port", async () => {
    const config = makeConnection();
    const session = fakeSession({});
    session.connect = async () => {
      throw noHostAvailable({
        "127.0.0.1:19999": { name: "Error", code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:19999" },
      });
    };
    const provider = new CassandraProvider(config, {}, new CassandraDriverTransport(config, 60_000, session));

    await expect(provider.connect()).rejects.toThrow(ConnectionError);
  });

  test("a keyspace that does not exist fails the connect, with the server's own words", async () => {
    // Measured: the driver pins the keyspace at connect time, so this is a CONNECT
    // failure rather than a first-statement one - `Keyspace 'nosuchks' does not exist`.
    const config = makeConnection({ database: "nosuchks" });
    const session = fakeSession({});
    session.connect = async () => {
      throw responseError(8704, "Keyspace 'nosuchks' does not exist");
    };
    const provider = new CassandraProvider(config, {}, new CassandraDriverTransport(config, 60_000, session));

    await expect(provider.connect()).rejects.toThrow(/nosuchks/);
  });

  test("a wrong data centre is a configuration fault, not a connectivity one", async () => {
    // Measured: the driver refuses and NAMES the data centres it found, which is the
    // useful half of the message - so it must not be wrapped in "failed to connect",
    // which would send the user to check their host.
    const config = makeConnection({ localDataCenter: "dc-does-not-exist" });
    const session = fakeSession({});
    session.connect = async () => {
      throw noHostAvailable({
        "127.0.0.1:19042": {
          name: "ArgumentError",
          message:
            "localDataCenter was configured as 'dc-does-not-exist', but only found hosts in data centers: [datacenter1]",
        },
      });
    };
    // A fresh provider per assertion: a failed connect closes the pool it opened, and
    // the adapter forgets its session when it closes - so a second attempt on the same
    // provider would build a real driver client and go to the network.
    const attempt = () => new CassandraProvider(config, {}, new CassandraDriverTransport(config, 60_000, session));

    await expect(attempt().connect()).rejects.toThrow(DatabaseConfigError);
    await expect(attempt().connect()).rejects.toThrow(/\[datacenter1\]/);
  });

  test("a failure that is not a transport failure is not dressed as a database error", async () => {
    // A bug in this provider's own mapping is not something the cluster said. The seam
    // always classifies, so this can only arrive from a defect above it - and it must
    // reach the shared message-based mapping rather than being reported as an engine
    // fault with a category it never had.
    const config = makeConnection();
    const provider = new CassandraProvider(
      config,
      {},
      {
        kind: "native" as const,
        connect: async () => {},
        execute: async () => {
          throw new TypeError("undefined is not an object");
        },
        close: async () => {},
      },
    );

    await expect(provider.connect()).rejects.toThrow(/undefined is not an object/);
  });

  test("disconnect closes the session and forgets it", async () => {
    const config = makeConnection();
    const session = fakeSession(healthyReplies());
    let shutdowns = 0;
    session.shutdown = async () => {
      shutdowns += 1;
    };
    const provider = new CassandraProvider(config, {}, new CassandraDriverTransport(config, 60_000, session));

    await provider.connect();
    await provider.disconnect();

    expect(shutdowns).toBe(1);
    expect(provider.isConnected()).toBe(false);
    // A second disconnect is a no-op rather than a second shutdown.
    await provider.disconnect();
    expect(shutdowns).toBe(1);
  });

  test("a statement before connect is refused", async () => {
    const provider = new CassandraProvider(makeConnection());

    await expect(provider.query("SELECT * FROM probe.customers")).rejects.toThrow();
  });
});

// ============================================================================
// Query execution
// ============================================================================

describe("query", () => {
  const SELECT = "SELECT * FROM probe.type_matrix WHERE id = 1";

  test("driver values reach the grid as something a reader can use", async () => {
    const declaration = declare(
      ["id", INT],
      ["c_bigint", BIGINT],
      ["c_blob", { code: 3, info: null }],
      ["c_duration", { code: 0, info: "org.apache.cassandra.db.marshal.DurationType" }],
      [
        "c_vector",
        { code: 0, info: "org.apache.cassandra.db.marshal.VectorType(org.apache.cassandra.db.marshal.FloatType , 3)" },
      ],
    );
    const row = {
      id: 1,
      c_bigint: types.Long.fromString("9223372036854775807"),
      c_blob: Buffer.from("4c69627265444200c3bf6279746573", "hex"),
      c_duration: new types.Duration(1, 2, types.Long.fromString("10800000000000")),
      c_vector: new types.Vector(Float32Array.of(1.5, 2.5, 3.5), "float"),
    };
    const { provider } = await connectedProvider(healthyReplies({ [SELECT]: result(declaration, [row]) }));

    const answer = await provider.query(SELECT);

    expect(answer.fields).toEqual(["id", "c_bigint", "c_blob", "c_duration", "c_vector"]);
    expect(answer.rows).toEqual([
      {
        id: 1,
        c_bigint: "9223372036854775807",
        c_blob: "0x4c69627265444200c3bf6279746573",
        c_duration: "1mo2d3h",
        c_vector: [1.5, 2.5, 3.5],
      },
    ]);
    expect(answer.rowCount).toBe(1);
    // The declared type per column, including the two the code alone cannot name.
    expect(answer.columnTypes).toEqual({
      id: "int",
      c_bigint: "bigint",
      c_blob: "blob",
      c_duration: "duration",
      c_vector: "vector<float, 3>",
    });
  });

  test("a write reports no columns and no invented row count", async () => {
    const insert = "INSERT INTO probe.customers (id, name) VALUES (1, 'a')";
    const { provider } = await connectedProvider(healthyReplies({ [insert]: VOID_RESULT }));

    const answer = await provider.query(insert);

    expect(answer.rows).toEqual([]);
    expect(answer.fields).toEqual([]);
    // The protocol reports no affected-row count for a write, so none is claimed.
    expect(answer.rowCount).toBe(0);
    expect(answer.columnTypes).toBeUndefined();
  });

  test.each([
    ["a syntax error", 8192, "line 1:0 no viable alternative at input 'SELEC' ([SELEC]...)"],
    ["an unknown table", 8704, "table nosuchtable does not exist"],
    [
      "a query that needs filtering",
      8704,
      "Cannot execute this query as it might involve data filtering and thus may have unpredictable performance. If you want to execute this query despite the performance unpredictability, use ALLOW FILTERING",
    ],
    ["a refused grant", 8448, "User lowpriv has no SELECT permission on <table probe.orders> or any of its parents"],
    [
      "an unavailable replica set",
      4096,
      "Not enough replicas available for query at consistency TWO (2 required but only 1 alive)",
    ],
  ])("%s surfaces as a query error carrying the server's own sentence", async (_label, code, message) => {
    const { provider } = await connectedProvider(healthyReplies({ [SELECT]: responseError(code, message) }));

    await expect(provider.query(SELECT)).rejects.toThrow(QueryError);
    await expect(provider.query(SELECT)).rejects.toThrow(message.slice(0, 40));
  });

  test("the server's own read timeout is a timeout, not a query error", async () => {
    // Measured with FallthroughRetryPolicy: `Server timeout during read query at
    // consistency LOCAL_ONE (0 replica(s) responded over 1 required)`, code 4608.
    // Under the DEFAULT retry policy the same statement silently succeeded on retry,
    // which is why nothing here depends on a retry outcome.
    const failure = responseError(
      4608,
      "Server timeout during read query at consistency LOCAL_ONE (0 replica(s) responded over 1 required)",
    );
    const { provider } = await connectedProvider(healthyReplies({ [SELECT]: failure }));

    await expect(provider.query(SELECT)).rejects.toThrow(TimeoutError);
  });

  test("the client's own deadline is a timeout too", async () => {
    const failure = new Error("The host 127.0.0.1:19042 did not reply before timeout 1 ms");
    failure.name = "OperationTimedOutError";
    const { provider } = await connectedProvider(healthyReplies({ [SELECT]: failure }));

    await expect(provider.query(SELECT)).rejects.toThrow(TimeoutError);
  });

  test("positional parameters are refused rather than spliced into the statement", async () => {
    const { provider } = await connectedProvider();

    await expect(provider.query("SELECT * FROM probe.customers WHERE id = ?", [1])).rejects.toThrow(QueryError);
  });

  test("an empty parameter list is not a parameter list", async () => {
    const { provider } = await connectedProvider(
      healthyReplies({ [SELECT]: result(declare(["id", INT]), [{ id: 1 }]) }),
    );

    expect((await provider.query(SELECT, [])).rowCount).toBe(1);
  });

  test("no cancellation method is published, because the engine has no cancellation", async () => {
    // The protocol has no cancel frame, CQL has no KILL, and the driver's Client
    // publishes no cancel/abort method at all (checked against its own API surface).
    // Both routes detect support by the method's PRESENCE (`"cancelQuery" in
    // provider`), so declining to define it is what makes /api/db/cancel answer
    // "cancellation is not supported for this database type" instead of reporting a
    // cancellation that silently failed. `search/index.ts` declined it the same way.
    const { provider } = await connectedProvider();

    expect("cancelQuery" in provider).toBe(false);
  });
});

// ============================================================================
// prepareQuery: the row bound
// ============================================================================

describe("prepareQuery", () => {
  const provider = new CassandraProvider(makeConnection());

  test("a plain SELECT gets the bound the shared limiter builds", () => {
    const prepared = provider.prepareQuery("SELECT * FROM probe.customers", { limit: 500 });

    expect(prepared.query).toBe("SELECT * FROM probe.customers LIMIT 500");
    expect(prepared.wasLimited).toBe(true);
  });

  test("a statement carrying its own LIMIT is left exactly as written", () => {
    // Measured: a SECOND `LIMIT` is a syntax error ("line 1:38 mismatched input
    // 'LIMIT' expecting EOF"), so the shared limiter's leave-it-alone rule is also
    // the only correct one here.
    const prepared = provider.prepareQuery("SELECT * FROM probe.customers LIMIT 5", { limit: 500 });

    expect(prepared.query).toBe("SELECT * FROM probe.customers LIMIT 5");
    expect(prepared.wasLimited).toBe(false);
  });

  test("a second page is refused, because CQL has no OFFSET", () => {
    // `… LIMIT 5 OFFSET 5` is "line 1:45 mismatched input 'OFFSET' expecting EOF",
    // and `OFFSET` alone is refused too. Dropping the offset and sending `LIMIT n`
    // would return page ONE while the editor appends it to what it already shows -
    // duplicate rows presented as new ones, which is a wrong ANSWER.
    expect(() => provider.prepareQuery("SELECT * FROM probe.customers", { limit: 50, offset: 50 })).toThrow(QueryError);
  });

  test("a first page is not a second one, so no offset means no refusal", () => {
    expect(provider.prepareQuery("SELECT * FROM probe.customers", { limit: 50, offset: 0 }).wasLimited).toBe(true);
  });

  test("a statement the limiter left alone is never refused for its offset", () => {
    // Nothing was rewritten, so there is nothing to refuse: the user's own bound is
    // what runs, exactly as on every other provider here.
    const prepared = provider.prepareQuery("INSERT INTO probe.customers (id) VALUES (1)", { limit: 50, offset: 50 });

    expect(prepared.wasLimited).toBe(false);
  });

  test("the bound goes BEFORE a trailing ALLOW FILTERING, where CQL accepts it", () => {
    // Measured both ways: `… LIMIT 3 ALLOW FILTERING` returns rows, while
    // `… ALLOW FILTERING LIMIT 3` is "line 1:60 mismatched input 'LIMIT' expecting
    // EOF". The shared limiter appends, so the two clauses are transposed.
    const prepared = provider.prepareQuery("SELECT * FROM probe.orders WHERE amount > 5 ALLOW FILTERING", {
      limit: 500,
    });

    expect(prepared.query).toBe("SELECT * FROM probe.orders WHERE amount > 5 LIMIT 500 ALLOW FILTERING");
    expect(prepared.wasLimited).toBe(true);
  });

  test("the transposition keeps the writer's own spacing", () => {
    const prepared = provider.prepareQuery("SELECT * FROM probe.orders WHERE amount > 5 ALLOW  FILTERING", {
      limit: 10,
    });

    expect(prepared.query).toBe("SELECT * FROM probe.orders WHERE amount > 5 LIMIT 10 ALLOW  FILTERING");
  });

  test("a statement ending in a `--` comment is not rewritten", () => {
    // The shared limiter inserts the clause BEFORE trailing trivia and re-attaches
    // the comment (#280), which on every other engine is right. Here it is not: the
    // trim drops the newline that CLOSED the comment, and measured,
    // `SELECT * FROM probe.customers LIMIT 3 -- note` with nothing after it is "line
    // 1:45 mismatched character '<EOF>' expecting set null". So a VALID statement
    // would become a syntax error. It runs unbounded instead, and says so.
    const prepared = provider.prepareQuery("SELECT * FROM probe.customers -- note\n", { limit: 500 });

    expect(prepared.query).toBe("SELECT * FROM probe.customers -- note\n");
    expect(prepared.wasLimited).toBe(false);
  });

  test("a statement ending in a `//` comment is not rewritten either", () => {
    // CQL has a THIRD line-comment form the shared readers know nothing about, so
    // the limiter appends the clause INSIDE the comment: measured,
    // `SELECT * FROM probe.customers // note LIMIT 3` is a syntax error.
    const prepared = provider.prepareQuery("SELECT * FROM probe.customers // note\n", { limit: 500 });

    expect(prepared.query).toBe("SELECT * FROM probe.customers // note\n");
    expect(prepared.wasLimited).toBe(false);
  });

  test("a `//` inside a string literal is not a comment", () => {
    const prepared = provider.prepareQuery("SELECT * FROM probe.customers WHERE name = 'http://x'", { limit: 5 });

    expect(prepared.query).toBe("SELECT * FROM probe.customers WHERE name = 'http://x' LIMIT 5");
  });

  test("a comment in the MIDDLE of a statement is left to be a comment", () => {
    const prepared = provider.prepareQuery("SELECT id // pick\nFROM probe.customers", { limit: 5 });

    expect(prepared.query).toBe("SELECT id // pick\nFROM probe.customers LIMIT 5");
    expect(prepared.wasLimited).toBe(true);
  });

  test("a trailing block comment is fine, because CQL closes it", () => {
    const prepared = provider.prepareQuery("SELECT * FROM probe.customers /* note */", { limit: 5 });

    expect(prepared.query).toContain("LIMIT 5");
    expect(prepared.wasLimited).toBe(true);
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("getSchema", () => {
  test("tables, their columns in a stated order, and their indexes", async () => {
    const { provider } = await connectedProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual([
      "customers",
      "events",
      "orders",
      "type_matrix",
      "orders_by_country",
    ]);

    const customers = schema.find((table) => table.name === "customers")!;
    // Partition key first, then clustering, then everything else alphabetically -
    // NOT declaration order, which is unrecoverable: `position` is -1 for every
    // regular column and the server returns them alphabetically.
    expect(customers.columns.map((column) => column.name)).toEqual(["id", "country", "name"]);
    expect(customers.columns[0]).toEqual({ name: "id", type: "int", nullable: false, isPrimary: true });
    expect(customers.columns[1]).toEqual({ name: "country", type: "text", nullable: true, isPrimary: false });
    expect(customers.indexes).toEqual([{ name: "customers_country_idx", columns: ["country"], unique: false }]);
    expect(customers.foreignKeys).toEqual([]);
  });

  test("a clustering column is part of the primary key and comes after the partition key", async () => {
    const { provider } = await connectedProvider();

    const events = (await provider.getSchema()).find((table) => table.name === "events")!;

    expect(events.columns.map((column) => column.name)).toEqual(["pk", "ck", "v"]);
    expect(events.columns.map((column) => column.isPrimary)).toEqual([true, true, false]);
  });

  test("no row count and no size are reported, because neither can be honest", async () => {
    const { provider } = await connectedProvider();

    for (const table of await provider.getSchema()) {
      expect(table.rowCount).toBeUndefined();
      expect(table.size).toBeUndefined();
    }
  });

  test("the declared CQL type is carried verbatim, vector dimension included", async () => {
    const { provider } = await connectedProvider();

    const matrix = (await provider.getSchema()).find((table) => table.name === "type_matrix")!;

    expect(matrix.columns.find((column) => column.name === "c_vector")!.type).toBe("vector<float, 3>");
  });

  test("a materialized view is listed as a table, because that is how it reads", async () => {
    // Measured on the instance where views are enabled: a view is NOT in
    // system_schema.tables, its columns ARE in system_schema.columns keyed by the
    // view name, `SELECT * FROM probe.orders_by_country` returns rows, and an
    // `INSERT` into it is refused with "Cannot directly modify a materialized view".
    const { provider } = await connectedProvider();

    const view = (await provider.getSchema()).find((table) => table.name === "orders_by_country")!;

    expect(view.columns.map((column) => column.name)).toEqual(["country", "id", "amount", "customer_id"]);
  });

  test("a stock 5.0 install lists no views at all, and that is not an error", async () => {
    // Materialized views are DISABLED by default in 5.0: `CREATE MATERIALIZED VIEW`
    // answers "Materialized views are disabled. Enable in cassandra.yaml to use."
    const { provider } = await connectedProvider(healthyReplies({ [cassandraViewListCql(KEYSPACE)]: EMPTY_VIEW_LIST }));

    expect((await provider.getSchema()).map((table) => table.name)).toEqual([
      "customers",
      "events",
      "orders",
      "type_matrix",
    ]);
  });

  test("a connection with no keyspace has no tree, and says which field to fill", async () => {
    const { provider } = await connectedProvider(healthyReplies(), { database: undefined });

    await expect(provider.getSchema()).rejects.toThrow(DatabaseConfigError);
    await expect(provider.getSchema()).rejects.toThrow(/keyspace/i);
  });

  test("getTables reads the same list", async () => {
    const { provider } = await connectedProvider();

    expect(await provider.getTables()).toContain("orders");
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("getOverview", () => {
  test("what the cluster is, and how long this node has been up", async () => {
    const { provider } = await connectedProvider();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("Apache Cassandra 5.0.9");
    // The gossip generation IS the node's start time in epoch seconds, and the
    // server's own clock is what it is subtracted from - never this process's.
    expect(overview.startTime).toEqual(new Date(1787249337 * 1000));
    expect(overview.uptime).toBe("1.89h");
    expect(overview.activeConnections).toBe(2);
    expect(overview.tableCount).toBe(4);
    expect(overview.indexCount).toBe(2);
  });

  test("no database size is claimed, because the server publishes only whole mebibytes", async () => {
    const { provider } = await connectedProvider();

    const overview = await provider.getOverview();

    expect(overview.databaseSize).toBe(CASSANDRA_SIZE_UNAVAILABLE);
    // The FIELD IS ABSENT rather than zero. A zero is a measurement: the Storage tab
    // read `databaseSizeBytes ?? 0` and rendered "0 B" for the tables, "0 B" for the
    // indexes and a 0.0% breakdown bar - a fabricated size for a provider whose whole
    // reason for existing is refusing to fabricate one (verified in the browser
    // against the live 5.0.9 node).
    expect(overview.databaseSizeBytes).toBeUndefined();
    expect("databaseSizeBytes" in overview).toBe(false);
  });

  test("no connection ceiling is invented", async () => {
    // Cassandra publishes no maximum-connections figure a statement can read, and a
    // made-up ceiling would render a usage percentage of nothing.
    const { provider } = await connectedProvider();

    expect((await provider.getOverview()).maxConnections).toBe(0);
  });

  test("a restricted role loses the connection count and keeps the rest", async () => {
    // Measured with a least-privilege role: `system_views.clients` answers 8448
    // while `system_schema` answers every table in every keyspace. A denied
    // monitoring surface must not break a working connection.
    const denied = responseError(
      8448,
      "User lowpriv has no SELECT permission on <table system_views.clients> or any of its parents",
    );
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_CLIENT_COUNT_CQL]: denied }));

    const overview = await provider.getOverview();

    expect(overview.activeConnections).toBe(0);
    expect(overview.tableCount).toBe(4);
  });

  test("a role refused the CACHE view keeps the overview it can read", async () => {
    // Measured with a least-privilege role: `system_views.caches` and
    // `system_views.queries` answer 8448 exactly as `clients` does, while
    // `system.local`, `system.peers_v2` and all of `system_schema` are readable. So the
    // identity read is the one surface that does NOT degrade - the driver's own control
    // connection reads `system.local` before this provider can send anything - and the
    // three virtual-table reads are the ones that do.
    const denied = responseError(
      8448,
      "User lowpriv has no SELECT permission on <table system_views.caches> or any of its parents",
    );
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_CACHE_CQL]: denied }));

    const overview = await provider.getOverview();

    expect(overview.version).toBe("Apache Cassandra 5.0.9");
    expect(await provider.getPerformanceMetrics()).toEqual({});
  });

  test("a surface that fails for any other reason still fails", async () => {
    // An `invalid` is also what a typo in this provider's own CQL would produce, and
    // an empty panel that hides that hides it forever.
    const broken = responseError(8704, "unconfigured table clients");
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_CLIENT_COUNT_CQL]: broken }));

    await expect(provider.getOverview()).rejects.toThrow(QueryError);
  });
});

describe("getPerformanceMetrics", () => {
  test("the key cache's own hit ratio, as a percentage", async () => {
    const { provider } = await connectedProvider();

    expect(await provider.getPerformanceMetrics()).toEqual({ cacheHitRatio: 83.05 });
  });

  test("a cache nobody has read reports no ratio rather than a zero", async () => {
    // Measured: `hit_ratio` is NULL until the cache has been asked for something. A
    // zero would score as a critical cache fault on a cluster that is merely idle.
    const cold = result(declare(["name", TEXT], ["hit_ratio", DOUBLE]), [{ name: "keys", hit_ratio: null }]);
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_CACHE_CQL]: cold }));

    expect(await provider.getPerformanceMetrics()).toEqual({});
  });

  test("a restricted role gets an empty panel rather than a broken connection", async () => {
    const denied = responseError(
      8448,
      "User lowpriv has no SELECT permission on <table system_views.caches> or any of its parents",
    );
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_CACHE_CQL]: denied }));

    expect(await provider.getPerformanceMetrics()).toEqual({});
  });
});

describe("getSlowQueries", () => {
  test("empty, and nothing is asked of the server", async () => {
    // There is no slow-query log to read: `system_views.system_logs` exists and
    // returns 0 rows on this image, and it is a log tail rather than an aggregate of
    // finished statements. Sending a statement to discover that would be noise.
    const { provider, session } = await connectedProvider();
    session.asked.length = 0;

    expect(await provider.getSlowQueries()).toEqual([]);
    expect(session.asked).toEqual([]);
  });
});

describe("getActiveSessions", () => {
  test("the statements running right now, with the duration the server measured", async () => {
    const { provider } = await connectedProvider();

    const sessions = await provider.getActiveSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe("Native-Transport-Requests-1");
    expect(sessions[0].query).toContain("SELECT * FROM system_views.queries");
    expect(sessions[0].durationMs).toBe(1.118);
    expect(sessions[0].state).toBe("running");
  });

  test("no user and no keyspace are invented, because the row carries neither", async () => {
    // `system_views.queries` publishes a thread, a task and two microsecond
    // readings. The connected role is NOT borrowed for the row: it would credit this
    // connection with a statement another client is running.
    const { provider } = await connectedProvider();

    const [session] = await provider.getActiveSessions();

    expect(session.user).toBe(CASSANDRA_UNKNOWN_TEXT);
    expect(session.database).toBe(CASSANDRA_UNKNOWN_TEXT);
  });

  test("a restricted role gets an empty list", async () => {
    const denied = responseError(
      8448,
      "User lowpriv has no SELECT permission on <table system_views.queries> or any of its parents",
    );
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_RUNNING_QUERY_CQL]: denied }));

    expect(await provider.getActiveSessions()).toEqual([]);
  });

  test("the caller's limit bounds the list", async () => {
    // Bounded against a THREE-row reply, because the one-row fixture cannot tell a
    // bound from its absence: every limit above zero returns that single row, so an
    // assertion made on it holds whatever the guard does.
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_RUNNING_QUERY_CQL]: MANY_RUNNING }));

    expect(await provider.getActiveSessions({ limit: 2 })).toHaveLength(2);
    expect(await provider.getActiveSessions()).toHaveLength(3);
  });

  test("a limit of zero is a limit, not a missing one", async () => {
    // Three SQL siblings were read to settle what zero means, and all three honour it:
    // PostgreSQL passes it to `LIMIT $2`, MSSQL to `SELECT TOP`, Oracle to
    // `ROWNUM <= 0` - each answering no rows. Substituting the default here would make
    // this the one engine where asking for none returns fifty.
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_RUNNING_QUERY_CQL]: MANY_RUNNING }));

    expect(await provider.getActiveSessions({ limit: 0 })).toEqual([]);
  });

  test("a negative limit falls back to the default, because it is not an amount", async () => {
    // The guard the three SQL siblings do NOT have: they would hand a negative straight
    // to the server. Nothing asks for it, and keeping it costs one comparison.
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_RUNNING_QUERY_CQL]: MANY_RUNNING }));

    expect(await provider.getActiveSessions({ limit: -1 })).toHaveLength(3);
  });
});

describe("the panels that report nothing rather than something wrong", () => {
  test("table statistics are empty: there is no honest row count and no honest size", async () => {
    // `size_estimates` counts PARTITIONS from flushed SSTables and was measured at
    // 143 for a 500-row clustered table; `disk_usage` reported 1 MiB for 19,476
    // bytes. Both are numbers that would look exactly like right ones on screen.
    const { provider, session } = await connectedProvider();
    session.asked.length = 0;

    expect(await provider.getTableStats()).toEqual([]);
    expect(session.asked).toEqual([]);
  });

  test("index statistics are empty: an index has no size and no scan counter here", async () => {
    const { provider } = await connectedProvider();

    expect(await provider.getIndexStats()).toEqual([]);
  });

  test("storage statistics are empty for the same reason as the size", async () => {
    const { provider } = await connectedProvider();

    expect(await provider.getStorageStats()).toEqual([]);
  });
});

describe("getHealth", () => {
  test("the connection count, the sessions, and no size", async () => {
    const { provider } = await connectedProvider();

    const health = await provider.getHealth();

    expect(health.activeConnections).toBe(2);
    expect(health.databaseSize).toBe(CASSANDRA_SIZE_UNAVAILABLE);
    expect(health.cacheHitRatio).toBe("83.05%");
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toHaveLength(1);
  });

  test("a cluster with no cache reading reports none", async () => {
    const cold = result(declare(["name", TEXT], ["hit_ratio", DOUBLE]), [{ name: "keys", hit_ratio: null }]);
    const { provider } = await connectedProvider(healthyReplies({ [CASSANDRA_CACHE_CQL]: cold }));

    expect((await provider.getHealth()).cacheHitRatio).toBe(CASSANDRA_SIZE_UNAVAILABLE);
  });
});

describe("getMonitoringData", () => {
  test("the orchestrated read carries every panel the engine can fill", async () => {
    const { provider } = await connectedProvider();

    const data = await provider.getMonitoringData({ includeTables: true, includeIndexes: true, includeStorage: true });

    expect(data.overview.version).toBe("Apache Cassandra 5.0.9");
    expect(data.performance.cacheHitRatio).toBe(83.05);
    expect(data.tables).toEqual([]);
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("runMaintenance", () => {
  test.each(["vacuum", "analyze", "reindex", "kill", "optimize", "check"] as const)(
    "%s is refused with the reason, not mapped onto the nearest statement",
    async (operation) => {
      const { provider } = await connectedProvider();

      await expect(provider.runMaintenance(operation)).rejects.toThrow(QueryError);
      await expect(provider.runMaintenance(operation)).rejects.toThrow(/nodetool/);
    },
  );
});

// ============================================================================
// prepareQuery: paging is refused by STATEMENT KIND, not by who added the bound
// ============================================================================

describe("prepareQuery offsets on an already-bounded SELECT", () => {
  const provider = new CassandraProvider(makeConnection());

  test("a SELECT carrying its own LIMIT is refused a second page too", () => {
    // The refusal has to be about the statement KIND, not about whether the shared
    // limiter happened to be the one that added the bound. Measured again on the live
    // node: `SELECT id, name FROM probe.customers LIMIT 5 OFFSET 5` is "line 1:45
    // mismatched input 'OFFSET' expecting EOF", so no page after the first exists for
    // this statement either. Returning page one instead makes the editor append rows
    // it already shows, and the user cannot tell them from new ones.
    expect(() =>
      provider.prepareQuery("SELECT id, name FROM probe.customers LIMIT 5", { limit: 5, offset: 5 }),
    ).toThrow(QueryError);
  });

  test("a SELECT ending in a line comment is refused a second page as well", () => {
    // This shape runs UNBOUNDED on purpose (the trim would break the comment), and it
    // is still a SELECT that cannot be paged - pinned so the refusal keeps being read
    // from the statement kind rather than from what the rewrite decided.
    expect(() => provider.prepareQuery("SELECT * FROM probe.customers -- note\n", { limit: 5, offset: 5 })).toThrow(
      QueryError,
    );
  });

  test("a non-SELECT statement is still never refused for its offset", () => {
    // Nothing is paged here: the offset the route carries is meaningless for a write,
    // and refusing it would break a statement CQL accepts.
    const prepared = provider.prepareQuery("INSERT INTO probe.customers (id) VALUES (1)", { limit: 50, offset: 50 });

    expect(prepared.wasLimited).toBe(false);
    expect(prepared.query).toBe("INSERT INTO probe.customers (id) VALUES (1)");
  });
});

// ============================================================================
// connect: the transport a failed probe opened
// ============================================================================

describe("connect closes what it opened", () => {
  /** A transport whose pool opens, then fails the identity probe. */
  function probeFailingTransport(closed: { count: number }) {
    return {
      kind: "native" as const,
      connect: async () => {},
      execute: async () => {
        throw new CassandraTransportError("Keyspace 'probe' does not exist", "invalid", 8704);
      },
      close: async () => {
        closed.count += 1;
      },
    };
  }

  test("a failed identity probe closes the pool the connect already opened", async () => {
    // `connect()` opens driver sockets and timers before the probe runs, so a probe
    // that fails leaks them unless this path closes the transport - and the connection
    // dialog retries, so the leak is per attempt. Druid and Couchbase close first,
    // then map and rethrow.
    const closed = { count: 0 };
    const provider = new CassandraProvider(makeConnection(), {}, probeFailingTransport(closed));

    await expect(provider.connect()).rejects.toThrow(QueryError);
    expect(closed.count).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });

  test("a connect that succeeds keeps its transport open", async () => {
    const closed = { count: 0 };
    const provider = new CassandraProvider(
      makeConnection(),
      {},
      {
        kind: "native" as const,
        connect: async () => {},
        execute: async () => ({ rows: [], fieldNames: null, columnTypes: null, pageState: null }),
        close: async () => {
          closed.count += 1;
        },
      },
    );

    await provider.connect();

    expect(provider.isConnected()).toBe(true);
    expect(closed.count).toBe(0);
  });
});
