import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
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

// ─── Create mock objects ────────────────────────────────────────────────────
const baseMockProvider = createMockProvider();

// Provider with cancelQuery support
const mockCancelProvider = {
  ...baseMockProvider,
  cancelQuery: mock(async () => true),
};

// Provider without cancelQuery support
const mockNoCancelProvider = createMockProvider();

// Typed with the factory's arguments, so a test can hand each owner of a connection a provider of its own.
const mockGetOrCreateProvider = mock<(...args: unknown[]) => Promise<never>>(async () => mockCancelProvider as never);

/** A session as `getSession` answers it; under governance it carries the identity provider subject too. */
type MockSession = { role: string; username: string; idpSubject?: string };

const mockGetSession = mock(async (): Promise<MockSession | null> => ({ role: "admin", username: "admin" }));

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
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockCancelProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
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
const { POST } = await import("@/app/api/db/cancel/route");
// The provider an editor request runs on, as `POST /api/db/query` opens it: the governance test starts a statement there.
const { editorProvider } = await import("@/lib/api/editor-provider");

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
describe("POST /api/db/cancel", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockCancelProvider.cancelQuery.mockClear();
    mockGetSession.mockClear();

    // Reset implementations
    mockGetOrCreateProvider.mockImplementation(async () => mockCancelProvider as never);
    mockCancelProvider.cancelQuery.mockImplementation(async () => true);
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection, queryId: "query-123" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns cancelled:true with valid connection and queryId", async () => {
    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection, queryId: "query-123" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ cancelled: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.cancelled).toBe(true);
    expect(mockCancelProvider.cancelQuery).toHaveBeenCalledWith("query-123");
  });

  test("missing connection returns 400", async () => {
    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { queryId: "query-123" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("missing queryId returns 400", async () => {
    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Connection and queryId are required");
  });

  test("a queryId that is not a string returns 400 and reaches no provider (#1364)", async () => {
    mockCancelProvider.cancelQuery.mockClear();
    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection, queryId: { $ne: "" } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; cancelled: boolean }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("queryId must be a string");
    expect(data.cancelled).toBe(false);
    expect(mockCancelProvider.cancelQuery).not.toHaveBeenCalled();
  });

  test("provider without cancelQuery returns 400", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => mockNoCancelProvider as never);

    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection, queryId: "query-123" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; cancelled: boolean }>(res);

    expect(res.status).toBe(400);
    expect(data.cancelled).toBe(false);
    expect(data.error).toContain("not supported");
  });

  test("cancelQuery returning false returns cancelled:false", async () => {
    mockCancelProvider.cancelQuery.mockImplementation(async () => false);

    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection, queryId: "query-999" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ cancelled: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.cancelled).toBe(false);
  });

  test("error in cancelQuery returns 500", async () => {
    mockCancelProvider.cancelQuery.mockImplementation(async () => {
      throw new Error("Failed to cancel query");
    });

    const req = createMockRequest("/api/db/cancel", {
      method: "POST",
      body: { connection: validConnection, queryId: "query-123" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain("Failed to cancel query");
    expect(data.code).toBe("INTERNAL_ERROR");
  });
});

// ─── Per-user providers under governance (docs/GOVERNANCE.md#per-user-providers) ───
//
// A statement is cancelled through the provider that runs it, and under governance every user's statements run on
// that user's own provider: the execution context names the session's identity provider subject as the owner, for the
// editor request that starts a statement and for the cancel alike. So a query id another user's provider runs is
// unknown to the caller's own provider, whoever names it.
describe("POST /api/db/cancel under governance", () => {
  const ALICE: MockSession = { role: "user", username: "alice@example.com", idpSubject: "alice-subject" };
  const BOB: MockSession = { role: "user", username: "bob@example.com", idpSubject: "bob-subject" };
  const ORDERS = { ...validConnection, id: "seed:orders" };

  let savedSource: string | undefined;

  beforeEach(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    process.env.GOVERNANCE_SOURCE = "postgres";
    clearRateLimitState();
  });

  afterEach(() => {
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
    mockGetOrCreateProvider.mockImplementation(async () => mockCancelProvider as never);
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  /** A provider double that runs a statement until it is cancelled, and cancels only the statements it runs. */
  function cancellableProvider() {
    const running = new Map<string, (error: Error) => void>();
    return {
      ...baseMockProvider,
      query: mock(
        (_sql: string, _params?: unknown[], queryId?: string) =>
          new Promise<never>((_resolve, reject) => {
            if (queryId !== undefined) running.set(queryId, reject);
          }),
      ),
      cancelQuery: mock(async (queryId: string) => {
        const stop = running.get(queryId);
        if (stop === undefined) return false;
        running.delete(queryId);
        stop(new Error("canceling statement due to user request"));
        return true;
      }),
      runs: (queryId: string) => running.has(queryId),
    };
  }

  /**
   * The factory as it keys providers: one per owner the execution context names, and one shared by every caller
   * that names none, which is every caller without governance.
   */
  function providerPerOwner() {
    const shared = cancellableProvider();
    const owned = new Map<string, ReturnType<typeof cancellableProvider>>();
    mockGetOrCreateProvider.mockImplementation(async (...args: unknown[]) => {
      const owner = (args[2] as { owner?: string } | undefined)?.owner;
      if (owner === undefined) return shared as never;
      if (!owned.has(owner)) owned.set(owner, cancellableProvider());
      return owned.get(owner) as never;
    });
    return { shared, of: (owner: string) => owned.get(owner) };
  }

  function cancelAs(session: MockSession, queryId: string) {
    mockGetSession.mockImplementation(async () => session);
    return POST(
      createMockRequest("/api/db/cancel", { method: "POST", body: { connection: ORDERS, queryId } }) as never,
    );
  }

  test("governance: user B cannot cancel user A's query id", async () => {
    const providers = providerPerOwner();
    // A's statement runs on the provider A's editor requests open, under the id A's editor minted for it.
    const aliceProvider = await editorProvider(ALICE, ORDERS as never, undefined);
    const aliceRun = aliceProvider.query("SELECT pg_sleep(60)", undefined, "alice-query");

    const bob = await cancelAs(BOB, "alice-query");

    expect(bob.status).toBe(200);
    expect(await parseResponseJSON<Record<string, unknown>>(bob)).toEqual({ cancelled: false });
    expect(providers.of("alice-subject")?.runs("alice-query")).toBe(true);
    expect(providers.of("alice-subject")?.cancelQuery).not.toHaveBeenCalled();
    expect(providers.shared.cancelQuery).not.toHaveBeenCalled();

    // The control: the same id from A reaches A's statement and stops it.
    const alice = await cancelAs(ALICE, "alice-query");

    expect(await parseResponseJSON<Record<string, unknown>>(alice)).toEqual({ cancelled: true });
    await expect(aliceRun).rejects.toThrow("canceling statement due to user request");
  });
});

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'queryId' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/cancel: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/cancel", {
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
