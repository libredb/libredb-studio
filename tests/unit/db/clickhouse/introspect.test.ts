/**
 * ClickHouse schema introspection (issue #264, design spec section 3.6)
 *
 * Driven entirely through a hand-built ClickHouseTransport - the point of the
 * seam: no fetch mocking, no `mock.module()` (process-wide in bun) and no
 * server. Every row shape below was captured from a live ClickHouse
 * 26.7.1.1315 instance, so the fake speaks exactly what the server speaks,
 * including the two encodings that break naive parsing: a `UInt64` arrives as a
 * decimal STRING (spec 2.1 quoting) while a `UInt8` stays a NUMBER, and a
 * `Nullable(UInt64)` arrives as `null` for anything that is not a MergeTree.
 */
import { describe, expect, test } from "bun:test";
import {
  CLICKHOUSE_CATALOG_TIMEOUT_SECONDS,
  CLICKHOUSE_PRIMARY_INDEX_NAME,
  CLICKHOUSE_SORTING_INDEX_NAME,
  CLICKHOUSE_SYSTEM_DATABASES,
  getSchema,
  getSchemaList,
  getSchemaRelations,
} from "@/lib/db/providers/sql/clickhouse/introspect";
import {
  CLICKHOUSE_ERROR_CODES,
  type ClickHouseQueryOptions,
  type ClickHouseQueryResult,
  type ClickHouseRow,
  type ClickHouseTransport,
  ClickHouseTransportError,
} from "@/lib/db/providers/sql/clickhouse/transport";

// ============================================================================
// Fake transport
// ============================================================================

/** Which system table a recorded statement reads. */
type Surface = "tables" | "columns" | "indices";

interface RecordedCall {
  sql: string;
  opts: ClickHouseQueryOptions | undefined;
}

interface FakeOptions {
  tables?: ClickHouseRow[];
  columns?: ClickHouseRow[];
  indices?: ClickHouseRow[];
  /** Raised instead of returning rows, per surface. */
  failures?: Partial<Record<Surface, Error>>;
}

function surfaceOf(sql: string): Surface {
  if (sql.includes("system.data_skipping_indices")) return "indices";
  if (sql.includes("system.columns")) return "columns";
  return "tables";
}

function createTransport(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  const transport: ClickHouseTransport = {
    kind: "http",
    query: async (sql: string, opts?: ClickHouseQueryOptions): Promise<ClickHouseQueryResult> => {
      calls.push({ sql, opts });
      const surface = surfaceOf(sql);
      const failure = options.failures?.[surface];
      if (failure) throw failure;
      return {
        rows: options[surface] ?? [],
        fieldNames: null,
        columnTypes: null,
        executionTimeMs: 1,
        mutationCount: 0,
        rawText: null,
      };
    },
    close: () => Promise.resolve(),
  };

  return { transport, calls };
}

function sqlFor(calls: RecordedCall[], surface: Surface): string {
  const call = calls.find((entry) => surfaceOf(entry.sql) === surface);
  if (!call) throw new Error(`no ${surface} statement was sent`);
  return call.sql;
}

function accessDenied(): ClickHouseTransportError {
  return new ClickHouseTransportError(
    "libredb: Not enough privileges. To execute this query, it's necessary to have the grant SELECT " +
      "for at least one column on system.data_skipping_indices. (ACCESS_DENIED)",
    CLICKHOUSE_ERROR_CODES.ACCESS_DENIED,
    "ACCESS_DENIED",
  );
}

// ============================================================================
// Row builders (shapes captured from ClickHouse 26.7.1.1315)
// ============================================================================

/**
 * A `system.tables` row. `total_rows`/`total_bytes` default to the quoted-string
 * form a MergeTree reports; pass null for the view / non-MergeTree case.
 */
function tableRow(overrides: Partial<ClickHouseRow> = {}): ClickHouseRow {
  return {
    database: "demo",
    name: "users",
    total_rows: "3",
    total_bytes: "1346",
    sorting_key: "id",
    primary_key: "id",
    ...overrides,
  };
}

function columnRow(overrides: Partial<ClickHouseRow> = {}): ClickHouseRow {
  return {
    database: "demo",
    table: "users",
    name: "id",
    type: "UInt32",
    is_in_primary_key: 0,
    default_kind: "",
    default_expression: "",
    ...overrides,
  };
}

function indexRow(overrides: Partial<ClickHouseRow> = {}): ClickHouseRow {
  return {
    database: "demo",
    table: "orders",
    name: "idx_status",
    expr: "status",
    ...overrides,
  };
}

/** The pinned database of the live probe connection. */
const PINNED = "demo";

// ============================================================================
// The system-database filter
// ============================================================================

describe("the system-database filter", () => {
  test.each<[Surface]>([
    ["tables"],
    ["columns"],
    ["indices"],
  ])("excludes every system database from the %s read", async (surface) => {
    const { transport, calls } = createTransport();

    await getSchema(transport, PINNED);
    const sql = sqlFor(calls, surface);

    expect(sql).toContain("NOT IN (");
    for (const name of CLICKHOUSE_SYSTEM_DATABASES) expect(sql).toContain(`'${name}'`);
  });

  test("names exactly the three system databases the live server reports", () => {
    expect([...CLICKHOUSE_SYSTEM_DATABASES]).toEqual(["system", "information_schema", "INFORMATION_SCHEMA"]);
  });

  // `default` is a real, user-writable database - it is where a connection with
  // no explicit database lands - so excluding it with the system catalogs would
  // hide the tables of the commonest single-database setup.
  test("keeps the default database", async () => {
    const { transport, calls } = createTransport({ tables: [tableRow({ database: "default", name: "events" })] });

    const schema = await getSchema(transport, PINNED);

    expect(sqlFor(calls, "tables")).not.toContain("'default'");
    expect(schema.map((table) => table.name)).toEqual(["default.events"]);
  });

  // Live-verified: system.data_skipping_indices carries ~40 rows for the system
  // databases alone, which swamp a user's own handful without this predicate.
  test("filters the data-skipping-index read by database, not just the table list", async () => {
    const { transport, calls } = createTransport();

    await getSchemaRelations(transport, PINNED);

    expect(sqlFor(calls, "indices")).toContain("system.data_skipping_indices");
    expect(sqlFor(calls, "indices")).toContain("NOT IN (");
  });

  // A stuck replica or a cluster with thousands of tables must not leave the
  // schema tree spinning forever.
  test("bounds every catalog read with a server-side deadline", async () => {
    const { transport, calls } = createTransport();

    await getSchema(transport, PINNED);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.opts?.settings).toEqual({ max_execution_time: CLICKHOUSE_CATALOG_TIMEOUT_SECONDS });
    }
  });
});

// ============================================================================
// Row counts and sizes
// ============================================================================

describe("row counts and sizes", () => {
  // The correctness requirement of this file. total_rows/total_bytes are
  // Nullable(UInt64) and live-verified null for a View and for every
  // non-MergeTree engine. Coercing that to 0 would print "0 rows" for a view
  // that returns thousands - a number the server never said.
  test("reports an unknown row count and size as unknown, never as zero", async () => {
    const { transport } = createTransport({
      tables: [
        tableRow({ name: "daily_events", total_rows: null, total_bytes: null, sorting_key: "", primary_key: "" }),
      ],
    });

    const [view] = await getSchema(transport, PINNED);

    expect(view.rowCount).toBeUndefined();
    expect(view.size).toBeUndefined();
  });

  test("keeps a genuine zero distinct from unknown", async () => {
    const { transport } = createTransport({ tables: [tableRow({ total_rows: "0", total_bytes: "0" })] });

    const [empty] = await getSchema(transport, PINNED);

    expect(empty.rowCount).toBe(0);
    expect(empty.size).toBe("0 B");
  });

  // Spec 2.1: with 64-bit quoting on - which the transport always sends, so
  // JSON.parse cannot round a UInt64 - a count arrives as a decimal string.
  test("parses the quoted-string form a UInt64 arrives in", async () => {
    const { transport } = createTransport({ tables: [tableRow({ total_rows: "5", total_bytes: "2613" })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.rowCount).toBe(5);
    expect(table.size).toBe("2.55 KB");
  });

  // The same read has to keep working if a transport ever stops quoting, so the
  // unquoted number is accepted too.
  test("accepts an unquoted count", async () => {
    const { transport } = createTransport({ tables: [tableRow({ total_rows: 3, total_bytes: 1346 })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.rowCount).toBe(3);
    expect(table.size).toBe("1.31 KB");
  });

  test.each<[string, unknown]>([
    ["an empty string", ""],
    ["a non-numeric string", "not-a-number"],
    ["a value of another type", { nested: true }],
  ])("treats %s as unknown rather than zero", async (_label, value) => {
    const { transport } = createTransport({ tables: [tableRow({ total_rows: value, total_bytes: value })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.rowCount).toBeUndefined();
    expect(table.size).toBeUndefined();
  });
});

// ============================================================================
// Columns
// ============================================================================

describe("columns", () => {
  // Spec 1.7: the declared type is precise and is what a ClickHouse user expects
  // to read. Mapping it onto a generic family would throw away the wrapper -
  // and the wrapper is what says nullable, low-cardinality or parameterised.
  test.each([
    "Int32",
    "Nullable(String)",
    "Array(UInt8)",
    "Map(String,String)",
    "Enum8('x' = 1, 'y' = 2)",
    "LowCardinality(String)",
    "Decimal(10, 3)",
    "DateTime64(3)",
    "UUID",
  ])("carries the declared type %s verbatim", async (type) => {
    const { transport } = createTransport({ tables: [tableRow()], columns: [columnRow({ type })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns[0].type).toBe(type);
  });

  test.each<[string, boolean]>([
    ["Nullable(String)", true],
    ["Nullable(Int32)", true],
    ["String", false],
    ["UInt32", false],
    // Live-verified: the one wrapper ClickHouse puts OUTSIDE Nullable. The
    // column really does accept NULL, so a bare startsWith would get it wrong.
    ["LowCardinality(Nullable(String))", true],
    // Live-verified counter-cases: here Nullable qualifies the ELEMENT type, not
    // the column, so a substring search would get all three wrong.
    ["Array(Nullable(String))", false],
    ["Map(String, Nullable(String))", false],
    ["SimpleAggregateFunction(any, Nullable(UInt64))", false],
  ])("derives nullability from the Nullable wrapper of %s", async (type, nullable) => {
    const { transport } = createTransport({ tables: [tableRow()], columns: [columnRow({ type })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns[0].nullable).toBe(nullable);
  });

  // is_in_primary_key is a UInt8, so it stays an unquoted number even with
  // 64-bit quoting on. It is the authority on membership: the sorting key can
  // extend past the primary key, and those extra columns are not primary.
  test("marks a column primary from is_in_primary_key", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "id, email", primary_key: "id" })],
      columns: [
        columnRow({ name: "id", is_in_primary_key: 1 }),
        columnRow({ name: "email", type: "String", is_in_primary_key: 0 }),
      ],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns.map((column) => [column.name, column.isPrimary])).toEqual([
      ["id", true],
      ["email", false],
    ]);
  });

  test("preserves the order the catalog returned, and asks for declaration order", async () => {
    const { transport, calls } = createTransport({
      tables: [tableRow()],
      columns: [
        columnRow({ name: "id" }),
        columnRow({ name: "email", type: "String" }),
        columnRow({ name: "country", type: "LowCardinality(String)" }),
      ],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns.map((column) => column.name)).toEqual(["id", "email", "country"]);
    expect(sqlFor(calls, "columns")).toContain("ORDER BY database, table, position");
  });

  test("groups columns onto the table they belong to and leaves an unmatched table empty", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ name: "users" }), tableRow({ name: "orders" }), tableRow({ name: "lonely" })],
      columns: [
        columnRow({ table: "users", name: "id" }),
        columnRow({ table: "orders", name: "order_id" }),
        columnRow({ table: "orders", name: "amount", type: "Decimal(12, 2)" }),
      ],
    });

    const schema = await getSchema(transport, PINNED);

    expect(schema.map((table) => table.columns.map((column) => column.name))).toEqual([
      ["id"],
      ["order_id", "amount"],
      [],
    ]);
  });

  // Two databases may each hold a table of the same name, and a same-named
  // column in both must not be merged onto one of them.
  test("keeps same-named tables in different databases apart", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ database: "demo", name: "users" }), tableRow({ database: "staging", name: "users" })],
      columns: [
        columnRow({ database: "demo", table: "users", name: "id" }),
        columnRow({ database: "staging", table: "users", name: "legacy_id" }),
      ],
    });

    const schema = await getSchema(transport, PINNED);

    expect(schema.map((table) => [table.name, table.columns.map((column) => column.name)])).toEqual([
      ["users", ["id"]],
      ["staging.users", ["legacy_id"]],
    ]);
  });

  // Live-verified: `CREATE DATABASE `a.b`` is accepted and system.databases
  // reports the name verbatim, so joining database to table with a dot really
  // does collide - "a.b" + "c" and "a" + "b.c" produce the same string, and the
  // two tables would swap columns.
  test("keeps a dotted database name from colliding with a dotted table name", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ database: "a.b", name: "c" }), tableRow({ database: "a", name: "b.c" })],
      columns: [
        columnRow({ database: "a.b", table: "c", name: "from_dotted_database" }),
        columnRow({ database: "a", table: "b.c", name: "from_dotted_table" }),
      ],
    });

    const schema = await getSchema(transport, PINNED);

    expect(schema.map((table) => table.columns.map((column) => column.name))).toEqual([
      ["from_dotted_database"],
      ["from_dotted_table"],
    ]);
  });

  test.each<[string, string, string | undefined]>([
    ["", "", undefined],
    ["DEFAULT", "'x'", "'x'"],
    // A MATERIALIZED or ALIAS column is computed, not defaulted. Showing the
    // bare expression would read as a value an INSERT could override.
    ["MATERIALIZED", "a * 2", "MATERIALIZED a * 2"],
    ["ALIAS", "a + 1", "ALIAS a + 1"],
  ])("renders a %s column default", async (kind, expression, expected) => {
    const { transport } = createTransport({
      tables: [tableRow()],
      columns: [columnRow({ default_kind: kind, default_expression: expression })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns[0].defaultValue).toBe(expected);
  });

  test("ignores a default kind that carries no expression", async () => {
    const { transport } = createTransport({
      tables: [tableRow()],
      columns: [columnRow({ default_kind: "DEFAULT", default_expression: "" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns[0].defaultValue).toBeUndefined();
  });

  test("skips a column row that names neither a table nor itself", async () => {
    const { transport } = createTransport({
      tables: [tableRow()],
      columns: [columnRow({ name: 7 }), columnRow({ table: null, name: "orphan" }), columnRow({ name: "id" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns.map((column) => column.name)).toEqual(["id"]);
  });

  test("falls back to an empty declared type when the catalog omits it", async () => {
    const { transport } = createTransport({ tables: [tableRow()], columns: [columnRow({ type: null })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns[0]).toEqual({ name: "id", type: "", nullable: false, isPrimary: false });
  });
});

// ============================================================================
// Indexes
// ============================================================================

describe("indexes", () => {
  // ClickHouse's primary key is a sparse index over the sort order, not a
  // constraint. Live-verified: three identical values were accepted into a
  // table declared PRIMARY KEY (a), so `unique` is false as a matter of fact.
  test("reports the primary key as a non-unique index", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "user_id, order_id", primary_key: "user_id, order_id" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([
      { name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: ["user_id", "order_id"], unique: false },
    ]);
  });

  // ORDER BY may extend PRIMARY KEY. The extra columns are genuinely part of the
  // on-disk sort order and drive query planning, so they are reported - but as a
  // separate entry, because they are not primary-key columns.
  test("adds the sorting key as its own index when it extends the primary key", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "a, b, cityHash64(c)", primary_key: "(a)" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([
      { name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: ["a"], unique: false },
      { name: CLICKHOUSE_SORTING_INDEX_NAME, columns: ["a", "b", "cityHash64(c)"], unique: false },
    ]);
  });

  // A backtick-quoted identifier may legally contain a comma or a parenthesis, and
  // splitting on those blindly reports one column as two - or, worse, an unbalanced
  // paren inside quotes corrupts the depth counter and swallows every later
  // top-level comma.
  test("keeps a quoted identifier containing a comma as one key column", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "`region,code`, id", primary_key: "`region,code`, id" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([
      { name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: ["`region,code`", "id"], unique: false },
    ]);
  });

  test("does not let an unbalanced parenthesis inside quotes swallow later commas", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "`a(b`, c", primary_key: "`a(b`, c" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(["`a(b`", "c"]);
  });

  test("treats a doubled quote as an escape rather than the end of the span", async () => {
    const key = "`a``b,c`, d";
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: key, primary_key: key })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(["`a``b,c`", "d"]);
  });

  test("treats a backslash as escaping the next character inside a literal", async () => {
    const key = "concat(a, 'x\\', y'), b";
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: key, primary_key: key })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(["concat(a, 'x\\', y')", "b"]);
  });

  // An unterminated span is malformed input that cannot be split sensibly; consuming
  // the rest is the reading that at least never reports a fragment as a column.
  test("treats an unterminated quote as running to the end", async () => {
    const key = "`a, b";
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: key, primary_key: key })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(["`a, b"]);
  });

  // The outer-paren unwrap runs the same scan, so a quoted paren must not fool it
  // into thinking the wrapper closes early.
  test("unwraps an outer paren list whose quoted identifier contains a parenthesis", async () => {
    const key = "(`a(b`, c)";
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: key, primary_key: key })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(["`a(b`", "c"]);
  });

  test("keeps a comma inside a string literal out of the split", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "concat(a, 'x, y'), b", primary_key: "concat(a, 'x, y'), b" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(["concat(a, 'x, y')", "b"]);
  });

  test("does not repeat the key when the sorting key and the primary key agree", async () => {
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: "id", primary_key: "id" })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes.map((index) => index.name)).toEqual([CLICKHOUSE_PRIMARY_INDEX_NAME]);
  });

  // Live-verified rendering: a table declared PRIMARY KEY tuple() ORDER BY x
  // reports an empty primary_key with a populated sorting_key.
  test("reports a sorting key that has no primary key at all", async () => {
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: "id", primary_key: "" })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([{ name: CLICKHOUSE_SORTING_INDEX_NAME, columns: ["id"], unique: false }]);
  });

  // Live-verified: ORDER BY tuple() and a View both report both keys as "".
  test("synthesizes nothing for a table with no key", async () => {
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: "", primary_key: "" })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([]);
  });

  // Live-verified rendering trap: a one-element key keeps its parentheses
  // ("(a)") while a multi-element one drops them ("a, b"). Taking the string
  // verbatim would name a column "(a)".
  test.each<[string, string[]]>([
    ["(a)", ["a"]],
    ["a, b", ["a", "b"]],
    ["  id  ", ["id"]],
    // Live-verified: a function call inside the key carries its own commas, so
    // splitting on every comma yields "cityHash64(c" and "c)".
    ["a, b, cityHash64(c, c)", ["a", "b", "cityHash64(c, c)"]],
    // Live-verified: a string literal inside the key carries commas too.
    ["a, concat(b, 'x, y')", ["a", "concat(b, 'x, y')"]],
    // Parentheses that do not wrap the whole expression are not a wrapper.
    ["(a), (b)", ["(a)", "(b)"]],
  ])("splits the key expression %p at top level only", async (primaryKey, columns) => {
    const { transport } = createTransport({ tables: [tableRow({ sorting_key: "", primary_key: primaryKey })] });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(columns);
  });

  test("reports a data-skipping index against the table that owns it", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ name: "orders", sorting_key: "", primary_key: "" }), tableRow({ name: "users" })],
      indices: [indexRow({ table: "orders", name: "idx_status", expr: "status" })],
    });

    const schema = await getSchema(transport, PINNED);

    expect(schema[0].indexes).toEqual([{ name: "idx_status", columns: ["status"], unique: false }]);
    expect(schema[1].indexes.map((index) => index.name)).toEqual([CLICKHOUSE_PRIMARY_INDEX_NAME]);
  });

  // Live-verified: an expression index renders parenthesised, and a multi-argument
  // function inside it makes a naive comma split produce two broken column names.
  test.each<[string, string[]]>([
    ["(lower(b))", ["lower(b)"]],
    ["(cityHash64(a, b))", ["cityHash64(a, b)"]],
    ["a, b", ["a", "b"]],
  ])("splits the data-skipping index expression %p", async (expr, columns) => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "", primary_key: "" })],
      indices: [indexRow({ table: "users", expr })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes[0].columns).toEqual(columns);
  });

  // A data-skipping index prunes granules; it enforces nothing. Nothing in a
  // ClickHouse schema is unique, so reporting one would be a fabricated
  // constraint the user could rely on.
  test("never reports a data-skipping index as unique", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "", primary_key: "" })],
      indices: [indexRow({ table: "users", name: "idx_email", expr: "email" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes.every((index) => index.unique === false)).toBe(true);
  });

  test("skips an index row that names neither a table nor itself", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "", primary_key: "" })],
      indices: [indexRow({ table: "users", name: null }), indexRow({ table: 9, name: "idx_orphan" })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([]);
  });

  test("treats an index row with no expression as covering no column", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ sorting_key: "", primary_key: "" })],
      indices: [indexRow({ table: "users", name: "idx_empty", expr: null })],
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([{ name: "idx_empty", columns: [], unique: false }]);
  });
});

// ============================================================================
// Foreign keys
// ============================================================================

describe("foreign keys", () => {
  // ClickHouse has no foreign keys: no engine, no table setting and no DDL
  // declares one. Empty here is a fact about the engine, not a load that failed
  // or was deferred, and the doc says so in the same words.
  test("are empty because ClickHouse has none", async () => {
    const { transport } = createTransport({ tables: [tableRow()], columns: [columnRow()] });

    const [fromSchema] = await getSchema(transport, PINNED);
    const [fromList] = await getSchemaList(transport, PINNED);
    const [fromRelations] = await getSchemaRelations(transport, PINNED);

    expect(fromSchema.foreignKeys).toEqual([]);
    expect(fromList.foreignKeys).toEqual([]);
    expect(fromRelations.foreignKeys).toEqual([]);
  });
});

// ============================================================================
// Table naming (spec 3.4)
// ============================================================================

describe("table naming", () => {
  const tables = [
    tableRow({ database: "demo", name: "users" }),
    tableRow({ database: "analytics", name: "events" }),
    tableRow({ database: "default", name: "probe" }),
  ];

  // A bare name resolves against the connection's pinned database, so
  // qualifying a table inside it would only add noise; a table outside it must
  // be qualified or the generated SQL would hit the wrong database.
  test("qualifies only the tables outside the pinned database", async () => {
    const { transport } = createTransport({ tables });

    const schema = await getSchema(transport, PINNED);

    expect(schema.map((table) => table.name)).toEqual(["users", "analytics.events", "default.probe"]);
  });

  test("applies the same rule when the pinned database is default", async () => {
    const { transport } = createTransport({ tables });

    const schema = await getSchema(transport, "default");

    expect(schema.map((table) => table.name)).toEqual(["demo.users", "analytics.events", "probe"]);
  });

  test.each<[string]>([["getSchemaList"], ["getSchemaRelations"]])("%s names tables the same way", async (entry) => {
    const { transport } = createTransport({ tables });

    const rows =
      entry === "getSchemaList" ? await getSchemaList(transport, PINNED) : await getSchemaRelations(transport, PINNED);

    expect(rows.map((row) => row.name)).toEqual(["users", "analytics.events", "default.probe"]);
  });

  test("skips a table row that does not name itself", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ name: null }), tableRow({ database: 4, name: "nowhere" }), tableRow({ name: "users" })],
    });

    const schema = await getSchema(transport, PINNED);

    expect(schema.map((table) => table.name)).toEqual(["users"]);
  });
});

// ============================================================================
// The split reads
// ============================================================================

describe("getSchemaList", () => {
  // Its contract is the fast structural read: indexes are getSchemaRelations()'s
  // job, so the tree renders without waiting on them.
  test("returns tables and columns but defers every index", async () => {
    const { transport, calls } = createTransport({
      tables: [tableRow()],
      columns: [columnRow({ name: "id", is_in_primary_key: 1 })],
      indices: [indexRow({ table: "users" })],
    });

    const [table] = await getSchemaList(transport, PINNED);

    expect(table.columns.map((column) => column.name)).toEqual(["id"]);
    expect(table.indexes).toEqual([]);
    expect(table.rowCount).toBe(3);
    expect(calls.map((call) => surfaceOf(call.sql)).sort()).toEqual(["columns", "tables"]);
  });
});

describe("getSchemaRelations", () => {
  test("returns an entry for every table, including one with no index", async () => {
    const { transport } = createTransport({
      tables: [tableRow({ name: "orders", sorting_key: "", primary_key: "" }), tableRow({ name: "users" })],
      indices: [indexRow({ table: "users", name: "idx_email", expr: "email" })],
    });

    const relations = await getSchemaRelations(transport, PINNED);

    expect(relations).toEqual([
      { name: "orders", foreignKeys: [], indexes: [] },
      {
        name: "users",
        foreignKeys: [],
        indexes: [
          { name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: ["id"], unique: false },
          { name: "idx_email", columns: ["email"], unique: false },
        ],
      },
    ]);
  });

  test("does not read the column catalog it has no use for", async () => {
    const { transport, calls } = createTransport({ tables: [tableRow()] });

    await getSchemaRelations(transport, PINNED);

    expect(calls.map((call) => surfaceOf(call.sql)).sort()).toEqual(["indices", "tables"]);
  });
});

// ============================================================================
// Degradation
// ============================================================================

describe("degradation", () => {
  // The live case that makes this mandatory: a user granted SELECT on one table
  // reads system.tables and system.columns fine (both are pre-filtered to what
  // is granted) but gets 500 / code 497 from system.data_skipping_indices, which
  // needs its own grant. Failing the read would cost that user the whole tree.
  test("keeps the tree when the data-skipping-index catalog is denied", async () => {
    const { transport } = createTransport({
      tables: [tableRow()],
      columns: [columnRow({ name: "id", is_in_primary_key: 1 })],
      failures: { indices: accessDenied() },
    });

    const [table] = await getSchema(transport, PINNED);

    expect(table.columns.map((column) => column.name)).toEqual(["id"]);
    expect(table.indexes).toEqual([{ name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: ["id"], unique: false }]);
  });

  test("keeps the table list when the column catalog is denied", async () => {
    const { transport } = createTransport({ tables: [tableRow()], failures: { columns: accessDenied() } });

    const schema = await getSchema(transport, PINNED);

    expect(schema.map((table) => table.name)).toEqual(["users"]);
    expect(schema[0].columns).toEqual([]);
  });

  test("degrades to an empty tree when the table catalog itself is denied", async () => {
    const { transport } = createTransport({ tables: [tableRow()], failures: { tables: accessDenied() } });

    await expect(getSchema(transport, PINNED)).resolves.toEqual([]);
    await expect(getSchemaList(transport, PINNED)).resolves.toEqual([]);
    await expect(getSchemaRelations(transport, PINNED)).resolves.toEqual([]);
  });

  // A deployment that does not expose a catalog at all is the same situation as
  // one the user may not read: nothing to show, not a broken connection.
  test("degrades when a catalog does not exist on this deployment", async () => {
    const missing = new ClickHouseTransportError(
      "Unknown table expression identifier 'system.data_skipping_indices' (UNKNOWN_TABLE)",
      CLICKHOUSE_ERROR_CODES.UNKNOWN_TABLE,
      "UNKNOWN_TABLE",
    );
    const { transport } = createTransport({ tables: [tableRow()], failures: { indices: missing } });

    const [table] = await getSchema(transport, PINNED);

    expect(table.indexes).toEqual([{ name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: ["id"], unique: false }]);
  });

  // Only "this surface is unavailable" degrades. Anything else is a real
  // failure, and an empty tree in its place would hide it forever.
  test.each<[string, ClickHouseTransportError]>([
    [
      "a syntax error",
      new ClickHouseTransportError("Syntax error (SYNTAX_ERROR)", CLICKHOUSE_ERROR_CODES.SYNTAX_ERROR, "SYNTAX_ERROR"),
    ],
    [
      "a rejected credential",
      new ClickHouseTransportError(
        "Authentication failed (AUTHENTICATION_FAILED)",
        CLICKHOUSE_ERROR_CODES.AUTHENTICATION_FAILED,
        "AUTHENTICATION_FAILED",
      ),
    ],
  ])("propagates %s", async (_label, failure) => {
    const { transport } = createTransport({ tables: [tableRow()], failures: { tables: failure } });

    await expect(getSchema(transport, PINNED)).rejects.toThrow(failure.message);
  });

  test("propagates a failure that never reached the server", async () => {
    const { transport } = createTransport({
      tables: [tableRow()],
      failures: { indices: new TypeError("fetch failed") },
    });

    await expect(getSchema(transport, PINNED)).rejects.toThrow("fetch failed");
  });
});
