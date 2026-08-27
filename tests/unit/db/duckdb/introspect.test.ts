/**
 * Unit tests for DuckDB introspection (issue #424).
 *
 * Two things are pinned here that a live database cannot pin on its own:
 *
 * 1. **The SQL text.** Every statement is scoped to `current_database()` rather than
 *    to `NOT internal`, because `duckdb_schemas().internal` is TRUE for `main` even in
 *    a user database - measured - so a `NOT internal` filter DROPS the default schema.
 *    That is a one-word regression nothing else would catch: the object browser would
 *    simply come back with the analytics schema and no `main`.
 * 2. **The absent branches.** A reading DuckDB has none for must answer `undefined` or
 *    omit its key, never `0`. Provoking each of those live means finding a database in
 *    exactly the wrong state; a stub client hands the reader the shape directly.
 *
 * The row fixtures are verbatim measurements from DuckDB v1.5.5 through
 * @duckdb/node-api 1.5.5-r.4 (2026-08-27) - note that every 64-bit column arrives as a
 * decimal STRING, which is the detail these readers exist to absorb.
 */

import { describe, expect, test } from "bun:test";
import type { DuckDBClient, DuckDBStatementResult } from "@/lib/db/providers/sql/duckdb/client";
import {
  COLUMNS_SQL,
  CONSTRAINTS_SQL,
  DB_SIZE_SQL,
  DEFAULT_SCHEMA,
  INDEXES_SQL,
  TABLES_SQL,
  VIEWS_SQL,
  displayName,
  readDatabaseSize,
  readHealth,
  readIndexStats,
  readOverview,
  readSchema,
  readStorageStats,
  readTableBytes,
  readTableStats,
} from "@/lib/db/providers/sql/duckdb/introspect";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// Stub client
// ============================================================================

function statementResult(rows: Record<string, unknown>[]): DuckDBStatementResult {
  return {
    columnNames: rows.length > 0 ? Object.keys(rows[0]) : [],
    columnTypes: [],
    rows,
    rowsChanged: 0,
  };
}

/**
 * A client that answers whatever the first matching predicate says.
 *
 * Matching is by substring of the statement rather than by equality, so a test names
 * the table function it is standing in for (`duckdb_tables()`) rather than repeating
 * the whole statement - which would make every one of these tests a second copy of the
 * SQL, and therefore prove nothing about the first.
 */
function stubClient(
  answers: ReadonlyArray<[match: string, rows: Record<string, unknown>[]]>,
  seen: string[] = [],
  failOn: readonly string[] = [],
): DuckDBClient {
  return {
    path: "/tmp/stub.duckdb",
    readOnly: false,
    async run(sql: string): Promise<DuckDBStatementResult> {
      seen.push(sql);
      const failure = failOn.find((match) => sql.includes(match));
      if (failure !== undefined) throw new Error(`Catalog Error: ${failure} could not be read`);
      const answer = answers.find(([match]) => sql.includes(match));
      return statementResult(answer === undefined ? [] : answer[1]);
    },
    interrupt(): void {},
    close(): void {},
  };
}

/** The exact-count read's own marker, as `readRowCounts` spells it. */
const COUNTS_MATCH = "AS row_count";

// ============================================================================
// Measured fixtures
// ============================================================================

const TABLE_ROWS = [
  { schema_name: "analytics", table_name: "events", estimated_size: "2" },
  { schema_name: "main", table_name: "customers", estimated_size: "5" },
];

const COLUMN_ROWS = [
  {
    schema_name: "main",
    table_name: "customers",
    column_name: "id",
    data_type: "INTEGER",
    is_nullable: false,
    column_default: null,
  },
  {
    schema_name: "main",
    table_name: "customers",
    column_name: "signed_up_at",
    data_type: "TIMESTAMP",
    is_nullable: true,
    column_default: "now()",
  },
  {
    schema_name: "main",
    table_name: "customer_totals",
    column_name: "revenue",
    data_type: "DECIMAL(38,2)",
    is_nullable: true,
    column_default: null,
  },
];

const DB_SIZE_ROW = {
  database_name: "warehouse",
  database_size: "2.0 MiB",
  block_size: "262144",
  total_blocks: "8",
  used_blocks: "8",
  free_blocks: "0",
  wal_size: "0 bytes",
  memory_usage: "512.0 KiB",
};

// ============================================================================
// Naming
// ============================================================================

describe("displayName", () => {
  test("an object in the default schema is named bare", () => {
    expect(displayName(DEFAULT_SCHEMA, "customers")).toBe("customers");
  });

  test("an object anywhere else carries its schema", () => {
    expect(displayName("analytics", "events")).toBe("analytics.events");
  });
});

// ============================================================================
// SQL text
// ============================================================================

describe("introspection SQL", () => {
  test.each([
    ["TABLES_SQL", TABLES_SQL],
    ["VIEWS_SQL", VIEWS_SQL],
    ["COLUMNS_SQL", COLUMNS_SQL],
    ["CONSTRAINTS_SQL", CONSTRAINTS_SQL],
    ["INDEXES_SQL", INDEXES_SQL],
  ])("%s is scoped to the attached catalog, never to another database", (_name, sql) => {
    expect(sql).toContain("database_name = current_database()");
  });

  test.each([
    ["TABLES_SQL", TABLES_SQL],
    ["VIEWS_SQL", VIEWS_SQL],
    ["COLUMNS_SQL", COLUMNS_SQL],
  ])("%s still excludes DuckDB's own internal objects", (_name, sql) => {
    expect(sql).toContain("NOT internal");
  });

  test("the constraint read asks only for the two constraint kinds the schema needs", () => {
    // `duckdb_constraints()` also publishes a row per NOT NULL and per UNIQUE
    // constraint, which would otherwise arrive as foreign keys with no referenced table.
    expect(CONSTRAINTS_SQL).toContain("constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')");
  });

  test("index columns are cast to a real list rather than parsed out of DuckDB's text", () => {
    // `expressions` is declared VARCHAR and prints as "[a, b]"; the cast is what makes
    // an expression index carrying a comma safe.
    expect(INDEXES_SQL).toContain("expressions::VARCHAR[] AS index_columns");
  });

  test("the size read does not ask for memory_limit", () => {
    // It is 80% of host RAM, so it differs per machine and says nothing about this
    // database. Reading it would invite a test that asserts a number no CI box shares.
    expect(DB_SIZE_SQL).not.toContain("memory_limit");
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("readSchema", () => {
  test("attaches columns, primary keys, foreign keys and indexes to their objects", async () => {
    const client = stubClient([
      ["duckdb_tables()", TABLE_ROWS],
      ["duckdb_views()", [{ schema_name: "main", view_name: "customer_totals" }]],
      ["duckdb_columns()", COLUMN_ROWS],
      [
        "duckdb_constraints()",
        [
          {
            schema_name: "main",
            table_name: "customers",
            constraint_type: "PRIMARY KEY",
            constraint_column_names: ["id"],
            referenced_table: null,
            referenced_column_names: [],
          },
          {
            schema_name: "analytics",
            table_name: "events",
            constraint_type: "FOREIGN KEY",
            constraint_column_names: ["customer_id"],
            referenced_table: "customers",
            referenced_column_names: ["id"],
          },
        ],
      ],
      [
        "duckdb_indexes()",
        [
          {
            schema_name: "main",
            table_name: "customers",
            index_name: "idx_customers_email",
            is_unique: true,
            is_primary: false,
            index_columns: ["email"],
          },
        ],
      ],
      [
        COUNTS_MATCH,
        [
          { schema_name: "analytics", table_name: "events", row_count: "2" },
          { schema_name: "main", table_name: "customers", row_count: "5" },
        ],
      ],
    ]);

    const schema = await readSchema(client);

    expect(schema.map((entry) => entry.name)).toEqual(["analytics.events", "customers", "customer_totals"]);

    const customers = schema.find((entry) => entry.name === "customers");
    expect(customers?.rowCount).toBe(5);
    expect(customers?.columns).toEqual([
      { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
      { name: "signed_up_at", type: "TIMESTAMP", nullable: true, isPrimary: false, defaultValue: "now()" },
    ]);
    expect(customers?.indexes).toEqual([{ name: "idx_customers_email", columns: ["email"], unique: true }]);

    // The target is spelled exactly as the tree node it refers to. DuckDB refuses a
    // foreign key across schemas ("Binder Error: Creating foreign keys across different
    // schemas or catalogs is not supported", measured), so the referenced table is
    // necessarily in the constraint's own schema - and an unqualified `customers` here
    // would link the ER diagram to the SAME-NAMED table in `main`.
    const events = schema.find((entry) => entry.name === "analytics.events");
    expect(events?.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "analytics.customers", referencedColumn: "id" },
    ]);
  });

  test("a foreign key in the default schema keeps the bare name the tree node carries", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "orders", estimated_size: "1" }]],
      ["duckdb_views()", []],
      ["duckdb_columns()", []],
      [
        "duckdb_constraints()",
        [
          {
            schema_name: "main",
            table_name: "orders",
            constraint_type: "FOREIGN KEY",
            constraint_column_names: ["customer_id"],
            referenced_table: "customers",
            referenced_column_names: ["id"],
          },
        ],
      ],
    ]);

    const [orders] = await readSchema(client);

    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });

  test("a view is listed with its columns and no row count", async () => {
    // `duckdb_views()` publishes no cardinality, and counting one would mean running it.
    const client = stubClient([
      ["duckdb_tables()", []],
      ["duckdb_views()", [{ schema_name: "main", view_name: "customer_totals" }]],
      ["duckdb_columns()", COLUMN_ROWS],
    ]);

    const [view] = await readSchema(client);

    expect(view.name).toBe("customer_totals");
    expect(view.rowCount).toBeUndefined();
    expect(view.columns).toEqual([{ name: "revenue", type: "DECIMAL(38,2)", nullable: true, isPrimary: false }]);
    expect(view.indexes).toEqual([]);
  });

  test("a composite foreign key becomes one entry per column pair", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "child", estimated_size: "0" }]],
      ["duckdb_views()", []],
      ["duckdb_columns()", []],
      [
        "duckdb_constraints()",
        [
          {
            schema_name: "main",
            table_name: "child",
            constraint_type: "FOREIGN KEY",
            constraint_column_names: ["a", "b"],
            referenced_table: "parent",
            referenced_column_names: ["x", "y"],
          },
        ],
      ],
    ]);

    const [child] = await readSchema(client);

    expect(child.foreignKeys).toEqual([
      { columnName: "a", referencedTable: "parent", referencedColumn: "x" },
      { columnName: "b", referencedTable: "parent", referencedColumn: "y" },
    ]);
  });

  test("a foreign key DuckDB published no target for degrades to empty strings, not a crash", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "child", estimated_size: "0" }]],
      ["duckdb_views()", []],
      ["duckdb_columns()", []],
      [
        "duckdb_constraints()",
        [
          {
            schema_name: "main",
            table_name: "child",
            constraint_type: "FOREIGN KEY",
            constraint_column_names: ["a"],
            referenced_table: null,
            referenced_column_names: [],
          },
        ],
      ],
    ]);

    const [child] = await readSchema(client);

    expect(child.foreignKeys).toEqual([{ columnName: "a", referencedTable: "", referencedColumn: "" }]);
  });

  test("the row count is COUNTED, never taken from estimated_size", async () => {
    // Measured on DuckDB v1.5.5: after deleting 19M of a table's 20M rows,
    // `duckdb_tables().estimated_size` answered 1,076,480 where `count(*)` answered
    // 1,000,000 - and a CHECKPOINT did not move it. It is a row-group estimate, so it is
    // never published as `rowCount`.
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "big", estimated_size: "1076480" }]],
      ["duckdb_views()", []],
      ["duckdb_columns()", []],
      [COUNTS_MATCH, [{ schema_name: "main", table_name: "big", row_count: "1000000" }]],
    ]);

    const [table] = await readSchema(client);

    expect(table.rowCount).toBe(1000000);
  });

  test("every table is counted in ONE statement, and the names are quoted both ways", async () => {
    // Measured: 41 tables including a 20M-row one counted in 8.8 ms, and 1000 tables in
    // 240 ms, as a single UNION ALL - DuckDB answers count(*) from row-group metadata.
    // A per-table statement would be the sweep this provider exists without.
    const seen: string[] = [];
    const client = stubClient(
      [
        [
          "duckdb_tables()",
          [
            { schema_name: "main", table_name: "we'ird-name", estimated_size: "1" },
            { schema_name: "an'alytics", table_name: 'we"ird', estimated_size: "1" },
          ],
        ],
        ["duckdb_views()", []],
        ["duckdb_columns()", []],
      ],
      seen,
    );

    await readSchema(client);

    const counting = seen.filter((sql) => sql.includes(COUNTS_MATCH));
    expect(counting).toHaveLength(1);
    // The name travels twice in each arm and the two spellings are different: a
    // single-quoted literal for the label, a double-quoted identifier for the read.
    expect(counting[0]).toContain(`SELECT 'main' AS schema_name, 'we''ird-name' AS table_name`);
    expect(counting[0]).toContain(`FROM "main"."we'ird-name"`);
    expect(counting[0]).toContain(`SELECT 'an''alytics' AS schema_name, 'we"ird' AS table_name`);
    expect(counting[0]).toContain(`FROM "an'alytics"."we""ird"`);
    expect(counting[0]).toContain(" UNION ALL ");
  });

  test("a catalog with no tables issues no counting statement at all", async () => {
    const seen: string[] = [];
    const client = stubClient([["duckdb_views()", [{ schema_name: "main", view_name: "v" }]]], seen);

    await readSchema(client);

    expect(seen.filter((sql) => sql.includes(COUNTS_MATCH))).toEqual([]);
  });

  test("a table the count read could not answer for carries NO row count rather than a wrong one", async () => {
    // `TableSchema.rowCount` is optional, and this repo publishes nothing rather than a
    // number it cannot make true - the rule the Cassandra provider follows.
    const client = stubClient(
      [
        ["duckdb_tables()", [{ schema_name: "main", table_name: "t", estimated_size: "5" }]],
        ["duckdb_views()", []],
        ["duckdb_columns()", []],
      ],
      [],
      [COUNTS_MATCH],
    );

    const [table] = await readSchema(client);

    expect(table).toEqual({ name: "t", columns: [], indexes: [], foreignKeys: [] });
    expect("rowCount" in table).toBe(false);
  });

  test("a count row DuckDB answered unreadably is absent rather than zero", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "t", estimated_size: "5" }]],
      ["duckdb_views()", []],
      ["duckdb_columns()", []],
      [COUNTS_MATCH, [{ schema_name: "main", table_name: "t", row_count: null }]],
    ]);

    const [table] = await readSchema(client);

    expect("rowCount" in table).toBe(false);
  });

  test("an index whose column list DuckDB left NULL is listed with no columns", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "t", estimated_size: "0" }]],
      ["duckdb_views()", []],
      ["duckdb_columns()", []],
      [
        "duckdb_indexes()",
        [
          {
            schema_name: "main",
            table_name: "t",
            index_name: "idx",
            is_unique: false,
            is_primary: false,
            index_columns: null,
          },
        ],
      ],
    ]);

    const [table] = await readSchema(client);

    expect(table.indexes).toEqual([{ name: "idx", columns: [], unique: false }]);
  });
});

// ============================================================================
// Sizes
// ============================================================================

describe("readDatabaseSize", () => {
  test("parses every human string DuckDB printed into bytes", async () => {
    const size = await readDatabaseSize(stubClient([["pragma_database_size()", [DB_SIZE_ROW]]]));

    expect(size).toEqual({
      databaseSizeBytes: 2097152,
      walSizeBytes: 0,
      memoryUsageBytes: 524288,
      blockSize: 262144,
      totalBlocks: 8,
      usedBlocks: 8,
      freeBlocks: 0,
    });
  });

  test("an in-memory database publishes NO database size, because its '0 bytes' is not one", async () => {
    // Measured on DuckDB v1.5.5: a `:memory:` database holding 10,000,000 rows still
    // answers database_size "0 bytes", wal_size "0 bytes" and block_size 0, over a
    // memory_usage of "283.0 MiB". There is no file, so the zero is the absence of a
    // file rather than the size of one - publishing it draws an empty database over
    // live data. The block size stays: it IS a reading, and it is what tells
    // `readTableBytes` there are no blocks to measure.
    const size = await readDatabaseSize(
      stubClient([
        [
          "pragma_database_size()",
          [
            {
              database_size: "0 bytes",
              block_size: "0",
              total_blocks: "0",
              wal_size: "0 bytes",
              memory_usage: "283.0 MiB",
            },
          ],
        ],
      ]),
    );

    expect(size.databaseSizeBytes).toBeUndefined();
    expect(size.walSizeBytes).toBeUndefined();
    expect(size.blockSize).toBe(0);
    expect(size.memoryUsageBytes).toBe(296747008);
    expect(size.usedBlocks).toBeUndefined();
    expect(size.freeBlocks).toBeUndefined();
  });

  test("a file-backed database with a genuinely empty WAL still publishes its zero", async () => {
    // The suppression above is keyed to block_size 0, which only an in-memory database
    // answers - a file's "0 bytes" WAL is a measurement of a real, empty WAL.
    const size = await readDatabaseSize(stubClient([["pragma_database_size()", [DB_SIZE_ROW]]]));

    expect(size.walSizeBytes).toBe(0);
    expect(size.databaseSizeBytes).toBe(2097152);
  });

  test("a size read that answered no row at all reports nothing rather than zeroes", async () => {
    expect(await readDatabaseSize(stubClient([]))).toEqual({});
  });

  test("a size string DuckDB printed in a form this parser cannot read is omitted", async () => {
    const size = await readDatabaseSize(stubClient([["pragma_database_size()", [{ database_size: "unknown" }]]]));

    expect(size.databaseSizeBytes).toBeUndefined();
  });
});

describe("readTableBytes", () => {
  test("distinct persistent blocks times the block size", async () => {
    const client = stubClient([["pragma_storage_info", [{ blocks: "3" }]]]);

    expect(await readTableBytes(client, "main", "customers", 262144)).toBe(786432);
  });

  test("the argument is a quoted, qualified name inside a string literal", async () => {
    const seen: string[] = [];
    const client = stubClient([["pragma_storage_info", [{ blocks: "1" }]]], seen);

    await readTableBytes(client, "main", "we'ird-name", 262144);

    // Both layers of quoting are required and they are different - measured, the
    // unquoted spelling is a parse error.
    expect(seen[0]).toContain(`pragma_storage_info('"main"."we''ird-name"')`);
  });

  test.each([
    ["main", 'we"ird', "the table's name"],
    ['sch"ema', "t", "the schema's name"],
  ])("a double quote in %s.%s (%s) is refused rather than mis-addressed", async (schemaName, tableName) => {
    // Measured on DuckDB v1.5.5: `pragma_storage_info()` parses its argument as a
    // qualified name that CANNOT carry an embedded double quote in any spelling. The
    // doubled form `'"main"."we""ird"'` does not fail cleanly - it resolves to a
    // DIFFERENT table called `weird` and reports ITS blocks, and raises
    // "Catalog Error: Table with name weird does not exist!" when there is none, which
    // is what took the whole Storage panel down. Neither the raw form nor a backslash
    // nor a bound parameter reaches the table either. So the read is not attempted.
    const seen: string[] = [];
    const client = stubClient([["pragma_storage_info", [{ blocks: "3" }]]], seen);

    expect(await readTableBytes(client, schemaName, tableName, 262144)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("a storage read the engine refused reports nothing rather than throwing", async () => {
    const client = stubClient([], [], ["pragma_storage_info"]);

    expect(await readTableBytes(client, "main", "t", 262144)).toBeUndefined();
  });

  test("only persistent blocks with a real id are counted", async () => {
    const seen: string[] = [];
    const client = stubClient([["pragma_storage_info", [{ blocks: "1" }]]], seen);

    await readTableBytes(client, "main", "t", 262144);

    expect(seen[0]).toContain("WHERE persistent AND block_id >= 0");
  });

  test("a table with no persistent block reports nothing, never zero bytes", async () => {
    // An in-memory database and a table whose rows are still in the write-ahead log
    // both land here. A 0 would read as an empty table on the Storage tab.
    const client = stubClient([["pragma_storage_info", [{ blocks: "0" }]]]);

    expect(await readTableBytes(client, "main", "t", 262144)).toBeUndefined();
  });

  test("an unreadable block count reports nothing", async () => {
    const client = stubClient([["pragma_storage_info", [{ blocks: null }]]]);

    expect(await readTableBytes(client, "main", "t", 262144)).toBeUndefined();
  });

  test.each([
    [undefined, "no block size was published"],
    [0, "an in-memory database publishes a zero block size"],
  ])("reports nothing when %p (%s), and issues no statement", async (blockSize) => {
    const seen: string[] = [];
    const client = stubClient([], seen);

    expect(await readTableBytes(client, "main", "t", blockSize)).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("readOverview", () => {
  test("reports the version, the counts and the measured size", async () => {
    const overview = await readOverview(
      stubClient([
        ["current_database() AS catalog_name", [{ catalog_name: "warehouse", version: "v1.5.5" }]],
        ["pragma_database_size()", [DB_SIZE_ROW]],
        ["AS table_count", [{ table_count: "3", index_count: "1" }]],
      ]),
    );

    expect(overview).toEqual({
      version: "DuckDB v1.5.5",
      uptime: "N/A",
      activeConnections: 1,
      maxConnections: 0,
      databaseSize: "2 MB",
      databaseSizeBytes: 2097152,
      tableCount: 3,
      indexCount: 1,
    });
  });

  test("an in-memory database reads N/A rather than an empty one", async () => {
    const overview = await readOverview(
      stubClient([
        ["current_database() AS catalog_name", [{ catalog_name: "memory", version: "v1.5.5" }]],
        ["pragma_database_size()", [{ database_size: "0 bytes", block_size: "0", memory_usage: "283.0 MiB" }]],
        ["AS table_count", [{ table_count: "1", index_count: "0" }]],
      ]),
    );

    expect(overview.databaseSize).toBe("N/A");
    expect("databaseSizeBytes" in overview).toBe(false);
  });

  test("omits databaseSizeBytes entirely when no size was published", async () => {
    // Absence and zero are different facts: a 0 renders as an empty database and a
    // 0.0% storage breakdown.
    const overview = await readOverview(stubClient([]));

    expect(overview.databaseSize).toBe("N/A");
    expect("databaseSizeBytes" in overview).toBe(false);
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
    expect(overview.version).toBe("DuckDB unknown");
  });
});

describe("readHealth", () => {
  test("reports the size and says plainly that it has no ratio, no queries and no sessions", async () => {
    const health = await readHealth(stubClient([["pragma_database_size()", [DB_SIZE_ROW]]]));

    expect(health).toEqual({
      activeConnections: 1,
      databaseSize: "2 MB",
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [],
    });
  });

  test("an unmeasurable size is 'N/A' rather than a zero-byte database", async () => {
    expect((await readHealth(stubClient([]))).databaseSize).toBe("N/A");
  });
});

describe("readTableStats", () => {
  test("one unreadable table never costs the others their panel", async () => {
    // A name `pragma_storage_info()` cannot address, beside an ordinary table. The panel
    // lists both, and the one with no byte figure falls into the N/A branch.
    const client = stubClient([
      [
        "duckdb_tables()",
        [
          { schema_name: "main", table_name: 'we"ird', estimated_size: "1" },
          { schema_name: "main", table_name: "customers", estimated_size: "5" },
        ],
      ],
      ["pragma_database_size()", [DB_SIZE_ROW]],
      ["pragma_storage_info", [{ blocks: "1" }]],
      [
        COUNTS_MATCH,
        [
          { schema_name: "main", table_name: 'we"ird', row_count: "1" },
          { schema_name: "main", table_name: "customers", row_count: "5" },
        ],
      ],
    ]);

    const stats = await readTableStats(client);

    expect(stats.map((entry) => entry.tableName)).toEqual(['we"ird', "customers"]);
    expect(stats[0].totalSize).toBe("N/A");
    expect(stats[1].totalSizeBytes).toBe(262144);
  });

  test("the row count is the counted one, not the row-group estimate", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "big", estimated_size: "1076480" }]],
      ["pragma_database_size()", [DB_SIZE_ROW]],
      ["pragma_storage_info", [{ blocks: "1" }]],
      [COUNTS_MATCH, [{ schema_name: "main", table_name: "big", row_count: "1000000" }]],
    ]);

    expect((await readTableStats(client))[0].rowCount).toBe(1000000);
  });

  test("a count the engine refused falls back to the estimate rather than to zero", async () => {
    // `TableStats.rowCount` is required, so absence is not expressible here. Of the two
    // numbers available, the row-group estimate is the closer one; a 0 would draw an
    // empty table over real rows.
    const client = stubClient(
      [
        ["duckdb_tables()", [{ schema_name: "main", table_name: "big", estimated_size: "1076480" }]],
        ["pragma_database_size()", [DB_SIZE_ROW]],
        ["pragma_storage_info", [{ blocks: "1" }]],
      ],
      [],
      [COUNTS_MATCH],
    );

    expect((await readTableStats(client))[0].rowCount).toBe(1076480);
  });

  test("a table with persistent blocks carries its measured bytes", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "customers", estimated_size: "5" }]],
      ["pragma_database_size()", [DB_SIZE_ROW]],
      ["pragma_storage_info", [{ blocks: "1" }]],
      [COUNTS_MATCH, [{ schema_name: "main", table_name: "customers", row_count: "5" }]],
    ]);

    expect(await readTableStats(client)).toEqual([
      {
        schemaName: "main",
        tableName: "customers",
        rowCount: 5,
        tableSize: "256 KB",
        tableSizeBytes: 262144,
        totalSize: "256 KB",
        totalSizeBytes: 262144,
      },
    ]);
  });

  test("a table with no measurable bytes omits them and carries the N/A placeholder", async () => {
    // The same rule `buildTableStats` follows in sqlite.ts: the Storage tab keys off
    // the ABSENT `tableSizeBytes` and draws neither figure.
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "customers", estimated_size: "5" }]],
      ["pragma_database_size()", [{ database_size: "0 bytes", block_size: "0" }]],
    ]);

    const [stats] = await readTableStats(client);

    expect(stats).toEqual({
      schemaName: "main",
      tableName: "customers",
      rowCount: 5,
      totalSize: "N/A",
      totalSizeBytes: 0,
    });
    expect("tableSizeBytes" in stats).toBe(false);
  });

  test("no per-table index size is invented", async () => {
    const client = stubClient([
      ["duckdb_tables()", [{ schema_name: "main", table_name: "customers", estimated_size: "5" }]],
      ["pragma_database_size()", [DB_SIZE_ROW]],
      ["pragma_storage_info", [{ blocks: "1" }]],
    ]);

    const [stats] = await readTableStats(client);

    // `pragma_storage_info()` reports the table's own column segments and attributes
    // nothing to an index, so claiming an index size would be a fabrication.
    expect("indexSizeBytes" in stats).toBe(false);
    expect("indexSize" in stats).toBe(false);
  });
});

describe("readIndexStats", () => {
  test("reports the columns and uniqueness, and no size or scan count it cannot measure", async () => {
    const client = stubClient([
      [
        "duckdb_indexes()",
        [
          {
            schema_name: "main",
            table_name: "orders",
            index_name: "idx_orders_customer",
            is_unique: false,
            is_primary: false,
            index_columns: ["customer_id"],
          },
        ],
      ],
    ]);

    const [index] = await readIndexStats(client);

    expect(index).toEqual({
      schemaName: "main",
      tableName: "orders",
      indexName: "idx_orders_customer",
      columns: ["customer_id"],
      isUnique: false,
      isPrimary: false,
      indexSize: "N/A",
      scans: 0,
    });
    expect("indexSizeBytes" in index).toBe(false);
  });

  test("an index with no column list is reported with none rather than dropped", async () => {
    const client = stubClient([
      [
        "duckdb_indexes()",
        [
          {
            schema_name: "main",
            table_name: "t",
            index_name: "idx",
            is_unique: true,
            is_primary: true,
            index_columns: null,
          },
        ],
      ],
    ]);

    expect((await readIndexStats(client))[0].columns).toEqual([]);
  });
});

describe("readStorageStats", () => {
  test("the database file, its location and its write-ahead log", async () => {
    const client = stubClient([
      ["pragma_database_size()", [{ ...DB_SIZE_ROW, wal_size: "4.0 KiB" }]],
      ["duckdb_databases()", [{ path: "/tmp/libredb-duckdb/warehouse.duckdb" }]],
      ["duckdb_temporary_files()", []],
    ]);

    expect(await readStorageStats(client)).toEqual([
      {
        name: "Main Database",
        location: "/tmp/libredb-duckdb/warehouse.duckdb",
        size: "2 MB",
        sizeBytes: 2097152,
        walSize: "4 KB",
        walSizeBytes: 4096,
      },
    ]);
  });

  test("an in-memory database reports the memory it measured, never a zero-byte file", async () => {
    // Measured: `duckdb_databases().path` is NULL and pragma_database_size() answers
    // "0 bytes" whatever the database holds. The reading that IS true of an in-memory
    // database is its memory usage, so that is the one published - a 0 here draws an
    // empty database over live data.
    const client = stubClient([
      ["pragma_database_size()", [{ database_size: "0 bytes", block_size: "0", memory_usage: "283.0 MiB" }]],
      ["duckdb_databases()", [{ path: null }]],
      ["duckdb_temporary_files()", []],
    ]);

    const [main] = await readStorageStats(client);

    expect(main).toEqual({
      name: "In-Memory Database",
      location: ":memory:",
      size: "283 MB",
      sizeBytes: 296747008,
    });
  });

  test("an in-memory database whose memory usage was unreadable says N/A", async () => {
    const client = stubClient([
      ["pragma_database_size()", [{ database_size: "0 bytes", block_size: "0" }]],
      ["duckdb_databases()", [{ path: null }]],
      ["duckdb_temporary_files()", []],
    ]);

    const [main] = await readStorageStats(client);

    expect(main).toEqual({ name: "In-Memory Database", location: ":memory:", size: "N/A", sizeBytes: 0 });
  });

  test("a size read that answered nothing at all reports N/A and no path row", async () => {
    const [main] = await readStorageStats(stubClient([]));

    expect(main).toEqual({ name: "In-Memory Database", location: ":memory:", size: "N/A", sizeBytes: 0 });
  });

  test("a spill file is listed only when DuckDB reports one", async () => {
    const client = stubClient([
      ["pragma_database_size()", [DB_SIZE_ROW]],
      ["duckdb_databases()", [{ path: "/tmp/x.duckdb" }]],
      [
        "duckdb_temporary_files()",
        [
          { path: "/tmp/duckdb_temp/spill.tmp", size: "1048576" },
          { path: "/tmp/b", size: null },
        ],
      ],
    ]);

    const stats = await readStorageStats(client);

    expect(stats.slice(1)).toEqual([
      { name: "Temporary File", location: "/tmp/duckdb_temp/spill.tmp", size: "1 MB", sizeBytes: 1048576 },
      { name: "Temporary File", location: "/tmp/b", size: "0 B", sizeBytes: 0 },
    ]);
  });
});
