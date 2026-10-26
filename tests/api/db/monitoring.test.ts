import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
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

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

const mockResolveConnection = mock(async (_body: Record<string, unknown>): Promise<unknown> => undefined);

// ─── Mock auth + seed resolution BEFORE importing route ─────────────────────
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
    resolveConnection: mockResolveConnection.mockImplementation(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// The role denial is recorded through the audit boundary, so the test reads what reaches it.
const mockEmitAuditEvent = mock((_event: Record<string, unknown>) => {});
mock.module("@/lib/audit", () => ({
  emitAuditEvent: mockEmitAuditEvent,
}));

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
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
const { POST } = await import("@/app/api/db/monitoring/route");

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
describe("POST /api/db/monitoring", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();

    // Reset implementations
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockImplementation(async () => ({
      timestamp: new Date(),
      overview: {
        version: "PostgreSQL 16.1",
        uptime: "10 days",
        activeConnections: 5,
        maxConnections: 100,
        databaseSize: "256 MB",
        databaseSizeBytes: 268435456,
        tableCount: 15,
        indexCount: 30,
      },
      performance: {
        cacheHitRatio: 99.2,
        transactionsPerSecond: 120,
        queriesPerSecond: 350,
        bufferPoolUsage: 45.5,
        deadlocks: 0,
      },
      slowQueries: [],
      activeSessions: [],
    }));
  });

  test("valid connection returns 200 with monitoring data", async () => {
    const req = createMockRequest("/api/db/monitoring", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      timestamp: string;
      overview: { version: string; activeConnections: number };
      performance: { cacheHitRatio: number };
      slowQueries: unknown[];
      activeSessions: unknown[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.overview).toBeDefined();
    expect(data.overview.version).toBe("PostgreSQL 16.1");
    expect(data.performance).toBeDefined();
    expect(data.performance.cacheHitRatio).toBe(99.2);
    expect(data.slowQueries).toBeDefined();
    expect(data.activeSessions).toBeDefined();
  });

  // #1387: provider-meta never connects, so the maintenance a CONNECTED server accepts reaches the
  // tabs from here, read off the same provider the panels came from.
  test("the payload carries the connected provider's maintenance declaration", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementationOnce(() => ({
      maintenanceOperations: ["analyze", "kill"],
      maintenanceOperationSpecs: {
        analyze: { label: "Analyze Table", perEntity: true, global: false },
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      },
    }));

    const res = await POST(
      createMockRequest("/api/db/monitoring", { method: "POST", body: { connection: validConnection } }) as never,
    );
    const data = await parseResponseJSON<{ maintenance: unknown }>(res);

    expect(data.maintenance).toEqual({
      maintenanceOperations: ["analyze", "kill"],
      maintenanceOperationSpecs: {
        analyze: { label: "Analyze Table", perEntity: true, global: false },
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      },
    });
  });

  test("a provider that declares no operation specs sends the operations alone", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementationOnce(() => ({
      maintenanceOperations: ["vacuum"],
    }));

    const res = await POST(
      createMockRequest("/api/db/monitoring", { method: "POST", body: { connection: validConnection } }) as never,
    );
    const data = await parseResponseJSON<{ maintenance: unknown }>(res);

    expect(data.maintenance).toEqual({ maintenanceOperations: ["vacuum"] });
  });

  test("empty body returns 400", async () => {
    const req = new Request("http://localhost:3000/api/db/monitoring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("empty");
  });

  test("invalid JSON returns 400", async () => {
    const req = new Request("http://localhost:3000/api/db/monitoring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-valid-json{{{",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid JSON");
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/monitoring", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  // Threat: this route used to parse the body BEFORE guardRoute(), unlike every other
  // provider-reaching route - an unauthenticated caller with an empty or malformed body got a 400
  // with no denial audit, instead of the 401 (and audit line) the guard produces. A malformed body
  // also means work spent parsing before authentication is even checked. Both cases below prove
  // the guard now runs first regardless of what the body contains.
  test("returns 401, not 400, when an unauthenticated request also carries an empty body", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = new Request("http://localhost:3000/api/db/monitoring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns 401, not 400, when an unauthenticated request also carries malformed JSON", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = new Request("http://localhost:3000/api/db/monitoring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-valid-json{{{",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("aborted request returns 499 with empty body", async () => {
    const abortError = new Error("socket hang up") as NodeJS.ErrnoException;
    abortError.code = "ECONNRESET";
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockRejectedValueOnce(abortError);

    const req = createMockRequest("/api/db/monitoring", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(499);
    expect(await res.text()).toBe("");
  });

  test("missing connection type returns 400", async () => {
    const req = createMockRequest("/api/db/monitoring", {
      method: "POST",
      body: { connection: { host: "localhost" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Valid connection configuration is required");
  });

  test("ConnectionError returns 503", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new ConnectionError("Connection refused", "postgres", "localhost", 5432);
    });

    const req = createMockRequest("/api/db/monitoring", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain("Connection refused");
    expect(data.code).toBe("CONNECTION_ERROR");
  });

  test("DatabaseError returns 500", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new DatabaseError("Internal error", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/monitoring", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string; statusCode: number }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain("Internal error");
    expect(data.code).toBe("DATABASE_ERROR");
    expect(data.statusCode).toBe(500);
  });

  // Under governance (docs/GOVERNANCE.md#grants-and-the-connection-list), users who share a read principal would see
  // each other's statements in pg_stat_activity, so monitoring is an admin page there. The refusal comes before the
  // connection is resolved, so nothing is opened for it, and it is audited as the maintenance route's is.
  describe("governance", () => {
    const savedSource = process.env.GOVERNANCE_SOURCE;

    beforeEach(() => {
      process.env.GOVERNANCE_SOURCE = "postgres";
      mockResolveConnection.mockClear();
      mockEmitAuditEvent.mockClear();
    });

    afterEach(() => {
      if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
      else process.env.GOVERNANCE_SOURCE = savedSource;
    });

    test("governance: a user session gets 403 and no provider is created", async () => {
      mockGetSession.mockImplementation(
        async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "bob" }),
      );

      const res = await POST(
        createMockRequest("/api/db/monitoring", { method: "POST", body: { connection: validConnection } }) as never,
      );
      const data = await parseResponseJSON<{ error: string; code?: string }>(res);

      expect(res.status).toBe(403);
      expect(data).toEqual({ error: "Unauthorized. Admin access required.", code: "ADMIN_REQUIRED" });
      expect(mockResolveConnection).not.toHaveBeenCalled();
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(mockEmitAuditEvent).toHaveBeenCalledTimes(1);
      expect(mockEmitAuditEvent.mock.calls[0][0]).toMatchObject({
        type: "permission_denied",
        action: "denied",
        target: "POST /api/db/monitoring",
        user: "bob",
        result: "failure",
        reason: "insufficient_role",
      });
    });

    test("governance: an admin with a grant gets monitoring data", async () => {
      // A governed session always carries its identity provider subject, which names the owner of
      // the provider the request runs on (docs/GOVERNANCE.md#per-user-providers).
      mockGetSession.mockImplementation(
        async (): Promise<{ role: string; username: string; idpSubject?: string } | null> => ({
          role: "admin",
          username: "admin",
          idpSubject: "sub-admin",
        }),
      );
      const res = await POST(
        createMockRequest("/api/db/monitoring", {
          method: "POST",
          body: { connectionId: "granted-1", connection: validConnection },
        }) as never,
      );
      const data = await parseResponseJSON<{ overview: { version: string } }>(res);

      expect(res.status).toBe(200);
      expect(data.overview.version).toBe("PostgreSQL 16.1");
      expect(mockResolveConnection).toHaveBeenCalledTimes(1);
      expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
      expect(mockEmitAuditEvent).not.toHaveBeenCalled();
    });
  });

  test("without governance a user session keeps its monitoring access", async () => {
    const savedSource = process.env.GOVERNANCE_SOURCE;
    delete process.env.GOVERNANCE_SOURCE;
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "bob" }),
    );

    try {
      const res = await POST(
        createMockRequest("/api/db/monitoring", { method: "POST", body: { connection: validConnection } }) as never,
      );
      const data = await parseResponseJSON<{ overview: { version: string } }>(res);

      expect(res.status).toBe(200);
      expect(data.overview.version).toBe("PostgreSQL 16.1");
      expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
    } finally {
      if (savedSource !== undefined) process.env.GOVERNANCE_SOURCE = savedSource;
    }
  });
});

// A JSON `null` body answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'connection' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/monitoring: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/monitoring", {
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

// A present `options` that is not an object answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'includeTables' ...").
describe("POST /api/db/monitoring: options that are not an object", () => {
  test.each<[string, unknown]>([
    ["null", null],
    ["a number", 5],
    ["an array", []],
  ])("options that are %s answer 400 and open no provider", async (_label, options) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      createMockRequest("/api/db/monitoring", {
        method: "POST",
        body: { connection: validConnection, options },
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON(res)).toEqual({ error: "options must be an object" });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });
});
