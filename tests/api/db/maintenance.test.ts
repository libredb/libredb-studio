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

  // The audit log is where an operator reconstructs what was done to a database, so a
  // refusal recorded as a completed operation is worse than no record. This became routine
  // rather than theoretical on 2026-08-25: MySQL and Oracle now read the engine's own
  // verdict, so `success: false` on an HTTP 200 is the ordinary answer for a target the
  // engine would not touch.
  test("an operation the engine refused is audited as a failure, not as success", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
      success: false,
      executionTime: 3,
      message: "OPTIMIZE failed: u9v.missing: Table 'u9v.missing' doesn't exist",
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "missing", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);

    // Still a 200: the request was well formed and the statement reached the engine. What
    // the engine answered travels in the body, and in the audit row.
    expect(res.status).toBe(200);
    expect(data.success).toBe(false);
    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    expect((mockAuditPush.mock.calls[0]![0] as { result: string }).result).toBe("failure");
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

  // ─── U20: the route gates on WHAT an operation can be pointed at ──────────
  //
  // `maintenanceOperations` says only that an operation EXISTS on this engine; each
  // provider also declares what KIND of target it takes (`maintenanceOperationSpecs`),
  // and both UI surfaces already gate on `maintenanceControl`. The route did not, so a
  // caller reaching the API directly bypassed the only declaration that says a target
  // is meaningless here. The U20 backlog entry reports that gap from a live SQLite run:
  // POST {type:"vacuum", target:"users"} answered 200 and vacuumed the whole file - the
  // reading `perEntity: false` exists to withhold.
  //
  // These tests measure the status code and the message, not that run: the capabilities
  // below are SQLite-SHAPED mocks, so what is asserted is that the route now refuses the
  // request the declaration says is meaningless and attempts nothing.
  const sqliteShapedCapabilities = () => ({
    queryLanguage: "sql",
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsMaintenance: true,
    maintenanceOperations: ["vacuum", "analyze", "reindex"],
    maintenanceOperationSpecs: {
      // SQLite's VACUUM rewrites the whole file and ignores a target entirely.
      vacuum: { label: "Vacuum Database", perEntity: false, global: true },
      analyze: { label: "Analyze Database", perEntity: true, global: true },
      // Couchbase-shaped half of the same field: BUILD INDEX needs one keyspace and
      // has no whole-database form.
      reindex: { label: "Build Indexes", perEntity: true, global: false },
    },
    supportsConnectionString: true,
    defaultPort: 0,
    schemaRefreshPattern: "",
  });

  test("an operation that takes no target refuses a request that names one", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; success?: boolean }>(res);

    expect(res.status).toBe(400);
    // The provider's own wording for the control, and what it does accept.
    expect(data.error).toContain("Vacuum Database");
    expect(data.error).toContain("whole database");
    // A client error, not a maintenance verdict: no `success` field for a caller to
    // read as "the engine refused the work".
    expect(data.success).toBeUndefined();
    // Nothing was attempted, so nothing may be recorded as done.
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test("an operation that requires a target refuses a request without one", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "reindex", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Build Indexes");
    expect(data.error).toContain("target");
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test("an empty target string reads as the whole-database form, not as a target", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "", connection: validConnection },
    });

    const res = await POST(req as never);

    // Same reading the audit row below already uses (`target || "all"`).
    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
  });

  test("a target an operation does accept still runs", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "analyze", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
    expect(mockAuditPush).toHaveBeenCalledTimes(1);
  });

  // Every provider that declares `kill` declares it `perEntity: false, global: false`:
  // its target is a session or query id, which no table row and no whole-database card
  // can supply. Both halves false therefore does NOT mean "takes no target" - it means
  // the target comes from somewhere neither placement describes (the Sessions panel),
  // so the placement gate has nothing to say and must not refuse it.
  test("kill keeps its session-id target, which neither placement describes", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...sqliteShapedCapabilities(),
      maintenanceOperations: ["vacuum", "kill"],
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Database", perEntity: false, global: true },
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      },
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "kill", target: "4711", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
    expect((mockAuditPush.mock.calls[0]![0] as { type: string }).type).toBe("kill_session");
  });

  // A provider that declares no specs at all is offered in both placements - the
  // documented compatibility reading of the optional field, and what the route did for
  // every provider before this change.
  test("a provider declaring no operation specs accepts a target as before", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
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
