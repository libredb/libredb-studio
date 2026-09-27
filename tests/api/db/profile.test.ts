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

  // The column name arrives in the request and is embedded in the profiling query
  // as a string literal (`'<col>' as column_name`). Doubling the quote is enough
  // only where a backslash is data, so on a backslash-escaping dialect a name
  // ending in one would close the literal and have the rest read as SQL (#290).
  test("quotes the column label for the connected dialect", async () => {
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
    expect(emitted).toContain("'a\\\\'' UNION SELECT 1 -- ' as column_name");
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
    // Mock SQL query responses - order matters:
    // 1st call: SELECT COUNT(*) as total FROM users
    // 2nd call: per-column profile query containing 'as column_name'
    // 3rd call: SELECT "id" FROM users LIMIT 5
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    const mockQuery = mock(async (sql: string) => {
      if (sql.includes("as total") && !sql.includes("as column_name")) {
        return { rows: [{ total: 100 }], fields: ["total"], rowCount: 1, executionTime: 5 };
      }
      if (sql.includes("as column_name")) {
        return {
          rows: [
            {
              column_name: "id",
              total_count: 100,
              non_null_count: 100,
              null_count: 0,
              distinct_count: 100,
              min_value: "1",
              max_value: "100",
            },
          ],
          fields: [
            "column_name",
            "total_count",
            "non_null_count",
            "null_count",
            "distinct_count",
            "min_value",
            "max_value",
          ],
          rowCount: 1,
          executionTime: 5,
        };
      }
      // sample query
      return { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 5 };
    });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(mockQuery);
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["id"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      tableName: string;
      totalRows: number;
      columns: { name: string; totalRows: number; nullCount: number; distinctCount: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.tableName).toBe("users");
    expect(data.totalRows).toBe(100);
    expect(data.columns).toBeArray();
    expect(data.columns.length).toBeGreaterThan(0);
    expect(data.columns[0].name).toBe("id");
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

  test("SQL sample values included for top 5 columns", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.includes("as total") && !sql.includes("as column_name")) {
        return { rows: [{ total: 50 }], fields: ["total"], rowCount: 1, executionTime: 5 };
      }
      if (sql.includes("as column_name")) {
        // Extract column name from the SQL pattern: 'colname' as column_name
        const match = sql.match(/'([^']+)' as column_name/);
        const colName = match ? match[1] : "unknown";
        return {
          rows: [
            {
              column_name: colName,
              total_count: 50,
              non_null_count: 48,
              null_count: 2,
              distinct_count: 30,
              min_value: "a",
              max_value: "z",
            },
          ],
          fields: [
            "column_name",
            "total_count",
            "non_null_count",
            "null_count",
            "distinct_count",
            "min_value",
            "max_value",
          ],
          rowCount: 1,
          executionTime: 5,
        };
      }
      // Sample query (SELECT "name", "email" FROM users LIMIT 5)
      return {
        rows: [
          { name: "Alice", email: "alice@test.com" },
          { name: "Bob", email: "bob@test.com" },
        ],
        fields: ["name", "email"],
        rowCount: 2,
        executionTime: 3,
      };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["name", "email"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      columns: { name: string; sampleValues?: string[] }[];
    }>(res);

    expect(res.status).toBe(200);
    const nameProfile = data.columns.find((c) => c.name === "name");
    expect(nameProfile).toBeDefined();
    expect(nameProfile!.sampleValues).toBeArray();
  });

  test("SQL column profiling error is gracefully handled", async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: "sql" } });
    let profileCallIdx = 0;
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.includes("as total") && !sql.includes("as column_name")) {
        return { rows: [{ total: 100 }], fields: ["total"], rowCount: 1, executionTime: 5 };
      }
      if (sql.includes("as column_name")) {
        profileCallIdx++;
        if (profileCallIdx === 1) {
          throw new Error("Cannot profile binary column");
        }
        return {
          rows: [
            {
              column_name: "name",
              total_count: 100,
              non_null_count: 100,
              null_count: 0,
              distinct_count: 50,
              min_value: "a",
              max_value: "z",
            },
          ],
          fields: [
            "column_name",
            "total_count",
            "non_null_count",
            "null_count",
            "distinct_count",
            "min_value",
            "max_value",
          ],
          rowCount: 1,
          executionTime: 5,
        };
      }
      return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest("/api/db/profile", {
      method: "POST",
      body: { connection: validConnection, tablePath: ["public", "users"], columns: ["binary_col", "name"] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      columns: { name: string; error?: string }[];
    }>(res);

    expect(res.status).toBe(200);
    // The first column should have an error fallback
    const errorCol = data.columns.find((c) => c.error);
    expect(errorCol).toBeDefined();
    expect(errorCol!.error).toContain("Could not profile");
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
});
