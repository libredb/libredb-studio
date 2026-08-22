import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { DatabaseConfigError } from "@/lib/db/errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockCreateDatabaseProvider = mock(async (connection?: unknown) => {
  // The parameter is declared so `mock.calls` carries the connection the route built the
  // provider from - that argument is what proves the SSH tunnel endpoint was used (#457).
  void connection;
  return mockProvider;
});

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing route ─────────────────────
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

// The real scope opens an unshared SSH tunnel and rewrites host/port to its local
// endpoint. Standing in for it with a pass-through that performs that rewrite is what
// lets these tests assert the route connects THROUGH the tunnel rather than around it
// (#457). `disconnectsAtScopeExit` records how many disconnect() calls had happened by
// the time the scope was about to close its tunnel - the ordering the route must honour.
let disconnectsAtScopeExit = -1;
const mockWithOneShotTunnel = mock(
  async (connection: Record<string, unknown>, run: (c: Record<string, unknown>) => Promise<unknown>) => {
    try {
      return await run({ ...connection, host: "127.0.0.1", port: 54321 });
    } finally {
      disconnectsAtScopeExit = (mockProvider.disconnect as ReturnType<typeof mock>).mock.calls.length;
    }
  },
);

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
mock.module("@/lib/db/factory", () => ({
  createDatabaseProvider: mockCreateDatabaseProvider,
  withOneShotTunnel: mockWithOneShotTunnel,
  getOrCreateProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/test-connection/route");

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
describe("POST /api/db/test-connection", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockCreateDatabaseProvider.mockClear();
    mockWithOneShotTunnel.mockClear();
    disconnectsAtScopeExit = -1;
    (mockProvider.connect as ReturnType<typeof mock>).mockClear();
    (mockProvider.disconnect as ReturnType<typeof mock>).mockClear();
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();

    // Reset implementations to defaults
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockCreateDatabaseProvider.mockImplementation(async () => mockProvider);
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.disconnect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => ({
      activeConnections: 5,
      databaseSize: "256 MB",
      cacheHitRatio: "99.2%",
      slowQueries: [],
      activeSessions: [],
    }));
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns success with latency for valid connection", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string; latency: number }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("Connection successful");
    expect(typeof data.latency).toBe("number");
  });

  test("returns 400 when connection type is missing", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { host: "localhost" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
  });

  test("returns 400 when body is empty object", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
  });

  test("returns 400 when DatabaseConfigError is thrown", async () => {
    mockCreateDatabaseProvider.mockImplementation(async () => {
      throw new DatabaseConfigError("Invalid database configuration");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("Invalid database configuration");
    expect(data.code).toBe("CONFIG_ERROR");
  });

  test("returns 500 when connection error occurs", async () => {
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("ECONNREFUSED");
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("calls connect and disconnect on successful test", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    await POST(req as never);

    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.getHealth).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  test("calls disconnect on error", async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("Health check failed");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    await POST(req as never);

    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  // ─── SSH tunnel (#457) ────────────────────────────────────────────────────
  // This route builds its provider with createDatabaseProvider, outside both provider
  // caches, so it does not inherit the tunnel handling the cached paths have. Until
  // #457 it connected to the raw database host: a tunnelled connection could never be
  // tested, and because the dialog gates its only save button on a passing test, never
  // be saved either.

  test("connects through the connection's SSH tunnel rather than to the raw host", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: {
        ...validConnection,
        host: "db.internal",
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "jump", authMethod: "password" },
      },
    });

    await POST(req as never);

    expect(mockWithOneShotTunnel).toHaveBeenCalledTimes(1);
    expect(mockWithOneShotTunnel.mock.calls[0]?.[0]).toMatchObject({ host: "db.internal" });
    expect(mockCreateDatabaseProvider.mock.calls[0]?.[0]).toMatchObject({ host: "127.0.0.1", port: 54321 });
  });

  test("disconnects the provider before the tunnel scope tears the tunnel down", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    await POST(req as never);

    // Closing the tunnel under a still-connected provider would leave the driver
    // shutting down a socket whose transport is already gone.
    expect(disconnectsAtScopeExit).toBe(1);
  });

  test("disconnects the provider inside the tunnel scope when the health check fails", async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("Health check failed");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    await POST(req as never);

    expect(disconnectsAtScopeExit).toBe(1);
  });
});
