import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
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

// Typed with the factory's arguments, so a test can remove only the entries a scope names.
const mockRemoveProvider = mock<(...args: unknown[]) => Promise<void>>(async () => {});

mock.module("@/lib/db/factory", () => ({
  createDatabaseProvider: mock(async () => ({})),
  getOrCreateProvider: mock(async () => ({})),
  removeProvider: mockRemoveProvider,
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  registerShutdownHandlers: mock(() => {}),
}));

mock.module("@/lib/db", () => ({
  createDatabaseProvider: mock(async () => ({})),
  getOrCreateProvider: mock(async () => ({})),
  removeProvider: mockRemoveProvider,
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  registerShutdownHandlers: mock(() => {}),
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
}));

mock.module("@/lib/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

/** A session as `getSession` answers it; under governance it carries the identity provider subject too. */
type MockSession = { role: string; username: string; idpSubject?: string };

const mockGetSession = mock(async (): Promise<MockSession | null> => ({ role: "admin", username: "admin" }));

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

const { POST } = await import("@/app/api/db/disconnect/route");

beforeEach(() => {
  clearRateLimitState();
  mockRemoveProvider.mockClear();
});

describe("POST /api/db/disconnect", () => {
  test("returns 400 when connectionId is missing", async () => {
    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe("connectionId is required");
  });

  test("returns 400 when connectionId is not a string", async () => {
    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: { connectionId: 123 },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test("calls removeProvider and returns success", async () => {
    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: { connectionId: "conn-123" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockRemoveProvider).toHaveBeenCalledWith("conn-123");
  });

  test("returns 500 when removeProvider throws", async () => {
    mockRemoveProvider.mockImplementationOnce(async () => {
      throw new Error("disconnect failed");
    });

    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: { connectionId: "conn-fail" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ─── Per-user providers under governance (spec 9.4) ─────────────────────────
//
// Under governance every user of a connection has providers of their own, so a disconnect removes only the caller's:
// the route names the session's identity provider subject as the owner. Without the scope, any signed-in user could
// tear down every other user's providers of a connection by naming its id (spec 17).
describe("POST /api/db/disconnect under governance (spec 9.4)", () => {
  let savedSource: string | undefined;

  beforeEach(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    process.env.GOVERNANCE_SOURCE = "postgres";
  });

  afterEach(() => {
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
    mockRemoveProvider.mockImplementation(async () => {});
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  /**
   * The factory's cache as the owner scope reads it: one provider per owner of a connection, and a removal that takes
   * the entries of the connection it names, only the scope's owner's when it names one.
   */
  function providerPerOwner(entries: { connectionId: string; owner: string }[]) {
    const cache = entries.map((entry) => ({ ...entry, connected: true }));
    mockRemoveProvider.mockImplementation(async (...args: unknown[]) => {
      const [connectionId, scope] = args as [string, { owner: string } | undefined];
      for (const entry of cache) {
        if (entry.connectionId === connectionId && (scope === undefined || entry.owner === scope.owner)) {
          entry.connected = false;
        }
      }
    });
    return {
      connected: (connectionId: string, owner: string) =>
        cache.find((entry) => entry.connectionId === connectionId && entry.owner === owner)?.connected,
    };
  }

  function as(session: MockSession) {
    mockGetSession.mockImplementation(async () => session);
  }

  function disconnect(connectionId: string) {
    return POST(createMockRequest("/api/db/disconnect", { method: "POST", body: { connectionId } }) as never);
  }

  test("governance: user B's disconnect leaves user A's provider connected", async () => {
    const providers = providerPerOwner([
      { connectionId: "seed:orders", owner: "alice-subject" },
      { connectionId: "seed:orders", owner: "bob-subject" },
      { connectionId: "seed:billing", owner: "bob-subject" },
    ]);
    as({ role: "user", username: "bob@example.com", idpSubject: "bob-subject" });

    const res = await disconnect("seed:orders");

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({ success: true });
    expect(mockRemoveProvider).toHaveBeenCalledWith("seed:orders", { owner: "bob-subject" });
    expect(providers.connected("seed:orders", "alice-subject")).toBe(true);
    expect(providers.connected("seed:orders", "bob-subject")).toBe(false);
    // Only the connection the request names.
    expect(providers.connected("seed:billing", "bob-subject")).toBe(true);
  });

  test("governance: an admin's disconnect is scoped to the admin's own providers too", async () => {
    // The admin role opens the admin pages and maintenance only (spec 9.3), never another user's providers.
    const providers = providerPerOwner([
      { connectionId: "seed:orders", owner: "alice-subject" },
      { connectionId: "seed:orders", owner: "admin-subject" },
    ]);
    as({ role: "admin", username: "admin@example.com", idpSubject: "admin-subject" });

    expect((await disconnect("seed:orders")).status).toBe(200);

    expect(mockRemoveProvider).toHaveBeenCalledWith("seed:orders", { owner: "admin-subject" });
    expect(providers.connected("seed:orders", "alice-subject")).toBe(true);
    expect(providers.connected("seed:orders", "admin-subject")).toBe(false);
  });

  test("governance: a session without an identity provider subject removes nothing and answers 500", async () => {
    // getSession() refuses such a session under governance, so one that gets here is an error, never a reason to
    // remove the providers of every user of the connection.
    const providers = providerPerOwner([{ connectionId: "seed:orders", owner: "alice-subject" }]);
    as({ role: "user", username: "nobody@example.com" });

    const res = await disconnect("seed:orders");

    expect(res.status).toBe(500);
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({
      success: false,
      error: "Failed to disconnect",
    });
    expect(mockRemoveProvider).not.toHaveBeenCalled();
    expect(providers.connected("seed:orders", "alice-subject")).toBe(true);
  });
});
