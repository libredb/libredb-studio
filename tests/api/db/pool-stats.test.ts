import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { ConnectionError, QueryError } from "@/lib/db/errors";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
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

// ─── Mock @/lib/db/factory BEFORE importing the route ───────────────────────
mock.module("@/lib/db/factory", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
  // The barrel `@/lib/db` re-exports it from this module, and the route loads the barrel; never called here.
  readProviderDeclarations: mock(async () => {
    throw new Error("readProviderDeclarations is not read by this route");
  }),
  // src/lib/api/editor-provider.ts imports it, and the route loads that module.
  findCachedProvider: mock(() => null),
  // The barrel `@/lib/db` re-exports it from this module too; this route reads no object tree.
  getOrCreateMetadataProvider: mock(async () => {
    throw new Error("getOrCreateMetadataProvider is not read by this route");
  }),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/pool-stats/route");

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
describe("POST /api/db/pool-stats", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => POST(createMockRequest("/api/db/pool-stats", { method: "POST", body: { connection } }) as never);
    const refusing = (message: string) => ({
      ...createMockProvider(),
      getPoolStats: mock(() => {
        throw new QueryError(message, "postgres");
      }),
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(refusing(`pool read refused for ${password}`));
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(400);
    expect(body).toMatchObject({ code: "QUERY_ERROR", error: withheldErrorMessage("QueryError") });
    expect(JSON.stringify(body)).not.toContain(password);

    mockGetOrCreateProvider.mockResolvedValueOnce(refusing("pool read refused"));
    const clean = await send();
    expect(clean.status).toBe(400);
    expect(await parseResponseJSON(clean)).toMatchObject({ code: "QUERY_ERROR", error: "pool read refused" });
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/pool-stats", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns pool stats when provider supports getPoolStats", async () => {
    const providerWithPoolStats = {
      ...createMockProvider(),
      getPoolStats: mock(() => ({ total: 10, idle: 5, active: 3, waiting: 2 })),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithPoolStats);

    const req = createMockRequest("/api/db/pool-stats", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      total: number;
      idle: number;
      active: number;
      waiting: number;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.total).toBe(10);
    expect(data.idle).toBe(5);
    expect(data.active).toBe(3);
    expect(data.waiting).toBe(2);
  });

  test("passes the configured maximum through when the provider reports one", async () => {
    const providerWithMax = {
      ...createMockProvider(),
      getPoolStats: mock(() => ({ total: 2, max: 10, idle: 0, active: 2, waiting: 0 })),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithMax);

    const res = await POST(
      createMockRequest("/api/db/pool-stats", { method: "POST", body: { connection: validConnection } }) as never,
    );
    const data = await parseResponseJSON<{ total: number; max: number }>(res);

    expect(data.total).toBe(2);
    expect(data.max).toBe(10);
  });

  test("returns fallback stats when provider lacks getPoolStats", async () => {
    // Default mockProvider does not have getPoolStats
    const req = createMockRequest("/api/db/pool-stats", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      total: number;
      idle: number;
      active: number;
      waiting: number;
      message: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.total).toBe(0);
    expect(data.idle).toBe(0);
    expect(data.active).toBe(0);
    expect(data.waiting).toBe(0);
    expect(data.message).toContain("not available");
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/pool-stats", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 500 on error", async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(new Error("Provider creation failed"));

    const req = createMockRequest("/api/db/pool-stats", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Provider creation failed");
  });
});

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'connection' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/pool-stats: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/pool-stats", {
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
 * What the pool-stats route answers today, at the provider's own `getPoolStats`, which the host core keeps when the
 * route reads the session's pool through monitoring.poolStats, its not-available answer the one for a session that
 * does not offer that facet.
 */
describe("what the pool-stats route answers today, which the host core keeps", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  const send = () =>
    POST(createMockRequest("/api/db/pool-stats", { method: "POST", body: { connection: validConnection } }) as never);

  test("the provider's pool statistics are read once, with no argument, and answered as they are, with or without a ceiling", async () => {
    for (const stats of [
      { total: 5, max: 10, idle: 2, active: 3, waiting: 1 },
      { total: 4, idle: 1, active: 3, waiting: 0 },
    ]) {
      const getPoolStats = mock(() => stats);
      const pooled = { ...createMockProvider(), getPoolStats };
      mockGetOrCreateProvider.mockResolvedValueOnce(pooled);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own provider's.
      const res = await send();

      expect(res.status).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await parseResponseJSON(res)).toEqual(stats);
      expect(getPoolStats.mock.calls).toEqual([[]]);
    }
  });

  test("a provider with no pool statistics answers zeros and the sentence that says they are not available", async () => {
    const res = await send();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON(res)).toEqual({
      total: 0,
      idle: 0,
      active: 0,
      waiting: 0,
      message: "Pool statistics not available for this provider",
    });
  });

  test("a pool statistics read that throws answers by its class", async () => {
    const words = crypto.randomUUID();
    const cases: [Error, number, Record<string, unknown>][] = [
      [
        new ConnectionError(words, "postgres", "localhost", 5432),
        503,
        { error: words, code: "CONNECTION_ERROR", retryable: true, kind: "connection", outcome: "unknown" },
      ],
      [new Error(words), 500, { error: words, code: "INTERNAL_ERROR" }],
    ];

    for (const [error, status, expected] of cases) {
      const getPoolStats = mock(() => {
        throw error;
      });
      const pooled = { ...createMockProvider(), getPoolStats };
      mockGetOrCreateProvider.mockResolvedValueOnce(pooled);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const res = await send();

      expect([error.name, res.status]).toEqual([error.name, status]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await parseResponseJSON(res)).toEqual({ ...expected, statusCode: status });
    }
  });
});
