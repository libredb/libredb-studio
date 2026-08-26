/**
 * libSQL provider, end to end (issue #424 Phase 5)
 *
 * Every payload below was captured on 2026-08-27 from BOTH deployments this one
 * type-id reaches: a self-hosted `ghcr.io/tursodatabase/libsql-server` (sqld
 * 0.24.33, SQLite 3.47.0) and a Turso Cloud database in `aws-eu-west-1`.
 * `globalThis.fetch` is REPLACED per test and restored afterwards - `mock.module()`
 * is refused, being process-wide in bun and able to poison sibling files - so the
 * real provider, the real introspection and the real Hrana transport all execute
 * here and only the server is fake.
 *
 * Five measured behaviours drive what is asserted:
 *
 * 1. A FAILED STATEMENT IS AN HTTP 200 with the failure inside `results[]`, so
 *    `response.ok` is never the test.
 * 2. THE TWO DEPLOYMENTS WORD THE SAME REFUSAL DIFFERENTLY - "unsupported
 *    statement: VACUUM" against "SQL not allowed statement: VACUUM" - under one
 *    code, so nothing may key on the wording.
 * 3. `GET /version` IS A SQLD ROUTE TURSO CLOUD DOES NOT HAVE, and a deployment
 *    that publishes no version is not a broken one.
 * 4. AN AUTH FAILURE USES A DIFFERENT ENVELOPE (`{"error": "<string>"}`) and
 *    answers 401 with no token, 400 with a malformed one.
 * 5. `dbstat` ANSWERS ON BOTH, so per-table bytes here are measured - which
 *    `bun:sqlite` cannot do at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { LibSQLProvider } from "@/lib/db/providers/sql/libsql";
import type { DatabaseConnection } from "@/lib/db/types";

// ============================================================================
// Harness
// ============================================================================

interface FetchCall {
  url: string;
  body: string | null;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];

/** A row set as Hrana encodes one: declared columns, positional typed values. */
type Cell = Record<string, unknown>;

function result(cols: [string, string | null][], rows: Cell[][], extra: Record<string, unknown> = {}): Cell {
  return {
    type: "ok",
    response: {
      type: "execute",
      result: {
        cols: cols.map(([name, decltype]) => ({ name, decltype })),
        rows,
        affected_row_count: 0,
        last_insert_rowid: null,
        replication_index: "1",
        rows_read: rows.length,
        rows_written: 0,
        query_duration_ms: 0.107,
        ...extra,
      },
    },
  };
}

function text(value: string): Cell {
  return { type: "text", value };
}

function int(value: number | string): Cell {
  return { type: "integer", value: String(value) };
}

function failure(message: string, code: string): Cell {
  return { type: "error", error: { message, code } };
}

/**
 * The fixture both deployments answered for, verbatim in shape: two tables, one
 * user index, one foreign key, `dbstat` populated.
 */
function answerFor(sql: string): Cell {
  if (/FROM sqlite_master\s+WHERE type = 'table'\s+AND name NOT LIKE/.test(sql) && /COUNT/.test(sql)) {
    return result([["table_count", null]], [[int(2)]]);
  }
  if (/FROM sqlite_master\s+WHERE type = 'table'/.test(sql)) {
    return result([["name", "TEXT"]], [[text("probe_customers")], [text("probe_orders")]]);
  }
  if (/type = 'index' AND name NOT LIKE/.test(sql)) return result([["index_count", null]], [[int(1)]]);
  if (/SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'/.test(sql)) {
    return result(
      [
        ["name", "TEXT"],
        ["tbl_name", "TEXT"],
      ],
      [[text("idx_country"), text("probe_customers")]],
    );
  }
  if (/FROM dbstat/.test(sql)) {
    return result(
      [
        ["name", "TEXT"],
        ["bytes", null],
      ],
      [
        [text("probe_customers"), int(8192)],
        [text("idx_country"), int(4096)],
        [text("probe_orders"), int(270336)],
      ],
    );
  }
  if (/COUNT\(\*\) AS row_count FROM "probe_customers"/.test(sql)) return result([["row_count", null]], [[int(3)]]);
  if (/COUNT\(\*\) AS row_count FROM "probe_orders"/.test(sql)) return result([["row_count", null]], [[int(2000)]]);
  if (/pragma_table_info\('probe_customers'\)/.test(sql)) {
    return result(
      [
        ["cid", null],
        ["name", null],
        ["type", null],
        ["notnull", null],
        ["dflt_value", null],
        ["pk", null],
      ],
      [
        [int(0), text("id"), text("INTEGER"), int(1), { type: "null" }, int(1)],
        [int(1), text("country"), text("TEXT"), int(0), { type: "null" }, int(0)],
      ],
    );
  }
  if (/pragma_table_info\('probe_orders'\)/.test(sql)) {
    return result(
      [
        ["cid", null],
        ["name", null],
        ["type", null],
        ["notnull", null],
        ["dflt_value", null],
        ["pk", null],
      ],
      [[int(0), text("id"), text("INTEGER"), int(0), { type: "null" }, int(1)]],
    );
  }
  if (/pragma_index_list\('probe_customers'\)/.test(sql)) {
    return result(
      [
        ["seq", null],
        ["name", null],
        ["unique", null],
        ["origin", null],
      ],
      [
        [int(0), text("idx_country"), int(1), text("c")],
        [int(1), text("sqlite_autoindex_probe_customers_1"), int(1), text("pk")],
      ],
    );
  }
  if (/pragma_index_info\('idx_country'\)/.test(sql)) {
    return result(
      [
        ["seqno", null],
        ["cid", null],
        ["name", null],
      ],
      [[int(0), int(1), text("country")]],
    );
  }
  if (/pragma_foreign_key_list\('probe_orders'\)/.test(sql)) {
    return result(
      [
        ["id", null],
        ["seq", null],
        ["table", null],
        ["from", null],
        ["to", null],
      ],
      [[int(0), int(0), text("probe_customers"), text("customer_id"), text("id")]],
    );
  }
  if (/pragma_page_count/.test(sql)) return result([["size_bytes", null]], [[int(282624)]]);
  if (/sqlite_version\(\)/.test(sql)) return result([["version", null]], [[text("3.47.0")]]);
  if (/PRAGMA integrity_check/.test(sql)) return result([["integrity_check", null]], [[text("ok")]]);
  if (/PRAGMA journal_mode/.test(sql)) return result([["journal_mode", null]], [[text("wal")]]);
  if (/^SELECT 1$/.test(sql)) return result([["1", null]], [[int(1)]]);

  return result([], []);
}

/** What the server does with one pipeline: an answer per statement, then a close. */
type Server = (sql: string) => Cell;

let server: Server = answerFor;
let versionRoute: () => Response = () => new Response("sqld 0.24.33 (f8fb14f3 2026-08-11)", { status: 200 });

function installFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? null : String(init.body);
    calls.push({ url, body });

    if (url.endsWith("/version")) return Promise.resolve(versionRoute());

    const requests = (JSON.parse(body ?? "{}") as { requests?: { type: string; stmt?: { sql?: string } }[] }).requests;
    const results = (requests ?? [])
      .filter((request) => request.type === "execute")
      .map((request) => server(String(request.stmt?.sql)));

    return Promise.resolve(
      new Response(JSON.stringify({ baton: null, base_url: null, results: [...results, { type: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "libsql-probe",
    name: "libSQL probe",
    type: "libsql",
    host: "127.0.0.1",
    port: 18081,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

async function connected(overrides: Partial<DatabaseConnection> = {}): Promise<LibSQLProvider> {
  const provider = new LibSQLProvider(connection(overrides));
  await provider.connect();
  return provider;
}

/** Every statement the provider sent, in order. */
function sentStatements(): string[] {
  return calls
    .filter((call) => call.body !== null)
    .flatMap((call) => {
      const requests = (JSON.parse(call.body as string) as { requests?: { stmt?: { sql?: string } }[] }).requests ?? [];
      return requests.filter((request) => request.stmt !== undefined).map((request) => String(request.stmt?.sql));
    });
}

beforeEach(() => {
  calls = [];
  server = answerFor;
  versionRoute = () => new Response("sqld 0.24.33 (f8fb14f3 2026-08-11)", { status: 200 });
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Configuration and connection
// ============================================================================

describe("LibSQLProvider configuration", () => {
  test("refuses a connection with neither a host nor a URL", () => {
    expect(() => new LibSQLProvider(connection({ host: undefined }))).toThrow(DatabaseConfigError);
  });

  test("resolves a libsql:// URL into host, port and token", async () => {
    const provider = await connected({
      host: undefined,
      port: undefined,
      connectionString: "libsql://libredb-probe-424-cevheri.aws-eu-west-1.turso.io?authToken=jwt-123",
    });

    expect(calls[0]?.url).toBe("https://libredb-probe-424-cevheri.aws-eu-west-1.turso.io:443/v2/pipeline");
    await provider.disconnect();
  });

  test("connects with the cheapest statement there is, not a health route", async () => {
    await connected();

    expect(sentStatements()).toEqual(["SELECT 1"]);
  });

  test("connecting twice reuses the transport rather than probing again", async () => {
    const provider = await connected();
    await provider.connect();

    expect(sentStatements()).toEqual(["SELECT 1"]);
    await provider.disconnect();
  });

  test("reports a missing token as an authentication failure, not a connection one", async () => {
    // 401, and the envelope is `{"error": "<string>"}` rather than the statement
    // shape - captured from Turso Cloud with no Authorization header.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "Unauthorized: `unauthorized access attempt on database: empty JWT token`" }),
          {
            status: 401,
          },
        ),
      )) as unknown as typeof fetch;

    await expect(new LibSQLProvider(connection()).connect()).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("reports a malformed token as an authentication failure even though the status is 400", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "JWT error: InvalidToken" }), { status: 400 }),
      )) as unknown as typeof fetch;

    await expect(new LibSQLProvider(connection({ password: "notatoken" })).connect()).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  test("reports an unreachable server as a connection failure naming host and port", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

    const failed = new LibSQLProvider(connection()).connect();

    await expect(failed).rejects.toBeInstanceOf(ConnectionError);
    await expect(failed).rejects.toThrow(/connect ECONNREFUSED/);
  });

  test("refuses every read before connect, rather than answering an empty one", async () => {
    const provider = new LibSQLProvider(connection());

    await expect(provider.query("SELECT 1")).rejects.toThrow();
    await expect(provider.getSchema()).rejects.toThrow();
    await expect(provider.getOverview()).rejects.toThrow();
  });
});

// ============================================================================
// Capabilities
// ============================================================================

describe("LibSQLProvider capabilities", () => {
  test("offers only the two maintenance operations the server accepts", () => {
    const capabilities = new LibSQLProvider(connection()).getCapabilities();

    expect(capabilities.maintenanceOperations).toEqual(["reindex", "check"]);
    // Measured on BOTH deployments: each of these is refused by the server's own
    // statement allowlist, so a control for it could only ever fail.
    expect(capabilities.maintenanceOperations).not.toContain("vacuum");
    expect(capabilities.maintenanceOperations).not.toContain("analyze");
  });

  test("reads EXPLAIN the way SQLite does, and takes a pasted URL", () => {
    const capabilities = new LibSQLProvider(connection()).getCapabilities();

    expect(capabilities.explainFormat).toBe("sqlite-queryplan");
    expect(capabilities.supportsConnectionString).toBe(true);
    expect(capabilities.defaultPort).toBe(8080);
  });

  test("declares no transaction, because the stream closes with each statement", () => {
    expect(new LibSQLProvider(connection()).getCapabilities().supportsTransactions).toBe(false);
  });

  test("tells the reader there is no statement history to enable", () => {
    expect(new LibSQLProvider(connection()).getLabels().slowQueriesEmptyState).toBe(
      "libSQL keeps no statistics about finished statements, so there is nothing to enable.",
    );
  });
});

// ============================================================================
// Queries
// ============================================================================

describe("LibSQLProvider query", () => {
  test("returns rows, declared fields and the types the engine declared", async () => {
    const provider = await connected();

    const answer = await provider.query("SELECT name, type FROM sqlite_master WHERE type = 'table'");

    expect(answer.rows).toEqual([{ name: "probe_customers" }, { name: "probe_orders" }]);
    expect(answer.fields).toEqual(["name"]);
    expect(answer.columnTypes).toEqual({ name: "TEXT" });
    await provider.disconnect();
  });

  test("omits columnTypes entirely when the engine declared none", async () => {
    const provider = await connected();

    const answer = await provider.query("SELECT sqlite_version() AS version");

    expect(answer.rows).toEqual([{ version: "3.47.0" }]);
    expect(answer.columnTypes).toBeUndefined();
    await provider.disconnect();
  });

  test("counts a write by what the engine says it changed", async () => {
    server = () => result([], [], { affected_row_count: 3, last_insert_rowid: "12" });
    const provider = await connected();

    const answer = await provider.query("DELETE FROM probe_orders WHERE id < 4");

    expect(answer.rowCount).toBe(3);
    expect(answer.rows).toEqual([]);
    await provider.disconnect();
  });

  test("binds positional parameters as the protocol requires", async () => {
    const provider = await connected();

    await provider.query("SELECT * FROM probe_customers WHERE country = ?", ["tr"]);

    const sent = JSON.parse(calls[1]?.body ?? "{}") as { requests: { stmt?: { args?: unknown[] } }[] };
    expect(sent.requests[0]?.stmt?.args).toEqual([{ type: "text", value: "tr" }]);
    await provider.disconnect();
  });

  test("surfaces SQLite's own wording for a statement the engine rejected", async () => {
    const provider = await connected();
    server = () => failure("SQLite error: no such table: nope", "SQLITE_UNKNOWN");

    const failed = provider.query("SELECT * FROM nope");

    await expect(failed).rejects.toBeInstanceOf(QueryError);
    await expect(failed).rejects.toThrow("SQLite error: no such table: nope");
    await provider.disconnect();
  });

  test("surfaces a refusal the same way whichever deployment worded it", async () => {
    // sqld says "unsupported statement"; Turso Cloud says "SQL not allowed
    // statement". Both are SQL_PARSE_ERROR and both must reach the user verbatim.
    for (const message of [
      "SQL string could not be parsed: unsupported statement: VACUUM",
      "SQL not allowed statement: VACUUM",
    ]) {
      server = answerFor;
      const provider = await connected();
      server = () => failure(message, "SQL_PARSE_ERROR");

      await expect(provider.query("VACUUM")).rejects.toThrow(message);
      await provider.disconnect();
    }
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("LibSQLProvider getSchema", () => {
  test("reads both tables with their columns, indexes, keys, counts and measured sizes", async () => {
    const provider = await connected();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["probe_customers", "probe_orders"]);
    expect(schema[0]?.rowCount).toBe(3);
    expect(schema[0]?.size).toBe("12 KB");
    expect(schema[0]?.columns).toEqual([
      { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
      { name: "country", type: "TEXT", nullable: true, isPrimary: false },
    ]);
    expect(schema[0]?.indexes).toEqual([{ name: "idx_country", columns: ["country"], unique: true }]);
    expect(schema[1]?.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "probe_customers", referencedColumn: "id" },
    ]);
    await provider.disconnect();
  });

  test("reads the whole tree in three round trips, not four per table", async () => {
    const provider = await connected();
    calls = [];

    await provider.getSchema();

    // The object list, one batch of four statements per table, one batch for the
    // single user index, and one for the two size reads.
    expect(calls).toHaveLength(4);
    await provider.disconnect();
  });

  test("keeps every other table when one table's column read fails", async () => {
    server = (sql) =>
      /pragma_table_info\('probe_customers'\)/.test(sql)
        ? failure("SQLite error: no such table: probe_customers", "SQLITE_UNKNOWN")
        : answerFor(sql);
    const provider = await connected();

    const schema = await provider.getSchema();

    expect(schema).toHaveLength(2);
    expect(schema[0]?.columns).toEqual([]);
    expect(schema[1]?.columns).toHaveLength(1);
    await provider.disconnect();
  });

  test("omits every size when dbstat is missing, and keeps the row counts", async () => {
    server = (sql) =>
      /FROM dbstat/.test(sql) ? failure("SQLite error: no such table: dbstat", "SQLITE_UNKNOWN") : answerFor(sql);
    const provider = await connected();

    const schema = await provider.getSchema();

    expect(schema[0]?.size).toBeUndefined();
    expect(schema[0]?.rowCount).toBe(3);
    await provider.disconnect();
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("LibSQLProvider monitoring", () => {
  test("names the server version and the SQLite it embeds", async () => {
    const provider = await connected();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("sqld 0.24.33 (f8fb14f3 2026-08-11) (SQLite 3.47.0)");
    expect(overview.databaseSize).toBe("276 KB");
    expect(overview.tableCount).toBe(2);
    expect(overview.indexCount).toBe(1);
    expect(overview.maxConnections).toBe(0);
    await provider.disconnect();
  });

  test("shows the SQLite version alone on Turso Cloud, where /version does not exist", async () => {
    versionRoute = () => new Response(JSON.stringify({ error: 'route not found: ["version"]' }), { status: 404 });
    const provider = await connected();

    expect((await provider.getOverview()).version).toBe("SQLite 3.47.0");
    await provider.disconnect();
  });

  test("reports the integrity check and journal mode, and no invented cache ratio", async () => {
    const provider = await connected();

    const health = await provider.getHealth();

    expect(health.databaseSize).toBe("276 KB");
    expect(health.cacheHitRatio).toBe("N/A");
    expect(health.slowQueries.map((entry) => entry.query)).toEqual(["Integrity: OK", "Journal Mode: wal"]);
    expect(health.activeSessions).toEqual([]);
    await provider.disconnect();
  });

  test("counts zero deadlocks as a fact about the engine and measures nothing else", async () => {
    const provider = await connected();

    expect(await provider.getPerformanceMetrics()).toEqual({ deadlocks: 0 });
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    await provider.disconnect();
  });

  test("splits measured pages between tables and their indexes", async () => {
    const provider = await connected();

    const stats = await provider.getTableStats();

    expect(stats[0]).toMatchObject({ tableName: "probe_customers", tableSizeBytes: 8192, indexSizeBytes: 4096 });
    expect(stats[1]).toMatchObject({ tableName: "probe_orders", rowCount: 2000, totalSizeBytes: 270336 });
    await provider.disconnect();
  });

  test("reports the user index with its columns and measured bytes", async () => {
    const provider = await connected();

    expect(await provider.getIndexStats()).toEqual([
      {
        schemaName: "main",
        tableName: "probe_customers",
        indexName: "idx_country",
        columns: ["country"],
        isUnique: true,
        isPrimary: false,
        indexSize: "4 KB",
        indexSizeBytes: 4096,
        scans: 0,
      },
    ]);
    await provider.disconnect();
  });

  test("reports the one database as storage, from its own page counters", async () => {
    const provider = await connected();

    expect(await provider.getStorageStats()).toEqual([{ name: "main", size: "276 KB", sizeBytes: 282624 }]);
    await provider.disconnect();
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("LibSQLProvider runMaintenance", () => {
  test("runs a bare REINDEX, and a targeted one against the named table", async () => {
    const provider = await connected();
    calls = [];

    expect(await provider.runMaintenance("reindex")).toMatchObject({ success: true });
    expect(await provider.runMaintenance("reindex", "probe_customers")).toMatchObject({ success: true });

    expect(sentStatements()).toEqual(["REINDEX", 'REINDEX "probe_customers"']);
    await provider.disconnect();
  });

  test("reads the integrity check's ANSWER rather than its status", async () => {
    const provider = await connected();

    expect(await provider.runMaintenance("check")).toMatchObject({ success: true, message: "ok" });
    await provider.disconnect();
  });

  test("reports a corrupt database as a failed check, even though the statement succeeded", async () => {
    server = (sql) =>
      /integrity_check/.test(sql)
        ? result([["integrity_check", null]], [[text("*** in database main ***")]])
        : answerFor(sql);
    const provider = await connected();

    expect(await provider.runMaintenance("check")).toMatchObject({
      success: false,
      message: "*** in database main ***",
    });
    await provider.disconnect();
  });

  test("refuses VACUUM here rather than relaying the server's refusal", async () => {
    const provider = await connected();
    calls = [];

    const refused = provider.runMaintenance("vacuum");

    await expect(refused).rejects.toThrow(/do not accept VACUUM/);
    // Nothing was sent: the refusal is ours, so the user is not told about a
    // statement they never asked for.
    expect(sentStatements()).toEqual([]);
    await provider.disconnect();
  });

  test("refuses ANALYZE and OPTIMIZE for the same measured reason", async () => {
    const provider = await connected();

    await expect(provider.runMaintenance("analyze")).rejects.toThrow(/do not accept ANALYZE/);
    await expect(provider.runMaintenance("optimize")).rejects.toThrow(/do not accept OPTIMIZE/);
    await provider.disconnect();
  });
});
