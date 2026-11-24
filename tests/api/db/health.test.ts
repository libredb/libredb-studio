import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  PermissionDeniedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { withheldErrorMessage } from "@/lib/db/operations/provider-text";
import type { HealthInfo } from "@/lib/db/types";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
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
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

// ─── Import route handlers AFTER mocking ────────────────────────────────────
const { GET, POST } = await import("@/app/api/db/health/route");

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
describe("GET /api/db/health", () => {
  test("returns 200 with healthy status", async () => {
    const res = await GET();
    const data = await parseResponseJSON<{
      status: string;
      timestamp: string;
      service: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.service).toBe("libredb-studio");
    expect(data.timestamp).toBeDefined();
  });
});

describe("POST /api/db/health", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();
  });

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => POST(createMockRequest("/api/db/health", { method: "POST", body: { connection } }) as never);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ConnectionError(`could not connect as ${password}`, "postgres"),
    );
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(503);
    expect(body).toMatchObject({ code: "CONNECTION_ERROR", error: withheldErrorMessage("ConnectionError") });
    expect(JSON.stringify(body)).not.toContain(password);

    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ConnectionError("could not connect", "postgres"),
    );
    const clean = await send();
    expect(clean.status).toBe(503);
    expect(await parseResponseJSON(clean)).toMatchObject({ code: "CONNECTION_ERROR", error: "could not connect" });
  });

  test("returns 200 with health info for valid connection", async () => {
    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      activeConnections: number;
      databaseSize: string;
      cacheHitRatio: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.activeConnections).toBeDefined();
    expect(data.databaseSize).toBeDefined();
    expect(data.cacheHitRatio).toBeDefined();
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 503 for ConnectionError", async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(new ConnectionError("Connection refused"));

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain("Connection refused");
    expect(data.code).toBe("CONNECTION_ERROR");
  });

  test("returns 500 for DatabaseError", async () => {
    const dbError = new DatabaseError("Database internal error", "postgres", "INTERNAL_ERROR");
    mockGetOrCreateProvider.mockResolvedValueOnce(mockProvider);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Database internal error");
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("returns 401 when no session", async () => {
    const { getSession } = await import("@/lib/auth");
    (getSession as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  test("returns 400 when connection has no type", async () => {
    const { resolveConnection } = await import("@/lib/seed/resolve-connection");
    (resolveConnection as ReturnType<typeof mock>).mockResolvedValueOnce({ id: "x", name: "X" });

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: { id: "x", name: "X" } },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test("returns 500 for generic error", async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Unexpected failure"));

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Unexpected failure");
  });
});

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'connection' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/health: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON(res)).toEqual({ error: "Invalid request body" });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });
});

/**
 * What the health route answers today, at the provider's own `getHealth`, which the host core keeps when the route
 * reads the session's health through the mandatory health call.
 */
describe("what the health route answers today, which the host core keeps", () => {
  type Mocked = ReturnType<typeof mock>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    (mockProvider.getHealth as Mocked).mockClear();
  });

  const send = () =>
    POST(createMockRequest("/api/db/health", { method: "POST", body: { connection: validConnection } }) as never);

  test("the provider's health is read once, with no argument, and answered as it is, an unmeasured connection count left out", async () => {
    const health: HealthInfo = {
      databaseSize: crypto.randomUUID(),
      cacheHitRatio: crypto.randomUUID(),
      slowQueries: [{ query: crypto.randomUUID(), calls: 3, avgTime: "10 ms" }],
      activeSessions: [
        { pid: 4711, user: "app", database: "orders", state: "active", query: crypto.randomUUID(), duration: "1s" },
      ],
    };
    (mockProvider.getHealth as Mocked).mockResolvedValueOnce(health);

    const res = await send();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON(res)).toEqual(health);
    expect((mockProvider.getHealth as Mocked).mock.calls).toEqual([[]]);
  });

  test("a health read's Studio error answers by its class, with its code, kind and outcome", async () => {
    const words = crypto.randomUUID();
    const cases: [Error, number, Record<string, unknown>][] = [
      [new QueryError(words, "postgres"), 400, { error: words, code: "QUERY_ERROR", kind: "query" }],
      [
        new ConnectionError(words, "postgres", "localhost", 5432),
        503,
        { error: words, code: "CONNECTION_ERROR", retryable: true, kind: "connection" },
      ],
      [
        new TimeoutError(words, "postgres", 1000),
        504,
        {
          error: "Query timed out. Please try a simpler query or increase timeout.",
          code: "TIMEOUT_ERROR",
          retryable: true,
          kind: "timeout",
        },
      ],
      [
        new PoolExhaustedError(words, "postgres", 4),
        503,
        { error: words, code: "POOL_EXHAUSTED", retryable: true, kind: "pool-exhausted" },
      ],
      [
        new PermissionDeniedError(words, "postgres"),
        403,
        { error: words, code: "PERMISSION_DENIED", kind: "permission" },
      ],
    ];

    for (const [error, status, expected] of cases) {
      (mockProvider.getHealth as Mocked).mockRejectedValueOnce(error);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const res = await send();
      expect([error.name, res.status]).toEqual([error.name, status]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await parseResponseJSON(res)).toEqual({ ...expected, statusCode: status, outcome: "unknown" });
    }
  });

  test("a health read's raw error answers 500 with its own words", async () => {
    const words = crypto.randomUUID();
    (mockProvider.getHealth as Mocked).mockRejectedValueOnce(new Error(words));

    const res = await send();

    expect(res.status).toBe(500);
    expect(await parseResponseJSON(res)).toEqual({ error: words, code: "INTERNAL_ERROR", statusCode: 500 });
  });
});
