/**
 * BigQueryProvider over a fake transport. `mock.module()` is process-wide in bun, so this file keeps the transport and
 * auth mocks to itself (the runner gives every test file its own process).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BIGQUERY_DRY_RUN_MARKER } from "@/lib/explain/bigquery-dryrun";
import type {
  BigQueryDatasetRef,
  BigQueryQueryOptions,
  BigQueryQueryResult,
  BigQueryTable,
  BigQueryTableRef,
  BigQueryTransport,
} from "@/lib/db/providers/sql/bigquery/transport";
import type { DatabaseConnection } from "@/lib/types";

const realTransport = { ...(await import("@/lib/db/providers/sql/bigquery/transport")) };
const { BigQueryApiError } = realTransport;
const { TransportError } = await import("@/lib/db/http/node-transport");

function result(over: Partial<BigQueryQueryResult> = {}): BigQueryQueryResult {
  return {
    fields: [],
    rows: [],
    totalBytesProcessed: null,
    totalBytesBilled: null,
    cacheHit: false,
    affectedRows: null,
    executionTimeMs: 1.4,
    ...over,
  };
}

class FakeTransport implements BigQueryTransport {
  calls: { sql: string; options: BigQueryQueryOptions }[] = [];
  listTablesCalls: string[] = [];
  listTablesSignals: (AbortSignal | undefined)[] = [];
  listTablesGate: Promise<void> | null = null;
  getTableCalls: string[] = [];
  closed = false;
  datasets: BigQueryDatasetRef[] = [
    { id: "sales", location: "EU" },
    { id: "logs", location: "EU" },
  ];
  datasetsError: unknown = null;
  tables: Record<string, BigQueryTableRef[]> = {
    sales: [
      { id: "orders", type: "TABLE" },
      { id: "v_orders", type: "VIEW" },
      { id: "mv_orders", type: "MATERIALIZED_VIEW" },
      { id: "broken", type: "TABLE" },
    ],
  };
  tablesError: unknown = null;
  onQuery: (sql: string, options: BigQueryQueryOptions) => Promise<BigQueryQueryResult> = async () => result();

  async query(sql: string, options: BigQueryQueryOptions): Promise<BigQueryQueryResult> {
    this.calls.push({ sql, options });
    return this.onQuery(sql, options);
  }
  async listDatasets(): Promise<BigQueryDatasetRef[]> {
    if (this.datasetsError) throw this.datasetsError;
    return this.datasets;
  }
  async listTables(dataset: string, signal?: AbortSignal): Promise<BigQueryTableRef[]> {
    this.listTablesCalls.push(dataset);
    this.listTablesSignals.push(signal);
    if (this.listTablesGate) await this.listTablesGate;
    if (this.tablesError) throw this.tablesError;
    return this.tables[dataset] ?? [];
  }
  async getTable(dataset: string, table: string): Promise<BigQueryTable> {
    this.getTableCalls.push(`${dataset}.${table}`);
    if (table === "broken") throw new BigQueryApiError(404, "notFound", "gone");
    return {
      fields: [
        { name: "id", type: "INT64", mode: "REQUIRED" },
        { name: "tags", type: "STRING", mode: "REPEATED" },
        { name: "addr", type: "RECORD", fields: [{ name: "city", type: "STRING" }] },
      ],
    };
  }
  close(): void {
    this.closed = true;
  }
}

let fake = new FakeTransport();
const createCalls: unknown[][] = [];

mock.module("@/lib/db/providers/sql/bigquery/transport", () => ({
  ...realTransport,
  createBigQueryTransport: (...args: unknown[]) => {
    createCalls.push(args);
    return fake;
  },
}));
mock.module("@/lib/db/providers/sql/bigquery/auth", () => ({
  readCredentials: (password?: string) =>
    password?.includes('"external_account"')
      ? { type: "external_account", kind: "fake", password }
      : { kind: "fake", password },
}));

const { BigQueryProvider, jobLocation, catalogLimits } = await import("@/lib/db/providers/sql/bigquery");
const { AuthenticationError, DatabaseConfigError, QueryError, TimeoutError } = await import("@/lib/db/errors");

const base: DatabaseConnection = {
  id: "bq",
  name: "bq",
  type: "bigquery",
  database: "my-proj",
  schema: "sales",
  password: "key",
  createdAt: new Date(),
} as DatabaseConnection;

async function connected(over: Partial<DatabaseConnection> = {}) {
  const provider = new BigQueryProvider({ ...base, ...over });
  await provider.connect();
  return provider;
}

/** Answers the region INFORMATION_SCHEMA catalog reads. */
function catalogQueries(sql: string): Promise<BigQueryQueryResult> | null {
  if (sql.includes(".TABLES")) {
    return Promise.resolve(
      result({
        rows: [
          { table_schema: "sales", table_name: "orders", table_type: "BASE TABLE" },
          { table_schema: "sales", table_name: "v_orders", table_type: "VIEW" },
          { table_schema: "sales", table_name: "mv_orders", table_type: "MATERIALIZED VIEW" },
          { table_schema: "orphan", table_name: "x", table_type: "BASE TABLE" },
        ],
      }),
    );
  }
  if (sql.includes(".COLUMNS")) {
    return Promise.resolve(
      result({
        rows: [
          { table_schema: "sales", table_name: "orders", column_name: "id", data_type: "INT64", is_nullable: "NO" },
          { table_schema: "sales", table_name: "orders", column_name: "note", data_type: "STRING", is_nullable: "YES" },
        ],
      }),
    );
  }
  return null;
}

beforeEach(() => {
  fake = new FakeTransport();
  createCalls.length = 0;
});

afterEach(() => {
  mock.restore();
});

describe("construction and metadata", () => {
  test("a missing project id is a config error", () => {
    expect(() => new BigQueryProvider({ ...base, database: "" })).toThrow(DatabaseConfigError);
  });

  test("capabilities and backtick quoting", () => {
    const provider = new BigQueryProvider(base);
    const caps = provider.getCapabilities();
    expect(caps.explainFormat).toBe("bigquery-dryrun");
    expect(caps.identifierQuoting).toBe("backtick");
    expect(caps.tablesNeedContainer).toBe(true);
    expect((provider as unknown as { escapeIdentifier(s: string): string }).escapeIdentifier("a`b\\c")).toBe(
      "`a\\`b\\\\c`",
    );
  });

  test("jobLocation prefers the default dataset, else the majority", () => {
    const ds = [
      { id: "a", location: "US" },
      { id: "b", location: "EU" },
      { id: "c", location: "EU" },
    ];
    expect(jobLocation(ds, "a")).toBe("US");
    expect(jobLocation(ds)).toBe("EU");
    expect(jobLocation([])).toBeUndefined();
  });
});

describe("connect / disconnect", () => {
  test("detects the location and probes with it", async () => {
    const provider = await connected({ password: "{}" });
    expect(createCalls[0]).toEqual(["my-proj", { kind: "fake", password: "{}" }]);
    expect(fake.calls[0].sql).toBe("SELECT 1");
    expect(fake.calls[0].options.location).toBe("EU");
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
    expect(fake.closed).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("no datasets: probe sent without a location", async () => {
    fake.datasets = [];
    await connected();
    expect(fake.calls[0].options.location).toBeUndefined();
  });

  test("a keyless connection a user created is refused; an operator-seeded one uses the server's credentials", async () => {
    const error = await new BigQueryProvider({ ...base, password: " " }).connect().catch((e) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toContain("only for operator-seeded connections");
    expect(createCalls).toHaveLength(0);
    const seeded = await connected({ password: undefined, managed: true });
    expect(seeded.isConnected()).toBe(true);
    expect(createCalls[0]).toEqual(["my-proj", { kind: "fake", password: undefined }]);
  });

  test("an external_account connection a user created is refused; an operator-seeded one connects", async () => {
    const external = JSON.stringify({ type: "external_account" });
    const error = await new BigQueryProvider({ ...base, password: external }).connect().catch((e) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toContain("external_account credentials are used only for operator-seeded connections");
    expect(createCalls).toHaveLength(0);
    const seeded = await connected({ password: external, managed: true });
    expect(seeded.isConnected()).toBe(true);
  });

  test("a datasets listing the principal may not read leaves the location to BigQuery", async () => {
    fake.datasetsError = new BigQueryApiError(403, "accessDenied", "no datasets.list");
    const provider = await connected();
    expect(provider.isConnected()).toBe(true);
    expect(fake.calls[0].options.location).toBeUndefined();
  });

  test("an authentication failure from the token source still fails the connect", async () => {
    fake.datasetsError = new AuthenticationError("token refused", "bigquery");
    await expect(new BigQueryProvider(base).connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(fake.calls).toHaveLength(0);
  });

  test("401 maps to AuthenticationError and closes the transport", async () => {
    fake.datasetsError = new BigQueryApiError(401, null, "bad token");
    const provider = new BigQueryProvider(base);
    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(fake.closed).toBe(true);
  });

  test("accessDenied is a permission problem, a QueryError", async () => {
    fake.onQuery = async () => {
      throw new BigQueryApiError(403, "accessDenied", "nope");
    };
    const error = await new BigQueryProvider(base).connect().catch((e) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
  });

  test("other API errors map to QueryError", async () => {
    fake.onQuery = async () => {
      throw new BigQueryApiError(400, "invalid", "bad");
    };
    await expect(new BigQueryProvider(base).connect()).rejects.toBeInstanceOf(QueryError);
  });

  test("a transport timeout maps to TimeoutError", async () => {
    fake.onQuery = async () => {
      throw new TransportError("timeout", "timed out");
    };
    await expect(new BigQueryProvider(base).connect()).rejects.toBeInstanceOf(TimeoutError);
  });

  test("a plain error goes through the generic mapper", async () => {
    fake.onQuery = async () => {
      throw new Error("boom");
    };
    await expect(new BigQueryProvider(base).connect()).rejects.toThrow("boom");
  });

  test("disconnect without connect is safe", async () => {
    await new BigQueryProvider(base).disconnect();
  });
});

describe("query", () => {
  test("refuses parameters", async () => {
    const provider = await connected();
    await expect(provider.query("SELECT ?", [1])).rejects.toBeInstanceOf(QueryError);
  });

  test("dry run answers the bytes row", async () => {
    const provider = await connected();
    fake.onQuery = async () => result({ totalBytesProcessed: 2048 });
    const r = await provider.query(`${BIGQUERY_DRY_RUN_MARKER}SELECT 1`);
    expect(fake.calls.at(-1)?.options.dryRun).toBe(true);
    expect(r.fields).toEqual(["bytes_processed", "bytes_processed_human"]);
    expect(r.rows[0].bytes_processed).toBe(2048);
    expect(r.executionTime).toBe(1);
  });

  test("dry run with no byte count reports 0", async () => {
    const provider = await connected();
    const r = await provider.query(`${BIGQUERY_DRY_RUN_MARKER}SELECT 1`);
    expect(r.rows[0].bytes_processed).toBe(0);
  });

  test("result with column types and a billed warning", async () => {
    const provider = await connected();
    fake.onQuery = async () =>
      result({
        fields: [
          { name: "id", type: "INT64" },
          { name: "s", type: "RECORD", mode: "REPEATED", fields: [{ name: "x", type: "STRING" }] },
          { name: "e", type: "RECORD", fields: [] },
        ],
        rows: [{ id: 1 }, { id: 2 }],
        totalBytesProcessed: 1024,
        totalBytesBilled: 10485760,
      });
    const r = await provider.query("SELECT * FROM t");
    expect(fake.calls.at(-1)?.options.defaultDataset).toBe("sales");
    expect(fake.calls.at(-1)?.options.location).toBe("EU");
    expect(r.rowCount).toBe(2);
    expect(r.columnTypes).toEqual({ id: "INT64", s: "ARRAY<STRUCT<x STRING>>", e: "RECORD" });
    expect(r.warnings?.[0].message).toContain("billed");
    expect(r.warnings?.[0].message).not.toContain("cache hit");
  });

  test("cache hit, no billed bytes", async () => {
    const provider = await connected({ schema: undefined });
    fake.onQuery = async () => result({ totalBytesProcessed: 0, cacheHit: true });
    const r = await provider.query("SELECT 1");
    expect(fake.calls.at(-1)?.options.defaultDataset).toBeUndefined();
    expect(r.warnings?.[0].message).toContain("(cache hit)");
    expect(r.warnings?.[0].message).not.toContain("billed");
    expect(r.columnTypes).toBeUndefined();
  });

  test("no warning without processed bytes; DML affected rows; no location", async () => {
    fake.datasets = [];
    const provider = await connected();
    // BigQuery sends the table's schema with a DML answer.
    fake.onQuery = async () => result({ affectedRows: 7, fields: [{ name: "id", type: "INTEGER" }] });
    const r = await provider.query("DELETE FROM t WHERE true");
    expect(fake.calls.at(-1)?.options.location).toBeUndefined();
    expect(r.rowCount).toBe(7);
    expect(r.fields).toEqual([]);
    expect(r.columnTypes).toBeUndefined();
    expect(r.warnings).toBeUndefined();
  });

  test("errors are mapped", async () => {
    const provider = await connected();
    fake.onQuery = async () => {
      throw new BigQueryApiError(400, "invalidQuery", "Syntax error");
    };
    await expect(provider.query("SELEC")).rejects.toBeInstanceOf(QueryError);
  });

  test("not connected", async () => {
    await expect(new BigQueryProvider(base).query("SELECT 1")).rejects.toBeInstanceOf(DatabaseConfigError);
  });
});

describe("object surface via INFORMATION_SCHEMA", () => {
  test("containers, counts, objects and bulk columns", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => catalogQueries(sql) ?? result();

    expect(await provider.listContainers(["x"])).toEqual([]);
    expect(await provider.listContainers()).toEqual([
      { path: ["logs"], name: "logs", level: 0, isSessionDefault: false },
      { path: ["sales"], name: "sales", level: 0, isSessionDefault: true },
    ]);
    expect(await provider.listContainers([])).toHaveLength(2);

    expect(await provider.countObjects(["sales"])).toEqual({
      table: { count: 1 },
      view: { count: 1 },
      materialized_view: { count: 1 },
    });
    expect(await provider.countObjects(["logs"])).toEqual({
      table: { count: 0 },
      view: { count: 0 },
      materialized_view: { count: 0 },
    });
    // A dataset the catalog does not know (created within its TTL) is answered over REST.
    expect(await provider.countObjects(["nowhere"])).toEqual({
      table: { count: 0 },
      view: { count: 0 },
      materialized_view: { count: 0 },
    });

    expect(await provider.listObjects(["sales"], "view")).toEqual([
      { path: ["sales", "v_orders"], name: "v_orders", kind: "view" },
    ]);

    const batch = await provider.describeObjects(["sales"], "table");
    expect(batch.details[0].columns).toEqual([
      { name: "id", type: "INT64", nullable: false, isPrimary: false },
      { name: "note", type: "STRING", nullable: true, isPrimary: false },
    ]);
    expect(batch.truncated).toBeUndefined();

    const views = await provider.describeObjects(["sales"], "view", 5);
    expect(views.details[0].columns).toEqual([]);

    // The catalog is read once (2 region queries) and cached.
    expect(fake.calls.filter((c) => c.sql.includes("INFORMATION_SCHEMA")).length).toBe(2);
    expect(fake.listTablesCalls).toEqual(["nowhere"]);
  });

  test("DDL drops the catalog and table lists; a plain read does not", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => catalogQueries(sql) ?? result();
    await provider.listObjects(["sales"], "table");
    await provider.query("SELECT 1");
    await provider.query(`${BIGQUERY_DRY_RUN_MARKER}CREATE TABLE x (a INT64)`);
    await provider.listObjects(["sales"], "table");
    expect(fake.calls.filter((c) => c.sql.includes(".TABLES")).length).toBe(1);
    await provider.query("CREATE TABLE x (a INT64)");
    await provider.listObjects(["sales"], "table");
    expect(fake.calls.filter((c) => c.sql.includes(".TABLES")).length).toBe(2);
    await provider.disconnect();
    await provider.connect();
    await provider.listObjects(["sales"], "table");
    expect(fake.calls.filter((c) => c.sql.includes(".TABLES")).length).toBe(3);
  });

  test("one unreadable region falls back to REST for its datasets only", async () => {
    fake.datasets = [
      { id: "sales", location: "EU" },
      { id: "us_data", location: "US" },
    ];
    fake.tables.us_data = [{ id: "u", type: "TABLE" }];
    const provider = await connected();
    fake.onQuery = async (sql) => {
      if (sql.includes("region-us")) throw new BigQueryApiError(403, "accessDenied", "no");
      return catalogQueries(sql) ?? result();
    };
    expect((await provider.listObjects(["sales"], "table")).map((o) => o.name)).toEqual(["orders"]);
    expect((await provider.listObjects(["us_data"], "table")).map((o) => o.name)).toEqual(["u"]);
    expect(fake.listTablesCalls).toEqual(["us_data"]);
    expect((await provider.describeObjects(["us_data"], "table")).details[0].columns).toHaveLength(3);
  });

  test("a catalog where every region failed is cached for a minute, not five", async () => {
    const provider = await connected();
    let fail = true;
    fake.onQuery = async (sql) => {
      if (fail) throw new Error("transient");
      return catalogQueries(sql) ?? result();
    };
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    const catalogReads = () => fake.calls.filter((c) => c.sql.includes("INFORMATION_SCHEMA")).length;
    await provider.listObjects(["sales"], "table");
    expect(fake.listTablesCalls).toEqual(["sales"]);
    expect(catalogReads()).toBe(2);
    fail = false;
    now.mockReturnValue(1_000_000 + 30_001);
    await provider.listObjects(["sales"], "table");
    expect(fake.listTablesCalls).toEqual(["sales", "sales"]);
    expect(catalogReads()).toBe(2);
    now.mockReturnValue(1_000_000 + 60_001);
    await provider.listObjects(["sales"], "table");
    expect(catalogReads()).toBe(4);
    expect(fake.listTablesCalls).toEqual(["sales", "sales"]);
  });

  test("a region over the row cap is treated as unread, not truncated", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => catalogQueries(sql) ?? result();
    const original = catalogLimits.maxRows;
    catalogLimits.maxRows = 3;
    try {
      await provider.listObjects(["sales"], "table");
    } finally {
      catalogLimits.maxRows = original;
    }
    expect(fake.calls.find((c) => c.sql.includes(".TABLES"))?.options.maxRows).toBe(4);
    expect(fake.listTablesCalls).toEqual(["sales"]);
  });

  test("catalog expires after its TTL", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => catalogQueries(sql) ?? result();
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    await provider.listObjects(["sales"], "table");
    now.mockReturnValue(1_000_000 + 5 * 60_000 + 1);
    await provider.listObjects(["sales"], "table");
    expect(fake.calls.filter((c) => c.sql.includes(".TABLES")).length).toBe(2);
  });

  test("truncation by limit", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => catalogQueries(sql) ?? result();
    fake.tables.sales = [];
    const batch = await provider.describeObjects(["sales"], "table", 1);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated).toBeUndefined();
  });

  test("bad limits are refused", async () => {
    const provider = await connected();
    await expect(provider.describeObjects(["sales"], "table", 0)).rejects.toBeInstanceOf(QueryError);
    await expect(provider.describeObjects(["sales"], "table", 1.5)).rejects.toBeInstanceOf(QueryError);
  });

  test("unknown kind and bad container shape", async () => {
    const provider = await connected();
    await expect(provider.listObjects(["sales"], "index")).rejects.toBeInstanceOf(QueryError);
    await expect(provider.listObjects(["a", "b"], "table")).rejects.toThrow();
  });

  test("listContainers maps transport errors", async () => {
    const provider = await connected();
    fake.datasetsError = new BigQueryApiError(401, null, "expired");
    await expect(provider.listContainers()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("object surface via REST fallback", () => {
  async function restProvider() {
    const provider = await connected();
    fake.onQuery = async (sql) => {
      if (sql.includes("INFORMATION_SCHEMA")) throw new BigQueryApiError(403, "accessDenied", "no");
      return result();
    };
    return provider;
  }

  test("counts and lists from tables.list, cached for its TTL", async () => {
    const provider = await restProvider();
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await provider.countObjects(["sales"])).toEqual({
      table: { count: 2 },
      view: { count: 1 },
      materialized_view: { count: 1 },
    });
    expect((await provider.listObjects(["sales"], "materialized_view")).map((o) => o.name)).toEqual(["mv_orders"]);
    expect(fake.listTablesCalls).toEqual(["sales"]);
    now.mockReturnValue(1_000_000 + 30_001);
    await provider.listObjects(["sales"], "table");
    expect(fake.listTablesCalls).toEqual(["sales", "sales"]);
  });

  test("a cached listing is answered before the catalog is consulted", async () => {
    const provider = await restProvider();
    await provider.countObjects(["sales"]);
    (provider as unknown as { catalogCache: unknown }).catalogCache = null;
    const before = fake.calls.length;
    await provider.countObjects(["sales"]);
    expect(fake.calls.length).toBe(before);
    expect(fake.listTablesCalls).toEqual(["sales"]);
  });

  test("a shared listing runs on its own deadline: one caller's abort fails only that caller", async () => {
    const provider = await restProvider();
    await provider.countObjects(["logs"]); // reads the (null) catalog once
    let open!: () => void;
    fake.listTablesGate = new Promise((resolve) => {
      open = resolve;
    });
    type Lister = { listTables(t: unknown, d: string, s: AbortSignal): Promise<BigQueryTableRef[]> };
    const lister = provider as unknown as Lister;
    const short = new AbortController();
    const first = lister.listTables(fake, "sales", short.signal);
    const second = lister.listTables(fake, "sales", new AbortController().signal);
    await Promise.resolve();
    short.abort(new Error("caller gone"));
    await expect(first).rejects.toThrow("caller gone");
    open();
    expect(await second).toHaveLength(4);
    expect(fake.listTablesCalls).toEqual(["logs", "sales"]);
    expect(fake.listTablesSignals.at(-1)).not.toBe(short.signal);
    const aborted = AbortSignal.abort(new Error("already gone"));
    await expect(lister.listTables(fake, "sales", aborted)).rejects.toThrow("already gone");
  });

  test("a failed listing is unavailable and not cached", async () => {
    const provider = await restProvider();
    fake.tablesError = new Error("rate limited");
    expect(await provider.countObjects(["sales"])).toEqual({
      table: { unavailable: "rate limited" },
      view: { unavailable: "rate limited" },
      materialized_view: { unavailable: "rate limited" },
    });
    fake.tablesError = "plain";
    expect((await provider.countObjects(["sales"])).table).toEqual({ unavailable: "plain" });
    fake.tablesError = null;
    expect((await provider.countObjects(["sales"])).table).toEqual({ count: 2 });
  });

  test("describeObject reads the REST schema", async () => {
    const provider = await restProvider();
    const detail = await provider.describeObject(["sales", "orders"], "table");
    expect(detail.columns).toEqual([
      { name: "id", type: "INT64", nullable: false, isPrimary: false },
      { name: "tags", type: "ARRAY<STRING>", nullable: true, isPrimary: false },
      { name: "addr", type: "STRUCT<city STRING>", nullable: true, isPrimary: false },
    ]);
    await expect(provider.describeObject(["sales"], "table")).rejects.toThrow();
    await expect(provider.describeObject(["sales", "x"], "nope")).rejects.toBeInstanceOf(QueryError);
  });

  test("describeObjects: per-table failure keeps the batch, limit truncates", async () => {
    const provider = await restProvider();
    const batch = await provider.describeObjects(["sales"], "table");
    expect(batch.details.map((d) => [d.path[1], d.columns.length])).toEqual([
      ["broken", 0],
      ["orders", 3],
    ]);
    const bounded = await provider.describeObjects(["sales"], "table", 1);
    expect(bounded.details).toHaveLength(1);
    expect(bounded.truncated?.limit).toBe(1);
    const none = await provider.describeObjects(["logs"], "table");
    expect(none.details).toEqual([]);
  });
});

describe("monitoring", () => {
  function monitoringAnswers(sql: string): Promise<BigQueryQueryResult> {
    if (sql.includes("COUNTIF(cache_hit)")) return Promise.resolve(result({ rows: [{ total: 3600, cached: 900 }] }));
    if (sql.includes("GROUP BY query"))
      return Promise.resolve(
        result({
          rows: [
            { query: "SELECT 1", calls: 2, total_ms: 100, min_ms: 40, max_ms: 60 },
            { query: "SELECT 2", calls: 0 },
          ],
        }),
      );
    if (sql.includes("state != 'DONE'"))
      return Promise.resolve(
        result({
          rows: [
            {
              job_id: "j1",
              user_email: "a@b",
              state: "RUNNING",
              query: "SELECT 3",
              start_time: "2026-01-01T00:00:00Z",
              ms: 2500,
            },
            { job_id: "j2", state: "PENDING" },
          ],
        }),
      );
    if (sql.includes("total_rows"))
      return Promise.resolve(
        result({
          rows: [
            { table_schema: "sales", table_name: "orders", total_rows: 10, total_logical_bytes: 2048 },
            { table_schema: "sales", table_name: "empty" },
          ],
        }),
      );
    if (sql.includes("GROUP BY table_schema"))
      return Promise.resolve(
        result({
          rows: [
            { table_schema: "sales", tables: 2, bytes: 4096 },
            { table_schema: "logs", tables: 1 },
          ],
        }),
      );
    return Promise.resolve(result());
  }

  test("reads every panel from the region INFORMATION_SCHEMA", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => monitoringAnswers(sql);

    expect(await provider.getOverview()).toMatchObject({
      version: "BigQuery (EU)",
      databaseSize: "4 KB",
      databaseSizeBytes: 4096,
      tableCount: 3,
    });
    expect(fake.calls.at(-1)?.sql).toContain("`region-eu`.INFORMATION_SCHEMA.TABLE_STORAGE");
    expect(fake.calls.at(-1)?.sql).toContain("project_id = 'my-proj'");

    expect(await provider.getPerformanceMetrics()).toEqual({ cacheHitRatio: 25, queriesPerSecond: 1 });

    const slow = await provider.getSlowQueries({ limit: 5000 });
    expect(slow[0]).toEqual({
      query: "SELECT 1",
      calls: 2,
      totalTime: 100,
      avgTime: 50,
      minTime: 40,
      maxTime: 60,
      rows: 0,
    });
    expect(slow[1]).toMatchObject({ calls: 0, totalTime: 0, avgTime: 0, minTime: 0, maxTime: 0 });
    expect(fake.calls.at(-1)?.sql).toContain("LIMIT 200");
    await provider.getSlowQueries();

    const sessions = await provider.getActiveSessions({ limit: 0 });
    expect(sessions[0]).toMatchObject({
      pid: "j1",
      user: "a@b",
      database: "my-proj",
      state: "running",
      query: "SELECT 3",
      duration: "3s",
      durationMs: 2500,
    });
    expect(sessions[0].queryStart).toBeInstanceOf(Date);
    expect(sessions[1]).toMatchObject({ user: "", query: "", durationMs: 0 });
    expect(sessions[1].queryStart).toBeUndefined();
    expect(fake.calls.at(-1)?.sql).toContain("LIMIT 1");
    await provider.getActiveSessions();

    const tables = await provider.getTableStats({ schema: "o'k" });
    expect(fake.calls.at(-1)?.sql).toContain("table_schema = 'o\\'k'");
    expect(tables[0]).toEqual({
      schemaName: "sales",
      tableName: "orders",
      rowCount: 10,
      totalSize: "2 KB",
      totalSizeBytes: 2048,
    });
    expect(tables[1]).toMatchObject({ rowCount: 0, totalSizeBytes: 0 });
    await provider.getTableStats();

    expect(await provider.getStorageStats()).toEqual([
      { name: "sales", location: "EU", size: "4 KB", sizeBytes: 4096 },
      { name: "logs", location: "EU", size: "0 B", sizeBytes: 0 },
    ]);

    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    await expect(provider.runMaintenance("vacuum")).rejects.toBeInstanceOf(QueryError);
  });

  test("JOBS reads are cached for a minute, TABLE_STORAGE reads for fifteen", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => monitoringAnswers(sql);
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    await provider.getPerformanceMetrics();
    await provider.getOverview();
    await provider.getPerformanceMetrics();
    await provider.getOverview();
    expect(fake.calls.length).toBe(3);
    now.mockReturnValue(1_000_000 + 60_001);
    await provider.getPerformanceMetrics();
    await provider.getOverview();
    expect(fake.calls.length).toBe(4);
    now.mockReturnValue(1_000_000 + 15 * 60_000 + 1);
    await provider.getOverview();
    expect(fake.calls.length).toBe(5);
  });

  test("the overview and the storage panel share one TABLE_STORAGE read", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => monitoringAnswers(sql);
    const before = fake.calls.length;
    await provider.getOverview();
    await provider.getStorageStats();
    expect(fake.calls.length).toBe(before + 1);
  });

  test("the cache drops expired entries and holds at most 50", async () => {
    const provider = await connected();
    fake.onQuery = async (sql) => monitoringAnswers(sql);
    const cache = (provider as unknown as { monitoringCache: Map<string, unknown> }).monitoringCache;
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    for (let i = 0; i < 55; i++) await provider.getTableStats({ schema: `s${i}` });
    expect(cache.size).toBe(50);
    now.mockReturnValue(1_000_000 + 15 * 60_000 + 1);
    await provider.getTableStats({ schema: "fresh" });
    expect(cache.size).toBe(1);
    await provider.disconnect();
    expect(cache.size).toBe(0);
  });

  test("a project with no tables reads 0 B, not N/A", async () => {
    const provider = await connected();
    fake.onQuery = async () => result({ rows: [] });
    expect(await provider.getOverview()).toMatchObject({ databaseSize: "0 B", databaseSizeBytes: 0, tableCount: 0 });
  });

  test("no location: everything empty", async () => {
    fake.datasets = [];
    const provider = await connected();
    expect(await provider.getOverview()).toMatchObject({ version: "BigQuery", databaseSize: "N/A", tableCount: 0 });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getStorageStats()).toEqual([]);
    expect(fake.calls.length).toBe(1);
  });

  test("a refused read is empty and not cached; zero jobs give no metrics", async () => {
    const provider = await connected();
    fake.onQuery = async () => {
      throw new BigQueryApiError(403, "accessDenied", "no listAll");
    };
    const cache = (provider as unknown as { monitoringCache: Map<string, unknown> }).monitoringCache;
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(cache.size).toBe(0);
    const before = fake.calls.length;
    await provider.getSlowQueries();
    expect(fake.calls.length).toBe(before + 1);
    fake.onQuery = async () => result({ rows: [{ total: 0, cached: 0 }] });
    expect(await provider.getPerformanceMetrics()).toEqual({});
  });
});
