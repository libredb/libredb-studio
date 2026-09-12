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
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { AuthenticationError, ConnectionError, DatabaseConfigError, DatabaseError, QueryError } from "@/lib/db/errors";
import { containerDepth, isCountUnavailable } from "@/lib/db/object-kinds";
import { LibSQLProvider } from "@/lib/db/providers/sql/libsql";
import { comparePaths, countLibSQLObjects, type LibSQLObjectReader } from "@/lib/db/providers/sql/libsql/objects";
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

/**
 * What the server does with one pipeline: an answer per statement, then a close.
 *
 * The bound arguments are handed over as well as the statement, because the object
 * surface binds the object NAME rather than embedding it (`pragma_table_xinfo(?, ?)`
 * is one statement for every object), so a server that saw only the SQL could not
 * answer per object - and could not tell a name bind from a container one, which is
 * the whole point of the two-level test below.
 */
type Server = (sql: string, args: unknown[]) => Cell;

let server: Server = answerFor;
let versionRoute: () => Response = () => new Response("sqld 0.24.33 (f8fb14f3 2026-08-11)", { status: 200 });

function installFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? null : String(init.body);
    calls.push({ url, body });

    if (url.endsWith("/version")) return Promise.resolve(versionRoute());

    const requests = (JSON.parse(body ?? "{}") as { requests?: { type: string; stmt?: Statement }[] }).requests;
    const results = (requests ?? [])
      .filter((request) => request.type === "execute")
      .map((request) => server(String(request.stmt?.sql), boundArgs(request.stmt)));

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

/** One statement as it left this process: what was sent, and what was bound into it. */
interface Statement {
  sql?: string;
  args?: { value?: unknown }[];
}

/** The values bound into one statement, in order, with the wire encoding unwrapped. */
function boundArgs(statement: Statement | undefined): unknown[] {
  return (statement?.args ?? []).map((arg) => arg.value);
}

/** Every statement the provider sent, with its bindings, in order. */
function sentCalls(): { sql: string; args: unknown[] }[] {
  return calls
    .filter((call) => call.body !== null)
    .flatMap((call) => {
      const requests = (JSON.parse(call.body as string) as { requests?: { stmt?: Statement }[] }).requests ?? [];
      return requests
        .filter((request) => request.stmt !== undefined)
        .map((request) => ({ sql: String(request.stmt?.sql), args: boundArgs(request.stmt) }));
    });
}

/** Every statement the provider sent, in order. */
function sentStatements(): string[] {
  return sentCalls().map((call) => call.sql);
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

// ============================================================================
// Object surface (#789, task 13)
// ----------------------------------------------------------------------------
// The fixture below is a CATALOG rather than a set of canned answers, and that is
// the whole design. Every row was captured on 2026-09-11 from a live
// `ghcr.io/tursodatabase/libsql-server:v0.24.33` (sqld 0.24.33 `40a151bd`, SQLite
// 3.45.1) built by the DDL in `docs/providers/libsql.md`, in the engine's own
// order, and the fake server applies only the predicates the statement it receives
// actually spells. So dropping a predicate from the provider does not fall through
// to an unmatched regex and a canned row set: it widens the population the way it
// would against the real server, which is what makes the mutations below die for
// the right reason.
//
// The two facts that separate this engine from `sqlite.ts` are both measured and
// both drive assertions here:
//
// - sqld REFUSES `VACUUM`, `ANALYZE`, `PRAGMA query_only`, `ATTACH DATABASE` and
//   `CREATE TEMP TABLE`, but ACCEPTS `CREATE VIEW temp.<name>` - so a `temp` object
//   shadowing a `main` one is reachable and the schema restriction is load-bearing.
// - `CREATE FUNCTION ... LANGUAGE wasm` is refused by sqld's own parser
//   ("syntax error around L1:16: `FUNCTION`"), so NO routine kind is declared.
// ============================================================================

/** One row of `PRAGMA table_list`, verbatim and in the engine's own order. */
const TABLE_LIST_ROWS: readonly { schema: string; name: string; type: string }[] = [
  { schema: "main", name: "notes_content", type: "shadow" },
  { schema: "main", name: "legacy_ref", type: "table" },
  { schema: "main", name: "legacy", type: "table" },
  { schema: "main", name: "order_summary", type: "view" },
  { schema: "main", name: "sqlite_schema", type: "table" },
  { schema: "main", name: "badges", type: "table" },
  { schema: "main", name: "orders", type: "table" },
  { schema: "main", name: "shipments", type: "table" },
  { schema: "main", name: "regions", type: "table" },
  { schema: "main", name: "notes_config", type: "shadow" },
  { schema: "main", name: "sqlite_sequence", type: "table" },
  { schema: "main", name: "archive", type: "table" },
  { schema: "main", name: "notes_idx", type: "shadow" },
  { schema: "main", name: "customers", type: "table" },
  { schema: "main", name: "sqliteXledger", type: "table" },
  { schema: "main", name: "notes_docsize", type: "shadow" },
  { schema: "main", name: "notes", type: "virtual" },
  { schema: "main", name: "notes_data", type: "shadow" },
  { schema: "temp", name: "sqlite_temp_schema", type: "table" },
];

/**
 * The same catalog with a `temp` VIEW live, which sqld really does accept.
 *
 * `CREATE TEMP VIEW` is refused by sqld's parser and `CREATE VIEW temp.orders` is
 * not, measured. The row is here so the schema restriction can be mutated: without
 * `t.schema = ?` the listing answers `orders` TWICE, two objects with one path,
 * which is the uniqueness the tree addresses rows by.
 */
const TABLE_LIST_WITH_TEMP: readonly { schema: string; name: string; type: string }[] = [
  ...TABLE_LIST_ROWS,
  { schema: "temp", name: "orders", type: "view" },
];

/**
 * The same catalog plus the two names that separate the ENGINE's order from this process's.
 *
 * Measured on a live sqld 0.24.33: `ORDER BY t.name` answers `U+E000` before `U+1F600`,
 * because SQLite's BINARY collation is the UTF-8 BYTE order (`EE 80 80` below
 * `F0 9F 98 80`), while a JavaScript sort compares UTF-16 code units and puts the surrogate
 * `0xD83D` first. So a bounded read's MEMBERSHIP is the server's and the ORDER of the
 * answer is ours, and neither can be dropped without the other showing it.
 */
const TABLE_LIST_WITH_EXOTIC: readonly { schema: string; name: string; type: string }[] = [
  ...TABLE_LIST_ROWS,
  { schema: "main", name: "\uE000", type: "table" },
  { schema: "main", name: "\u{1F600}", type: "table" },
];

/** One row of `sqlite_schema`, verbatim and in the engine's own order. */
const SQLITE_SCHEMA_ROWS: readonly { type: string; name: string; tbl_name: string }[] = [
  { type: "table", name: "customers", tbl_name: "customers" },
  { type: "table", name: "sqlite_sequence", tbl_name: "sqlite_sequence" },
  { type: "table", name: "orders", tbl_name: "orders" },
  { type: "table", name: "regions", tbl_name: "regions" },
  { type: "table", name: "archive", tbl_name: "archive" },
  { type: "table", name: "sqliteXledger", tbl_name: "sqliteXledger" },
  { type: "table", name: "notes", tbl_name: "notes" },
  { type: "table", name: "notes_data", tbl_name: "notes_data" },
  { type: "table", name: "notes_idx", tbl_name: "notes_idx" },
  { type: "table", name: "notes_content", tbl_name: "notes_content" },
  { type: "table", name: "notes_docsize", tbl_name: "notes_docsize" },
  { type: "table", name: "notes_config", tbl_name: "notes_config" },
  { type: "view", name: "order_summary", tbl_name: "order_summary" },
  { type: "index", name: "idx_orders_customer", tbl_name: "orders" },
  { type: "index", name: "idx_orders_placed", tbl_name: "orders" },
  { type: "index", name: "idx_customers_name", tbl_name: "customers" },
  { type: "trigger", name: "orders_stamp", tbl_name: "orders" },
  { type: "trigger", name: "order_summary_guard", tbl_name: "order_summary" },
  { type: "table", name: "legacy", tbl_name: "legacy" },
  { type: "table", name: "legacy_ref", tbl_name: "legacy_ref" },
  { type: "table", name: "shipments", tbl_name: "shipments" },
  { type: "table", name: "badges", tbl_name: "badges" },
  // The implicit index behind `code TEXT UNIQUE` on a ROWID table, and it IS a row of
  // `sqlite_schema` rather than an invisible structure. Measured: a WITHOUT ROWID table
  // (`regions`) produces an autoindex that `pragma_index_list` publishes and
  // `sqlite_schema` does NOT, which is exactly the shape that hid this row from an
  // earlier fixture and made the reserved-name predicate look untestable here.
  { type: "index", name: "sqlite_autoindex_badges_1", tbl_name: "badges" },
];

/**
 * `pragma_table_xinfo(name, 'main')` per object, exactly as the engine publishes it:
 * name, declared type, `notnull`, default, `pk` rank and `hidden`.
 *
 * `hidden` is carried rather than pre-applied, because two separate rules read it and both
 * are mutable. `hidden = 1` is a virtual table module's OWN interface columns, which the
 * statement excludes; `hidden = 2` is a VIRTUAL generated column and `hidden = 3` a STORED
 * one, which `pragma_table_info` drops entirely and `pragma_table_xinfo` publishes.
 * Measured: `table_info('orders')` answers four columns where `table_xinfo` answers five.
 */
interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt: string | null;
  pk: number;
  hidden: number;
}

function column(name: string, type: string, notnull: number, dflt: string | null, pk: number, hidden = 0): ColumnRow {
  return { name, type, notnull, dflt, pk, hidden };
}

const COLUMNS: Readonly<Record<string, ColumnRow[]>> = {
  orders: [
    column("id", "INTEGER", 0, null, 1),
    column("customer_id", "INTEGER", 1, null, 0),
    column("total", "REAL", 1, null, 0),
    // GENERATED ALWAYS AS (total * 0.2) VIRTUAL, so `hidden` is 2.
    column("tax", "REAL", 0, null, 0, 2),
    column("placed_at", "TEXT", 0, null, 0),
  ],
  // PRIMARY KEY (region, year): `pk` is a 1-based RANK, so `= 1` demotes `year`.
  regions: [
    column("region", "TEXT", 1, null, 1),
    column("year", "INTEGER", 1, null, 2),
    column("revenue", "REAL", 0, null, 0),
  ],
  customers: [
    column("id", "INTEGER", 0, null, 1),
    column("name", "TEXT", 1, null, 0),
    column("country", "TEXT", 0, "'TR'", 0),
  ],
  // The FTS5 table. Its declared columns carry the EMPTY STRING as their type, and the
  // module's own interface columns are `notes` and `rank` at `hidden = 1`.
  notes: [
    column("title", "", 0, null, 0),
    column("body", "", 0, null, 0),
    column("notes", "", 0, null, 0, 1),
    column("rank", "", 0, null, 0, 1),
  ],
  order_summary: [column("name", "TEXT", 0, null, 0), column("total", "REAL", 0, null, 0)],
  legacy: [column("note", "TEXT", 0, null, 0)],
  legacy_ref: [column("id", "INTEGER", 0, null, 1), column("note", "TEXT", 0, null, 0)],
  archive: [column("id", "INTEGER", 0, null, 1), column("body", "TEXT", 0, null, 0)],
  sqliteXledger: [column("id", "INTEGER", 0, null, 1), column("note", "TEXT", 0, null, 0)],
  shipments: [
    column("id", "INTEGER", 0, null, 1),
    column("order_id", "INTEGER", 0, null, 0),
    column("carrier", "TEXT", 0, null, 0),
  ],
  // Two names whose UTF-8 byte order is the OPPOSITE of their UTF-16 code-unit order, so
  // the engine's cut and this process's sort can be told apart (#789).
  "\uE000": [column("x", "INTEGER", 0, null, 0)],
  "\u{1F600}": [column("x", "INTEGER", 0, null, 0)],
  badges: [
    column("id", "INTEGER", 0, null, 1),
    column("code", "TEXT", 0, null, 0),
    column("label", "TEXT", 0, null, 0),
  ],
};

/** `pragma_index_list(name, 'main')` per object, including the implicit ones. */
const INDEX_LIST: Readonly<Record<string, [string, number][]>> = {
  orders: [
    ["idx_orders_placed", 0],
    ["idx_orders_customer", 0],
  ],
  customers: [["idx_customers_name", 1]],
  // WITHOUT ROWID with a composite primary key, so the engine made an index nobody
  // declared and nobody can drop. The `sqlite_` predicate is what removes it.
  regions: [["sqlite_autoindex_regions_1", 1]],
  // `code TEXT UNIQUE` on a ROWID table. Same exclusion, and unlike the one above this
  // index is ALSO a row of `sqlite_schema`, so it reaches the Indexes folder too.
  badges: [["sqlite_autoindex_badges_1", 1]],
};

/** `pragma_index_info(name, 'main')`, in `seqno` order. A null name is an EXPRESSION key. */
const INDEX_COLUMNS: Readonly<Record<string, (string | null)[]>> = {
  idx_orders_customer: ["customer_id"],
  // CREATE INDEX idx_orders_placed ON orders(date(placed_at)): `name` is NULL, `cid` is -2.
  idx_orders_placed: [null],
  idx_customers_name: ["name"],
  sqlite_autoindex_regions_1: ["region", "year"],
  sqlite_autoindex_badges_1: ["code"],
};

/** `pragma_foreign_key_list(name, 'main')`. A null `to` means the parent's primary key. */
const FOREIGN_KEYS: Readonly<Record<string, [number, number, string, string, string | null][]>> = {
  // REFERENCES customers, with no column list.
  orders: [[0, 0, "customers", "customer_id", null]],
  // REFERENCES legacy, whose parent declares no primary key at all.
  legacy_ref: [[0, 0, "legacy", "note", null]],
  // REFERENCES orders(id), which NAMES its column - so nothing needs the parent's key.
  shipments: [[0, 0, "orders", "order_id", "id"]],
};

/** Every kind, and how many of it `main` holds. Counted by hand off the fixture DDL. */
const EXPECTED_COUNTS = { table: 10, view: 1, index: 3, trigger: 2 } as const;

/** True when the statement carries the reserved-name predicate, escaped or not. */
function reservedPredicate(sql: string): "escaped" | "wildcard" | "none" {
  if (/NOT LIKE 'sqlite\\_%' ESCAPE '\\'/.test(sql)) return "escaped";
  if (/NOT LIKE 'sqlite_%'/.test(sql)) return "wildcard";
  return "none";
}

/** The engine's own LIKE, for the one pattern these statements use. */
function keepsName(sql: string, name: string): boolean {
  const predicate = reservedPredicate(sql);
  if (predicate === "none") return true;
  // `_` is LIKE's single-character wildcard, so the UNESCAPED pattern also matches
  // `sqliteXledger`. That is the whole reason ESCAPE is in the statement.
  return predicate === "escaped" ? !name.startsWith("sqlite_") : !/^sqlite.{1}/.test(name);
}

/** The `type IN (...)` or `type = '...'` set the statement actually spells. */
function selectedTypes(sql: string): string[] | null {
  const list = /t\.type IN \(([^)]*)\)/.exec(sql);
  if (list) return [...list[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  const single = /t\.type = '([^']*)'/.exec(sql);
  return single ? [single[1]] : null;
}

/**
 * `PRAGMA table_list` as the engine answers it, narrowed by the predicates the
 * statement spells and by nothing else.
 *
 * The schema filter applies only when `t.schema = ?` is present, so a provider that
 * stopped restricting to `main` sees `temp` here exactly as it would see it live.
 */
function tableListRows(sql: string, args: unknown[], rows: typeof TABLE_LIST_ROWS): string[][] {
  const types = selectedTypes(sql);
  const schema = /t\.schema = \?/.test(sql) ? args[0] : null;
  return rows
    .filter((row) => schema === null || row.schema === schema)
    .filter((row) => types === null || types.includes(row.type))
    .filter((row) => keepsName(sql, row.name))
    .map((row) => (/AS kind/.test(sql) ? [row.type === "view" ? "view" : "table"] : [row.name]));
}

/** `sqlite_schema` as the engine answers it, narrowed the same way. */
function sqliteSchemaRows(sql: string, rows: typeof SQLITE_SCHEMA_ROWS): typeof SQLITE_SCHEMA_ROWS {
  const list = /s\.type IN \(([^)]*)\)/.exec(sql);
  const single = /s\.type = '([^']*)'/.exec(sql);
  const types = list ? [...list[1].matchAll(/'([^']*)'/g)].map((match) => match[1]) : single ? [single[1]] : null;
  return rows.filter((row) => types === null || types.includes(row.type)).filter((row) => keepsName(sql, row.name));
}

/** A `{ kind, n }` result built the way the GROUP BY does. */
function groupedCounts(sql: string, args: unknown[], catalog: Catalog): Cell {
  const kinds = [
    ...tableListRows(sql, args, catalog.tableList).map((row) => row[0]),
    ...sqliteSchemaRows(sql, catalog.sqliteSchema).map((row) => row.type),
  ];
  const tally = new Map<string, number>();
  for (const kind of kinds) tally.set(kind, (tally.get(kind) ?? 0) + 1);
  return result(
    [
      ["kind", "TEXT"],
      ["n", null],
    ],
    [...tally].map(([kind, n]) => [text(kind), int(n)]),
  );
}

/** Which rows of a keyed fixture one statement asks for, or none at all. */
function lookup<T>(table: Readonly<Record<string, T[]>>, key: unknown): T[] {
  return table[String(key)] ?? [];
}

/** The two catalogs one object-surface test runs against. */
interface Catalog {
  tableList: typeof TABLE_LIST_ROWS;
  sqliteSchema: typeof SQLITE_SCHEMA_ROWS;
}

const FIXTURE: Catalog = { tableList: TABLE_LIST_ROWS, sqliteSchema: SQLITE_SCHEMA_ROWS };

/**
 * Two names in the order SQLite's BINARY collation puts them, which is the UTF-8 BYTE
 * order and NOT JavaScript's UTF-16 code-unit order. Measured on a live sqld 0.24.33.
 */
function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** The name a flat-surface statement embeds as a LITERAL rather than binding. */
function literalArg(sql: string): string | undefined {
  return /pragma_\w+\('([^']*)'\)/.exec(sql)?.[1];
}

/**
 * The parent key column an unnamed foreign key resolves to, as the correlated subquery in
 * `OBJECT_FOREIGN_KEYS_SQL` resolves it: the parent's key column whose 1-based `pk` rank is
 * `seq + 1`. `legacy` declares no primary key at all, so it answers null.
 */
function parentKey(parent: string, seq: number): string | null {
  const keys = lookup(COLUMNS, parent)
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk);
  return keys[seq]?.name ?? null;
}

/**
 * The five statements of the BULK column read, answered off the same fixture the single
 * read answers off (#789).
 *
 * Written as one arm rather than five, because all five carry the same target CTE and the
 * point of the fake is that they cut the SAME set: the target is derived here once and the
 * four detail statements are answered against it. What this arm cannot see is a rewrite of
 * the SQL itself (standing ruling 5b), which is why the whole method was also run against a
 * live `ghcr.io/tursodatabase/libsql-server:v0.24.33` - see docs/providers/libsql.md.
 */
function bulkRows(sql: string, args: unknown[], catalog: Catalog): Cell | null {
  if (!/WITH described AS/.test(sql)) return null;
  const types = selectedTypes(sql) ?? [];
  // `?` are positional and the type list is a LITERAL list, the same spelling the folder's
  // own listing carries, so the only binds before the LIMIT are the schema.
  const limit = /LIMIT \?/.test(sql) ? Number(args[1]) : undefined;
  const ordered = catalog.tableList
    .filter((row) => row.schema === args[0])
    .filter((row) => types.includes(row.type))
    .filter((row) => keepsName(sql, row.name))
    .map((row) => row.name);
  // `ORDER BY t.name` is APPLIED here rather than assumed, and under the engine's own
  // collation. Measured against a live sqld 0.24.33: the sort is BINARY, the UTF-8 BYTE
  // order, so `U+E000` (EE 80 80) comes back before `U+1F600` (F0 9F 98 80) - the opposite
  // of a JavaScript sort, which compares UTF-16 code units and puts the surrogate 0xD83D
  // first. Without applying it here, dropping the clause from the statement could not be
  // mutated, and the two orders could not be told apart at all.
  const targets = (/ORDER BY t\.name/.test(sql) ? [...ordered].sort(byteOrder) : ordered).slice(0, limit);

  const cols = (names: string[]): [string, string | null][] => names.map((name) => [name, null]);
  const rows = (names: string[], values: (Cell | null)[][]): Cell =>
    result(
      cols(names),
      values.map((row) => row.map((cell) => cell ?? { type: "null" })),
    );

  if (/JOIN pragma_table_xinfo/.test(sql)) {
    return rows(
      ["object_name", "name", "type", "notnull", "dflt_value", "pk"],
      targets.flatMap((object) =>
        lookup(COLUMNS, object)
          .filter((row) => !/hidden <> 1/.test(sql) || row.hidden !== 1)
          .map((row) => [
            text(object),
            text(row.name),
            text(row.type),
            int(row.notnull),
            row.dflt === null ? null : text(row.dflt),
            int(row.pk),
          ]),
      ),
    );
  }
  if (/JOIN pragma_index_info/.test(sql)) {
    return rows(
      ["object_name", "index_name", "name"],
      targets.flatMap((object) =>
        lookup(INDEX_LIST, object)
          .filter(([name]) => keepsName(sql, name))
          .flatMap(([index]) =>
            lookup(INDEX_COLUMNS, index).map((column) => [
              text(object),
              text(index),
              column === null ? null : text(column),
            ]),
          ),
      ),
    );
  }
  if (/JOIN pragma_index_list/.test(sql)) {
    return rows(
      ["object_name", "name", "unique"],
      targets.flatMap((object) =>
        (/ORDER BY d\.object_name, i\.name/.test(sql)
          ? [...lookup(INDEX_LIST, object)].sort(([left], [right]) => byteOrder(left, right))
          : lookup(INDEX_LIST, object)
        )
          .filter(([name]) => keepsName(sql, name))
          .map(([name, unique]) => [text(object), text(name), int(unique)]),
      ),
    );
  }
  if (/JOIN pragma_foreign_key_list/.test(sql)) {
    return rows(
      ["object_name", "id", "seq", "table", "from", "to", "parent_key"],
      targets.flatMap((object) =>
        lookup(FOREIGN_KEYS, object).map(([id, seq, parent, from, to]) => {
          const key = parentKey(parent, seq);
          return [
            text(object),
            int(id),
            int(seq),
            text(parent),
            text(from),
            to === null ? null : text(to),
            key === null ? null : text(key),
          ];
        }),
      ),
    );
  }
  return rows(
    ["object_name"],
    targets.map((object) => [text(object)]),
  );
}

/**
 * The FLAT reading, answered off the SAME fixture the object reading answers off (#789).
 *
 * Without it `getSchema()` here answers the two `probe_*` tables of the recorded
 * connection payloads, which share no name with any object this fixture publishes - so the
 * conformance helper's join guard could only report the two readings as two populations.
 * A fixture that puts one object in front of both surfaces is the whole point of that
 * guard, and answering the flat read from a different catalog is the thing it exists to
 * catch.
 *
 * Two differences from the object reading are the ENGINE's and are kept rather than
 * smoothed away: the flat read is over `sqlite_master`, so it sees the FTS5 shadow tables
 * as ordinary tables, and its `NOT LIKE 'sqlite_%'` carries no `ESCAPE`, so it also drops
 * `sqliteXledger`, a name a user can really have. Both are why the object surface reads
 * `PRAGMA table_list` and escapes its wildcard.
 */
function flatRows(sql: string, catalog: Catalog): Cell | null {
  if (/FROM sqlite_master/.test(sql) && /type = 'table'/.test(sql) && /SELECT name/.test(sql)) {
    const names = catalog.sqliteSchema
      .filter((row) => row.type === "table")
      .map((row) => row.name)
      .filter((name) => !/^sqlite.{1}/.test(name))
      .sort();
    return result(
      [["name", "TEXT"]],
      names.map((name) => [text(name)]),
    );
  }
  if (/^SELECT COUNT\(\*\) AS row_count/.test(sql.trim())) {
    return result([["row_count", null]], [[int(0)]]);
  }
  const name = literalArg(sql);
  if (name === undefined) return null;
  if (/pragma_table_info/.test(sql)) {
    return result(
      [
        ["cid", null],
        ["name", null],
        ["type", null],
        ["notnull", null],
        ["dflt_value", null],
        ["pk", null],
      ],
      lookup(COLUMNS, name)
        // `table_info` and not `table_xinfo`: the flat surface loses a generated column,
        // which is the defect the object surface's `table_xinfo` does not have.
        .filter((row) => row.hidden === 0)
        .map((row, cid) => [
          int(cid),
          text(row.name),
          text(row.type),
          int(row.notnull),
          row.dflt === null ? { type: "null" } : text(row.dflt),
          int(row.pk),
        ]),
    );
  }
  if (/pragma_index_list/.test(sql)) {
    return result(
      [
        ["seq", null],
        ["name", null],
        ["unique", null],
        ["origin", null],
      ],
      lookup(INDEX_LIST, name).map(([index, unique], seq) => [int(seq), text(index), int(unique), text("c")]),
    );
  }
  if (/pragma_index_info/.test(sql)) {
    return result(
      [
        ["seqno", null],
        ["cid", null],
        ["name", null],
      ],
      lookup(INDEX_COLUMNS, name).map((column, seqno) => [
        int(seqno),
        int(seqno),
        column === null ? { type: "null" } : text(column),
      ]),
    );
  }
  if (/pragma_foreign_key_list/.test(sql)) {
    return result(
      [
        ["id", null],
        ["seq", null],
        ["table", null],
        ["from", null],
        ["to", null],
      ],
      lookup(FOREIGN_KEYS, name).map(([id, seq, parent, from, to]) => [
        int(id),
        int(seq),
        text(parent),
        text(from),
        to === null ? { type: "null" } : text(to),
      ]),
    );
  }
  return null;
}

/** The catalog every object-surface test runs against. */
function objectServer(catalog: Catalog = FIXTURE): Server {
  return (sql, args) => {
    const bulk = bulkRows(sql, args, catalog);
    if (bulk !== null) return bulk;
    if (/GROUP BY kind/.test(sql)) return groupedCounts(sql, args, catalog);
    if (/pragma_table_list/.test(sql)) {
      return result(
        [["name", null]],
        tableListRows(sql, args, catalog.tableList).map((row) => [text(row[0])]),
      );
    }
    if (/FROM sqlite_schema AS s/.test(sql)) {
      const selected = sqliteSchemaRows(sql, catalog.sqliteSchema);
      if (/s\.tbl_name AS parent/.test(sql)) {
        return result(
          [
            ["name", "TEXT"],
            ["parent", "TEXT"],
          ],
          selected.map((row) => [text(row.name), text(row.tbl_name)]),
        );
      }
      return result(
        [["name", "TEXT"]],
        selected.map((row) => [text(row.name)]),
      );
    }
    if (/pragma_foreign_key_list/.test(sql)) {
      // `args[1]`, not `args[0]`: the statement's first placeholder belongs to the
      // parent-key subquery, which SQLite numbers first because the select list is written
      // before the FROM. A fake reading `args[0]` would answer the SCHEMA's foreign keys,
      // which is nothing, and every foreign key assertion would quietly go vacuous.
      const object = args[1];
      return result(
        [
          ["id", null],
          ["seq", null],
          ["table", null],
          ["from", null],
          ["to", null],
          ["parent_key", null],
        ],
        lookup(FOREIGN_KEYS, object).map(([id, seq, parent, from, to]) => {
          const key = parentKey(parent, seq);
          return [
            int(id),
            int(seq),
            text(parent),
            text(from),
            to === null ? { type: "null" } : text(to),
            key === null ? { type: "null" } : text(key),
          ];
        }),
      );
    }
    // BEFORE the `pragma_table_x?info` branch, and that order is load-bearing: the foreign
    // key statement resolves the parent's key with a correlated `pragma_table_info`, so a
    // column-shaped answer would win and every foreign key would read as empty.
    if (/pragma_table_x?info/.test(sql)) {
      // `table_info` publishes only the ordinary columns and `table_xinfo` publishes the
      // hidden ones too; then the statement's own `hidden <> 1` narrows what it asked for.
      const published = lookup(COLUMNS, args[0]).filter((row) => /pragma_table_xinfo/.test(sql) || row.hidden === 0);
      const selected = published.filter((row) => !/hidden <> 1/.test(sql) || row.hidden !== 1);
      if (/pk > 0/.test(sql)) {
        const keys = selected.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk);
        return result(
          [["name", null]],
          keys.map((row) => [text(row.name)]),
        );
      }
      return result(
        [
          ["name", null],
          ["type", null],
          ["notnull", null],
          ["dflt_value", null],
          ["pk", null],
        ],
        selected.map((row) => [
          text(row.name),
          text(row.type),
          int(row.notnull),
          row.dflt === null ? { type: "null" } : text(row.dflt),
          int(row.pk),
        ]),
      );
    }
    if (/pragma_index_list/.test(sql)) {
      // `INDEX_LIST` is captured in the ENGINE's own order, which is reverse creation
      // order, and the statement's `ORDER BY name` is applied here rather than assumed:
      // dropping it from the statement has to change what this fake answers, or the clause
      // that keeps the single and the bulk read agreeing could not be mutated (#789).
      const listed = lookup(INDEX_LIST, args[0]).filter(([name]) => keepsName(sql, name));
      const ordered = /ORDER BY name/.test(sql)
        ? [...listed].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        : listed;
      return result(
        [
          ["name", null],
          ["unique", null],
        ],
        ordered.map(([name, unique]) => [text(name), int(unique)]),
      );
    }
    if (/pragma_index_info/.test(sql)) {
      return result(
        [["name", null]],
        lookup(INDEX_COLUMNS, args[0]).map((name) => [name === null ? { type: "null" } : text(name)]),
      );
    }
    const flat = flatRows(sql, catalog);
    if (flat !== null) return flat;
    return answerFor(sql);
  };
}

/** A connected provider whose server answers the object catalog above. */
async function connectedWithObjects(catalog: Catalog = FIXTURE): Promise<LibSQLProvider> {
  server = objectServer(catalog);
  const provider = new LibSQLProvider(connection());
  await provider.connect();
  calls = [];
  return provider;
}

describe("LibSQLProvider object surface (#789)", () => {
  let objects: LibSQLProvider;

  afterEach(async () => {
    if (objects?.isConnected()) await objects.disconnect();
  });

  test("declares the four kinds libSQL has, at zero container levels, and no routine kind", async () => {
    objects = await connectedWithObjects();
    const capabilities = objects.getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id)).toEqual(["table", "view", "index", "trigger"]);
    expect(kinds.find((kind) => kind.id === "table")?.role).toBe("relation");
    expect(kinds.find((kind) => kind.id === "table")?.acceptsRowWrites).toBe(true);
    expect(kinds.find((kind) => kind.id === "view")?.role).toBe("relation");
    expect(kinds.find((kind) => kind.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "index")?.role).toBe("config");
    expect(kinds.find((kind) => kind.id === "trigger")?.role).toBe("attached");
    expect(kinds.find((kind) => kind.id === "trigger")?.attachedTo).toBe("table");
    // NO `function` kind, which the brief made conditional on the server accepting
    // `CREATE FUNCTION ... LANGUAGE wasm`. Measured on the image `database-compose.yml`
    // pins: sqld's own parser refuses it ("syntax error around L1:16: `FUNCTION`"),
    // `libsql_wasm_func_table` does not exist and `sqld --help` carries no wasm flag.
    // A declared kind that always counts zero is a folder for something the engine
    // cannot do; an undeclared one is the honest answer.
    for (const absent of ["function", "procedure", "routine", "sequence", "package", "event"]) {
      expect(kinds.find((kind) => kind.id === absent)).toBeUndefined();
    }
    expect(capabilities.containerLevels).toEqual([]);
    expect(containerDepth(capabilities)).toBe(0);
  });

  test("satisfies the object-surface conformance contract", async () => {
    objects = await connectedWithObjects();

    await assertObjectSurface(objects, {
      containers: [],
      kinds: { ...EXPECTED_COUNTS },
      sampleObject: { path: ["orders"], kind: "table" },
    });
  });

  test("listContainers answers an empty array, which is an answer and not a refusal", async () => {
    objects = await connectedWithObjects();

    await expect(objects.listContainers()).resolves.toEqual([]);
    // An answer, not a declaration read: it is not answerable off a provider that
    // never connected, and it costs no round trip when it is.
    expect(calls).toEqual([]);
    await expect(new LibSQLProvider(connection()).listContainers()).rejects.toThrow();
  });

  // --------------------------------------------------------------------------
  // What the counts and the listings enumerate
  // --------------------------------------------------------------------------

  test("a shadow table is not an object, and a virtual table is", async () => {
    objects = await connectedWithObjects();

    // The control, measured live: `sqlite_schema` types an FTS5 table's five shadow
    // tables `table`, so a naive scan answers 16 where the engine holds 10.
    const naive = SQLITE_SCHEMA_ROWS.filter((row) => row.type === "table");
    expect(naive).toHaveLength(16);
    expect(naive.map((row) => row.name)).toContain("notes_data");

    const tables = await objects.listObjects([], "table");

    expect(tables.map((table) => table.name)).toEqual([
      "archive",
      "badges",
      "customers",
      "legacy",
      "legacy_ref",
      "notes",
      "orders",
      "regions",
      "shipments",
      "sqliteXledger",
    ]);
    expect((await objects.countObjects([])).table).toEqual({ count: EXPECTED_COUNTS.table });
  });

  test("every value PRAGMA table_list can answer has a rule, and the fixture holds all four", async () => {
    // Standing ruling 5a: the vocabulary is SQLite's documented four values, not a
    // `SELECT DISTINCT` over whatever this fixture happens to hold. The fixture is
    // built to contain all four so the rule is exercised rather than asserted, and the
    // live catalog this was captured from answers exactly these four.
    objects = await connectedWithObjects();

    expect([...new Set(TABLE_LIST_ROWS.map((row) => row.type))].sort()).toEqual(["shadow", "table", "view", "virtual"]);

    const names = (await objects.listObjects([], "table")).map((object) => object.name);
    const views = (await objects.listObjects([], "view")).map((object) => object.name);

    // `virtual` is a table, `shadow` is nothing, `view` is a view, `table` is a table.
    expect(names).toContain("notes");
    expect(names).toContain("orders");
    expect(names.filter((name) => name.startsWith("notes_"))).toEqual([]);
    expect(views).toEqual(["order_summary"]);
  });

  test("the names libSQL reserves for itself are not objects, and ESCAPE is what makes that true", async () => {
    objects = await connectedWithObjects();

    const tables = (await objects.listObjects([], "table")).map((object) => object.name);

    // Present: a user CAN create this name, and the unescaped `LIKE 'sqlite_%'` would
    // swallow it because `_` is LIKE's single-character wildcard.
    expect(tables).toContain("sqliteXledger");
    // Absent: `sqlite_sequence` appears the moment a table declares AUTOINCREMENT, and
    // `sqlite_schema` is a row of `PRAGMA table_list` on every database there is.
    expect(tables).not.toContain("sqlite_sequence");
    expect(tables).not.toContain("sqlite_schema");
  });

  test("an index the engine created for itself is not an object, and it IS a row of sqlite_schema", async () => {
    // The reserved-name predicate on the INDEX listing, pinned by BEHAVIOUR.
    //
    // An earlier version of this suite claimed it could not be: the fixture's only
    // implicit index belonged to `regions`, a WITHOUT ROWID table, whose autoindex
    // `pragma_index_list` publishes and `sqlite_schema` does NOT. That one shape is the
    // exception. Measured on sqld 0.24.33, `code TEXT UNIQUE` on an ordinary ROWID table
    // puts `sqlite_autoindex_badges_1` straight into `sqlite_schema` as an `index` row,
    // so the predicate removes a real row here and a test can see it.
    objects = await connectedWithObjects();

    // The control, and the non-vacuity guard: the catalog really does hold the row this
    // test exists to exclude, so the assertions below are not about an empty population.
    const catalogIndexes = SQLITE_SCHEMA_ROWS.filter((row) => row.type === "index");
    expect(catalogIndexes.map((row) => row.name)).toContain("sqlite_autoindex_badges_1");

    const listed = await objects.listObjects([], "index");
    const counts = await objects.countObjects([]);

    expect(listed.map((index) => index.name)).toEqual([
      "idx_customers_name",
      "idx_orders_customer",
      "idx_orders_placed",
    ]);
    // The badge counts what the folder lists, one row fewer than the catalog holds.
    expect(counts.index).toEqual({ count: catalogIndexes.length - 1 });
    // And the same predicate applies inside the object's own detail, so the two surfaces
    // cannot disagree about what an index is.
    expect(await objects.describeObject(["badges"], "table")).toMatchObject({ indexes: [] });
  });

  test("a temp object shadowing a main one never reaches the tree, which sqld really can produce", async () => {
    // sqld refuses `CREATE TEMP VIEW` and accepts `CREATE VIEW temp.orders`, measured.
    // Without `t.schema = ?` the listing then answers `orders` twice under one path.
    objects = await connectedWithObjects({ ...FIXTURE, tableList: TABLE_LIST_WITH_TEMP });

    const views = await objects.listObjects([], "view");
    const tables = await objects.listObjects([], "table");

    expect(views.map((view) => view.path)).toEqual([["order_summary"]]);
    expect(tables.filter((table) => table.name === "orders")).toHaveLength(1);
    // And the COUNT is restricted by the same predicate, or the badge says 2 while the
    // folder holds 1 - a badge disagreeing with its own folder (standing ruling 5f).
    expect((await objects.countObjects([])).view).toEqual({ count: 1 });
    // And the bind is `main`, on the statement rather than in it.
    expect(sentCalls().every((call) => !/pragma_table_list/.test(call.sql) || call.args[0] === "main")).toBe(true);
  });

  test("the listing contains exactly what the count counted, for every declared kind", async () => {
    // Standing ruling 5f. A badge comes from `countObjects` and a folder from
    // `listObjects`, and the two read different statements, so nothing but a test
    // keeps them enumerating the same population.
    objects = await connectedWithObjects();
    const counts = await objects.countObjects([]);

    for (const [kind, expected] of Object.entries(EXPECTED_COUNTS)) {
      const listed = await objects.listObjects([], kind);
      expect(counts[kind]).toEqual({ count: expected });
      expect(listed).toHaveLength(expected);
    }
  });

  test("a trigger nests under the object it fires on, view or table", async () => {
    objects = await connectedWithObjects();

    const triggers = await objects.listObjects([], "trigger");

    // `attachedTo: "table"` names the kind a trigger usually hangs off; sqld accepts an
    // INSTEAD OF trigger on a VIEW and `sqlite_schema.tbl_name` then names the view.
    // Both the count and the listing carry it rather than one of them dropping it.
    expect(triggers.map((trigger) => trigger.path)).toEqual([
      ["order_summary", "order_summary_guard"],
      ["orders", "orders_stamp"],
    ]);
    expect(triggers.every((trigger) => trigger.kind === "trigger")).toBe(true);
  });

  test("a listing is sorted by path here, which the engine's own order is not", async () => {
    objects = await connectedWithObjects();

    // Measured: `PRAGMA table_list` answers in PAGE order rather than name order. The exact
    // sequence is a property of one build - the same DDL replayed into a fresh container
    // produced a different one - so what is pinned here is that the fixture's captured
    // order is NOT sorted, which is what makes the assertion below non-vacuous.
    const catalogOrder = TABLE_LIST_ROWS.filter((row) => row.type === "table").map((row) => row.name);
    expect(catalogOrder).not.toEqual([...catalogOrder].sort());

    const tables = await objects.listObjects([], "table");

    expect(tables.map((table) => table.name)).toEqual([...tables.map((table) => table.name)].sort());
    expect(tables[0]?.name).toBe("archive");
  });

  // --------------------------------------------------------------------------
  // describeObject
  // --------------------------------------------------------------------------

  test("describes a table with its generated column and its composite primary key", async () => {
    objects = await connectedWithObjects();

    const orders = await objects.describeObject(["orders"], "table");
    const regions = await objects.describeObject(["regions"], "table");

    expect(orders.path).toEqual(["orders"]);
    // `tax` is GENERATED ALWAYS AS ... VIRTUAL. `pragma_table_info` drops it and
    // `table_xinfo` publishes it, which is why the object surface reads the latter.
    expect(orders.columns.map((column) => column.name)).toEqual(["id", "customer_id", "total", "tax", "placed_at"]);
    expect(orders.columns.find((column) => column.name === "customer_id")?.nullable).toBe(false);
    expect(orders.columns.find((column) => column.name === "placed_at")?.nullable).toBe(true);
    // `pk` is a 1-based RANK, not a flag: `= 1` would report `year` as ordinary.
    expect(regions.columns.filter((column) => column.isPrimary).map((column) => column.name)).toEqual([
      "region",
      "year",
    ]);
  });

  test("a default value is the engine's own literal, and an absent one is absent", async () => {
    objects = await connectedWithObjects();

    const customers = await objects.describeObject(["customers"], "table");

    expect(customers.columns.find((column) => column.name === "country")?.defaultValue).toBe("'TR'");
    expect(customers.columns.find((column) => column.name === "name")?.defaultValue).toBeUndefined();
  });

  test("describes a view, which has columns and neither indexes nor foreign keys", async () => {
    objects = await connectedWithObjects();

    const detail = await objects.describeObject(["order_summary"], "view");

    expect(detail.columns.map((column) => column.name)).toEqual(["name", "total"]);
    expect(detail.indexes).toEqual([]);
    expect(detail.foreignKeys).toEqual([]);
  });

  test("a virtual table describes its declared columns, with the type the engine actually gave", async () => {
    objects = await connectedWithObjects();

    const detail = await objects.describeObject(["notes"], "table");

    expect(detail.columns.map((column) => column.name)).toEqual(["title", "body"]);
    // The EMPTY STRING, which is what an FTS5 column's declared type is. `getSchema()`
    // writes "TEXT" there, which is a guess about affinity rather than an answer.
    expect(detail.columns.map((column) => column.type)).toEqual(["", ""]);
  });

  test("a table's indexes exclude the implicit ones, and an expression key has no column name", async () => {
    objects = await connectedWithObjects();

    const orders = await objects.describeObject(["orders"], "table");
    const regions = await objects.describeObject(["regions"], "table");

    // BY NAME, which is this read's own `ORDER BY` and not `pragma_index_list`'s: measured
    // on sqld 0.24.33, that pragma answers in reverse creation order, so it would put
    // `idx_orders_placed` first. The bulk read has to order by the object to group its
    // rows, and two orders over one table's indexes is a disagreement between the two
    // surfaces (#789).
    expect(orders.indexes).toEqual([
      { name: "idx_orders_customer", columns: ["customer_id"], unique: false },
      { name: "idx_orders_placed", columns: [], unique: false },
    ]);
    // `sqlite_autoindex_regions_1` serves the composite primary key of a WITHOUT ROWID
    // table. Nobody declared it and nobody can drop it, and the Indexes folder excludes
    // it by the same predicate, so the two surfaces cannot disagree.
    expect(regions.indexes).toEqual([]);
  });

  test("a foreign key that names no column resolves to the parent's primary key", async () => {
    objects = await connectedWithObjects();

    const detail = await objects.describeObject(["orders"], "table");

    // `REFERENCES customers` answers `to = NULL`, which SQLite reads as the parent's
    // PRIMARY KEY. `ForeignKeySchema.referencedColumn` is a string, so the alternative
    // is a null in a typed string field.
    expect(detail.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });

  test("a foreign key whose parent has no primary key carries no referenced column", async () => {
    objects = await connectedWithObjects();

    const detail = await objects.describeObject(["legacy_ref"], "table");

    // A parent with no primary key is a schema SQLite accepts and rejects only on
    // INSERT, so there is nothing to name and the field is empty rather than invented.
    expect(detail.foreignKeys).toEqual([{ columnName: "note", referencedTable: "legacy", referencedColumn: "" }]);
  });

  test("no foreign key costs a parent read of its own, whether it names its column or not", async () => {
    // The other half of the resolution rule, and the half a fixture of all-implicit keys
    // cannot see: `REFERENCES orders(id)` answers `to = 'id'`, so nothing has to be
    // resolved at all. Neither half costs a request any more - the parent's key is a
    // correlated subquery inside the foreign key statement (#789), which is what lets the
    // bulk read describe a whole folder without a statement per distinct parent.
    objects = await connectedWithObjects();

    const detail = await objects.describeObject(["shipments"], "table");

    expect(detail.foreignKeys).toEqual([{ columnName: "order_id", referencedTable: "orders", referencedColumn: "id" }]);
    // `shipments` declares no index either, so the second batch is empty and costs no
    // The pragma matched is the LAST `FROM pragma_*` in each statement, because the foreign
    // key statement also names `pragma_table_info` inside its parent-key subquery, and the
    // subquery is written before the outer FROM.
    expect(sentCalls().map((call) => [...call.sql.matchAll(/FROM pragma_(\w+)/g)].pop()?.[1])).toEqual([
      "table_xinfo",
      "index_list",
      "foreign_key_list",
    ]);
  });

  test("an index and a trigger describe as three empty arrays, without a round trip", async () => {
    objects = await connectedWithObjects();

    const index = await objects.describeObject(["idx_orders_customer"], "index");
    const trigger = await objects.describeObject(["orders", "orders_stamp"], "trigger");

    expect(index).toEqual({ path: ["idx_orders_customer"], columns: [], indexes: [], foreignKeys: [] });
    expect(trigger).toEqual({ path: ["orders", "orders_stamp"], columns: [], indexes: [], foreignKeys: [] });
    // A true fact about those kinds rather than a failed read: nothing was sent.
    expect(calls).toEqual([]);
  });

  test("a relation is described in two round trips, not one per index and parent", async () => {
    // The difference from the SQLite provider, and the reason it is not a copy: there
    // every read is a call into a file handle, and here every read is a request across
    // a network. One batch asks for the columns, the index list and the foreign keys;
    // one more asks for every index's columns.
    objects = await connectedWithObjects();

    await objects.describeObject(["orders"], "table");

    expect(calls).toHaveLength(2);
    expect(sentCalls().map((call) => call.args)).toEqual([
      ["orders", "main"],
      ["orders", "main"],
      // THREE binds, and the schema first: the foreign key statement's first placeholder
      // belongs to the parent-key subquery, because SQLite numbers placeholders by where
      // they appear in the text and the select list is written before the FROM. Passing
      // the two-value array here is what sqld answers "Arguments do not match SQL
      // parameters: value for parameter 3 not found" to - measured against a live server,
      // and invisible to any fake that does not count binds (#789).
      ["main", "orders", "main"],
      ["idx_orders_customer", "main"],
      ["idx_orders_placed", "main"],
    ]);
  });

  test("a catalog row with no name is refused rather than addressed by an empty segment", async () => {
    // `readText(...) ?? ""` is the obvious spelling and it MASKS: the row would become an
    // object whose last path segment is the empty string, which the tree would draw, let a
    // user click, and then describe as nothing. Every one of these catalog columns is NOT
    // NULL, so this is unreachable on the engine - which is precisely why a silent default
    // would never be noticed if it ever stopped being unreachable.
    objects = await connectedWithObjects();
    server = () => result([["name", "TEXT"]], [[{ type: "null" }]]);

    const refusal = await objects.listObjects([], "index").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DatabaseError);
    expect((refusal as DatabaseError).message).toBe("libSQL answered a index row with no name");
    // Naming the statement, so whoever reads it knows which of the four listings produced
    // the row rather than being told only that something was nameless.
    expect((refusal as DatabaseError).query).toContain("s.type = 'index'");
  });

  test("a trigger row with no parent is refused rather than promoted to the top level", async () => {
    // The parent is half of an attached kind's ADDRESS, so losing it is not a cosmetic
    // gap: the trigger would come back as `["orders_stamp"]`, a top-level row sitting
    // beside the tables. Which kinds require one is read off `attachedTo` rather than off
    // whether the column is present, so the three unattached listings are unaffected.
    objects = await connectedWithObjects();
    server = () =>
      result(
        [
          ["name", "TEXT"],
          ["parent", "TEXT"],
        ],
        [[text("orders_stamp"), { type: "null" }]],
      );

    await expect(objects.listObjects([], "trigger")).rejects.toThrow(/libSQL answered a trigger parent with no name/);
    // The control: the same null in the column the other three kinds do not select is not
    // an error, because absent is what "this kind does not nest" looks like.
    await expect(objects.listObjects([], "index")).resolves.toEqual([
      { path: ["orders_stamp"], name: "orders_stamp", kind: "index" },
    ]);
  });

  test("an object that is not there is a failed read and says so", async () => {
    objects = await connectedWithObjects();

    // Zero columns cannot be a real answer: SQLite refuses `CREATE TABLE t()`, so every
    // table and every view has at least one column.
    await expect(objects.describeObject(["nowhere"], "table")).rejects.toThrow(/No libSQL table named nowhere/);
  });

  // --------------------------------------------------------------------------
  // Declarations, shapes and refusals
  // --------------------------------------------------------------------------

  test("a kind the database holds none of still draws its folder, badged zero", async () => {
    // A database with tables and nothing else: no view, no index, no trigger.
    objects = await connectedWithObjects({
      tableList: TABLE_LIST_ROWS.filter((row) => row.type !== "view"),
      sqliteSchema: SQLITE_SCHEMA_ROWS.filter((row) => row.type === "table"),
    });

    const counts = await objects.countObjects([]);

    // Every declared kind is seeded at zero before a row overwrites it. Building the
    // record from the GROUP BY rows alone would leave the kind out entirely, and an
    // absent kind means something else and stronger: the engine has no such concept.
    expect(counts).toEqual({
      table: { count: EXPECTED_COUNTS.table },
      view: { count: 0 },
      index: { count: 0 },
      trigger: { count: 0 },
    });
  });

  test("a kind libSQL does not declare is refused by name, in both methods", async () => {
    objects = await connectedWithObjects();

    await expect(objects.listObjects([], "procedure")).rejects.toThrow(/libSQL declares no object kind "procedure"/);
    await expect(objects.describeObject(["x"], "procedure")).rejects.toThrow(
      /libSQL declares no object kind "procedure"/,
    );
  });

  test("a kind that is declared but has no listing statement says so, not that it is undeclared", async () => {
    // Two guards, two different facts, and the message must not confuse them. The
    // DECLARATION decides whether a kind exists; whether this file can list it is a gap in
    // this file. Reporting the second as the first would send whoever reads it looking at
    // `objectKinds` for a kind that is right there.
    objects = await connectedWithObjects();
    const real = objects.getCapabilities();
    spyOn(objects, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [...(real.objectKinds ?? []), { id: "sequence", role: "config", label: "S", labelPlural: "S" }],
    });

    await expect(objects.listObjects([], "sequence")).rejects.toThrow(
      /libSQL declares the kind "sequence" but has no statement that lists it/,
    );
    // The control: a kind nothing declares still reports the other sentence.
    await expect(objects.listObjects([], "procedure")).rejects.toThrow(/declares no object kind "procedure"/);
  });

  test("a container path of another engine's shape is refused rather than read", async () => {
    objects = await connectedWithObjects();

    // Awaited one at a time rather than built into an array first: a rejected promise
    // that waits a tick for its handler is an unhandled rejection under bun.
    await expect(objects.countObjects(["main"])).rejects.toThrow(
      /A libSQL container path is empty, received \["main"\]/,
    );
    await expect(objects.listObjects(["main"], "table")).rejects.toThrow(
      /A libSQL container path is empty, received \["main"\]/,
    );
    await expect(objects.describeObject(["main", "orders"], "table")).rejects.toThrow(
      /A libSQL "table" path is \[name\], received \["main","orders"\]/,
    );
    await expect(objects.describeObject(["orders_stamp"], "trigger")).rejects.toThrow(
      /A libSQL "trigger" path is \[table, name\], received \["orders_stamp"\]/,
    );
    // A caller mistake is not something the engine refused, so nothing was sent.
    expect(calls).toEqual([]);
  });

  test("every population the object surface reads applies the SAME two restrictions", async () => {
    // Standing ruling 5f from the statement side, and it is a SHAPE assertion on purpose.
    // It covers exactly the two places no data this engine can produce reaches, and every
    // other restriction is pinned by behaviour in the tests above:
    //
    // - `t.schema = ?` on the TABLE listing. sqld refuses `CREATE TEMP TABLE` and
    //   `CREATE TABLE temp.x` outright and accepts only `CREATE VIEW temp.x`, whose row
    //   is typed `view` and so can never enter a `type IN ('table','virtual')` listing.
    //   The counts arm and the view listing are driven behaviourally by the temp test.
    // - the reserved-name predicate on the TRIGGER listing. Measured on sqld 0.24.33:
    //   `CREATE TRIGGER sqlite_guard ...` is refused, "object name reserved for internal
    //   use", and the engine creates no trigger of its own, so no `sqlite`-prefixed
    //   trigger row can exist. The INDEX listing is NOT in this category and is pinned
    //   behaviourally above, because an implicit `sqlite_autoindex_*` on a ROWID table IS
    //   a row of `sqlite_schema`.
    //
    // Both stay, because a badge and its folder must enumerate one population however the
    // engine happens to be shaped today, and this is what keeps them from drifting apart.
    objects = await connectedWithObjects();
    const declared = (objects.getCapabilities().objectKinds ?? []).map((kind) => kind.id);

    await objects.countObjects([]);
    for (const kind of declared) await objects.listObjects([], kind);

    const statements = sentCalls();
    // Derived from the declaration rather than pinned to a number, so a new kind cannot
    // slip past by making this loop shorter. One statement per kind, plus the counts.
    expect(statements).toHaveLength(declared.length + 1);
    for (const statement of statements) {
      // Counted per POPULATION rather than merely "present", because the counts statement
      // reads two catalogs in one `UNION ALL`: asserting containment would let one of its
      // two arms lose the predicate while the other still carried it.
      const populations = statement.sql.match(/FROM (?:pragma_table_list|sqlite_schema)\b/g) ?? [];
      const reserved = statement.sql.match(/NOT LIKE 'sqlite\\_%' ESCAPE '\\'/g) ?? [];
      expect(reserved).toHaveLength(populations.length);
      // Only `pragma_table_list` spans schemas; `sqlite_schema` unqualified is already
      // `main`. So the schema restriction is required exactly where it can apply, and the
      // bind count follows from that rather than from a typed number.
      const spanning = statement.sql.match(/FROM pragma_table_list\b/g) ?? [];
      const restricted = statement.sql.match(/t\.schema = \?/g) ?? [];
      expect(restricted).toHaveLength(spanning.length);
      expect(statement.args).toEqual(spanning.map(() => "main"));
    }
  });

  test("the container depth, the object path and the name bind are DERIVED, which a two-level declaration shows", async () => {
    // Standing ruling 5g. On a ZERO-container engine this test is the only thing that
    // can tell a derivation from a literal: `container.length !== 0` and `path[0]` for
    // the object name are behaviour-identical to the derived forms at depth 0, which is
    // why the same defect shipped three times before it was named. Driven all the way
    // to a BOUND VALUE, never stopping at the refusal.
    objects = await connectedWithObjects();
    const real = objects.getCapabilities();
    spyOn(objects, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });

    // The refusal half: the depth comes from `containerDepth()`, so the EMPTY container
    // path - the only one this engine really accepts - is now wrong.
    await expect(objects.countObjects([])).rejects.toThrow(
      /A libSQL container path is \[catalog, database\], received \[\]/,
    );
    await expect(objects.listObjects([], "table")).rejects.toThrow(
      /A libSQL container path is \[catalog, database\], received \[\]/,
    );
    await expect(objects.describeObject(["orders"], "table")).rejects.toThrow(
      /A libSQL "table" path is \[catalog, database, name\], received \["orders"\]/,
    );

    // The bound-value half, which a refusal-only test cannot see.
    expect(await objects.countObjects(["cat", "sch"])).toEqual({
      table: { count: EXPECTED_COUNTS.table },
      view: { count: EXPECTED_COUNTS.view },
      index: { count: EXPECTED_COUNTS.index },
      trigger: { count: EXPECTED_COUNTS.trigger },
    });

    const tables = await objects.listObjects(["cat", "sch"], "table");
    expect(tables.map((table) => table.path)).toContainEqual(["cat", "sch", "orders"]);
    const triggers = await objects.listObjects(["cat", "sch"], "trigger");
    expect(triggers.map((trigger) => trigger.path)).toEqual([
      ["cat", "sch", "order_summary", "order_summary_guard"],
      ["cat", "sch", "orders", "orders_stamp"],
    ]);

    // AND THE BIND. `path[path.length - 1]` is `orders` at this depth while `path[0]` is
    // the CATALOG: both are depth-identical at 0, so only this declaration tells them
    // apart. Binding either literal would ask for an object called `cat` or `sch`.
    calls = [];
    const detail = await objects.describeObject(["cat", "sch", "orders"], "table");
    expect(detail.path).toEqual(["cat", "sch", "orders"]);
    expect(detail.columns.map((column) => column.name)).toEqual(["id", "customer_id", "total", "tax", "placed_at"]);
    // The foreign key statement binds the SCHEMA first, so its `args[0]` is `main`; every
    // other read binds the object's own name, which is `orders` and never `cat` or `sch`.
    expect(sentCalls().map((call) => call.args[0])).toEqual([
      "orders",
      "orders",
      "main",
      "idx_orders_customer",
      "idx_orders_placed",
    ]);
  });

  // --------------------------------------------------------------------------
  // A read the engine refuses
  // --------------------------------------------------------------------------

  test("a refused count carries the server's own sentence, for every kind at once", async () => {
    objects = await connectedWithObjects();
    // A failed statement is an HTTP 200 carrying the engine's words, which is the whole
    // reason this provider never reads `response.ok` as the verdict.
    server = () => failure("SQLite error: no such table: pragma_table_list", "SQLITE_UNKNOWN");

    const counts = await objects.countObjects([]);

    expect(counts).toEqual({
      table: { unavailable: "SQLite error: no such table: pragma_table_list" },
      view: { unavailable: "SQLite error: no such table: pragma_table_list" },
      index: { unavailable: "SQLite error: no such table: pragma_table_list" },
      trigger: { unavailable: "SQLite error: no such table: pragma_table_list" },
    });
    // Verbatim, with no product prefix in front of the server's words.
    for (const count of Object.values(counts)) {
      expect(isCountUnavailable(count) ? count.unavailable : "").not.toContain("libSQL");
    }
  });

  test("a count refused because the server is unreachable says that instead of zero", async () => {
    objects = await connectedWithObjects();
    globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

    const counts = await objects.countObjects([]);

    expect(isCountUnavailable(counts.table) ? counts.table.unavailable : "").toContain("connect ECONNREFUSED");
  });

  test("a refused LISTING raises against the statement the server received", async () => {
    objects = await connectedWithObjects();
    server = (sql, args) =>
      /pragma_table_list/.test(sql)
        ? failure("SQLite error: no such table: pragma_table_list", "SQLITE_UNKNOWN")
        : objectServer()(sql, args);

    const refusal = await objects.listObjects([], "table").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DatabaseError);
    expect((refusal as DatabaseError).message).toContain("no such table: pragma_table_list");
    expect((refusal as DatabaseError).provider).toBe("libsql");
    expect((refusal as DatabaseError).query).toContain("pragma_table_list");
    // The kinds that read `sqlite_schema` are untouched, which is the control.
    await expect(objects.listObjects([], "index")).resolves.toHaveLength(EXPECTED_COUNTS.index);
  });

  test("a refused DETAIL read raises against the statement, per statement of the batch", async () => {
    objects = await connectedWithObjects();
    server = (sql, args) =>
      /pragma_index_list/.test(sql)
        ? failure("SQLite error: disk I/O error", "SQLITE_IOERR")
        : objectServer()(sql, args);

    const refusal = await objects.describeObject(["orders"], "table").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DatabaseError);
    expect((refusal as DatabaseError).message).toContain("disk I/O error");
    expect((refusal as DatabaseError).query).toContain("pragma_index_list");
  });

  test("an expired token during a listing stays an authentication failure", async () => {
    // The status carries the distinction and the wording does not, which is why the
    // object surface maps through the provider's own mapping rather than wrapping
    // every failure as a query error.
    objects = await connectedWithObjects();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "JWT error: ExpiredSignature" }), { status: 401 }),
      )) as unknown as typeof fetch;

    await expect(objects.listObjects([], "table")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a catalog row whose kind names a prototype member draws no folder", async () => {
    // `Object.hasOwn` and not `in`: `"toString" in counts` is true on any object
    // literal, so the `in` spelling writes a folder for a kind nothing declared.
    objects = await connectedWithObjects();
    server = () =>
      result(
        [
          ["kind", "TEXT"],
          ["n", null],
        ],
        [
          [text("table"), int(3)],
          [text("toString"), int(9)],
          [text("constructor"), int(9)],
          [text("__proto__"), int(9)],
        ],
      );

    const counts = await objects.countObjects([]);

    // The control, so this is not a test of an empty read.
    expect(counts.table).toEqual({ count: 3 });
    expect(Object.keys(counts).sort()).toEqual(["index", "table", "trigger", "view"]);
  });
});

/**
 * The bulk column read (#789).
 *
 * The fake below replays the SAME fixture the single read replays, so every "the two
 * readings agree" assertion compares two answers the provider produced. What it cannot see
 * is a rewrite of the SQL itself (standing ruling 5b), which is why the whole method was
 * also run against a live `ghcr.io/tursodatabase/libsql-server:v0.24.33` - the measurements
 * and what that run caught are in docs/providers/libsql.md.
 */
describe("LibSQLProvider bulk column read (#789)", () => {
  let objects: LibSQLProvider;

  test("describes every table in ONE round trip, and each detail is what the single read answers", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");

    expect(batch.truncated).toBeUndefined();
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["archive"],
      ["badges"],
      ["customers"],
      ["legacy"],
      ["legacy_ref"],
      ["notes"],
      ["orders"],
      ["regions"],
      ["shipments"],
      ["sqliteXledger"],
    ]);
    // ONE request for ten objects. This is the engine-specific half of the decision: the
    // five statements are independent of each other, so they go in one batch, where the
    // SQLite provider issues five calls into a file handle.
    expect(calls).toHaveLength(1);

    // One mapper serves both reads, so a divergence here is the bulk read spelling a
    // column, an index or a foreign key differently from the single read of the same table.
    for (const detail of batch.details) {
      expect(detail).toEqual(await objects.describeObject(detail.path, "table"));
    }
  });

  test("every described path is one listObjects produced", async () => {
    objects = await connectedWithObjects();

    const listed = await objects.listObjects([], "table");
    const batch = await objects.describeObjects([], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
  });

  test("the five statements bind what their placeholders ask for, and the foreign key read takes three", async () => {
    // The arity pin, and it is not theoretical: a two-value array against the foreign key
    // statement's three placeholders is what sqld answers "Arguments do not match SQL
    // parameters: value for parameter 3 not found" to. Measured against a live server, and
    // invisible to this fake, which dispatches on statement text and never counted binds.
    objects = await connectedWithObjects();

    await objects.describeObjects([], "table", 4);

    const sent = sentCalls();
    expect(sent).toHaveLength(5);
    for (const call of sent) {
      const placeholders = (call.sql.match(/\?/g) ?? []).length;
      expect(call.args).toHaveLength(placeholders);
    }
    // The schema, the bound `limit + 1`, and one schema per pragma the statement joins.
    // Hrana encodes an integer as a decimal STRING on the wire, which is why the 5 comes
    // back quoted here and never in a provider assertion.
    expect(sent.map((call) => call.args)).toEqual([
      ["main", "5"],
      ["main", "5", "main"],
      ["main", "5", "main"],
      ["main", "5", "main", "main"],
      ["main", "5", "main", "main"],
    ]);
  });

  test("a view is described from the same statements a table is", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "view");

    expect(batch.details.map((detail) => detail.path)).toEqual([["order_summary"]]);
    expect(batch.details[0]!.columns.map((column) => column.name)).toEqual(["name", "total"]);
    expect(batch.details[0]!.indexes).toEqual([]);
    expect(batch.details[0]!.foreignKeys).toEqual([]);
  });

  test("an index and a trigger answer an empty batch without touching the network", async () => {
    objects = await connectedWithObjects();

    await expect(objects.describeObjects([], "index")).resolves.toEqual({ details: [] });
    await expect(objects.describeObjects([], "trigger")).resolves.toEqual({ details: [] });

    // Not "no rows came back": nothing was sent. Neither kind has columns on this engine -
    // `pragma_table_xinfo` answers zero rows for either name - and that is a fact about the
    // KIND, answered from the declaration.
    expect(calls).toEqual([]);
    // The control: a kind that DOES have columns still reaches the server.
    await objects.describeObjects([], "view");
    expect(calls.length).toBeGreaterThan(0);
  });

  test("an undeclared kind raises, naming the engine and the kind", async () => {
    objects = await connectedWithObjects();

    await expect(objects.describeObjects([], "sequence")).rejects.toThrow(/libSQL declares no object kind "sequence"/);
  });

  test("a container path of the wrong shape raises through the declaration, not a literal depth", async () => {
    objects = await connectedWithObjects();

    await expect(objects.describeObjects(["main"], "table")).rejects.toThrow(/A libSQL container path is empty/);
  });

  test("a two-level declaration is accepted and reaches the produced path", async () => {
    // Standing ruling 5g, driven to a VALUE and not to a refusal. libSQL declares no
    // container level, so `container.length !== 0` and `[name]` are behaviour-identical on
    // the real server and only a differently shaped declaration tells them apart.
    objects = await connectedWithObjects();
    spyOn(objects, "getCapabilities").mockReturnValue({
      ...objects.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });

    const batch = await objects.describeObjects(["cat", "sch"], "view");

    expect(batch.details.map((detail) => detail.path)).toEqual([["cat", "sch", "order_summary"]]);
    await expect(objects.describeObjects([], "view")).rejects.toThrow(
      /A libSQL container path is \[catalog, database\]/,
    );
  });

  test("a limit that is not a positive whole number raises rather than clamping", async () => {
    objects = await connectedWithObjects();

    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(objects.describeObjects([], "table", limit)).rejects.toThrow(
        /A libSQL bulk column read limit must be a positive whole number/,
      );
    }
    // Nothing was sent for any of them: the guard is before the batch.
    expect(calls).toEqual([]);
  });

  test("a bound that bites reports the caller's own limit, and one that does not never reports", async () => {
    objects = await connectedWithObjects();

    const bounded = await objects.describeObjects([], "table", 3);
    expect(bounded.details.map((detail) => detail.path)).toEqual([["archive"], ["badges"], ["customers"]]);
    expect(bounded.truncated?.limit).toBe(3);
    expect(bounded.truncated?.reason.length).toBeGreaterThan(0);
    // The bound cuts OBJECTS and never columns: every detail it kept is complete.
    expect(bounded.details[2]!.columns.map((column) => column.name)).toEqual(["id", "name", "country"]);

    // Exactly as many as the folder holds. `limit + 1` is what the statement carries, so a
    // saturated read is told from an exact one with no second count.
    const exact = await objects.describeObjects([], "table", EXPECTED_COUNTS.table);
    expect(exact.details).toHaveLength(EXPECTED_COUNTS.table);
    expect(exact.truncated).toBeUndefined();

    const unbounded = await objects.describeObjects([], "table");
    expect(unbounded.details).toHaveLength(EXPECTED_COUNTS.table);
    expect(unbounded.truncated).toBeUndefined();
  });

  test("the engine cuts under BINARY and the answer is sorted by path, and those are two different orders", async () => {
    // The one probe that separates the two, and it is a real disagreement rather than a
    // contrived one - see TABLE_LIST_WITH_EXOTIC for the live measurement behind the
    // fixture's order.
    objects = await connectedWithObjects({ tableList: TABLE_LIST_WITH_EXOTIC, sqliteSchema: SQLITE_SCHEMA_ROWS });

    const batch = await objects.describeObjects([], "table");

    // Last two by path, in UTF-16 order: the emoji before U+E000.
    expect(batch.details.map((detail) => detail.path).slice(-2)).toEqual([["\u{1F600}"], ["\uE000"]]);
    // And the cut keeps the engine's last, which is the other one: a limit of 11 over the
    // twelve the catalog now holds drops the emoji, not U+E000.
    const bounded = await objects.describeObjects([], "table", 11);
    expect(bounded.details.map((detail) => detail.path)).toContainEqual(["\uE000"]);
    expect(bounded.details.map((detail) => detail.path)).not.toContainEqual(["\u{1F600}"]);
    expect(bounded.truncated?.limit).toBe(11);
  });

  test("a generated column survives the bulk read, as it does the single one", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");
    const orders = batch.details.find((detail) => detail.path[0] === "orders")!;

    // `pragma_table_xinfo` and not `pragma_table_info`, which DROPS a generated column.
    // `readSchema()` still reads `table_info` and still loses it: the bulk read inherits the
    // object model's catalog and not the flat surface's.
    expect(orders.columns.map((column) => column.name)).toContain("tax");
  });

  test("an expression index publishes no fabricated column name, and an implicit one is not published at all", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");
    const byName = new Map(batch.details.map((detail) => [detail.path[0], detail]));

    expect(byName.get("orders")!.indexes).toEqual([
      { name: "idx_orders_customer", columns: ["customer_id"], unique: false },
      // `idx_orders_placed` keys `date(placed_at)`, whose `index_info` row carries a null
      // name. The index still appears, with an empty column list.
      { name: "idx_orders_placed", columns: [], unique: false },
    ]);
    // `regions` is WITHOUT ROWID with a composite primary key, so the engine made
    // `sqlite_autoindex_regions_1`, which the same `sqlite_` predicate removes here as in
    // the Indexes folder.
    expect(byName.get("regions")!.indexes).toEqual([]);
  });

  test("a foreign key resolves its parent's key, and a parent with none carries no column", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");
    const byName = new Map(batch.details.map((detail) => [detail.path[0], detail]));

    // `REFERENCES customers`, no column list: the correlated subquery answers the parent's
    // primary key.
    expect(byName.get("orders")!.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
    // `REFERENCES orders(id)`, which names its column, so nothing had to be resolved.
    expect(byName.get("shipments")!.foreignKeys).toEqual([
      { columnName: "order_id", referencedTable: "orders", referencedColumn: "id" },
    ]);
    // `REFERENCES legacy`, whose parent declares no primary key at all. There is nothing to
    // name and the field is empty rather than invented.
    expect(byName.get("legacy_ref")!.foreignKeys).toEqual([
      { columnName: "note", referencedTable: "legacy", referencedColumn: "" },
    ]);
  });

  test("a statement the server refused raises with the server's own sentence", async () => {
    objects = await connectedWithObjects();
    server = (sql) =>
      /JOIN pragma_index_info/.test(sql)
        ? failure("no such table: pragma_index_info", "SQLITE_UNKNOWN")
        : objectServer()(sql, []);

    // One statement of the batch failing is the whole read failing: a batch whose index
    // columns are missing would otherwise answer every index with no columns, which reads
    // as a fact about the tables.
    await expect(objects.describeObjects([], "table")).rejects.toThrow(/no such table: pragma_index_info/);
  });
});

describe("countLibSQLObjects through the transport seam", () => {
  /**
   * The Hrana transport wraps EVERY failure in an Error before it leaves the file, so the
   * non-Error arm of the refusal message is not reachable through it. It is reachable
   * through the seam, which is the point of the seam: `LibSQLTransport` has a documented
   * second implementation in mind (WebSocket, the embedded engine, `@libsql/client`), and
   * a folder that reported `undefined` as the reason it has no number would be worse than
   * the sentence itself.
   */
  const reader = (thrown: unknown): LibSQLObjectReader => ({
    transport: {
      kind: "hrana-http",
      execute: () => Promise.reject(thrown),
      executeBatch: () => Promise.resolve([]),
      serverVersion: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    },
    capabilities: new LibSQLProvider(connection()).getCapabilities(),
    mapError: (error: unknown) => (error instanceof Error ? error : new QueryError(String(error), "libsql")),
  });

  test("a transport that throws something that is not an Error still names a reason", async () => {
    const counts = await countLibSQLObjects(reader("a transport that threw a string"), []);

    expect(counts.table).toEqual({ unavailable: "a transport that threw a string" });
    // The control: an Error's own sentence is carried verbatim rather than stringified,
    // which is what `String(new Error("x"))` would turn into "Error: x".
    const fromError = await countLibSQLObjects(reader(new Error("no such table: pragma_table_list")), []);
    expect(fromError.table).toEqual({ unavailable: "no such table: pragma_table_list" });
  });
});

describe("comparePaths (libsql)", () => {
  // Exported and unit-tested directly, because the two cases that separate this from
  // `JSON.stringify` cannot arise inside ONE kind on an engine whose paths of a kind
  // are all the same length. Standing ruling 5h: written the settled way, and NOT
  // hoisted here - Task 28 replaces the copies with one definition.
  test("orders by segments, so a prefix sorts above what nests under it", () => {
    expect(comparePaths(["orders"], ["orders", "orders_stamp"])).toBeLessThan(0);
    expect(comparePaths(["orders", "orders_stamp"], ["orders"])).toBeGreaterThan(0);
    expect(comparePaths(["orders"], ["orders"])).toBe(0);
  });

  test("orders by code point, so an escaped name is not reordered by its escape", () => {
    expect(comparePaths(['a"b'], ["a\\b"])).toBeLessThan(0);
    expect(comparePaths(["a", "z"], ["b", "a"])).toBeLessThan(0);
  });
});
