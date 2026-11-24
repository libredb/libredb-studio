import { describe, test, expect, mock, beforeEach, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
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
  PermissionDeniedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import type { DatabaseProvider, DatabaseType, MonitoringOptions } from "@/lib/db/types";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { PanelRecord } from "@/lib/provider-host/core/monitoring";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";

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
  mapDatabaseError,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/monitoring/route");

// The route reads every panel through the process's host core (src/lib/provider-host/instance.ts), so this file
// composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

type Mocked = ReturnType<typeof mock>;

/** The seven panel members of a provider. */
const PANEL_MEMBERS = [
  "getOverview",
  "getPerformanceMetrics",
  "getSlowQueries",
  "getActiveSessions",
  "getTableStats",
  "getIndexStats",
  "getStorageStats",
] as const;

/** The panels in the dashboard's order, each read by the member at the same place in `PANEL_MEMBERS`. */
const MONITORING_ORDER = [
  "overview",
  "performance",
  "slowQueries",
  "activeSessions",
  "tables",
  "indexes",
  "storage",
] as const;

/** Every panel member of `provider` rejects once with `error`, as a provider whose every read fails. */
function failEveryOnce(provider: DatabaseProvider, error: unknown): void {
  for (const member of PANEL_MEMBERS) (provider[member] as Mocked).mockRejectedValueOnce(error);
}

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
    for (const member of PANEL_MEMBERS) (mockProvider[member] as Mocked).mockReset();
    (mockProvider.getOverview as Mocked).mockImplementation(async () => ({
      version: "PostgreSQL 16.1",
      uptime: "10 days",
      activeConnections: 5,
      maxConnections: 100,
      databaseSize: "256 MB",
      databaseSizeBytes: 268435456,
      tableCount: 15,
      indexCount: 30,
    }));
    (mockProvider.getPerformanceMetrics as Mocked).mockImplementation(async () => ({
      cacheHitRatio: 99.2,
      transactionsPerSecond: 120,
      queriesPerSecond: 350,
      bufferPoolUsage: 45.5,
      deadlocks: 0,
    }));
    for (const member of PANEL_MEMBERS.slice(2)) (mockProvider[member] as Mocked).mockImplementation(async () => []);
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

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => POST(createMockRequest("/api/db/monitoring", { method: "POST", body: { connection } }) as never);
    failEveryOnce(mockProvider, new QueryError(`permission denied for ${password}`, "postgres"));
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(400);
    expect(body).toMatchObject({ code: "QUERY_ERROR", error: withheldErrorMessage("QueryError") });
    expect(JSON.stringify(body)).not.toContain(password);

    failEveryOnce(mockProvider, new QueryError("permission denied", "postgres"));
    const clean = await send();
    expect(clean.status).toBe(400);
    expect(await parseResponseJSON(clean)).toMatchObject({ code: "QUERY_ERROR", error: "permission denied" });
  });

  test("a panel error that holds the connection's credential answers the withheld sentence, and the clean panel errors and the figures as the provider answered them", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const overview = {
      version: "PostgreSQL 16.1",
      uptime: "10 days",
      activeConnections: 5,
      maxConnections: 100,
      databaseSize: "256 MB",
      databaseSizeBytes: 268435456,
      tableCount: 15,
      indexCount: 30,
    };
    (mockProvider.getOverview as Mocked).mockResolvedValueOnce(overview);
    (mockProvider.getSlowQueries as Mocked).mockRejectedValueOnce(new Error(`permission denied for ${password}`));
    (mockProvider.getTableStats as Mocked).mockRejectedValueOnce(
      new Error("relation pg_stat_user_tables is not readable"),
    );
    const res = await POST(createMockRequest("/api/db/monitoring", { method: "POST", body: { connection } }) as never);
    const body = await parseResponseJSON<Record<string, unknown>>(res);
    expect(res.status).toBe(200);
    expect(body.errors).toEqual({
      slowQueries: PROVIDER_TEXT_WITHHELD,
      tables: "relation pg_stat_user_tables is not readable",
    });
    expect(body.overview).toEqual(overview);
    expect(JSON.stringify(body)).not.toContain(password);
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

  test("a provider error with the code ECONNRESET answers by its class, not as a request the caller left", async () => {
    const words = crypto.randomUUID();
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw Object.assign(new Error(words), { code: "ECONNRESET" });
    });

    const res = await POST(
      createMockRequest("/api/db/monitoring", { method: "POST", body: { connection: validConnection } }) as never,
    );

    expect(res.status).toBe(500);
    expect(await parseResponseJSON(res)).toMatchObject({ error: words, code: "INTERNAL_ERROR" });
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

/**
 * What the monitoring route answered at the provider's members before it read the panels through monitoring.panel, which
 * the host core keeps. The route reads the declared panels through `readDeclaredPanels` over the host core's panel
 * calls, a failure of every panel mapped through `mapDatabaseError` for the provider's type, as
 * `BaseDatabaseProvider.getMonitoringData` does, and never calls the provider's `getMonitoringData`. So each pin holds
 * the panel members' calls and answers.
 */
describe("what the monitoring route answers today, which the host core keeps", () => {
  const members = [
    "getOverview",
    "getPerformanceMetrics",
    "getSlowQueries",
    "getActiveSessions",
    "getTableStats",
    "getIndexStats",
    "getStorageStats",
  ] as const;

  /** Every provider each pin built, so the describe can hold that the route never called its getMonitoringData. */
  const built: DatabaseProvider[] = [];

  /** A provider of `type` whose panel members answer, the host reading them through the bridge. */
  function panelProvider(type: DatabaseType): DatabaseProvider {
    const provider = createMockProvider({ type });
    built.push(provider);
    return provider;
  }

  /** Every panel member of `provider` rejects with `error`. */
  function failEvery(provider: DatabaseProvider, error: unknown): void {
    for (const member of members) (provider[member] as Mocked).mockImplementation(async () => Promise.reject(error));
  }

  async function send(provider: DatabaseProvider, type: DatabaseType, options?: MonitoringOptions) {
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    const connection = { ...validConnection, type };
    const body = options === undefined ? { connection } : { connection, options };
    return POST(createMockRequest("/api/db/monitoring", { method: "POST", body }) as never);
  }

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  afterEach(() => {
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    for (const provider of built.splice(0)) expect(provider.getMonitoringData).not.toHaveBeenCalled();
  });

  test("each panel the engine offers and the request asks is read once from its own member with the request's limits and schema, and a panel it does not offer is never read", async () => {
    const schema = `schema_${crypto.randomUUID()}`;
    const provider = panelProvider("postgres");
    const asked = await send(provider, "postgres", {
      slowQueryLimit: 7,
      sessionLimit: 13,
      schemaFilter: schema,
      includeStorage: false,
    });

    expect(asked.status).toBe(200);
    for (const member of ["getOverview", "getPerformanceMetrics"] as const) {
      expect((provider[member] as Mocked).mock.calls).toEqual([[]]);
    }
    expect((provider.getSlowQueries as Mocked).mock.calls).toEqual([[{ limit: 7 }]]);
    expect((provider.getActiveSessions as Mocked).mock.calls).toEqual([[{ limit: 13 }]]);
    expect((provider.getTableStats as Mocked).mock.calls).toEqual([[{ schema }]]);
    expect((provider.getIndexStats as Mocked).mock.calls).toEqual([[{ schema }]]);
    expect(provider.getStorageStats).not.toHaveBeenCalled();

    // With no options: the limits 10 and 50, and a schema key that is present and undefined, every user schema.
    const defaults = panelProvider("postgres");
    expect((await send(defaults, "postgres")).status).toBe(200);
    expect((defaults.getSlowQueries as Mocked).mock.calls).toEqual([[{ limit: 10 }]]);
    expect((defaults.getActiveSessions as Mocked).mock.calls).toEqual([[{ limit: 50 }]]);
    for (const member of ["getTableStats", "getIndexStats"] as const) {
      const [[argument]] = (defaults[member] as Mocked).mock.calls as [[Record<string, unknown>]];
      expect(Object.keys(argument)).toEqual(["schema"]);
      expect(argument.schema).toBeUndefined();
    }
    expect((defaults.getStorageStats as Mocked).mock.calls).toEqual([[]]);

    // Cassandra's row declares the slow queries, the tables, the indexes and the storage not offered.
    const cassandra = panelProvider("cassandra");
    const narrow = await send(cassandra, "cassandra");
    const body = await parseResponseJSON<Record<string, unknown>>(narrow);
    expect(narrow.status).toBe(200);
    for (const member of ["getSlowQueries", "getTableStats", "getIndexStats", "getStorageStats"] as const) {
      expect(cassandra[member]).not.toHaveBeenCalled();
    }
    expect((cassandra.getOverview as Mocked).mock.calls).toEqual([[]]);
    expect((cassandra.getPerformanceMetrics as Mocked).mock.calls).toEqual([[]]);
    expect((cassandra.getActiveSessions as Mocked).mock.calls).toEqual([[{ limit: 50 }]]);
    expect(body.notOffered).toEqual(["slowQueries", "tables", "indexes", "storage"]);
    expect(Object.keys(body).sort()).toEqual([
      "activeSessions",
      "maintenance",
      "notOffered",
      "overview",
      "performance",
      "timestamp",
    ]);
  });

  test("the payload is the panels' answers, the engine's sentence for a failed panel, the panels not offered and the connected provider's maintenance", async () => {
    const provider = panelProvider("postgres");
    const sentence = `relation ${crypto.randomUUID()} is not readable`;
    const answers = {
      overview: {
        version: crypto.randomUUID(),
        uptime: "3 days",
        startTime: new Date(1_700_000_000_000),
        maxConnections: 100,
        databaseSize: "8 MB",
        tableCount: 2,
        indexCount: 1,
      },
      performance: { cacheHitRatio: 99.5, cacheHitAdvice: crypto.randomUUID() },
      slowQueries: [{ query: crypto.randomUUID(), calls: 3, totalTime: 30, avgTime: 10, rows: 3 }],
      activeSessions: [
        {
          pid: 4711,
          user: "app",
          database: "orders",
          state: "active",
          activity: "active",
          query: crypto.randomUUID(),
          queryStart: new Date(1_700_000_001_000),
          duration: "1s",
          durationMs: 1000,
        },
      ],
      indexes: [
        {
          schemaName: "public",
          tableName: "orders",
          indexName: "orders_pkey",
          columns: ["id"],
          isUnique: true,
          isPrimary: true,
          indexSize: "8 kB",
          scans: 3,
        },
      ],
      storage: [{ name: "pg_default", size: "8 MB", sizeBytes: 8_388_608 }],
    };
    (provider.getOverview as Mocked).mockImplementation(async () => answers.overview);
    (provider.getPerformanceMetrics as Mocked).mockImplementation(async () => answers.performance);
    (provider.getSlowQueries as Mocked).mockImplementation(async () => answers.slowQueries);
    (provider.getActiveSessions as Mocked).mockImplementation(async () => answers.activeSessions);
    (provider.getTableStats as Mocked).mockImplementation(async () => Promise.reject(new Error(sentence)));
    (provider.getIndexStats as Mocked).mockImplementation(async () => answers.indexes);
    (provider.getStorageStats as Mocked).mockImplementation(async () => answers.storage);
    (provider.getCapabilities as Mocked).mockImplementation(() => ({
      maintenanceOperations: ["vacuum"],
      maintenanceOperationSpecs: { vacuum: { label: "Vacuum", perEntity: true, global: true } },
    }));

    const res = await send(provider, "postgres");
    const body = await parseResponseJSON<Record<string, unknown>>(res);
    const { timestamp, ...rest } = body;

    expect(res.status).toBe(200);
    expect(typeof timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(timestamp as string))).toBe(false);
    expect(rest).toEqual({
      ...JSON.parse(JSON.stringify(answers)),
      errors: { tables: sentence },
      notOffered: [],
      maintenance: {
        maintenanceOperations: ["vacuum"],
        maintenanceOperationSpecs: { vacuum: { label: "Vacuum", perEntity: true, global: true } },
      },
    });
    expect(provider.getCapabilities).toHaveBeenCalledTimes(1);
  });

  test("a dashboard whose every panel fails answers the first panel's error by its class, and several sentences answer one database error naming each", async () => {
    const sentence = `connection to ${crypto.randomUUID()} refused`;
    const connectionFailure = panelProvider("postgres");
    failEvery(connectionFailure, new ConnectionError(sentence, "postgres", "localhost", 5432));
    const one = await send(connectionFailure, "postgres");

    expect(one.status).toBe(503);
    expect(await parseResponseJSON(one)).toEqual({
      error: sentence,
      code: "CONNECTION_ERROR",
      statusCode: 503,
      retryable: true,
      kind: "connection",
      outcome: "unknown",
    });

    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    const several = panelProvider("postgres");
    failEvery(several, new Error(first));
    (several.getStorageStats as Mocked).mockImplementation(async () => Promise.reject(new Error(second)));
    const joined = await send(several, "postgres");

    expect(joined.status).toBe(500);
    expect(await parseResponseJSON(joined)).toEqual({
      error: `${first}; ${second}`,
      code: "DATABASE_ERROR",
      statusCode: 500,
      kind: "database",
      outcome: "unknown",
    });
  });

  test("a monitoring read's Studio error answers by its class, with its code, kind and outcome", async () => {
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
      const provider = panelProvider("postgres");
      failEvery(provider, error);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const res = await send(provider, "postgres");
      expect([error.name, res.status]).toEqual([error.name, status]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await parseResponseJSON(res)).toEqual({ ...expected, statusCode: status, outcome: "unknown" });
    }
  });

  test("a provider error that reads like an abort answers by its class, and only the request's own signal answers 499", async () => {
    const byMessage = new Error("aborted");
    const byName = new Error(crypto.randomUUID());
    byName.name = "AbortError";
    const byCode = Object.assign(new Error(crypto.randomUUID()), { code: "ECONNRESET" });

    for (const error of [byMessage, byName, byCode]) {
      const provider = panelProvider("postgres");
      failEvery(provider, error);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const res = await send(provider, "postgres");
      expect([error.message, res.status]).toEqual([error.message, 500]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const body = await parseResponseJSON<Record<string, unknown>>(res);
      expect(body).toMatchObject({ error: error.message, code: "INTERNAL_ERROR" });
      expect(body.kind).toBeUndefined();
    }

    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const left = await POST(
      new Request("http://localhost:3000/api/db/monitoring", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: validConnection }),
        signal: caller.signal,
      }) as never,
    );
    expect(left.status).toBe(499);
    expect(await parseResponseJSON(left)).toMatchObject({ code: "QUERY_CANCELLED" });
  });
});

describe("the monitoring route on the host core", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockResolveConnection.mockClear();
    mockGetOrCreateProvider.mockClear();
  });

  afterEach(() => {
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
  });

  /** A monitoring request for `provider`, whose signal is `signal`, as a browser that may leave sends it. */
  function monitoringWith(provider: DatabaseProvider, signal?: AbortSignal, options?: unknown): Promise<Response> {
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    return POST(
      new Request("http://localhost:3000/api/db/monitoring", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          options === undefined ? { connection: validConnection } : { connection: validConnection, options },
        ),
        ...(signal === undefined ? {} : { signal }),
      }) as never,
    );
  }

  /** Runs `body` with `make(real)` installed in place of the real core, then puts the real one back. */
  async function withCore<T>(make: (real: HostCore) => HostCore, body: () => Promise<T>): Promise<T> {
    const real = hostCore();
    forgetHostCore();
    installHostCore(make(real), "test");
    try {
      return await body();
    } finally {
      forgetHostCore();
      installHostCore(real, "test");
    }
  }

  const DEADLINE_SENTENCE =
    "A monitoring panel read did not answer within the statement timeout of 60 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.";
  const stoppedRecord = (): PanelRecord => ({
    kind: "stopped",
    reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
    settled: Promise.resolve(),
  });

  test("the route reads every panel through the host core and never the provider's getMonitoringData", async () => {
    const provider = createMockProvider();
    const panels: string[] = [];
    const res = await withCore(
      (real) => ({
        ...real,
        panelCall: (session, request, ctx, ports) => {
          panels.push(request.panel);
          return real.panelCall(session, request, ctx, ports);
        },
      }),
      () => monitoringWith(provider),
    );

    expect(res.status).toBe(200);
    expect(panels).toEqual([...PANEL_MEMBERS.keys()].map((at) => MONITORING_ORDER[at]));
    expect(provider.getMonitoringData).not.toHaveBeenCalled();
    for (const member of PANEL_MEMBERS) expect((provider[member] as Mocked).mock.calls).toHaveLength(1);
  });

  test("a dashboard whose request leaves while its panels are read answers 499 at once, outcome unknown", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const provider = createMockProvider();
    const pending = Promise.withResolvers<never>();
    const reached = Promise.withResolvers<void>();
    let calls = 0;
    for (const member of PANEL_MEMBERS) {
      (provider[member] as Mocked).mockImplementation(() => {
        calls += 1;
        if (calls === PANEL_MEMBERS.length) reached.resolve();
        return pending.promise;
      });
    }
    const caller = new AbortController();
    try {
      const answering = monitoringWith(provider, caller.signal);
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

  test("a dashboard whose request is already gone answers 499 not-sent and reads no panel", async () => {
    const provider = createMockProvider();
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const response = await monitoringWith(provider, caller.signal);

    expect(response.status).toBe(499);
    expect(await parseResponseJSON(response)).toMatchObject({ code: "QUERY_CANCELLED", outcome: "not-sent" });
    for (const member of PANEL_MEMBERS) expect(provider[member]).not.toHaveBeenCalled();
  });

  test("a dashboard past its deadline answers 504 studio-timeout-refusal, and a panel stopped beside answered ones carries the sentence in errors", async () => {
    const provider = createMockProvider();
    const every = await withCore(
      (real) => ({ ...real, panelCall: async () => stoppedRecord() }),
      () => monitoringWith(provider),
    );
    const body = await parseResponseJSON<Record<string, unknown>>(every);

    expect(every.status).toBe(504);
    expect(body).toMatchObject({ code: "TIMEOUT_ERROR", kind: "studio-timeout-refusal", outcome: "unknown" });
    expect(body.error).toBe(DEADLINE_SENTENCE);

    const one = await withCore(
      (real) => ({
        ...real,
        panelCall: (session, request, ctx, ports) =>
          request.panel === "storage" ? Promise.resolve(stoppedRecord()) : real.panelCall(session, request, ctx, ports),
      }),
      () => monitoringWith(provider),
    );
    const partial = await parseResponseJSON<Record<string, unknown>>(one);

    expect(one.status).toBe(200);
    expect(partial.errors).toEqual({ storage: DEADLINE_SENTENCE });
    expect(partial.overview).toBeDefined();
  });

  test("options with a limit that is not a whole number of at least 1, or a schema filter that is not text naming a schema, are refused by name before any connection resolves", async () => {
    const provider = createMockProvider();
    const cases: [Record<string, unknown>, string][] = [
      [{ slowQueryLimit: 0 }, "options.slowQueryLimit must be a whole number of at least 1"],
      [{ slowQueryLimit: "10" }, "options.slowQueryLimit must be a whole number of at least 1"],
      [{ sessionLimit: 1.5 }, "options.sessionLimit must be a whole number of at least 1"],
      [{ sessionLimit: null }, "options.sessionLimit must be a whole number of at least 1"],
      [{ schemaFilter: "" }, "options.schemaFilter must name a schema, as text that is not empty"],
      [{ schemaFilter: 7 }, "options.schemaFilter must name a schema, as text that is not empty"],
    ];

    for (const [options, sentence] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own option's.
      const res = await monitoringWith(provider, undefined, options);
      expect([options, res.status]).toEqual([options, 400]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await parseResponseJSON(res)).toEqual({ error: sentence });
    }
    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    for (const member of PANEL_MEMBERS) expect(provider[member]).not.toHaveBeenCalled();
  });

  test("a panel answer whose form is not the requested panel's fails that panel by name", async () => {
    const provider = createMockProvider();
    const res = await withCore(
      (real) => ({
        ...real,
        panelCall: async (session, request, ctx, ports) =>
          request.panel === "tables"
            ? { kind: "answered", answer: { indexes: [] } }
            : real.panelCall(session, request, ctx, ports),
      }),
      () => monitoringWith(provider),
    );
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.errors).toEqual({
      tables:
        "The tables panel read answered a form other than the tables panel's, which is a defect of the session that answered it.",
    });
    expect(body.indexes).toEqual([]);
    expect(body.tables).toBeUndefined();
  });
});
