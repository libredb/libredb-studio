import { describe, test, expect, mock, beforeEach, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
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
  PermissionDeniedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { withheldErrorMessage } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, HealthInfo } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { HealthRecord } from "@/lib/provider-host/core/monitoring";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { editorEntryOf } from "../../helpers/editor-session-entry";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

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
  const resolveConnection = mock(async (body: Record<string, unknown>) => {
    if (!body.connection && !body.connectionId) {
      throw new SeedConnectionError("Either connection or connectionId is required", 400);
    }
    return body.connection;
  });
  return {
    resolveConnection,
    // The served resolve the route reads: the same resolution, with the record of the resolved type's engine, a legacy
    // engine's, as the server catalog holds it, and its refusal of a type it does not serve.
    resolveServedConnection: async (body: Record<string, unknown>) => {
      const connection = (await resolveConnection(body)) as { type?: unknown };
      return { connection, engine: servedEngineRecord(connection.type) };
    },
    SeedConnectionError,
  };
});

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
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
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

// ─── Mock @/lib/db/factory BEFORE importing the route ───────────────────────
/**
 * The metadata session health is read on (docs/providers/CONTRACT.md, clause C-66), answered by default with the same
 * `mockProvider`, so a title written against the provider the route resolves passes unchanged. The route opens it
 * through `getOrCreateMetadataSession`, whose stand-in answers the entry a legacy record's open answers for the
 * provider this stand-in answers with the same arguments. The editor's stand-in above stays in the barrel's mock, and
 * the titles below hold that the route never calls it.
 */
const mockGetOrCreateMetadataProvider = mock<(...args: unknown[]) => Promise<DatabaseProvider>>(
  async () => mockProvider,
);
mock.module("@/lib/db/factory", () => ({
  getOrCreateMetadataProvider: mockGetOrCreateMetadataProvider,
  // src/lib/api/editor-provider.ts imports it, and the route loads that module; this route reads no cached provider.
  findCachedProvider: mock(() => null),
  // src/lib/api/editor-provider.ts imports it, and the route loads that module; this route opens no editor session.
  getOrCreateEditorSession: mock(async () => {
    throw new Error("getOrCreateEditorSession is not read by this route");
  }),
  getOrCreateMetadataSession: async (connection: unknown, _engine: unknown, execution: unknown) =>
    editorEntryOf(await mockGetOrCreateMetadataProvider(connection, {}, execution)),
}));

// ─── Import route handlers AFTER mocking ────────────────────────────────────
const { GET, POST } = await import("@/app/api/db/health/route");
const { editorProvider } = await import("@/lib/api/editor-provider");

// The route reads health through the process's host core (src/lib/provider-host/instance.ts), so this file composes
// its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

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
describe("GET /api/db/health", () => {
  test("returns 200 with healthy status", async () => {
    const res = await GET();
    const data = await parseResponseJSON<{
      status: string;
      timestamp: string;
      service: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(data.service).toBe("libredb-studio");
    expect(data.timestamp).toBeDefined();
  });
});

describe("POST /api/db/health", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateMetadataProvider.mockClear();
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();
  });

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => POST(createMockRequest("/api/db/health", { method: "POST", body: { connection } }) as never);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ConnectionError(`could not connect as ${password}`, "postgres"),
    );
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(503);
    expect(body).toMatchObject({ code: "CONNECTION_ERROR", error: withheldErrorMessage("ConnectionError") });
    expect(JSON.stringify(body)).not.toContain(password);

    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(
      new ConnectionError("could not connect", "postgres"),
    );
    const clean = await send();
    expect(clean.status).toBe(503);
    expect(await parseResponseJSON(clean)).toMatchObject({ code: "CONNECTION_ERROR", error: "could not connect" });
  });

  test("returns 200 with health info for valid connection", async () => {
    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      activeConnections: number;
      databaseSize: string;
      cacheHitRatio: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.activeConnections).toBeDefined();
    expect(data.databaseSize).toBeDefined();
    expect(data.cacheHitRatio).toBeDefined();
  });

  test("returns 400 when connection is missing", async () => {
    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 503 for ConnectionError", async () => {
    mockGetOrCreateMetadataProvider.mockRejectedValueOnce(new ConnectionError("Connection refused"));

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain("Connection refused");
    expect(data.code).toBe("CONNECTION_ERROR");
  });

  test("returns 500 for DatabaseError", async () => {
    const dbError = new DatabaseError("Database internal error", "postgres", "INTERNAL_ERROR");
    mockGetOrCreateMetadataProvider.mockResolvedValueOnce(mockProvider);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Database internal error");
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("returns 401 when no session", async () => {
    const { getSession } = await import("@/lib/auth");
    (getSession as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  test("returns 400 when connection has no type", async () => {
    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: { id: "x", name: "X" } },
    });

    // The served resolve refuses it itself, before any open.
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(await parseResponseJSON(res)).toMatchObject({
      code: "PROVIDER_UNKNOWN",
      error: "This connection names no type, so no provider in this LibreDB Studio can open it.",
    });
  });

  test("returns 500 for generic error", async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(new Error("Unexpected failure"));

    const req = createMockRequest("/api/db/health", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Unexpected failure");
  });
});

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'connection' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/health: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateMetadataProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON(res)).toEqual({ error: "Invalid request body" });
    expect(mockGetOrCreateMetadataProvider).not.toHaveBeenCalled();
  });
});

/**
 * What the health route answers today, at the provider's own `getHealth`, which the host core keeps when the route
 * reads the session's health through the mandatory health call.
 */
describe("what the health route answers today, which the host core keeps", () => {
  type Mocked = ReturnType<typeof mock>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
    (mockProvider.getHealth as Mocked).mockClear();
  });

  const send = () =>
    POST(createMockRequest("/api/db/health", { method: "POST", body: { connection: validConnection } }) as never);

  test("the provider's health is read once, with no argument, and answered as it is, an unmeasured connection count left out", async () => {
    const health: HealthInfo = {
      databaseSize: crypto.randomUUID(),
      cacheHitRatio: crypto.randomUUID(),
      slowQueries: [{ query: crypto.randomUUID(), calls: 3, avgTime: "10 ms" }],
      activeSessions: [
        { pid: 4711, user: "app", database: "orders", state: "active", query: crypto.randomUUID(), duration: "1s" },
      ],
    };
    (mockProvider.getHealth as Mocked).mockResolvedValueOnce(health);

    const res = await send();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON(res)).toEqual(health);
    expect((mockProvider.getHealth as Mocked).mock.calls).toEqual([[]]);
  });

  test("a health read's Studio error answers by its class, with its code, kind and outcome", async () => {
    const words = crypto.randomUUID();
    const cases: [Error, number, Record<string, unknown>][] = [
      [new QueryError(words, "postgres"), 400, { error: words, code: "QUERY_ERROR", kind: "query" }],
      [
        new ConnectionError(words, "postgres", "localhost", 5432),
        503,
        { error: words, code: "CONNECTION_ERROR", retryable: true, kind: "connection" },
      ],
      [
        new TimeoutError(words, "postgres", 1000),
        504,
        {
          error: "Query timed out. Please try a simpler query or increase timeout.",
          code: "TIMEOUT_ERROR",
          retryable: true,
          kind: "timeout",
        },
      ],
      [
        new PoolExhaustedError(words, "postgres", 4),
        503,
        { error: words, code: "POOL_EXHAUSTED", retryable: true, kind: "pool-exhausted" },
      ],
      [
        new PermissionDeniedError(words, "postgres"),
        403,
        { error: words, code: "PERMISSION_DENIED", kind: "permission" },
      ],
    ];

    for (const [error, status, expected] of cases) {
      (mockProvider.getHealth as Mocked).mockRejectedValueOnce(error);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const res = await send();
      expect([error.name, res.status]).toEqual([error.name, status]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await parseResponseJSON(res)).toEqual({ ...expected, statusCode: status, outcome: "unknown" });
    }
  });

  test("a health read's raw error answers 500 with its own words", async () => {
    const words = crypto.randomUUID();
    (mockProvider.getHealth as Mocked).mockRejectedValueOnce(new Error(words));

    const res = await send();

    expect(res.status).toBe(500);
    expect(await parseResponseJSON(res)).toEqual({ error: words, code: "INTERNAL_ERROR", statusCode: 500 });
  });
});

describe("the health route on the host core", () => {
  beforeEach(() => {
    clearRateLimitState();
  });

  afterEach(() => {
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  /** A health request for `provider`, whose signal is `signal`, as a browser that may leave sends it. */
  function healthWith(provider: unknown, signal?: AbortSignal): Promise<Response> {
    mockGetOrCreateMetadataProvider.mockImplementation(async () => provider as never);
    return POST(
      new Request("http://localhost:3000/api/db/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: validConnection }),
        ...(signal === undefined ? {} : { signal }),
      }) as never,
    );
  }

  test("a health read whose request leaves answers 499 at once, outcome unknown", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const pending = Promise.withResolvers<never>();
    const reached = Promise.withResolvers<void>();
    const getHealth = mock(() => {
      reached.resolve();
      return pending.promise;
    });
    const caller = new AbortController();
    try {
      const answering = healthWith({ ...createMockProvider(), getHealth }, caller.signal);
      await reached.promise;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      const response = await answering;

      expect(response.status).toBe(499);
      expect(await parseResponseJSON(response)).toMatchObject({ code: "QUERY_CANCELLED", outcome: "unknown" });
      pending.reject(new Error(crypto.randomUUID()));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      warn.mockRestore();
    }
  });

  test("a health read whose request is already gone answers 499 not-sent and reads nothing", async () => {
    const getHealth = mock(async () => ({
      databaseSize: "0",
      cacheHitRatio: "0",
      slowQueries: [],
      activeSessions: [],
    }));
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const response = await healthWith({ ...createMockProvider(), getHealth }, caller.signal);

    expect(response.status).toBe(499);
    expect(await parseResponseJSON(response)).toMatchObject({ code: "QUERY_CANCELLED", outcome: "not-sent" });
    expect(getHealth).not.toHaveBeenCalled();
  });

  test("a health read past its deadline answers 504 studio-timeout-refusal naming the health read", async () => {
    const real = hostCore();
    const stopping: HostCore = {
      ...real,
      healthCall: async (): Promise<HealthRecord> => ({
        kind: "stopped",
        reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
        settled: Promise.resolve(),
      }),
    };
    const getHealth = mock(async () => ({
      databaseSize: "0",
      cacheHitRatio: "0",
      slowQueries: [],
      activeSessions: [],
    }));
    forgetHostCore();
    installHostCore(stopping, "test");
    let response: Response;
    try {
      response = await healthWith({ ...createMockProvider(), getHealth });
    } finally {
      forgetHostCore();
      installHostCore(real, "test");
    }
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(504);
    expect(body).toMatchObject({ code: "TIMEOUT_ERROR", kind: "studio-timeout-refusal", outcome: "unknown" });
    expect(body.error).toBe(
      "The health read did not answer within the statement timeout of 60 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
    expect(getHealth).not.toHaveBeenCalled();
  });
});

describe("the health route on the metadata session", () => {
  type Mocked = ReturnType<typeof mock>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateMetadataProvider.mockClear();
  });

  afterEach(() => {
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  /** A health request for `connection`, in `catalog` when one is given. */
  function check(connection: Record<string, unknown>, catalog?: string): Promise<Response> {
    const body = catalog === undefined ? { connection } : { connection, catalog };
    return POST(createMockRequest("/api/db/health", { method: "POST", body }) as never);
  }

  test("the health read runs on the connection's metadata session, opened with the editor's connection and posture", async () => {
    const databaseSize = crypto.randomUUID();
    const metadata = createMockProvider({
      health: { databaseSize, cacheHitRatio: "99%", slowQueries: [], activeSessions: [] },
    });
    const editor = createMockProvider();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata);
    mockGetOrCreateProvider.mockImplementation(async () => editor);

    const asAdmin = await check(validConnection);

    expect(asAdmin.status).toBe(200);
    expect(await parseResponseJSON(asAdmin)).toMatchObject({ databaseSize });
    expect(mockGetOrCreateMetadataProvider.mock.calls).toEqual([
      [validConnection, {}, { allowExternalFileAccess: true }],
    ]);

    // The pulse runs for every role, so a user's inline connection reads on its metadata session too, under the
    // user's posture.
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));
    const asUser = await check(validConnection);

    expect(asUser.status).toBe(200);
    expect(mockGetOrCreateMetadataProvider.mock.calls[1]).toEqual([
      validConnection,
      {},
      { allowExternalFileAccess: false },
    ]);
    expect((metadata.getHealth as Mocked).mock.calls).toEqual([[], []]);
    expect(editor.getHealth).not.toHaveBeenCalled();
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("a health read answers while the editor's provider holds every read, without waiting for it", async () => {
    // The editor's provider holds: its health read signals `reached` and settles only when this test rejects it.
    const held = Promise.withResolvers<never>();
    const reached = Promise.withResolvers<"editor held">();
    const editor = createMockProvider();
    (editor.getHealth as Mocked).mockImplementation(() => {
      reached.resolve("editor held");
      return held.promise;
    });
    mockGetOrCreateProvider.mockImplementation(async () => editor);
    const databaseSize = crypto.randomUUID();
    const metadata = createMockProvider({
      health: { databaseSize, cacheHitRatio: "99%", slowQueries: [], activeSessions: [] },
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata);

    const answering = check(validConnection);
    const first = await Promise.race([answering, reached.promise]);
    held.reject(new Error("released by the test"));
    const response = await answering;
    await held.promise.catch(() => undefined);

    expect(first).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await parseResponseJSON(response)).toMatchObject({ databaseSize });
    expect(editor.getHealth).not.toHaveBeenCalled();
  });

  test("a health read's catalog reads on that database's session of the metadata session, and a catalog the connection cannot honour is refused in the editor's provider's words", async () => {
    const serverLevel = { ...validConnection, database: "" };
    const shop = createMockProvider();
    const root = Object.assign(
      createMockProvider({ config: serverLevel as never, capabilities: { catalogSessions: true } }),
      { forCatalog: mock(async (catalog: string) => (catalog === "shop" ? shop : undefined)) },
    );
    mockGetOrCreateMetadataProvider.mockImplementation(async () => root as never);

    const inShop = await check(serverLevel, "shop");

    expect(inShop.status).toBe(200);
    expect(root.forCatalog.mock.calls).toEqual([["shop"]]);
    expect((shop.getHealth as Mocked).mock.calls).toEqual([[]]);
    expect(root.getHealth).not.toHaveBeenCalled();
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();

    // A connection that names its database honours no catalog, on the metadata session as on the editor's.
    const named = createMockProvider({ config: validConnection as never, capabilities: { catalogSessions: true } });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => named);
    mockGetOrCreateProvider.mockImplementation(async () => named);
    const refused = await check(validConnection, "shop");
    const body = await parseResponseJSON<{ error: string }>(refused);
    expect(named.getHealth).not.toHaveBeenCalled();
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();

    const editorRefusal = await editorProvider({ role: "admin" }, validConnection as never, "shop").then(
      () => "no refusal",
      (error: Error) => error.message,
    );
    expect(refused.status).toBe(400);
    expect(body.error).toBe(editorRefusal);
    expect(editorRefusal).toContain('cannot run one in "shop"');
  });
});
