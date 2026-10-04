import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";

// ─── Mock providers ─────────────────────────────────────────────────────────
const mockSQLProvider = createMockProvider({
  capabilities: { queryLanguage: "sql" },
});

const mockMongoProvider = createMockProvider({
  capabilities: { queryLanguage: "json" },
});

const mockGetOrCreateProvider = mock(async () => mockSQLProvider);

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// ─── Mock @/lib/db/factory BEFORE importing the route ───────────────────────
mock.module("@/lib/db/factory", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockSQLProvider),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/profile/route");
const { KafkaProvider } = await import("@/lib/db/providers/stream/kafka/index");
const { EtcdProvider } = await import("@/lib/db/providers/keyvalue/etcd/index");
const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
const { ConnectionError, QueryError, TimeoutError } = await import("@/lib/db/errors");
const { InfluxDB3Provider, InfluxDBProvider } = await import("@/lib/db/providers/timeseries/influxdb/index");
const { createInfluxClient } = await import("@/lib/db/providers/timeseries/influxdb/client");
const { INFLUX_ERROR_SENTENCES } = await import("@/lib/db/providers/timeseries/influxdb/errors");
const { loadInfluxCapture } = await import("../../helpers/influxdb-fixtures");
const { recordingInfluxTransport } = await import("../../helpers/influxdb-transport");

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

const mongoConnection = {
  id: "test-mongo",
  name: "Test MongoDB",
  type: "mongodb",
  connectionString: "mongodb://localhost:27017/testdb",
};

const kafkaConnection = {
  id: "test-kafka",
  name: "Test Kafka",
  type: "kafka" as const,
  host: "localhost",
  port: 9092,
};

const etcdConnection = {
  id: "test-etcd",
  name: "Test etcd",
  type: "etcd" as const,
  host: "localhost",
  port: 2379,
};

const influxdbConnection = {
  id: "test-influxdb",
  name: "Test InfluxDB",
  type: "influxdb" as const,
  host: "127.0.0.1",
  port: 8086,
  database: "home",
};

const influxdb3Connection = {
  id: "test-influxdb3",
  name: "Test InfluxDB 3",
  type: "influxdb3" as const,
  host: "127.0.0.1",
  port: 8181,
  password: "token-secret",
  database: "home",
};

type InfluxCaptureT = import("../../helpers/influxdb-fixtures").InfluxCapture;
type RecordedInfluxRequestT = import("../../helpers/influxdb-transport").RecordedInfluxRequest;

/** A jsonl answer of these rows, in the shape the 3.12.0-core captures show. */
function jsonlAnswer(rows: readonly Record<string, unknown>[]): InfluxCaptureT {
  return {
    version: "3.12.0-core",
    name: "built",
    image: "built",
    capturedAt: "built",
    request: { method: "POST", path: "/api/v3/query_sql", query: {}, auth: "bearer" },
    status: 200,
    contentType: "application/jsonl",
    body: rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  };
}

/**
 * The real InfluxDB 3 provider over the real client and a recording transport, connected to the seeded 3.12.0-core
 * server with Database `home` (`/ping` and the database listing are its captures); `rest` answers what the route
 * sends after the connect.
 */
async function connectedInfluxdb3(
  rest: readonly (InfluxCaptureT | ((request: RecordedInfluxRequestT) => InfluxCaptureT))[],
) {
  const wire = recordingInfluxTransport([
    loadInfluxCapture("3.12.0-core", "ping-auth"),
    loadInfluxCapture("3.12.0-core", "sql-databases"),
    ...rest,
  ]);
  const provider = new InfluxDB3Provider({ ...influxdb3Connection, createdAt: new Date(0) }, {}, (options, routes) =>
    createInfluxClient(options, routes, wire.factory),
  );
  await provider.connect();
  return { provider, requests: wire.requests };
}

/** The statement and database of a recorded `/api/v3/query_sql` request. */
const sqlOf = (request: RecordedInfluxRequestT): { db: string; q: string } => JSON.parse(request.body as string);

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/profile", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockSQLProvider);
    (mockSQLProvider.query as ReturnType<typeof mock>).mockClear();
    (mockMongoProvider.query as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  // The column name arrives in the request. It used to be embedded as a string literal
  // (`'<col>' as column_name`), which needed the dialect's literal quoting (#290); the
  // statement no longer carries the name as a value at all, only as a quoted identifier.
  test("never writes the column name into the statement as a string literal", async () => {
    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: {
        connection: { ...validConnection, type: "mysql" },
        tablePath: ["public", "users"],
        columns: ["a\\' UNION SELECT 1 -- "],
      },
    });

    await POST(req as never);

    const emitted = (mockSQLProvider.query as ReturnType<typeof mock>).mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(emitted).toContain('"a\\\' UNION SELECT 1 -- "');
    expect(emitted).not.toContain("column_name");
  });

  // E2E-007's root cause: one PostgreSQL-only statement for every engine. Every statement
  // the route writes is now plain SQL with no cast, so it is checked here on an engine that
  // is not PostgreSQL, through the real provider: SQLite rejected `::text` outright.
  describe("on a real SQLite database", () => {
    const sqliteConnection = {
      id: "test-sqlite",
      name: "Test SQLite",
      type: "sqlite" as const,
      database: ":memory:",
      createdAt: new Date(0),
    };

    async function seededSqlite() {
      const provider = new SQLiteProvider(sqliteConnection);
      await provider.connect();
      await provider.query("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, total REAL, payload BLOB)");
      // ids 1..200, so text ordering would answer max 99; every third name is NULL.
      for (let id = 1; id <= 200; id++) {
        const name = id % 3 === 0 ? "NULL" : `'n${id % 7}'`;
        await provider.query(`INSERT INTO customers VALUES (${id}, ${name}, ${id * 2.5}, x'DEAD')`);
      }
      return provider;
    }

    test("profiles every column, with numeric min and max and real null counts", async () => {
      const provider = await seededSqlite();
      mockGetOrCreateProvider.mockResolvedValueOnce(provider);
      const body = { connection: sqliteConnection, tablePath: ["customers"], columns: ["id", "name", "total"] };

      const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
      const data = await parseResponseJSON<{ totalRows: number; columns: Record<string, unknown>[] }>(res);
      await provider.disconnect();

      expect(res.status).toBe(200);
      expect(data.totalRows).toBe(200);
      expect(data.columns).toEqual([
        expect.objectContaining({
          name: "id",
          nullCount: 0,
          nullPercent: 0,
          distinctCount: 200,
          minValue: "1",
          maxValue: "200",
          sampleValues: ["1", "2", "3", "4", "5"],
        }),
        expect.objectContaining({ name: "name", nullCount: 66, nullPercent: 33, distinctCount: 7 }),
        expect.objectContaining({ name: "total", minValue: "2.5", maxValue: "500" }),
      ]);
      for (const column of data.columns) {
        expect(column.error).toBeUndefined();
        expect(column.warnings).toBeUndefined();
      }
    });

    test("writes a binary min and max as hex, not as a serialized Buffer", async () => {
      const provider = await seededSqlite();
      mockGetOrCreateProvider.mockResolvedValueOnce(provider);
      const body = { connection: sqliteConnection, tablePath: ["customers"], columns: ["payload"] };

      const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
      const data = await parseResponseJSON<{ columns: Record<string, unknown>[] }>(res);
      await provider.disconnect();

      expect(data.columns[0]).toMatchObject({ minValue: "\\xdead", maxValue: "\\xdead" });
    });
  });

  test("no statement carries a PostgreSQL cast, and the sample is bounded by the provider", async () => {
    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["id", "name"] },
    });

    await POST(req as never);

    const emitted = (mockSQLProvider.query as ReturnType<typeof mock>).mock.calls.map((call) => String(call[0]));
    for (const sql of emitted) expect(sql).not.toContain("::");
    // The sample's bound is the provider's own spelling (`FETCH FIRST`, `TOP`, `LIMIT`), so the
    // route hands it an unbounded statement and the limit as an option.
    expect(mockSQLProvider.prepareQuery).toHaveBeenCalledWith("SELECT id, name FROM public.users", { limit: 5 });
    expect(emitted.at(-1)).toBe("SELECT id, name FROM public.users LIMIT 50");
  });

  test("reads result aliases whatever case the engine folded them to", async () => {
    // Oracle folds an unquoted alias to upper case: `total` comes back as `TOTAL`.
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ TOTAL: 3 }], fields: ["TOTAL"] };
      if (sql.includes("non_null_count")) {
        const row = {
          TOTAL_COUNT: 3,
          NON_NULL_COUNT: 2,
          DISTINCT_COUNT: 2,
          MIN_VALUE: new Date("2026-01-02T00:00:00.000Z"),
          MAX_VALUE: BigInt("12345678901234567890"),
        };
        return { rows: [row], fields: Object.keys(row) };
      }
      return { rows: [{ ID: 1 }, { ID: null }], fields: ["ID"] };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["APP", "EMP"], columns: ["id"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ totalRows: number; columns: Record<string, unknown>[] }>(res);

    expect(res.status).toBe(200);
    expect(data.totalRows).toBe(3);
    expect(data.columns[0]).toMatchObject({
      name: "id",
      totalRows: 3,
      nullCount: 1,
      nullPercent: 33,
      distinctCount: 2,
      minValue: "2026-01-02T00:00:00.000Z",
      maxValue: "12345678901234567890",
      sampleValues: ["1", "NULL"],
    });
  });

  test("a measure the engine refuses is reported with its reason, and the others are kept", async () => {
    // SQL Server refuses COUNT(DISTINCT) on `text`; PostgreSQL has no MIN(boolean). The
    // one-statement profile fails, and each measure is then asked on its own.
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    const sent: string[] = [];
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      sent.push(sql);
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 4 }], fields: ["total"] };
      if (sql.includes("COUNT(DISTINCT")) throw new QueryError("The text data type cannot be selected as DISTINCT");
      if (sql.includes("MIN(")) return { rows: [{ min_value: null, max_value: null }], fields: [] };
      if (sql.includes("non_null_count")) return { rows: [{ total_count: 4, non_null_count: 3 }], fields: [] };
      return { rows: [], fields: [] };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["dbo", "notes"], columns: ["body"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ columns: Record<string, unknown>[] }>(res);

    expect(res.status).toBe(200);
    expect(data.columns[0]).toEqual({
      name: "body",
      totalRows: 4,
      nullCount: 1,
      nullPercent: 25,
      warnings: ["Distinct count: The text data type cannot be selected as DISTINCT"],
      sampleValues: [],
    });
    expect(sent.slice(1, 5)).toEqual([
      "SELECT COUNT(*) AS total_count, COUNT(body) AS non_null_count, COUNT(DISTINCT body) AS distinct_count, MIN(body) AS min_value, MAX(body) AS max_value FROM dbo.notes",
      "SELECT COUNT(*) AS total_count, COUNT(body) AS non_null_count FROM dbo.notes",
      "SELECT COUNT(DISTINCT body) AS distinct_count FROM dbo.notes",
      "SELECT MIN(body) AS min_value, MAX(body) AS max_value FROM dbo.notes",
    ]);
  });

  test("a range the engine refuses is reported with its reason", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 2 }], fields: ["total"] };
      if (sql.includes("MIN(")) throw new QueryError("function min(boolean) does not exist");
      if (sql.includes("COUNT(DISTINCT")) return { rows: [{ distinct_count: 2 }], fields: [] };
      if (sql.includes("non_null_count")) return { rows: [{ total_count: 2, non_null_count: 2 }], fields: [] };
      return { rows: [], fields: [] };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["public", "flags"], columns: ["on"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ columns: Record<string, unknown>[] }>(res);

    expect(data.columns[0]).toMatchObject({
      name: "on",
      nullCount: 0,
      distinctCount: 2,
      warnings: ["Min/max: function min(boolean) does not exist"],
    });
  });

  test("a column no aggregate takes still has its nulls counted through IS NULL", async () => {
    // SQL Server `text` and Oracle CLOB refuse COUNT(col) itself, measured on both.
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    const sent: string[] = [];
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      sent.push(sql);
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ TOTAL: 200 }], fields: [] };
      if (sql.includes("IS NULL")) return { rows: [{ NULL_COUNT: 50 }], fields: [] };
      if (sql.startsWith("SELECT bio FROM")) return { rows: [], fields: [] };
      throw new QueryError("ORA-22849: Type CLOB is not supported for this function or operator.");
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["APP", "EMP"], columns: ["bio"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ columns: Record<string, unknown>[] }>(res);

    expect(data.columns[0]).toEqual({
      name: "bio",
      totalRows: 200,
      nullCount: 50,
      nullPercent: 25,
      warnings: ["Distinct count and min/max: ORA-22849: Type CLOB is not supported for this function or operator."],
      sampleValues: [],
    });
    // The two other aggregates are not sent to be refused a second time.
    expect(sent.slice(1)).toEqual([
      'SELECT COUNT(*) AS total_count, COUNT(bio) AS non_null_count, COUNT(DISTINCT bio) AS distinct_count, MIN(bio) AS min_value, MAX(bio) AS max_value FROM "APP"."EMP"',
      'SELECT COUNT(*) AS total_count, COUNT(bio) AS non_null_count FROM "APP"."EMP"',
      'SELECT COUNT(*) AS null_count FROM "APP"."EMP" WHERE bio IS NULL',
      'SELECT bio FROM "APP"."EMP" LIMIT 50',
    ]);
  });

  test("an IS NULL count that answers no row is not read as zero nulls", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 7 }], fields: [] };
      if (sql.includes("IS NULL")) return { rows: [], fields: [] };
      throw new QueryError("Operand data type text is invalid for count operator.");
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["dbo", "notes"], columns: ["body"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ columns: Record<string, unknown>[] }>(res);

    expect(data.columns[0]).toEqual({
      name: "body",
      totalRows: 7,
      error: "Operand data type text is invalid for count operator.",
    });
  });

  // A timeout, a lost connection or a cancel says nothing about the column, and on a table
  // big enough to time out every further measure is one more full scan: the profile ends there.
  test("a timeout ends the profile at once, with the timeout's own response", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    const sent: string[] = [];
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      sent.push(sql);
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 1e9 }], fields: [] };
      throw new TimeoutError("canceling statement due to statement timeout", "postgres", 30000);
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["public", "events"], columns: ["a", "b"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);

    expect(res.status).toBe(408);
    expect(sent).toHaveLength(2);
  });

  test("a connection lost between measures ends the profile with a 503, not a column warning", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 3 }], fields: [] };
      if (sql.includes("MIN(") && !sql.includes("DISTINCT")) throw new ConnectionError("Connection terminated");
      if (sql.includes("COUNT(DISTINCT")) throw new QueryError("could not identify an equality operator for type json");
      return { rows: [{ total_count: 3, non_null_count: 3 }], fields: [] };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["public", "docs"], columns: ["meta"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toBe("Connection terminated");
  });

  test("refuses column names that are not strings", async () => {
    for (const columns of ["id", [1], ["id", null]]) {
      const body = { connection: validConnection, tablePath: ["public", "users"], columns };
      const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toContain("columns");
    }
    expect(mockSQLProvider.query).not.toHaveBeenCalled();
  });

  test("a column the engine cannot count says why, and reports no null figures", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 9 }], fields: ["total"] };
      if (sql.includes("geom")) throw new QueryError("ORA-22849: type SDO_GEOMETRY is not supported");
      // Not an engine error: whatever it says stays on the server.
      if (sql.includes("secret")) throw new TypeError("internal detail /srv/app/x.js");
      return { rows: [], fields: [] };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["APP", "SHAPES"], columns: ["geom", "secret"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ columns: Record<string, unknown>[] }>(res);

    expect(data.columns).toEqual([
      { name: "geom", totalRows: 9, error: "ORA-22849: type SDO_GEOMETRY is not supported" },
      { name: "secret", totalRows: 9, error: "Could not profile this column" },
    ]);
  });

  test("profiles the first 20 columns and names the ones it left out", async () => {
    const columns = Array.from({ length: 22 }, (_, i) => `c${i + 1}`);
    const body = { connection: validConnection, tablePath: ["public", "wide"], columns };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ columns: { name: string }[]; omittedColumns?: string[] }>(res);

    expect(data.columns.map((c) => c.name)).toEqual(columns.slice(0, 20));
    expect(data.omittedColumns).toEqual(["c21", "c22"]);
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["id"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns column profiles for SQL provider with columns", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) return { rows: [{ total: 100 }], fields: ["total"] };
      if (sql.includes("non_null_count")) {
        const row = { total_count: 100, non_null_count: 100, distinct_count: 100, min_value: 1, max_value: 100 };
        return { rows: [row], fields: Object.keys(row) };
      }
      return { rows: [{ id: 1 }], fields: ["id"] };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["id"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ tableName: string; totalRows: number; columns: Record<string, unknown>[] }>(
      res,
    );

    expect(res.status).toBe(200);
    expect(data).toEqual({
      tableName: "users",
      totalRows: 100,
      columns: [
        {
          name: "id",
          totalRows: 100,
          nullCount: 0,
          nullPercent: 0,
          distinctCount: 100,
          minValue: "1",
          maxValue: "100",
          sampleValues: ["1"],
        },
      ],
    });
  });

  test("returns 400 for SQL provider with no columns", async () => {
    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: [] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("No columns");
  });

  test("returns column profiles for MongoDB provider", async () => {
    const mongoProvider = createMockProvider({
      capabilities: {
        queryLanguage: "json",
        containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
      },
    });
    (mongoProvider.query as ReturnType<typeof mock>).mockImplementation(async (queryStr: string) => {
      const parsed = JSON.parse(queryStr);
      if (parsed.operation === "aggregate") {
        return {
          rows: [
            { status: "active", name: "Alice" },
            { status: "inactive", name: "Bob" },
          ],
          fields: ["status", "name"],
          rowCount: 2,
          executionTime: 5,
        };
      }
      if (parsed.operation === "count") {
        return { rows: [{ count: 50 }], fields: ["count"], rowCount: 1, executionTime: 3 };
      }
      // The real provider answers an unknown operation with QueryError
      // ("Unsupported operation: X"), so the mock must too: a mock that returns
      // empty rows for anything at all accepted `countDocuments` - an operation
      // MongoDBProvider has never supported - and the route shipped with it.
      throw new Error(`Unsupported operation: ${parsed.operation}`);
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(mongoProvider);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: mongoConnection, tablePath: ["sample_shop", "users"], columns: ["status", "name"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      tableName: string;
      totalRows: number;
      columns: { name: string; nullCount: number; distinctCount: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.tableName).toBe("users");
    expect(data.totalRows).toBe(50);
    expect(data.columns).toBeArray();
    expect(data.columns.length).toBe(2);
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { tablePath: ["public", "users"], columns: ["id"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 400 when the address is missing, empty or not segments", async () => {
    // Four shapes, because `Array.isArray` alone accepts three of them: a caller that lost
    // the address, one that sent an empty one, one that sent the old dotted STRING, and one
    // whose array holds something that is not a segment (memory: cast-is-not-a-check).
    for (const tablePath of [undefined, [], "public.users", ["public", null]]) {
      const req = createMockRequest("/api/db/profile", {
        method: "POST",
        body: { connection: validConnection, ...(tablePath === undefined ? {} : { tablePath }), columns: ["id"] },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toContain("tablePath");
    }
  });

  test("returns 500 on error", async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(new Error("Database unavailable"));

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["id"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Database unavailable");
  });

  /**
   * The defect Task 35 closed, at the one seam that could still only see a label (#789).
   *
   * The fixture is the collision itself: the live SQL Server holds `libredb_objects.app.customers`
   * and `shop.dbo.customers`. The request below asks for the SECOND, and the assertion is that
   * the statement the engine is sent addresses THAT one - a route that keeps the object's own
   * segment, or that qualifies it from the wrong container, profiles the other table and answers
   * 200 with somebody else's statistics.
   */
  test("profiles the object at the ADDRESS it was given, not the label's first match", async () => {
    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: {
        connection: { ...validConnection, type: "mssql", port: 1433 },
        tablePath: ["shop", "dbo", "customers"],
        columns: ["id"],
      },
    });

    await POST(req as never);

    const emitted = (mockSQLProvider.query as ReturnType<typeof mock>).mock.calls.map((call) => String(call[0]));
    expect(emitted.length).toBeGreaterThan(0);
    for (const sql of emitted) {
      expect(sql).toContain("FROM shop.dbo.customers");
      expect(sql).not.toContain("libredb_objects");
    }
  });

  test("a segment containing a dot is ONE segment, not two qualifiers", async () => {
    // ClickHouse really holds `demo`.`.inner_id.fake`. The string form split it into
    // `""."inner_id"."fake"`, which is the last instance of the defect `path` exists to retire.
    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["demo", ".inner_id.fake"], columns: ["id"] },
    });

    await POST(req as never);

    const emitted = String((mockSQLProvider.query as ReturnType<typeof mock>).mock.calls[0]?.[0]);
    expect(emitted).toContain('FROM demo.".inner_id.fake"');
  });

  test("MongoDB is addressed by its database and the collection's own segment, not by the joined path", async () => {
    // A collection's path is [database, collection] and the driver takes the collection
    // alone, so the database rides as its own key (#843): without it both reads went to
    // the connected database's same-named collection. `jsonCommandAddress` is the reading
    // the generators use too.
    const mongoProvider = createMockProvider({
      capabilities: {
        queryLanguage: "json",
        containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
      },
    });
    (mongoProvider.query as ReturnType<typeof mock>).mockImplementation(async (queryStr: string) => {
      const parsed = JSON.parse(queryStr);
      if (parsed.operation === "count")
        return { rows: [{ count: 1 }], fields: ["count"], rowCount: 1, executionTime: 1 };
      return { rows: [{ status: "active" }], fields: ["status"], rowCount: 1, executionTime: 1 };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(mongoProvider);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: mongoConnection, tablePath: ["sample_shop", "users"], columns: ["status"] },
    });

    await POST(req as never);

    const calls = (mongoProvider.query as ReturnType<typeof mock>).mock.calls;
    // Both reads, the sample and the count, so the loop below cannot pass over nothing.
    expect(calls.map((call) => JSON.parse(String(call[0])).operation)).toEqual(["aggregate", "count"]);
    for (const call of calls) {
      const parsed = JSON.parse(String(call[0]));
      expect(parsed.database).toBe("sample_shop");
      expect(parsed.collection).toBe("users");
    }
  });

  /**
   * A language this route writes no statement in is refused before anything is sent (#1085).
   *
   * The route used to take every language that is not SQL for MongoDB, so a PromQL or a Redis
   * connection was sent an `aggregate` document. Each refusal below is paired, in the same
   * test, with the same request against a provider the route CAN profile, whose statements do
   * run, so "nothing was sent" cannot pass because the request never reached a provider. The
   * table and column names are distinctive so the message can be shown not to echo them.
   */
  test("refuses a PromQL connection with a 400 that names the language, and sends nothing", async () => {
    const promqlProvider = createMockProvider({ capabilities: { queryLanguage: "promql" } });
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    mockGetOrCreateProvider.mockResolvedValueOnce(promqlProvider);
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);
    const body = { connection: validConnection, tablePath: ["refusal_probe_metric"], columns: ["refusal_probe_label"] };

    const refused = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(refused);

    expect(refused.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toContain('"promql"');
    expect(data.error).not.toContain("refusal_probe_metric");
    expect(data.error).not.toContain("refusal_probe_label");
    expect(promqlProvider.query).not.toHaveBeenCalled();

    // The control: the same request against SQL is profiled, and its statements run.
    const profiled = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    expect(profiled.status).toBe(200);
    expect(sqlProvider.query).toHaveBeenCalled();
  });

  test("refuses JSON in a dialect of its own, which is not the document the route builds", async () => {
    const redisProvider = createMockProvider({ capabilities: { queryLanguage: "json", queryDialect: "redis" } });
    const mongoProvider = createMockProvider({ capabilities: { queryLanguage: "json" } });
    mockGetOrCreateProvider.mockResolvedValueOnce(redisProvider);
    mockGetOrCreateProvider.mockResolvedValueOnce(mongoProvider);
    const body = { connection: mongoConnection, tablePath: ["refusal_probe_prefix"], columns: ["refusal_probe_field"] };

    const refused = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(refused);

    expect(refused.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toContain('"json" in the redis dialect');
    expect(data.error).not.toContain("refusal_probe_prefix");
    expect(data.error).not.toContain("refusal_probe_field");
    expect(redisProvider.query).not.toHaveBeenCalled();

    // The control: MongoDB's JSON, with no dialect, is profiled with its two statements.
    const profiled = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    expect(profiled.status).toBe(200);
    expect(mongoProvider.query).toHaveBeenCalledTimes(2);
  });

  test("refuses a Kafka connection, whose read request is JSON of its own dialect, and sends nothing (#1088)", async () => {
    // The provider's own declaration, so the refusal is the one a topic's profile request meets.
    const kafka = new KafkaProvider({ ...kafkaConnection, createdAt: new Date(0) }).getCapabilities();
    const kafkaProvider = createMockProvider({ capabilities: kafka });
    const mongoProvider = createMockProvider({ capabilities: { queryLanguage: "json" } });
    mockGetOrCreateProvider.mockResolvedValueOnce(kafkaProvider);
    mockGetOrCreateProvider.mockResolvedValueOnce(mongoProvider);
    const body = { connection: kafkaConnection, tablePath: ["refusal_probe_topic"], columns: ["refusal_probe_key"] };

    const refused = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(refused);

    expect(refused.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toContain('"json" in the kafka dialect');
    expect(data.error).not.toContain("refusal_probe_topic");
    expect(data.error).not.toContain("refusal_probe_key");
    expect(kafkaProvider.query).not.toHaveBeenCalled();

    // The control: MongoDB's JSON, with no dialect, is profiled with its two statements.
    const profiled = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    expect(profiled.status).toBe(200);
    expect(mongoProvider.query).toHaveBeenCalledTimes(2);
  });

  test("refuses an etcd connection, whose text is a line of etcdctl's, and sends nothing (#1089)", async () => {
    // The provider's own declaration, so the refusal is the one a key-prefix group's profile request meets.
    const etcd = new EtcdProvider({ ...etcdConnection, createdAt: new Date(0) }).getCapabilities();
    const etcdProvider = createMockProvider({ capabilities: etcd });
    mockGetOrCreateProvider.mockResolvedValueOnce(etcdProvider);
    const body = { connection: etcdConnection, tablePath: ["/refusal_probe/*"], columns: ["refusal_probe_column"] };

    const refused = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(refused);

    expect(refused.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toContain('"json" in the etcd dialect');
    expect(data.error).not.toContain("refusal_probe");
    expect(etcdProvider.query).not.toHaveBeenCalled();
  });

  test("refuses a Cypher connection with a 400 that names the language, and sends nothing (Neo4j spec 6.5)", async () => {
    // Correct as a fall-through: `offersColumnProfiling` names the two languages the route writes.
    const cypherProvider = createMockProvider({ capabilities: { queryLanguage: "cypher" } });
    mockGetOrCreateProvider.mockResolvedValueOnce(cypherProvider);
    const body = { connection: validConnection, tablePath: ["neo4j", "(:Person)"], columns: ["name"] };

    const refused = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(refused);

    expect(refused.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toContain('"cypher"');
    expect(cypherProvider.query).not.toHaveBeenCalled();
  });

  test("refuses an InfluxQL connection with a 400 that names the language, and sends nothing (InfluxDB spec 6.7)", async () => {
    // Correct as a fall-through: `offersColumnProfiling` names the two languages the route writes. The provider's own
    // declaration, so the refusal is the one a measurement's profile request meets.
    const influxql = new InfluxDBProvider({ ...influxdbConnection, createdAt: new Date(0) }).getCapabilities();
    const influxqlProvider = createMockProvider({ capabilities: influxql });
    mockGetOrCreateProvider.mockResolvedValueOnce(influxqlProvider);
    const body = {
      connection: influxdbConnection,
      tablePath: ["home", "refusal_probe_measurement"],
      columns: ["refusal_probe_field"],
    };

    const refused = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(refused);

    expect(refused.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toContain('"influxql"');
    expect(data.error).not.toContain("refusal_probe");
    expect(influxqlProvider.query).not.toHaveBeenCalled();
  });

  test("profiles an InfluxDB 3 table with the route's SQL, on the session database, unqualified (R25, K19)", async () => {
    const { provider, requests } = await connectedInfluxdb3([
      () => jsonlAnswer([{ total: 3 }]),
      () =>
        jsonlAnswer([
          {
            total_count: 3,
            non_null_count: 2,
            distinct_count: 2,
            min_value: 21,
            max_value: 22.5,
          },
        ]),
      () => jsonlAnswer([{ temp: 21 }, { temp: 22.5 }]),
    ]);
    mockGetOrCreateProvider.mockResolvedValueOnce(provider);
    const body = { connection: influxdb3Connection, tablePath: ["home"], columns: ["temp"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{
      tableName: string;
      totalRows: number;
      columns: { name: string; nullCount: number; distinctCount: number; sampleValues?: string[] }[];
    }>(res);
    await provider.disconnect();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ tableName: "home", totalRows: 3 });
    expect(data.columns).toEqual([
      expect.objectContaining({ name: "temp", nullCount: 1, distinctCount: 2, sampleValues: ["21", "22.5"] }),
    ]);
    // The three statements after the connect, each on the session database and naming the table unqualified.
    const sent = requests.slice(2).map(sqlOf);
    expect(sent.map((statement) => statement.db)).toEqual(["home", "home", "home"]);
    expect(sent[0].q).toBe('SELECT COUNT(*) AS total FROM "home"');
    expect(sent[1].q).toContain('COUNT(DISTINCT "temp") AS distinct_count');
    expect(sent[2].q).toBe('SELECT "temp" FROM "home" LIMIT 5');
  });

  test("an InfluxDB 3 profile past the Core file limit fails with the file-limit sentence (R25)", async () => {
    const { provider, requests } = await connectedInfluxdb3([loadInfluxCapture("3.12.0-core", "filelimit-sql")]);
    mockGetOrCreateProvider.mockResolvedValueOnce(provider);
    const body = { connection: influxdb3Connection, tablePath: ["home"], columns: ["temp"] };

    const res = await POST(createMockRequest("/api/db/profile", { method: "POST", body }) as never);
    const data = await parseResponseJSON<{ error: string }>(res);
    await provider.disconnect();

    expect(res.status).toBe(400);
    expect(data.error).toBe(INFLUX_ERROR_SENTENCES.fileLimit as string);
    // The first COUNT(*) failed the request: nothing was sent after it.
    expect(requests.slice(2).map((request) => sqlOf(request).q)).toEqual(['SELECT COUNT(*) AS total FROM "home"']);
  });
});
