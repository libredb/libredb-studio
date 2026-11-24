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
  PermissionDeniedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { engineFacetsFor } from "@/lib/db/engine-facets";
import { readDeclaredPanels, readPanel } from "@/lib/db/engine-facets/monitoring";
import type { DatabaseProvider, DatabaseType, MonitoringOptions } from "@/lib/db/types";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";

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

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => POST(createMockRequest("/api/db/monitoring", { method: "POST", body: { connection } }) as never);
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryError(`permission denied for ${password}`, "postgres"),
    );
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(400);
    expect(body).toMatchObject({ code: "QUERY_ERROR", error: withheldErrorMessage("QueryError") });
    expect(JSON.stringify(body)).not.toContain(password);

    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockRejectedValueOnce(
      new QueryError("permission denied", "postgres"),
    );
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
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockResolvedValueOnce({
      timestamp: new Date(0),
      overview,
      errors: {
        slowQueries: `permission denied for ${password}`,
        tables: "relation pg_stat_user_tables is not readable",
      },
    });
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

/**
 * What the monitoring route answers today, at the provider's members, which the host core keeps when the route reads the
 * panels through monitoring.panel. The provider answers getMonitoringData as every provider does today,
 * `BaseDatabaseProvider.getMonitoringData`: the declared panels read through `readDeclaredPanels`, a failure of every
 * panel mapped through `mapDatabaseError` for the provider's type. So each pin holds the panel members' calls and
 * answers, and stays true when the host reads them itself.
 */
describe("what the monitoring route answers today, which the host core keeps", () => {
  type Mocked = ReturnType<typeof mock>;
  const members = [
    "getOverview",
    "getPerformanceMetrics",
    "getSlowQueries",
    "getActiveSessions",
    "getTableStats",
    "getIndexStats",
    "getStorageStats",
  ] as const;

  /** A provider of `type` whose getMonitoringData reads its own panel members as every provider does today. */
  function panelProvider(type: DatabaseType): DatabaseProvider {
    const provider = createMockProvider({ type });
    (provider.getMonitoringData as Mocked).mockImplementation(async (options?: MonitoringOptions) =>
      readDeclaredPanels(
        (request) => readPanel(provider, request),
        engineFacetsFor(provider.type).monitoring,
        options ?? {},
        (error) => mapDatabaseError(error, provider.type),
      ),
    );
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

  test("a request the caller left answers 499 with no body, by the error's message, name or code", async () => {
    const byMessage = new Error("aborted");
    const byName = new Error(crypto.randomUUID());
    byName.name = "AbortError";
    const byCode = Object.assign(new Error(crypto.randomUUID()), { code: "ECONNRESET" });

    for (const error of [byMessage, byName, byCode]) {
      const provider = panelProvider("postgres");
      failEvery(provider, error);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const res = await send(provider, "postgres");
      expect(res.status).toBe(499);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect(await res.text()).toBe("");
    }
  });
});
