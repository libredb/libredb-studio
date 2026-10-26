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
  isRetryableError,
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
