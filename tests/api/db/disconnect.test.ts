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
import { providerCacheKey, providerOwner } from "@/lib/db/provider-cache-key";
import type { EditorExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { CUSTOM_CONNECTIONS_DISABLED_MESSAGE } from "@/lib/config/custom-connections";

// Typed with the factory's arguments, so a test can remove only the entries a scope names.
const mockRemoveProvider = mock<(...args: unknown[]) => Promise<void>>(async () => {});

/** The key the factory caches an editor provider under, derived from the same parts `editorCacheKey` frames. */
function editorKey(connection: DatabaseConnection, execution: EditorExecutionContext = {}): Promise<string> {
  return providerCacheKey(
    connection,
    execution.allowExternalFileAccess === true,
    providerOwner(connection, execution.owner),
  );
}

mock.module("@/lib/db/factory", () => ({
  createDatabaseProvider: mock(async () => ({})),
  getOrCreateProvider: mock(async () => ({})),
  editorCacheKey: mock(editorKey),
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

// Named, so a test can read the lines the route logs about what a disconnect removed.
const mockLoggerInfo = mock<(...args: unknown[]) => void>(() => {});

mock.module("@/lib/logger", () => ({
  logger: {
    info: mockLoggerInfo,
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
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

const { POST } = await import("@/app/api/db/disconnect/route");

beforeEach(() => {
  clearRateLimitState();
  // A reset, not a clear: an implementation a test queued and never reached must not answer the next test's removal.
  mockRemoveProvider.mockReset();
  mockRemoveProvider.mockImplementation(async () => {});
  mockLoggerInfo.mockClear();
});

/** A connection of the user's own, as the editor posts it: the record, credentials and SSH tunnel included. */
const CUSTOM: DatabaseConnection = {
  id: "conn-orders",
  name: "Orders",
  type: "postgres",
  host: "orders.db.internal",
  port: 5432,
  database: "orders",
  user: "alice",
  password: "alice-secret",
  sshTunnel: {
    enabled: true,
    host: "bastion.example.com",
    port: 22,
    username: "tunnel",
    authMethod: "password",
    password: "example-only-tunnel-password",
  },
  createdAt: new Date("2026-10-15T00:00:00Z"),
};

describe("POST /api/db/disconnect", () => {
  test("returns 400 when the body names no connection", async () => {
    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Either connection or connectionId is required");
  });

  test("returns 400 when connectionId is not a string", async () => {
    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: { connectionId: 123 },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test("returns 500 when removeProvider throws", async () => {
    mockRemoveProvider.mockImplementationOnce(async () => {
      throw new Error("disconnect failed");
    });

    const req = createMockRequest("/api/db/disconnect", {
      method: "POST",
      body: { connection: CUSTOM },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
  });
});

// ─── Caller-scoped disconnect without governance (docs/SECURITY.md, note 0.9) ───
//
// Without governance every caller of a connection shares its provider, so the route cannot scope a disconnect by owner.
// It resolves the caller's own record through resolveConnection, as every route does, and removes only the cache entries
// that record's provider key names, through the factory's key scope. The key frames the server and the credentials, so
// a request that names another user's connection id closes nothing of theirs, neither their provider nor the SSH
// tunnel it reaches the connection through. A seed id removes nothing: one provider serves every user of that seed,
// and the idle sweep reclaims it.
describe("POST /api/db/disconnect without governance", () => {
  const ALICE: MockSession = { role: "user", username: "alice@example.com" };
  const BOB: MockSession = { role: "user", username: "bob@example.com" };
  const ADMIN: MockSession = { role: "admin", username: "admin@example.com" };

  afterEach(() => {
    delete process.env.ALLOW_CUSTOM_CONNECTIONS;
    mockRemoveProvider.mockImplementation(async () => {});
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  /** The key the factory caches `connection`'s editor provider under for `session`, as the query routes open it. */
  function keyOf(connection: DatabaseConnection, session: MockSession): Promise<string> {
    return editorKey(connection, { allowExternalFileAccess: session.role === "admin" });
  }

  /**
   * The factory's cache as the key scope reads it: entries of a connection under their keys, and the connection's SSH
   * tunnel, which an unscoped removal closes at once and a scoped one only once no entry serves the connection.
   */
  function providersByKey(entries: { connectionId: string; key: string }[]) {
    const cache = entries.map((entry) => ({ ...entry, connected: true }));
    const closedTunnels = new Set<string>();
    mockRemoveProvider.mockImplementation(async (...args: unknown[]) => {
      const [connectionId, scope] = args as [string, { key?: string } | undefined];
      for (const entry of cache) {
        if (entry.connectionId === connectionId && (scope === undefined || entry.key === scope.key)) {
          entry.connected = false;
        }
      }
      if (scope === undefined || !cache.some((entry) => entry.connectionId === connectionId && entry.connected)) {
        closedTunnels.add(connectionId);
      }
    });
    return {
      connected: (key: string) => cache.find((entry) => entry.key === key)?.connected,
      tunnelOpen: (connectionId: string) => !closedTunnels.has(connectionId),
    };
  }

  function as(session: MockSession) {
    mockGetSession.mockImplementation(async () => session);
  }

  function disconnect(body: Record<string, unknown>) {
    return POST(createMockRequest("/api/db/disconnect", { method: "POST", body }) as never);
  }

  test("without governance, user B's disconnect leaves user A's provider and tunnel open", async () => {
    // Bob names Alice's connection id with his own credentials, which is all he has of hers.
    const bobsRecord = { ...CUSTOM, user: "bob", password: "bob-secret" };
    const aliceKey = await keyOf(CUSTOM, ALICE);
    const bobKey = await keyOf(bobsRecord, BOB);
    const providers = providersByKey([
      { connectionId: CUSTOM.id, key: aliceKey },
      { connectionId: CUSTOM.id, key: bobKey },
    ]);
    as(BOB);

    // The id alone names no record to resolve, so it is refused as on every other route, and nothing is removed.
    const byId = await disconnect({ connectionId: CUSTOM.id });
    expect(providers.connected(aliceKey)).toBe(true);
    expect(providers.tunnelOpen(CUSTOM.id)).toBe(true);
    expect(byId.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(byId)).toEqual(
      expect.objectContaining({ error: "Invalid connection ID format" }),
    );

    // His own record names his own entry, and only his entry goes.
    const byRecord = await disconnect({ connection: bobsRecord });
    expect(providers.connected(aliceKey)).toBe(true);
    expect(providers.tunnelOpen(CUSTOM.id)).toBe(true);
    expect(providers.connected(bobKey)).toBe(false);
    expect(byRecord.status).toBe(200);
    expect(await parseResponseJSON<Record<string, unknown>>(byRecord)).toEqual({ success: true });
    expect(mockRemoveProvider).toHaveBeenCalledTimes(1);
    expect(mockRemoveProvider).toHaveBeenCalledWith(CUSTOM.id, { key: bobKey });
  });

  test("without governance, a seed id leaves the shared seed provider connected", async () => {
    // Every user of a seed shares its one provider, so no user's disconnect may close it; the idle sweep reclaims it.
    const providers = providersByKey([{ connectionId: "seed:orders", key: "the-seed-provider" }]);
    as(BOB);

    // Named by its id, as the editor sends a managed connection, and as the editable copy of a seed, which keeps the
    // seed's id.
    const byId = await disconnect({ connectionId: "seed:orders" });
    const byCopy = await disconnect({ connection: { ...CUSTOM, id: "seed:orders" } });

    expect(providers.connected("the-seed-provider")).toBe(true);
    expect(providers.tunnelOpen("seed:orders")).toBe(true);
    expect(mockRemoveProvider).not.toHaveBeenCalled();
    expect([byId.status, byCopy.status]).toEqual([200, 200]);
    expect(await parseResponseJSON<Record<string, unknown>>(byId)).toEqual({ success: true });
    expect(await parseResponseJSON<Record<string, unknown>>(byCopy)).toEqual({ success: true });
  });

  test("without governance, the log line says whether the disconnect removed anything", async () => {
    as(ALICE);

    await disconnect({ connectionId: "seed:orders" });
    await disconnect({ connection: CUSTOM });

    // A seed id removes nothing, so its line says so rather than claiming a removal; the user's own record removes the
    // providers its key names.
    expect(mockLoggerInfo.mock.calls).toEqual([
      [
        "[DB] Disconnect removed nothing: one provider serves every user of a seed connection, and the idle sweep closes it",
        { connectionId: "seed:orders" },
      ],
      ["[DB] Provider disconnected and removed from cache", { connectionId: CUSTOM.id }],
    ]);
  });

  test("without governance, the key frames the caller's own file-access posture", async () => {
    // A DuckDB handle opens under the file-access posture of the session that opened it, and its key frames that
    // posture (non-admin DuckDB file access), so an admin's disconnect names the key of the admin's own handle, which
    // a key derived without the session would miss.
    const local: DatabaseConnection = {
      id: "conn-local",
      name: "Local",
      type: "duckdb",
      database: "/data/local.duckdb",
      createdAt: new Date("2026-10-15T00:00:00Z"),
    };
    const adminKey = await keyOf(local, ADMIN);
    expect(adminKey).not.toBe(await keyOf(local, ALICE));
    const providers = providersByKey([{ connectionId: local.id, key: adminKey }]);
    as(ADMIN);

    expect((await disconnect({ connection: local })).status).toBe(200);

    expect(mockRemoveProvider).toHaveBeenCalledWith(local.id, { key: adminKey });
    expect(providers.connected(adminKey)).toBe(false);
  });

  test("without governance, a custom connection is refused while custom connections are off, and nothing is removed", async () => {
    process.env.ALLOW_CUSTOM_CONNECTIONS = "false";
    const providers = providersByKey([{ connectionId: CUSTOM.id, key: await keyOf(CUSTOM, ALICE) }]);
    as(ALICE);

    const res = await disconnect({ connection: CUSTOM });

    expect(res.status).toBe(403);
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({
      error: CUSTOM_CONNECTIONS_DISABLED_MESSAGE,
      code: "CUSTOM_CONNECTIONS_DISABLED",
      statusCode: 403,
    });
    expect(mockRemoveProvider).not.toHaveBeenCalled();
    expect(providers.tunnelOpen(CUSTOM.id)).toBe(true);
  });
});

// ─── Per-user providers under governance (docs/GOVERNANCE.md#per-user-providers) ───
//
// Under governance every user of a connection has providers of their own, so a disconnect removes only the caller's:
// the route names the session's identity provider subject as the owner. Without the scope, any signed-in user could
// tear down every other user's providers of a connection by naming its id (docs/SECURITY.md, note 0.9).
describe("POST /api/db/disconnect under governance", () => {
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
    // Under governance a seed id removes the caller's own providers, and the line says so.
    expect(mockLoggerInfo.mock.calls).toEqual([
      ["[DB] Provider disconnected and removed from cache", { connectionId: "seed:orders" }],
    ]);
  });

  test("governance: an admin's disconnect is scoped to the admin's own providers too", async () => {
    // The admin role opens the admin pages and maintenance only (docs/GOVERNANCE.md#grants-and-the-connection-list),
    // never another user's providers.
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

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Failed to disconnect").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/disconnect: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockRemoveProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON(res)).toEqual({ success: false, error: "Invalid request body" });
    expect(mockRemoveProvider).not.toHaveBeenCalled();
  });
});
