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
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

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

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/admin/fleet-health/route");

// ─── Fixtures ───────────────────────────────────────────────────────────────
const connections = [
  {
    id: "conn-1",
    name: "Production DB",
    type: "postgres",
    host: "prod.example.com",
    port: 5432,
    database: "prod",
    createdAt: new Date(),
  },
  {
    id: "conn-2",
    name: "Staging DB",
    type: "mysql",
    host: "staging.example.com",
    port: 3306,
    database: "staging",
    createdAt: new Date(),
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/admin/fleet-health", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();
  });

  test("returns health results for all connections as admin", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; connectionName: string; status: string; latencyMs: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toBeArray();
    expect(data.results.length).toBe(2);
    expect(data.results[0].connectionId).toBe("conn-1");
    expect(data.results[0].connectionName).toBe("Production DB");
    expect(data.results[0].status).toBe("healthy");
    expect(data.results[0].latencyMs).toBeDefined();
  });

  // Issue #540: the fleet total used to re-parse `databaseSize`'s display string, which had no
  // "tb" branch and counted a 1 TB database as 1 byte. The route now projects the provider's own
  // byte figure from getOverview() instead, so the dashboard never has to parse a string at all.
  test("carries the provider's byte figure from getOverview alongside the display string", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; databaseSize?: string; databaseSizeBytes?: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].databaseSize).toBe("256 MB");
    expect(data.results[0].databaseSizeBytes).toBe(268435456);
  });

  test("omits databaseSizeBytes, not a fabricated 0, when the provider publishes no byte figure", async () => {
    const noByteProvider = createMockProvider({
      overview: {
        version: "Cassandra 4.1",
        uptime: "10 days",
        maxConnections: 100,
        databaseSize: "1 MiB",
        tableCount: 5,
        indexCount: 2,
      },
    });
    mockGetOrCreateProvider.mockImplementation(async () => noByteProvider);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [connections[0]] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { databaseSizeBytes?: number }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].databaseSizeBytes).toBeUndefined();
  });

  test("a getOverview failure omits the byte figure without turning a healthy connection into an error", async () => {
    const throwingProvider = createMockProvider();
    (throwingProvider.getOverview as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("overview query timed out");
    });
    mockGetOrCreateProvider.mockImplementation(async () => throwingProvider);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [connections[0]] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { status: string; databaseSizeBytes?: number }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].status).toBe("healthy");
    expect(data.results[0].databaseSizeBytes).toBeUndefined();
  });

  test("returns 403 for non-admin user", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain("Unauthorized");
  });

  // Guarded by guardRoute now: an unauthenticated caller is rejected at the session check,
  // before the route's own admin-role check ever runs, so this is 401 ("not authenticated"),
  // distinct from "returns 403 for non-admin user" above ("authenticated but forbidden").
  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns 400 when connections is missing", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: {},
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("connections");
  });

  test("connection error results in error status for that item", async () => {
    let callCount = 0;
    mockGetOrCreateProvider.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Connection refused");
      }
      return mockProvider;
    });

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; status: string; error?: string }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results.length).toBe(2);
    const errorItem = data.results.find((r) => r.status === "error");
    expect(errorItem).toBeDefined();
    expect(errorItem!.error).toContain("Connection refused");
  });

  test("invalid JSON body returns 500", async () => {
    const req = new Request("http://localhost:3000/api/admin/fleet-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-valid-json{{{",
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("empty connections array returns empty results", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: unknown[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toBeArray();
    expect(data.results.length).toBe(0);
  });
});

// ─── Fan-out width ──────────────────────────────────────────────────────────
// Threat: guardRoute bounds how OFTEN this route may be called, never how WIDE one call fans out.
// Before the cap, a single admin-authenticated POST naming an arbitrarily long connections array
// opened that many provider connections concurrently and the rate limiter saw one request.
describe("POST /api/admin/fleet-health fan-out cap", () => {
  function fleet(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `conn-${i}`,
      name: `DB ${i}`,
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "db",
      createdAt: new Date(),
    }));
  }

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
  });

  test("returns 400 above the cap, names the bound, and opens nothing", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: fleet(101) },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("100");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("accepts exactly the cap", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: fleet(100) },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: unknown[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results.length).toBe(100);
  });
});

// The role denial's audit line is asserted in tests/security/route-auth.test.ts, not here: this
// file's process neighbours mock @/lib/audit process-wide (tests/api/db/maintenance.test.ts among
// them), so an assertion on the authoritative stdout line would read whichever mock happened to
// win the module registry. Nothing under tests/security mocks that module.
