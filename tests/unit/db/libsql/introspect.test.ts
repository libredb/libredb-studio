/**
 * libSQL introspection (issue #424 Phase 5)
 *
 * The transport is a fake that answers by matching the statement text, so every
 * test here states what the provider ASKED as well as what it did with the
 * answer. Two behaviours are pinned that no engine can be trusted to keep:
 *
 * - a per-table read that fails costs its own reading and nothing else, because
 *   Hrana answers each statement of a batch separately (measured 2026-08-27);
 * - a size that could not be read is ABSENT, never 0 (#477, and the same rule
 *   `buildTableStats` follows in the SQLite provider).
 */
import { describe, expect, test } from "bun:test";
import {
  readHealth,
  readNumber,
  readIndexStats,
  readOverview,
  readStorageStats,
  readTableStats,
} from "@/lib/db/providers/sql/libsql/introspect";
import {
  type LibSQLBatchOutcome,
  type LibSQLExecuteOptions,
  type LibSQLStatement,
  type LibSQLStatementResult,
  type LibSQLTransport,
  LibSQLTransportError,
} from "@/lib/db/providers/sql/libsql/transport";

// ============================================================================
// Fake transport
// ============================================================================

type Answer = LibSQLStatementResult | LibSQLTransportError;

function rows(fieldNames: string[], values: unknown[][]): LibSQLStatementResult {
  return {
    rows: values.map((row) => Object.fromEntries(fieldNames.map((name, index) => [name, row[index]]))),
    fieldNames,
    columnTypes: {},
    affectedRowCount: 0,
    lastInsertRowId: null,
    executionTimeMs: 0.1,
  };
}

const EMPTY = rows([], []);

class FakeTransport implements LibSQLTransport {
  public readonly kind = "hrana-http" as const;
  public readonly asked: string[] = [];
  public batchSizes: number[] = [];
  private readonly version: string | null;
  private readonly answers: [RegExp, Answer][];

  constructor(answers: [RegExp, Answer][], version: string | null = "sqld 0.24.33 (f8fb14f3 2026-08-11)") {
    this.answers = answers;
    this.version = version;
  }

  public async execute(sql: string, _options?: LibSQLExecuteOptions): Promise<LibSQLStatementResult> {
    const outcome = this.answer(sql);
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  }

  public async executeBatch(
    statements: LibSQLStatement[],
    _options?: LibSQLExecuteOptions,
  ): Promise<LibSQLBatchOutcome[]> {
    this.batchSizes.push(statements.length);
    return statements.map((statement) => this.answer(statement.sql));
  }

  public async serverVersion(): Promise<string | null> {
    return this.version;
  }

  public async close(): Promise<void> {}

  private answer(sql: string): LibSQLBatchOutcome {
    this.asked.push(sql);
    for (const [pattern, answer] of this.answers) {
      if (pattern.test(sql)) {
        return answer instanceof LibSQLTransportError ? { ok: false, error: answer } : { ok: true, result: answer };
      }
    }
    return { ok: true, result: EMPTY };
  }
}

const REFUSED = new LibSQLTransportError("SQLite error: no such table: dbstat", 200, "SQLITE_UNKNOWN");

/** The reads a two-table database answers, with one index on the first table. */
function twoTableTransport(overrides: [RegExp, Answer][] = []): FakeTransport {
  return new FakeTransport([
    ...overrides,
    [/FROM sqlite_master\s+WHERE type = 'table'/, rows(["name"], [["probe_customers"], ["probe_orders"]])],
    [/COUNT\(\*\) AS row_count FROM "probe_customers"/, rows(["row_count"], [[3]])],
    [/COUNT\(\*\) AS row_count FROM "probe_orders"/, rows(["row_count"], [[2000]])],
    [
      /pragma_table_info\('probe_customers'\)/,
      rows(
        ["cid", "name", "type", "notnull", "dflt_value", "pk"],
        [
          [0, "id", "INTEGER", 1, null, 1],
          [1, "country", "TEXT", 0, "'tr'", 0],
        ],
      ),
    ],
    [
      /pragma_table_info\('probe_orders'\)/,
      rows(["cid", "name", "type", "notnull", "dflt_value", "pk"], [[0, "id", "INTEGER", 0, null, 0]]),
    ],
    [
      /pragma_index_list\('probe_customers'\)/,
      rows(
        ["seq", "name", "unique", "origin", "partial"],
        [
          [0, "idx_country", 1, "c", 0],
          [1, "sqlite_autoindex_probe_customers_1", 1, "pk", 0],
        ],
      ),
    ],
    [
      /pragma_foreign_key_list\('probe_orders'\)/,
      rows(["id", "seq", "table", "from", "to"], [[0, 0, "probe_customers", "customer_id", "id"]]),
    ],
    [/pragma_index_info\('idx_country'\)/, rows(["seqno", "cid", "name"], [[0, 1, "country"]])],
    [
      /FROM dbstat/,
      rows(
        ["name", "bytes"],
        [
          ["probe_customers", 8192],
          ["idx_country", 4096],
          ["probe_orders", 270336],
        ],
      ),
    ],
    [/type = 'index'/, rows(["name", "tbl_name"], [["idx_country", "probe_customers"]])],
    [/sqlite_version\(\)/, rows(["version"], [["3.47.0"]])],
    [/page_count/, rows(["size_bytes"], [[282624]])],
    [/integrity_check/, rows(["integrity_check"], [["ok"]])],
    [/journal_mode/, rows(["journal_mode"], [["wal"]])],
  ]);
}

// ============================================================================
// Schema
// ============================================================================

/**
 * `readNumber` is the ONE rule for reading a statistic as a number in this provider
 * directory, and it is exported so both the stats tabs and the object surface read a
 * figure the same way. Two spellings of "a statistic as a number" in one directory is how
 * two surfaces come to disagree about one value, which is why it is pinned here directly
 * rather than only through whichever caller happens to exercise it.
 */
describe("readNumber", () => {
  test("a number passes through, and a non-finite one is an absence", () => {
    expect(readNumber(0)).toBe(0);
    expect(readNumber(12)).toBe(12);
    expect(readNumber(Number.NaN)).toBeUndefined();
    expect(readNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("a NUMERIC STRING is read, which is the shape Hrana sends a large integer in", () => {
    expect(readNumber("12")).toBe(12);
    expect(readNumber(" 12 ")).toBe(12);
  });

  test("text that is not a number is an absence rather than a zero", () => {
    // A zero here would publish a measurement nobody took: the stats tabs draw the figure
    // they are given, so an unparseable value has to reach them as no value at all.
    expect(readNumber("wal")).toBeUndefined();
    expect(readNumber("")).toBeUndefined();
    expect(readNumber("   ")).toBeUndefined();
    expect(readNumber(null)).toBeUndefined();
    expect(readNumber(undefined)).toBeUndefined();
    expect(readNumber(true)).toBeUndefined();
  });
});

// ============================================================================
// Overview, health, metrics
// ============================================================================

describe("readOverview", () => {
  test("names both the server and the SQLite version it embeds", async () => {
    const overview = await readOverview(twoTableTransport());

    expect(overview.version).toBe("sqld 0.24.33 (f8fb14f3 2026-08-11) (SQLite 3.47.0)");
  });

  test("falls back to the SQLite version alone on a deployment that publishes no server version", async () => {
    // Turso Cloud, measured 2026-08-27: there is no /version route at all, so the
    // panel shows what the engine did answer instead of "Unknown".
    const transport = twoTableTransport();
    const cloud = new FakeTransport(
      [
        [/sqlite_version\(\)/, rows(["version"], [["3.47.0"]])],
        [/page_count/, rows(["size_bytes"], [[282624]])],
        [/type = 'table'/, rows(["table_count"], [[2]])],
        [/type = 'index'/, rows(["index_count"], [[1]])],
      ],
      null,
    );
    void transport;

    expect((await readOverview(cloud)).version).toBe("SQLite 3.47.0");
  });

  test("reports the measured database size, the table count and the index count", async () => {
    const overview = await readOverview(
      new FakeTransport([
        [/sqlite_version\(\)/, rows(["version"], [["3.47.0"]])],
        [/page_count/, rows(["size_bytes"], [[282624]])],
        [/type = 'table'/, rows(["table_count"], [[2]])],
        [/type = 'index'/, rows(["index_count"], [[1]])],
      ]),
    );

    expect(overview.databaseSizeBytes).toBe(282624);
    expect(overview.databaseSize).toBe("276 KB");
    expect(overview.tableCount).toBe(2);
    expect(overview.indexCount).toBe(1);
  });

  test("publishes no connection ceiling and no uptime, because libSQL publishes neither", async () => {
    const overview = await readOverview(twoTableTransport());

    // 0 is this codebase's encoding for "no limit published" (trino, druid, mssql).
    expect(overview.maxConnections).toBe(0);
    expect(overview.uptime).toBe("N/A");
    // Hrana is stateless: a statement is a request, so there is no session to count.
    expect(overview.activeConnections).toBeUndefined();
  });

  test("leaves the size absent when the page counters could not be read", async () => {
    const overview = await readOverview(twoTableTransport([[/page_count/, REFUSED]]));

    expect(overview.databaseSize).toBe("N/A");
    expect(overview.databaseSizeBytes).toBeUndefined();
  });
});

describe("readHealth", () => {
  test("reports the integrity check and the journal mode as the two readings libSQL has", async () => {
    const health = await readHealth(twoTableTransport());

    expect(health.databaseSize).toBe("276 KB");
    expect(health.slowQueries.map((q) => q.query)).toEqual(["Integrity: OK", "Journal Mode: wal"]);
    expect(health.activeSessions).toEqual([]);
  });

  test("says the cache hit ratio is not measured rather than inventing one", async () => {
    expect((await readHealth(twoTableTransport())).cacheHitRatio).toBe("N/A");
  });

  test("reports a failed integrity check as failed", async () => {
    const health = await readHealth(
      twoTableTransport([[/integrity_check/, rows(["integrity_check"], [["*** in database main ***"]])]]),
    );

    expect(health.slowQueries[0]?.query).toBe("Integrity: FAILED");
  });

  test("says unknown for a journal mode the engine would not answer", async () => {
    const health = await readHealth(twoTableTransport([[/journal_mode/, REFUSED]]));

    expect(health.slowQueries[1]?.query).toBe("Journal Mode: unknown");
  });
});

// ============================================================================
// Stats
// ============================================================================

describe("readTableStats", () => {
  test("splits measured pages between a table and its indexes", async () => {
    const stats = await readTableStats(twoTableTransport());

    expect(stats[0]).toEqual({
      schemaName: "main",
      tableName: "probe_customers",
      rowCount: 3,
      tableSize: "8 KB",
      tableSizeBytes: 8192,
      indexSize: "4 KB",
      indexSizeBytes: 4096,
      totalSize: "12 KB",
      totalSizeBytes: 12288,
    });
  });

  test("omits every byte figure when dbstat is unavailable, keeping the row counts", async () => {
    const stats = await readTableStats(twoTableTransport([[/FROM dbstat/, REFUSED]]));

    expect(stats[0]).toEqual({
      schemaName: "main",
      tableName: "probe_customers",
      rowCount: 3,
      totalSize: "N/A",
      totalSizeBytes: 0,
    });
  });
});

describe("readIndexStats", () => {
  test("reports each user index with its columns and its measured size", async () => {
    const stats = await readIndexStats(twoTableTransport());

    expect(stats).toEqual([
      {
        schemaName: "main",
        tableName: "probe_customers",
        indexName: "idx_country",
        columns: ["country"],
        isUnique: true,
        isPrimary: false,
        indexSize: "4 KB",
        indexSizeBytes: 4096,
        // SQLite keeps no per-index scan counter, and 0 here is the count of a
        // statistic that does not exist rather than a measurement of no scans.
        scans: 0,
      },
    ]);
  });

  test("reports an index whose size could not be measured as N/A rather than as empty", async () => {
    const stats = await readIndexStats(twoTableTransport([[/FROM dbstat/, REFUSED]]));

    expect(stats[0]?.indexSize).toBe("N/A");
    expect(stats[0]?.indexSizeBytes).toBeUndefined();
  });
});

describe("readStorageStats", () => {
  test("reports the one file libSQL has, measured from its own page counters", async () => {
    const stats = await readStorageStats(twoTableTransport());

    expect(stats).toEqual([{ name: "main", size: "276 KB", sizeBytes: 282624 }]);
  });

  test("answers nothing at all when the page counters could not be read", async () => {
    // An entry reading 0 B would draw an empty database on the Storage tab; no
    // entry draws the tab's own empty state, which is the honest one.
    expect(await readStorageStats(twoTableTransport([[/page_count/, REFUSED]]))).toEqual([]);
  });
});
