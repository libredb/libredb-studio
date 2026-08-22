import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";

// ─── Mock provider ──────────────────────────────────────────────────────────
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

// ─── Mock @/lib/db/factory BEFORE importing the route ───────────────────────
// Pass-through stand-in for the real scope, which opens an unshared SSH tunnel and
// rewrites host/port to its local endpoint (#457).
const mockWithOneShotTunnel = mock(
  async (connection: Record<string, unknown>, run: (c: Record<string, unknown>) => Promise<unknown>) =>
    await run({ ...connection, host: "127.0.0.1", port: 54321 }),
);

mock.module("@/lib/db/factory", () => ({
  getOrCreateProvider: mock(async () => mockProvider),
  createDatabaseProvider: mockCreateDatabaseProvider,
  withOneShotTunnel: mockWithOneShotTunnel,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/schema-snapshot/route");

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
describe("POST /api/db/schema-snapshot", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockCreateDatabaseProvider.mockClear();
    mockCreateDatabaseProvider.mockImplementation(async () => mockProvider);
    (mockProvider.connect as ReturnType<typeof mock>).mockClear();
    (mockProvider.disconnect as ReturnType<typeof mock>).mockClear();
    (mockProvider.getSchema as ReturnType<typeof mock>).mockClear();
    // Reset implementations
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.disconnect as ReturnType<typeof mock>).mockImplementation(async () => {});
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns schema with metadata for valid connection", async () => {
    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      schema: unknown[];
      connectionId: string;
      connectionName: string;
      databaseType: string;
      timestamp: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.schema).toBeArray();
    expect(data.connectionId).toBe("test-1");
    expect(data.connectionName).toBe("Test DB");
    expect(data.databaseType).toBe("postgres");
    expect(data.timestamp).toBeDefined();
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 500 when connect() fails", async () => {
    (mockProvider.connect as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Connection refused"));

    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Connection refused");
  });

  test("returns 500 when getSchema() fails and disconnect is still called", async () => {
    (mockProvider.getSchema as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Schema fetch failed"));

    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Schema fetch failed");
    // disconnect should be called in the error handler
    expect(mockProvider.disconnect).toHaveBeenCalled();
  });

  test("calls connect() and disconnect() on success", async () => {
    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: { connection: validConnection },
    });

    await POST(req as never);

    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  test("calls disconnect() in error handler when connect succeeds but getSchema fails", async () => {
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.getSchema as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Schema error"));
    (mockProvider.disconnect as ReturnType<typeof mock>).mockImplementation(async () => {});

    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(500);
    // disconnect should have been called in the catch block
    expect(mockProvider.disconnect).toHaveBeenCalled();
  });

  // ─── SSH tunnel (#457) ────────────────────────────────────────────────────
  // The agent's grounding capture reads its schema here. Like test-connection this
  // route builds its provider outside both caches, so it needs the tunnel scope
  // explicitly - otherwise a tunnelled connection has no readable schema at all.

  test("reads the schema through the connection's SSH tunnel rather than the raw host", async () => {
    mockWithOneShotTunnel.mockClear();
    mockCreateDatabaseProvider.mockClear();

    const req = createMockRequest("/api/db/schema-snapshot", {
      method: "POST",
      body: {
        connection: {
          ...validConnection,
          host: "db.internal",
          sshTunnel: { enabled: true, host: "bastion", port: 22, username: "jump", authMethod: "password" },
        },
      },
    });

    await POST(req as never);

    expect(mockWithOneShotTunnel).toHaveBeenCalledTimes(1);
    expect(mockWithOneShotTunnel.mock.calls[0]?.[0]).toMatchObject({ host: "db.internal" });
    expect(mockCreateDatabaseProvider.mock.calls[0]?.[0]).toMatchObject({ host: "127.0.0.1", port: 54321 });
  });
});
