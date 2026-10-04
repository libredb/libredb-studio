import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { installStandInVocabulary, STAND_IN_TYPE } from "../../helpers/stand-in-vocabulary";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { discoverRoutes } from "../../security/helpers/discover-routes";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { agentReadSqlInput } from "@/lib/db/operations/statement-guard";
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
import type { DatabaseConnection } from "@/lib/types";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);
/** The unconnected provider a route reads a declaration from, `provider-meta`'s way (#457). */
const mockCreateDatabaseProvider = mock(async (_connection: unknown) => mockProvider);

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
      // A managed id resolves from the OPERATOR's config and everything the caller attached to the
      // request is discarded — which the real `resolveConnection` does for the same reason (a `seed:`
      // id is the operator's namespace, GHSA-3wh2-8x78). This is exactly the path the top-level
      // `database` field has to survive: nothing the caller sent on a connection reaches this object.
      if (typeof body.connectionId === "string" && body.connectionId.startsWith("seed:")) {
        return {
          id: body.connectionId,
          name: "Seed Redis",
          type: "redis",
          host: "seed-host",
          port: 6379,
          database: "0",
        };
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mockCreateDatabaseProvider,
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
// The real check the factory runs first (#1089). This file replaces `@/lib/db`, the route's own import,
// and not `@/lib/db/factory`, so the test below can run the real refusal inside the replaced factory.
const { assertReadOnlyHonoured } = await import("@/lib/db/factory");

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
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  for (const [count, providerLimited, expectedLimited] of [
    [2, false, false],
    [50, false, true],
    [2, true, true],
  ] as const) {
    test(`reports a ${count}-row page with provider cut=${providerLimited} accurately`, async () => {
      (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
        rows: Array.from({ length: count }, (_, i) => ({ id: i + 1 })),
        fields: ["id"],
        rowCount: count,
        executionTime: 1,
        pagination: { limit: 50, offset: 0, hasMore: false, totalReturned: count, wasLimited: providerLimited },
      });
      const req = createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT * FROM users" },
      });
      const res = await POST(req as never);
      const data = await parseResponseJSON<{ pagination: unknown }>(res);
      expect(res.status).toBe(200);
      expect(data.pagination).toEqual({
        limit: 50,
        offset: 0,
        hasMore: count === 50,
        totalReturned: count,
        wasLimited: expectedLimited,
      });
    });
  }

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
    expect(providerWithCancel.query).toHaveBeenCalledWith(
      "SELECT * FROM users LIMIT 50",
      undefined,
      "query-42",
      expect.any(String),
    );
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
    expect(mockProvider.query).toHaveBeenCalledWith(
      `UPDATE users SET "name" = $1 WHERE "id" = $2 LIMIT 50`,
      ["\\' WHERE 1=1 -- ", 7],
      undefined,
      expect.any(String),
    );
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
      expect.any(String),
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
    expect(data.pagination.wasLimited).toBe(false);
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

  // #1089. The factory refuses a readOnly the engine cannot keep before it builds anything, and this
  // route answers that refusal as the configuration error it is. The replaced factory runs the real
  // check on the connection the route resolved, so a route that dropped or rewrote the field on the way
  // would fail here too.
  test("an inline read-only connection on an engine that does not enforce the mode answers 400 and runs nothing", async () => {
    mockCreateDatabaseProvider.mockClear();
    mockGetOrCreateProvider.mockImplementationOnce(async (...args: unknown[]) => {
      assertReadOnlyHonoured(args[0] as DatabaseConnection);
      return mockProvider;
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: { ...validConnection, readOnly: true }, sql: "SELECT * FROM users" },
    });
    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.code).toBe("CONFIG_ERROR");
    expect(data.error).toBe(
      "readOnly: true is refused for postgres: its provider does not enforce a read-only mode, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.",
    );
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
    expect(mockCreateDatabaseProvider).not.toHaveBeenCalled();
    expect(mockProvider.query).not.toHaveBeenCalled();
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

  test("a PostgreSQL statement timeout answers 408 TIMEOUT_ERROR, not 499 (#1145)", async () => {
    // The end-to-end shape of the bug: the provider throws the mapped error a real
    // `statement_timeout` produces, and the route must answer a retryable 408 timeout
    // rather than the 499 QUERY_CANCELLED that kept the previous rows on screen and
    // never told the user the statement timed out.
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      mapDatabaseError(new Error("canceling statement due to statement timeout"), "postgres"),
    );

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT pg_sleep(5)" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string; retryable?: boolean }>(res);

    expect(res.status).toBe(408);
    expect(data.code).toBe("TIMEOUT_ERROR");
    expect(res.status).not.toBe(499);
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

  /**
   * `hasMore` requires that the bound is OURS (#816).
   *
   * A statement the limiter DECLINED to rewrite comes back `wasLimited: false` with the
   * user's own bound still in the text — a ClickHouse query ending in `SETTINGS`, or a
   * hand-written `LIMIT 50`. Without this conjunct such a statement, returning exactly
   * `prepared.limit` rows, offered a Load More whose click re-ran it unchanged and
   * appended the rows already on screen. The two neighbouring tests both run with the
   * mock's default `wasLimited: true`, so neither can see this arm.
   */
  test("pagination hasMore is false at exactly limit rows when the bound is not ours", async () => {
    const declinedProvider = createMockProvider({
      prepareQueryResult: { query: "SELECT * FROM users LIMIT 50", wasLimited: false, limit: 50, offset: 0 },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(declinedProvider as never);
    (declinedProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
      fields: ["id"],
      rowCount: 50,
      executionTime: 10,
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users LIMIT 50" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.wasLimited).toBe(false);
    expect(data.pagination.totalReturned).toBe(50);
    expect(data.pagination.hasMore).toBe(false);
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

  /**
   * A bound the PROVIDER applied reaches the response too (#1085, section 5.4).
   *
   * The route rebuilt `pagination` from `prepareQuery` alone, so a provider that cut its own
   * result said so into a field the response then overwrote. The fixture is that provider's
   * shape: its `prepareQuery` rewrites nothing, and its result carries its own `pagination`.
   * The rows fill `prepared.limit` exactly and the provider's own `hasMore` says true, so a
   * route that took `hasMore` from the provider, or from the joined `wasLimited`, would offer
   * a Load More that re-runs the same statement; and the provider's other four fields differ
   * from the route's, so only `wasLimited` may cross.
   */
  test("keeps a provider-reported wasLimited, and hasMore stays on the limiter's own bound", async () => {
    const selfBounded = createMockProvider({
      prepareQueryResult: { query: "up", wasLimited: false, limit: 3, offset: 0 },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(selfBounded as never);
    (selfBounded.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
      fields: ["value"],
      rowCount: 3,
      executionTime: 4,
      pagination: { limit: 500, offset: 7, hasMore: true, totalReturned: 500, wasLimited: true },
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "up" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination).toEqual({ limit: 3, offset: 0, hasMore: false, totalReturned: 3, wasLimited: true });
  });

  test("the control: the same provider with no pagination of its own reports the limiter's false", async () => {
    const unbounded = createMockProvider({
      prepareQueryResult: { query: "up", wasLimited: false, limit: 3, offset: 0 },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(unbounded as never);
    (unbounded.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
      fields: ["value"],
      rowCount: 3,
      executionTime: 4,
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "up" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination).toEqual({ limit: 3, offset: 0, hasMore: false, totalReturned: 3, wasLimited: false });
  });

  test("a SQL result with no pagination of its own answers exactly what the route answered before", async () => {
    // Every shipped provider's shape: the mock's default `prepareQuery` rewrote the statement
    // (`wasLimited: true`, limit 50, `tests/helpers/mock-provider.ts:157-165`) and the result
    // carries no `pagination`. The whole object is pinned, so no field of it moved.
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
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
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination).toEqual({ limit: 50, offset: 0, hasMore: true, totalReturned: 50, wasLimited: true });
  });

  test("a provider's own false cannot clear a bound the limiter applied", async () => {
    // The same limiter-bounded statement, and a result that says `wasLimited: false`. No shipped
    // provider sets `pagination`, so this is the arm that keeps an external implementer's
    // `false` from hiding the badge, and `hasMore` still answers from the limiter's bound.
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
      fields: ["id"],
      rowCount: 50,
      executionTime: 10,
      pagination: { limit: 50, offset: 0, hasMore: false, totalReturned: 50, wasLimited: false },
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination).toEqual({ limit: 50, offset: 0, hasMore: true, totalReturned: 50, wasLimited: true });
  });

  test("a provider's own false leaves an untouched statement unlimited", async () => {
    // The mirror of the test above: nothing bounded this statement, and the provider's result
    // carries a `pagination` that says `wasLimited: false`. Only a `true` crosses, so a
    // `pagination` that is present is not by itself a bound, and the badge stays off.
    const untouched = createMockProvider({
      prepareQueryResult: { query: "up", wasLimited: false, limit: 3, offset: 0 },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(untouched as never);
    (untouched.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
      fields: ["value"],
      rowCount: 3,
      executionTime: 4,
      pagination: { limit: 3, offset: 0, hasMore: false, totalReturned: 3, wasLimited: false },
    });

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "up" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination).toEqual({ limit: 3, offset: 0, hasMore: false, totalReturned: 3, wasLimited: false });
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

/**
 * Regression for #328: the agent enforcement layer must not have followed the
 * operator into the editor. Everything #328 built — the read-only execution
 * profiles, the statement guard, the policy pipeline, the audited execution
 * glue — applies to the AGENT path only; a human running a write in the editor
 * is the product's primary use, and gating it would be a silent regression
 * that no test in the operations layer could see.
 */
describe("POST /api/db/query — the editor path stays outside the agent policy layer", () => {
  const writeStatement = "UPDATE orders SET status = 'shipped' WHERE id = 42";

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("executes a write the agent input contract refuses, through the shared provider", async () => {
    // The same statement, judged by both paths. If these ever agree, one of the
    // two is wrong: the agent contract must refuse it, the editor must run it.
    expect(agentReadSqlInput.safeParse({ sql: writeStatement }).success).toBe(false);

    const writeProvider = createMockProvider({
      prepareQueryResult: { query: writeStatement, wasLimited: false, limit: 0, offset: 0 },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(writeProvider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: writeStatement },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    // Reached the driver verbatim: not refused, not rewritten, not downgraded.
    expect(writeProvider.query).toHaveBeenCalledWith(writeStatement, undefined, undefined, expect.any(String));
    // The shared, fully-privileged provider cache - never an execution profile.
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
  });

  /**
   * Read from disk rather than asserted through a behaviour, deliberately. The
   * behavioural version of this check would be "the route emits no
   * agent_operation audit event", and it cannot fail: `bun run test` runs this
   * directory in one process with tests/api/db/maintenance.test.ts, whose
   * `mock.module("@/lib/audit")` replaces `emitAuditEvent` itself
   * process-wide, so no destination — buffer or stdout — would see an emission
   * even if the glue WERE wired in. A source-level invariant has no such hole.
   *
   * `discoverRoutes` is reused rather than re-walked here (it lives under
   * tests/security/helpers because the security enumerations were its first
   * callers): it recurses, so it sees `db/schema/list` and `db/schema/relations`
   * alongside `db/schema` — the exact case its own doc comment names, and the
   * one a single-level listing silently drops. Its route keys map back to files
   * deterministically, which is all this assertion needs.
   */
  const DB_ROUTES_DIR = join(import.meta.dir, "..", "..", "..", "src", "app", "api", "db");

  const dbRouteFiles = discoverRoutes(DB_ROUTES_DIR).map(([routeKey]) =>
    join(DB_ROUTES_DIR, ...routeKey.split("/"), "route.ts"),
  );

  test("the route enumeration finds every one of today's sixteen /api/db routes", () => {
    // An enumeration bug that found nothing - or that missed the nested schema
    // routes - would make the next test quietly narrower than it claims.
    expect(dbRouteFiles.length).toBeGreaterThanOrEqual(16);
    expect(dbRouteFiles.every((file) => existsSync(file))).toBe(true);
  });

  test("no /api/db route imports the agent operations layer", () => {
    const gated = dbRouteFiles.filter((file) => readFileSync(file, "utf8").includes("@/lib/db/operations"));
    expect(gated).toEqual([]);
  });
});

// ─── Server-built EXPLAIN (#574) ────────────────────────────────────────────
//
// The Explain panel used to build the EXPLAIN statement in the browser from the
// static `explainFormat` that `POST /api/db/provider-meta` answers WITHOUT
// connecting (#457). On the MySQL wire family the accepted form is only knowable
// once connected: measured 2026-09-06, `EXPLAIN FORMAT=JSON SELECT 1` is errno
// 1105 on TiDB v8.5.1 ("explain format 'json' is not supported now") and Apache
// Doris 4.1.3 ("mismatched input '='"), and errno 1064 on StarRocks 3.3.22 and
// SingleStore, while plain `EXPLAIN SELECT 1` is accepted on all of them. So the
// statement is built here, where the CONNECTED provider is, and the client sends
// the original statement plus the mode it wants.
describe("POST /api/db/query with an explain request", () => {
  const explainCapableProvider = () => createMockProvider({ capabilities: { explainFormat: "postgres-json" } });

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("runs the statement the connected provider's strategy builds and names the format", async () => {
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "SELECT * FROM users",
        options: {},
        explain: { mode: "estimate" },
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ explainFormat: string }>(res);

    expect(res.status).toBe(200);
    // The estimate plans without ANALYZE, so the statement is never executed (#1311).
    expect(provider.query).toHaveBeenCalledWith(
      "EXPLAIN (FORMAT JSON) SELECT * FROM users LIMIT 50",
      undefined,
      undefined,
      expect.any(String),
    );
    expect(data.explainFormat).toBe("postgres-json");
  });

  test("an analyze request builds the executing form the Explain button asks for", async () => {
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users", options: {}, explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(provider.query).toHaveBeenCalledWith(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users LIMIT 50",
      undefined,
      undefined,
      expect.any(String),
    );
  });

  /**
   * An EXPLAIN prefixes ONE statement. Handed `SELECT 1 AS a; INSERT ...` it explained
   * the SELECT and the simple-query protocol then ran the INSERT as a statement of its
   * own: measured on Materialize 26.44.1, AlloyDB Omni 17.9 and Cloudberry 2.1.0, a RUN
   * of that text applied the INSERT twice, once in the run and once in its background
   * plan request (#1311). Refused before any provider is opened, so nothing runs.
   */
  test.each<[string, string]>([
    ["a SELECT followed by a write", "SELECT 1 AS a; INSERT INTO t VALUES (7)"],
    ["two SELECTs", "SELECT 1; SELECT 2"],
  ])("returns 400 and runs nothing for an explain of %s", async (_label, sql) => {
    // No provider is queued: the refusal comes before one is opened, and a queued
    // `mockResolvedValueOnce` nobody consumed would leak into the next test.
    for (const mode of ["estimate", "analyze"]) {
      const req = createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql, explain: { mode } },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toBe("Only a single statement can be explained");
    }
    expect(mockProvider.query).not.toHaveBeenCalled();
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("a statement with a trailing semicolon or a quoted semicolon is still one statement", async () => {
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT ';' AS s;", options: {}, explain: { mode: "estimate" } },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(provider.query).toHaveBeenCalledTimes(1);
  });

  test("returns 400 and runs nothing when the provider declares no EXPLAIN support", async () => {
    const provider = createMockProvider({ capabilities: { supportsExplain: false, explainFormat: "postgres-json" } });
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("This server does not support EXPLAIN");
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("returns 400 and runs nothing when the provider declares no explain format", async () => {
    // supportsExplain true with no format is the Elasticsearch shape: the button is
    // hidden because no format is declared, so a request for one is still refused.
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("This server does not support EXPLAIN");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("returns 400 and runs nothing when the provider names a format this build does not register", async () => {
    // `getExplainStrategy` indexes a Record, so a format outside the union comes back as
    // undefined rather than null. A strict null check let that fall through to
    // `strategy.buildSql` and a TypeError, which the error mapper reports as a 500 with
    // no sentence a user can act on. Unreachable from this repo's providers today; an
    // external implementer of the published interface can declare anything.
    const provider = createMockProvider({
      capabilities: { supportsExplain: true, explainFormat: "oracle-hierarchy" as never },
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain: { mode: "analyze" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("This server does not support EXPLAIN");
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("returns 400 and runs nothing for a statement the strategy declines", async () => {
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "UPDATE users SET name = 'x'",
        explain: { mode: "analyze" },
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("Only SELECT statements can be explained");
    expect(provider.query).not.toHaveBeenCalled();
  });

  test("binds an explain request's parameters to the statement the strategy built", async () => {
    // The strategies only PREFIX the statement, so the built statement carries the
    // same placeholders in the same order and the same values bind them. This is the
    // contract PR #304 relied on when the browser still built the EXPLAIN itself:
    // without it, every generated statement that sends its values separately would
    // lose its plan.
    const provider = explainCapableProvider();
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "SELECT * FROM users WHERE id = $1",
        options: {},
        params: [7],
        explain: { mode: "estimate" },
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ explainFormat: string }>(res);

    expect(res.status).toBe(200);
    expect(provider.query).toHaveBeenCalledWith(
      "EXPLAIN (FORMAT JSON) SELECT * FROM users WHERE id = $1 LIMIT 50",
      [7],
      undefined,
      expect.any(String),
    );
    expect(data.explainFormat).toBe("postgres-json");
  });

  test.each([
    ["a missing mode", {}],
    ["an unknown mode", { mode: "profile" }],
    ["a non-object explain", "estimate"],
    ["a null explain", null],
  ])("returns 400 for %s", async (_label, explain) => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1", explain },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("explain");
    expect(mockProvider.query).not.toHaveBeenCalled();
  });

  test("a request without an explain field runs the statement and names no format", async () => {
    const req = createMockRequest("/api/db/query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(mockProvider.query).toHaveBeenCalledWith(
      "SELECT * FROM users LIMIT 50",
      undefined,
      undefined,
      expect.any(String),
    );
    expect("explainFormat" in data).toBe(false);
  });
});

describe("POST /api/db/query and the transaction its own statement left open", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    // One test below installs a persistent provider double, so the default is put back
    // here rather than at the end of that test, where a failing assertion would skip it.
    mockGetOrCreateProvider.mockResolvedValue(mockProvider as never);
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
  });

  // ── WHY THIS ROUTE ENDS ITS OWN TRANSACTION, AND ONLY ITS OWN (D74, D87) ──
  //
  // A single statement CAN leave a transaction open here: MEASURED 2026-09-15 against
  // PostgreSQL 18.4 through this handler with the real provider and the real cache, a
  // lone `BEGIN` answered 200, released its pooled client in status `T`, and the next
  // request on the same cached provider ran its `CREATE TABLE` inside that stranger's
  // transaction, answered 200, and an independent reader saw no such table.
  //
  // The finally below was tried once WITHOUT D87 and reverted, because the ender it calls
  // named one shared pointer: it rolled back whichever client anybody had recorded last.
  // Measured on the same engine, a plain `SELECT pg_sleep(3)` sent here rolled back a
  // concurrent `/api/db/multi-query` script mid-flight — the script was told all four
  // statements had succeeded, its `COMMIT` included, and its `CREATE TABLE` was gone — and
  // also discarded an interactive `POST /api/db/transaction` session's committed work
  // while `commit` still answered "Transaction committed". Nothing threw in either run.
  //
  // So the route mints a scope, passes it to the statement it runs, and ends THAT scope.
  // The two tests below are the two halves: the serial leak closes, and the cross-request
  // probe leaves the other caller's transaction untouched.

  /**
   * A stand-in for the shared `PostgresProvider`: clients recorded per call SCOPE, and an
   * ender that can only reach the clients the scope it is given ran on. The scope is the
   * fourth argument of `query()`, which is what the route supplies.
   */
  function sharedProviderKeyedByScope() {
    const perScope = new Map<string, { inTransaction: boolean }>();
    let releaseSlowQuery = () => {};
    let slowQueryStarted = () => {};
    const slowQueryRunning = new Promise<void>((resolve) => {
      slowQueryStarted = resolve;
    });

    const provider = {
      ...createMockProvider(),
      query: mock(async (sql: string, _params?: unknown[], _queryId?: string, scope?: string) => {
        const client = { inTransaction: /^\s*BEGIN/i.test(sql) };
        // Only a call that left a transaction open is recorded, and only under the scope
        // that ran it, which is what the provider does with the server's own status byte.
        if (scope !== undefined && client.inTransaction) perScope.set(scope, client);
        if (sql.includes("pg_sleep")) {
          slowQueryStarted();
          await new Promise<void>((resolve) => {
            releaseSlowQuery = resolve;
          });
        }
        return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
      }),
      endOpenQueryTransaction: mock(async (scope: string) => {
        const client = perScope.get(scope);
        perScope.delete(scope);
        if (client === undefined || !client.inTransaction) return "none" as const;
        client.inTransaction = false;
        return "rolled-back" as const;
      }),
      openTransactionCount: () => [...perScope.values()].filter((c) => c.inTransaction).length,
    };
    return { provider, slowQueryRunning, releaseSlowQuery: () => releaseSlowQuery() };
  }

  test("ends the transaction its own statement left open and says so", async () => {
    const { provider } = sharedProviderKeyedByScope();
    mockGetOrCreateProvider.mockResolvedValue(provider as never);

    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "BEGIN" },
      }) as never,
    );
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(data.openTransaction).toBe("rolled-back");
    // Nothing is left behind for the next user of this cached provider to walk into.
    expect(provider.openTransactionCount()).toBe(0);
  });

  test("says nothing about a transaction when its statement opened none", async () => {
    const { provider } = sharedProviderKeyedByScope();
    mockGetOrCreateProvider.mockResolvedValue(provider as never);

    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1" },
      }) as never,
    );
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(provider.endOpenQueryTransaction).toHaveBeenCalledTimes(1);
    expect("openTransaction" in data).toBe(false);
  });

  test("does not discard a transaction another caller of the shared provider opened", async () => {
    const { provider, slowQueryRunning, releaseSlowQuery } = sharedProviderKeyedByScope();
    mockGetOrCreateProvider.mockResolvedValue(provider as never);

    // A: an ordinary slow read through this route. It opens nothing.
    const slow = POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT pg_sleep(3)" },
      }) as never,
    );
    await slowQueryRunning;

    // B: another caller of the same cached provider opens a transaction while A runs,
    // which is what a `/api/db/multi-query` script or the interactive session does. It
    // runs under a scope of its own, as every other caller does.
    await provider.query("BEGIN", undefined, undefined, "scope-of-another-caller");

    releaseSlowQuery();
    const res = await slow;
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    // B's transaction is still B's. A rolled nothing back, and A claimed nothing.
    expect(provider.openTransactionCount()).toBe(1);
    expect("openTransaction" in data).toBe(false);

    // The control that makes the two assertions above non-vacuous: named by its OWN scope,
    // the same ender reaches the very transaction A could not.
    expect(await provider.endOpenQueryTransaction("scope-of-another-caller")).toBe("rolled-back");
    expect(provider.openTransactionCount()).toBe(0);
  });

  test("ends the transaction a FAILING statement left open, which is where they come from", async () => {
    // The finally is a finally for this: a statement that raised inside its own BEGIN is
    // what releases a client in status `E`, and every later request that draws it answers
    // 500 until somebody ends it.
    const endOpenQueryTransaction = mock(async () => "rolled-back" as const);
    const provider = { ...createMockProvider(), endOpenQueryTransaction };
    (provider.query as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new QueryError(
        "current transaction is aborted, commands ignored until end of transaction block",
        "postgres",
      );
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1" },
      }) as never,
    );
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(400);
    expect(endOpenQueryTransaction).toHaveBeenCalledTimes(1);
    // The error response is the statement's own; the route invents no transaction verdict
    // on a body it is not returning.
    expect("openTransaction" in data).toBe(false);
  });

  test("leaves a provider that cannot name its own session exactly as it found it", async () => {
    // `endOpenQueryTransaction` is optional for the reason its declaration gives, and a
    // provider without it is not guessed at.
    const provider = createMockProvider();
    expect("endOpenQueryTransaction" in provider).toBe(false);
    mockGetOrCreateProvider.mockResolvedValueOnce(provider as never);

    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "BEGIN" },
      }) as never,
    );
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect("openTransaction" in data).toBe(false);
  });
});

// ─── the database a run reads (#1095) ────────────────────────────────────────
/**
 * A key lives in exactly one numbered database and `GET <key>` cannot name it, so a run that must
 * reach another one says which — as a field BESIDE the connection, because a managed connection
 * travels as an id and the server discards whatever the caller attached to it. The field is refused
 * outright on an engine that declares no key-space walk: on any other engine it would be a per-run
 * override of an operator-pinned `database` with no walk to justify it.
 */
describe("POST /api/db/query — the database a run reads", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockCreateDatabaseProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockClear();
  });

  /** The connections the route asked to open, in order, with the typing the calls carry. */
  function openedConnections(): Array<Record<string, unknown>> {
    return (mockGetOrCreateProvider.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => call[0]);
  }

  test("applies a run's database to the connection a managed id resolved to", async () => {
    // `defaultCapabilities` declares no walk, and the gate reads the declaration: one walk-shaped
    // answer is injected for this request, exactly as the real provider declares it.
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockReturnValueOnce({
      keyScan: { defaultCount: 500, maxCount: 1000 },
      // Redis's own container level beside its walk: the field is taken only where there is a database
      // to name (spec 3.4).
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
    });

    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connectionId: "seed:test-redis-6380", sql: "GET db1:only:key", database: 3 },
      }) as never,
    );

    expect(res.status).toBe(200);
    // The declaration is read from the operator's config without a socket, and only the connection
    // with this run's database applied is opened. Before this field a caller had no way to produce
    // that connection at all, so the read fell back to the session's database while the key tab
    // claimed it had read another.
    expect(mockCreateDatabaseProvider.mock.calls[0]?.[0]).toMatchObject({ host: "seed-host", database: "0" });
    const opened = openedConnections();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ host: "seed-host", database: "3" });
  });

  test("refuses a database on an engine that declares no key-space walk, without connecting", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockReturnValueOnce({});

    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1", database: 1 },
      }) as never,
    );
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("declares no key-space walk");
    // Refused from the declaration alone: an unreachable Postgres answered 503 here while the gate
    // ran after the connect, which reported a network fault for a request that was never valid.
    expect(mockCreateDatabaseProvider).toHaveBeenCalledTimes(1);
    expect(openedConnections()).toHaveLength(0);
  });

  test("refuses a database on an engine that walks one key space, without connecting", async () => {
    // The walk declared and no container level to name, because one connection is one key space: etcd's
    // declaration, and the same declaration with the level left out rather than empty (spec 3.4, 4.1).
    const shapes = [
      {
        keyScan: {
          defaultCount: 500,
          maxCount: 1000,
          separator: "/",
          cursor: "opaque",
          pattern: "prefix",
          totalScope: "walk",
        },
        containerLevels: [],
      },
      { keyScan: { defaultCount: 500, maxCount: 1000 } },
    ];

    for (const capabilities of shapes) {
      (mockProvider.getCapabilities as ReturnType<typeof mock>).mockReturnValueOnce(capabilities);
      const res = await POST(
        createMockRequest("/api/db/query", {
          method: "POST",
          body: {
            connection: { id: "etcd-1", name: "etcd", type: "etcd", host: "127.0.0.1", port: 2379 },
            sql: "get /app/cfg",
            database: 0,
          },
        }) as never,
      );
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toBe(
        'etcd walks one key space and declares no database level: "database" names the numbered database a key was walked in, and this engine has none to name',
      );
    }
    // Decided from the unconnected declaration, so no provider, SSH forward or channel was opened or
    // cached for a value the engine refuses.
    expect(mockCreateDatabaseProvider).toHaveBeenCalledTimes(2);
    expect(openedConnections()).toHaveLength(0);
  });

  test("refuses an invalid database with the sentence the walk route refuses with", async () => {
    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1", database: -1 },
      }) as never,
    );
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    // `optionalDatabase`'s own sentence, shared with `POST /api/db/keys/scan` — the same words on both
    // routes is the point, so a change to one of them has to change this expectation too.
    expect(data.error).toBe('"database" must be a non-negative integer');
    // Refused before anything is opened at all.
    expect(openedConnections()).toHaveLength(0);
  });

  test("names no database at all when a run carries none, and opens the connection once", async () => {
    const res = await POST(
      createMockRequest("/api/db/query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1" },
      }) as never,
    );

    expect(res.status).toBe(200);
    // Absent is not zero: one lookup, with the connection exactly as configured, and no
    // declaration to read.
    expect(mockCreateDatabaseProvider).not.toHaveBeenCalled();
    expect(openedConnections()).toHaveLength(1);
    expect(openedConnections()[0]).toMatchObject({ database: "testdb" });
  });
});

/**
 * A connection type's console text bound. It is read after `resolveConnection` and the
 * `!sql` check and before the bound parameters, the provider and the statement cache, and the answer never repeats
 * the text. Milvus and Qdrant declare one; the stand-in below pins the rule apart from them, and the 9 MiB case pins
 * an engine that declares none.
 */
describe("POST /api/db/query: a declared console text bound", () => {
  const LIMIT = 64;
  const standIn = { id: "stand-in-1", name: "Stand-in", type: STAND_IN_TYPE };
  let remove: () => void = () => {};

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    remove = installStandInVocabulary({ maxTextBytes: LIMIT });
  });

  afterEach(() => {
    remove();
    remove = () => {};
  });

  async function post(body: Record<string, unknown>) {
    const res = await POST(createMockRequest("/api/db/query", { method: "POST", body }) as never);
    return { res, data: await parseResponseJSON<{ error?: string }>(res) };
  }

  test("answers 413 one byte over, naming the size and the bound, never the text, before any provider", async () => {
    const sql = `SECRET-${"x".repeat(LIMIT - 6)}`;
    const { res, data } = await post({ connection: standIn, sql });
    expect(res.status).toBe(413);
    expect(data.error).toBe(
      "The statement is 65 bytes in UTF-8, over the 64-byte limit for this connection type. Shorten it to run it.",
    );
    expect(JSON.stringify(data)).not.toContain("SECRET");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
  });

  test("counts UTF-8 bytes, not characters", async () => {
    const { res, data } = await post({ connection: standIn, sql: "é".repeat(40) });
    expect(res.status).toBe(413);
    expect(data.error).toContain("80 bytes");
  });

  test("refuses before it reads the bound parameters", async () => {
    const { res } = await post({ connection: standIn, sql: "x".repeat(LIMIT + 1), params: "not-an-array" });
    expect(res.status).toBe(413);
  });

  test("lets a text of exactly the bound through to the provider", async () => {
    const sql = "x".repeat(LIMIT);
    const { res } = await post({ connection: standIn, sql });
    expect(res.status).toBe(200);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
    expect((mockProvider.prepareQuery as ReturnType<typeof mock>).mock.calls[0][0]).toBe(sql);
  });

  test("refuses a sql that is not a string where the type declares a bound", async () => {
    const { res, data } = await post({ connection: standIn, sql: ["x"] });
    expect(res.status).toBe(400);
    expect(data.error).toBe("sql must be a string");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("an engine that declares no bound runs a 9 MiB statement as before", async () => {
    const sql = `SELECT 1 -- ${"x".repeat(9 * 1024 * 1024)}`;
    const { res } = await post({ connection: validConnection, sql });
    expect(res.status).toBe(200);
    expect((mockProvider.prepareQuery as ReturnType<typeof mock>).mock.calls[0][0]).toHaveLength(sql.length);
  });
});
