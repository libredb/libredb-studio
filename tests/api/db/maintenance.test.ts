import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  QueryError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  TimeoutError,
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

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider as never);

// ─── Mock getSession for auth ───────────────────────────────────────────────
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock audit buffer ──────────────────────────────────────────────────────
const mockAuditPush = mock((_event?: unknown) => ({
  id: "1",
  timestamp: new Date().toISOString(),
  type: "maintenance",
  action: "VACUUM",
  target: "all",
  user: "admin",
  result: "success" as const,
}));

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
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

mock.module("@/lib/audit", () => ({
  getServerAuditBuffer: () => ({ push: mockAuditPush }),
  // The route calls emitAuditEvent (the sanitizing boundary), not buffer.push, directly. This
  // delegates to the same push mock the test suite already exercises, so no assertion elsewhere
  // needs to change target.
  emitAuditEvent: (event: Record<string, unknown>) => mockAuditPush(event as never),
  AuditRingBuffer: class {},
  loadAuditFromStorage: () => [],
  saveAuditToStorage: () => {},
}));

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  QueryError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  TimeoutError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/maintenance/route");

// ─── Helpers ────────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/maintenance", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockAuditPush.mockClear();
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockClear();
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockClear();

    // Reset implementations
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
      success: true,
      executionTime: 100,
      message: "OK",
    }));
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: "sql",
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: true,
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze", "reindex"],
      supportsConnectionString: true,
      defaultPort: 5432,
      schemaRefreshPattern: "(?:CREATE|ALTER|DROP|TRUNCATE)\\s",
    }));
  });

  test("admin with valid params returns maintenance result", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; executionTime: number; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.executionTime).toBe(100);
    expect(data.message).toBe("OK");
  });

  // Threat: runMaintenance() has already completed by the time emitAuditEvent runs (see the route's
  // own comment). Before this fix, a broken audit sink shared the operation's try/catch, so a
  // throw here would 500 a client that must not be told to retry an operation - possibly a
  // destructive one, like "kill" - that already succeeded.
  test("a broken audit sink does not turn a completed maintenance operation into a 500", async () => {
    mockAuditPush.mockImplementationOnce(() => {
      throw new Error("audit sink unavailable");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; executionTime: number; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("OK");
  });

  test("non-admin user returns 403", async () => {
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "user" }),
    );

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain("Unauthorized");
  });

  // Threat: a role denial that leaves no trace. An authenticated caller probing for a role it does
  // not hold was invisible in the one channel this project treats as authoritative.
  test("non-admin denial emits permission_denied with reason insufficient_role", async () => {
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "bob" }),
    );

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0][0] as Record<string, unknown>;
    expect(event.type).toBe("permission_denied");
    expect(event.reason).toBe("insufficient_role");
    expect(event.user).toBe("bob");
    expect(event.target).toBe("POST /api/db/maintenance");
  });

  test("a broken audit sink does not turn the role denial into a 500", async () => {
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "bob" }),
    );
    mockAuditPush.mockImplementationOnce(() => {
      throw new Error("audit sink unavailable");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(403);
  });

  // Guarded by guardRoute now: an unauthenticated caller is rejected at the session check,
  // before the route's own admin-role check ever runs, so this is 401 ("not authenticated"),
  // distinct from "non-admin user returns 403" above ("authenticated but forbidden").
  test("no session returns 401", async () => {
    mockGetSession.mockImplementation(async () => null);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("missing connection returns 400", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("missing type returns 400", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Maintenance type is required");
  });

  test("provider without maintenance support returns 400", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: "sql",
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 0,
      schemaRefreshPattern: "",
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("not supported");
  });

  test("unsupported operation type returns 400", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "optimize", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("not supported");
  });

  test("DatabaseError from runMaintenance returns 500", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new DatabaseError("Internal maintenance failure", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain("Internal maintenance failure");
  });
});
