import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import {
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

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

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/query/route");

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/query", () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("passes queryId to provider when cancellation is supported", async () => {
    const providerWithCancel = {
      ...createMockProvider(),
      cancelQuery: mock(async () => true),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithCancel as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users", queryId: "query-42" },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(providerWithCancel.query).toHaveBeenCalledWith("SELECT * FROM users LIMIT 50", undefined, "query-42");
  });

  // ── Bound parameters (#290) ───────────────────────────────────────────────
  //
  // A generated statement (the inline row editor) sends its values here instead of
  // writing them into the SQL, so a value cannot close a string literal and have
  // the rest read as statement text. The route is the last hop before the driver's
  // bind path, so it is also where an unbindable value is refused.

  test("binds the request's parameters instead of running the statement unbound", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: `UPDATE users SET "name" = $1 WHERE "id" = $2`,
        params: ["\\' WHERE 1=1 -- ", 7],
      },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.query).toHaveBeenCalledWith(`UPDATE users SET "name" = $1 WHERE "id" = $2 LIMIT 50`, [
      "\\' WHERE 1=1 -- ",
      7,
    ]);
  });

  test("binds parameters alongside a queryId when cancellation is supported", async () => {
    const providerWithCancel = {
      ...createMockProvider(),
      cancelQuery: mock(async () => true),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithCancel as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: `UPDATE users SET "name" = $1 WHERE "id" = $2`,
        params: ["Alice", 7],
        queryId: "query-42",
      },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(providerWithCancel.query).toHaveBeenCalledWith(
      `UPDATE users SET "name" = $1 WHERE "id" = $2 LIMIT 50`,
      ["Alice", 7],
      "query-42",
    );
  });

  test("returns 400 for a parameter the driver cannot bind as a scalar", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users WHERE id = $1", params: [{ nested: true }] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("params");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("returns 200 with rows and pagination for valid query", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      rows: unknown[];
      fields: string[];
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
    expect(data.pagination).toBeDefined();
    expect(data.pagination.limit).toBe(50);
    expect(data.pagination.offset).toBe(0);
    expect(data.pagination.wasLimited).toBe(true);
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 400 when sql is missing", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 400 for QueryError", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryError('syntax error at or near "FORM"'),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FORM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("syntax error");
    expect(data.code).toBe("QUERY_ERROR");
  });

  test("returns 408 for TimeoutError", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new TimeoutError("Query timed out after 30000ms"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT pg_sleep(60)" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(408);
    expect(data.error).toContain("timed out");
  });

  test("returns 500 for DatabaseError", async () => {
    const dbError = new DatabaseError("Internal database failure", "postgres", "INTERNAL_ERROR");
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Internal database failure");
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("returns 499 for cancelled query", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryCancelledError("Query was cancelled"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM large_table" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(499);
    expect(data.code).toBe("QUERY_CANCELLED");
    expect(data.error).toContain("cancelled");
  });

  test("returns 500 for generic error", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Something unexpected happened"));

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Something unexpected happened");
  });

  test("calls prepareQuery with sql and options", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "SELECT * FROM users",
        options: { limit: 100 },
      },
    });

    await POST(req as never);

    expect(mockProvider.prepareQuery).toHaveBeenCalledTimes(1);
    expect(mockProvider.prepareQuery).toHaveBeenCalledWith("SELECT * FROM users", { limit: 100 });
  });

  test("pagination hasMore is true when rows.length equals limit", async () => {
    const fiftyRows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: fiftyRows,
      fields: ["id"],
      rowCount: 50,
      executionTime: 10,
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.hasMore).toBe(true);
    expect(data.pagination.totalReturned).toBe(50);
  });

  test("pagination hasMore is false when rows.length less than limit", async () => {
    const threeRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: threeRows,
      fields: ["id"],
      rowCount: 3,
      executionTime: 5,
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.totalReturned).toBe(3);
  });

  test("returns 499 for interrupted query execution", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryCancelledError("Query execution was interrupted"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(499);
    expect(data.code).toBe("QUERY_CANCELLED");
  });
});
