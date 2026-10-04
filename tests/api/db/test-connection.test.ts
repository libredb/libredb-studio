import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { DatabaseConfigError } from "@/lib/db/errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockCreateDatabaseProvider = mock(async (connection?: unknown, options?: unknown, execution?: unknown) => {
  // The parameters are declared so `mock.calls` carries what the route built the provider from:
  // the connection proves the SSH tunnel endpoint was used (#457), and the execution context
  // proves which file-access posture the handle opens under (B1/K1).
  void connection;
  void options;
  void execution;
  return mockProvider;
});

/**
 * The writable provider already holding a single-writer file, when one is open
 * (#498). Null by default: every engine but LibreDB is in that state.
 */
const borrowedProvider = createMockProvider();
const mockFindOpenSingleWriterProvider = mock((connection?: unknown, allowExternalFileAccess?: boolean): unknown => {
  void connection;
  void allowExternalFileAccess;
  return null;
});
/** Whether a handle of ANY file-access posture holds the file (B1/K1). False by default. */
const mockIsSingleWriterFileOpen = mock((): boolean => false);

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
  findOpenSingleWriterProvider: mockFindOpenSingleWriterProvider,
  isSingleWriterFileOpen: mockIsSingleWriterFileOpen,
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
    mockFindOpenSingleWriterProvider.mockClear();
    mockFindOpenSingleWriterProvider.mockImplementation(() => null);
    mockIsSingleWriterFileOpen.mockClear();
    mockIsSingleWriterFileOpen.mockImplementation(() => false);
    for (const method of ["connect", "disconnect", "getHealth"] as const) {
      (borrowedProvider[method] as ReturnType<typeof mock>).mockClear();
    }
    (borrowedProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => ({
      activeConnections: 1,
      databaseSize: "12 KB",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    }));

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
    // A provider that reports no connect cautions adds no key to the answer.
    expect("warnings" in data).toBe(false);
  });

  describe("what the server cautioned while the connection opened (#1401)", () => {
    // Materialize v26.44.1's own startup NOTICE, measured 2026-10-04.
    const caution = { message: 'session database "nosuchdb" does not exist', code: "MZ004", severity: "NOTICE" };
    const withCautions = mockProvider as typeof mockProvider & { connectWarnings?: () => unknown[] };

    afterEach(() => {
      delete withCautions.connectWarnings;
    });

    test("rides along with a successful answer", async () => {
      withCautions.connectWarnings = () => [caution];
      const res = await POST(
        createMockRequest("/api/db/test-connection", { method: "POST", body: validConnection }) as never,
      );
      const data = await parseResponseJSON<{ success: boolean; warnings?: unknown[] }>(res);

      expect(data.success).toBe(true);
      expect(data.warnings).toEqual([caution]);
    });

    test("rides along with a degraded answer too", async () => {
      withCautions.connectWarnings = () => [caution];
      (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error("no health here");
      });
      const res = await POST(
        createMockRequest("/api/db/test-connection", { method: "POST", body: validConnection }) as never,
      );
      const data = await parseResponseJSON<{ degraded?: boolean; warnings?: unknown[] }>(res);

      expect(data.degraded).toBe(true);
      expect(data.warnings).toEqual([caution]);
    });

    test("is left out when the provider has the channel and the server said nothing", async () => {
      withCautions.connectWarnings = () => [];
      const res = await POST(
        createMockRequest("/api/db/test-connection", { method: "POST", body: validConnection }) as never,
      );
      expect("warnings" in (await parseResponseJSON<Record<string, unknown>>(res))).toBe(false);
    });
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

  /*
    A connect that succeeded and a health read that did not are two different facts,
    and this route used to publish one word for both. Measured 2026-08-24
    against scylladb/scylla:2026.2.4: `connect`, `query` and `getSchema` all answer
    while `getHealth()` throws `Keyspace system_views does not exist`, because ScyllaDB
    has no `system_views` keyspace. `handleConnect` gates the dialog's save on this
    response, so a `success: false` here meant no ScyllaDB connection could be created
    at all - and StarRocks and SingleStore sat on the same gate.
  */
  test("a health read that fails after a successful connect is a degraded success, not a failure", async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("Keyspace system_views does not exist");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      success: boolean;
      degraded?: boolean;
      message: string;
      latency?: number;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.degraded).toBe(true);
    // The server's own sentence: it is the only thing that names the surface.
    expect(data.message).toContain("Keyspace system_views does not exist");
    // No latency, because the read it would have measured did not complete.
    expect(data.latency).toBeUndefined();
  });

  test("a connect that fails is still a failure, degraded by nothing", async () => {
    // The distinction the change rests on: a health read cannot excuse a connection
    // that does not exist.
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success?: boolean; degraded?: boolean; error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.degraded).toBeUndefined();
    expect(data.error).toBe("ECONNREFUSED");
  });

  test("a health read that rejects with a non-Error still names what it threw", async () => {
    // A driver that rejects with a string would otherwise report "[object Object]" or
    // an empty sentence, which tells the user nothing about what to change.
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
      throw "no monitoring endpoint";
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: validConnection,
    });

    const data = await parseResponseJSON<{ success: boolean; message: string }>(await POST(req as never));

    expect(data.success).toBe(true);
    expect(data.message).toContain("no monitoring endpoint");
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
  // ─── Single-writer files (#498) ───────────────────────────────────────────
  // An engine that declares `ProviderCapabilities.singleWriterFile` admits ONE handle
  // per file, so building a second provider to test it is refused by the lock the live
  // connection itself holds. The dialog tests before it saves, so that made the
  // built-in LibreDB sample impossible to EDIT: the edit was discarded with a toast
  // about a connection error, as if the sample were broken.

  test("reuses the provider already holding a single-writer file instead of opening a second one", async () => {
    mockFindOpenSingleWriterProvider.mockImplementation(() => borrowedProvider);

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { ...validConnection, type: "libredb", database: "/data/sample.libredb" },
    });

    const data = await parseResponseJSON<{ success: boolean; message: string; latency: number }>(
      await POST(req as never),
    );

    expect(data.success).toBe(true);
    expect(data.message).toBe("Connection successful");
    expect(typeof data.latency).toBe("number");
    // No second handle was built, and the open one was not re-connected.
    expect(mockCreateDatabaseProvider).not.toHaveBeenCalled();
    expect(borrowedProvider.connect).not.toHaveBeenCalled();
    expect(borrowedProvider.getHealth).toHaveBeenCalledTimes(1);
  });

  test("never disconnects a provider it borrowed", async () => {
    // Closing it would close the file under the live connection that opened it - the
    // editor's own session - which is worse than the failed test this replaced.
    mockFindOpenSingleWriterProvider.mockImplementation(() => borrowedProvider);

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { ...validConnection, type: "libredb", database: "/data/sample.libredb" },
    });

    await POST(req as never);

    expect(borrowedProvider.disconnect).not.toHaveBeenCalled();
    expect(disconnectsAtScopeExit).toBe(0);
  });

  test("a failed health read on a borrowed provider is a degraded success, and still closes nothing", async () => {
    mockFindOpenSingleWriterProvider.mockImplementation(() => borrowedProvider);
    (borrowedProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("no monitoring endpoint");
    });

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { ...validConnection, type: "libredb", database: "/data/sample.libredb" },
    });

    const data = await parseResponseJSON<{ success: boolean; degraded?: boolean; message: string }>(
      await POST(req as never),
    );

    expect(data.success).toBe(true);
    expect(data.degraded).toBe(true);
    expect(data.message).toContain("no monitoring endpoint");
    expect(borrowedProvider.disconnect).not.toHaveBeenCalled();
  });

  test("builds its own provider when nothing holds the file, and closes that one", async () => {
    // The other half: reuse is not a new default. With no open handle the route opens,
    // tests and closes its own, exactly as it does for every client-server engine.
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { ...validConnection, type: "libredb", database: "/data/other.libredb" },
    });

    await POST(req as never);

    expect(mockFindOpenSingleWriterProvider).toHaveBeenCalledTimes(1);
    expect(mockCreateDatabaseProvider).toHaveBeenCalledTimes(1);
    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  // B1/K1: a DuckDB handle is borrowed only under the caller's own file-access posture, so a
  // file can be open under the OTHER posture with nothing to borrow. A second read-write handle
  // there checkpoints its own view over the file when it closes; the test handle opens read-only.

  test("opens its own handle read-only when a handle of the other posture holds the file", async () => {
    mockIsSingleWriterFileOpen.mockImplementation(() => true);

    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { ...validConnection, type: "duckdb", database: "/data/held.duckdb" },
    });

    const data = await parseResponseJSON<{ success: boolean }>(await POST(req as never));

    expect(data.success).toBe(true);
    expect(mockCreateDatabaseProvider).toHaveBeenCalledTimes(1);
    expect(mockCreateDatabaseProvider.mock.calls[0]).toEqual([
      expect.objectContaining({ type: "duckdb", database: "/data/held.duckdb" }),
      { queryTimeout: 10000 },
      { readOnly: true },
    ]);
    // Still this route's own handle, so it is still closed.
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  test("opens its own handle under the caller's posture when nothing holds the file", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { ...validConnection, type: "duckdb", database: "/data/free.duckdb" },
    });

    await POST(req as never);

    // The admin session of this file, on an inline connection: the requester decides.
    expect(mockCreateDatabaseProvider.mock.calls[0]?.[2]).toEqual({ allowExternalFileAccess: true });
    expect(mockFindOpenSingleWriterProvider.mock.calls[0]).toEqual([
      expect.objectContaining({ database: "/data/free.duckdb" }),
      true,
    ]);
  });
});
