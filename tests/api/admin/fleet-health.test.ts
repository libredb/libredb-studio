import { describe, test, expect, mock, beforeEach, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { editorEntryOf } from "../../helpers/editor-session-entry";
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
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { withheldErrorMessage } from "@/lib/db/operations/provider-text";
import type { DatabaseOverview, DatabaseProvider, HealthInfo } from "@/lib/db/types";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { HealthRecord, PanelRecord } from "@/lib/provider-host/core/monitoring";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);
/**
 * The metadata session each row's health and overview are read on (docs/providers/CONTRACT.md, clause C-66), answered
 * by default with the same `mockProvider`, so a title written against the provider the route opens passes unchanged.
 * The route opens it through `getOrCreateMetadataSession`, whose stand-in in the factory's mock below answers the
 * entry a legacy record's open answers for the provider this stand-in answers with the same arguments; the editor's
 * stand-in in the barrel's mock is never called.
 */
const mockGetOrCreateMetadataProvider = mock<(...args: unknown[]) => Promise<DatabaseProvider>>(
  async () => mockProvider,
);
// The declarations the route reads capabilities from, the provider-meta pattern: data read off a provider.
const declarationsOf = (provider: ReturnType<typeof createMockProvider>) => ({
  capabilities: provider.getCapabilities(),
  labels: provider.getLabels(),
  supportsQueryCancel: false,
});
const mockReadProviderDeclarations = mock<(conn: { id: string }) => Promise<ReturnType<typeof declarationsOf>>>(
  async () => declarationsOf(mockProvider),
);
const { readProviderDeclarations: realReadProviderDeclarations } = await import("@/lib/db/factory");
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
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

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  readProviderDeclarations: mockReadProviderDeclarations,
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
mock.module("@/lib/db/factory", () => ({
  // src/lib/api/editor-provider.ts imports it, and the route loads that module; this route reads no cached entry.
  findCachedEditorEntry: mock(() => null),
  // src/lib/api/editor-provider.ts imports it, and the route loads that module; this route opens no editor session.
  getOrCreateEditorSession: mock(async () => {
    throw new Error("getOrCreateEditorSession is not read by this route");
  }),
  getOrCreateMetadataSession: async (connection: unknown, _engine: unknown, execution: unknown) =>
    editorEntryOf(await mockGetOrCreateMetadataProvider(connection, {}, execution)),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/admin/fleet-health/route");

// The route reads health and the overview through the process's host core (src/lib/provider-host/instance.ts), so
// this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

// ─── Fixtures ───────────────────────────────────────────────────────────────
const connections = [
  {
    id: "conn-1",
    name: "Production DB",
    type: "postgres",
    host: "prod.example.com",
    port: 5432,
    database: "prod",
    createdAt: new Date(),
  },
  {
    id: "conn-2",
    name: "Staging DB",
    type: "mysql",
    host: "staging.example.com",
    port: 3306,
    database: "staging",
    createdAt: new Date(),
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/admin/fleet-health", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateMetadataProvider.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
    mockReadProviderDeclarations.mockClear();
    mockReadProviderDeclarations.mockImplementation(async () => declarationsOf(mockProvider));
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();
  });

  test("returns health results for all connections as admin", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; connectionName: string; status: string; latencyMs: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toBeArray();
    expect(data.results.length).toBe(2);
    expect(data.results[0].connectionId).toBe("conn-1");
    expect(data.results[0].connectionName).toBe("Production DB");
    expect(data.results[0].status).toBe("healthy");
    expect(data.results[0].latencyMs).toBeDefined();
  });

  // Issue #540: the fleet total used to re-parse `databaseSize`'s display string, which had no
  // "tb" branch and counted a 1 TB database as 1 byte. The route now projects the provider's own
  // byte figure from getOverview() instead, so the dashboard never has to parse a string at all.
  test("carries the provider's byte figure from getOverview alongside the display string", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; databaseSize?: string; databaseSizeBytes?: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].databaseSize).toBe("256 MB");
    expect(data.results[0].databaseSizeBytes).toBe(268435456);
  });

  test("omits databaseSizeBytes, not a fabricated 0, when the provider publishes no byte figure", async () => {
    const noByteProvider = createMockProvider({
      overview: {
        version: "Cassandra 4.1",
        uptime: "10 days",
        maxConnections: 100,
        databaseSize: "1 MiB",
        tableCount: 5,
        indexCount: 2,
      },
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => noByteProvider);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [connections[0]] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { databaseSizeBytes?: number }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].databaseSizeBytes).toBeUndefined();
  });

  test("a getOverview failure omits the byte figure without turning a healthy connection into an error", async () => {
    const throwingProvider = createMockProvider();
    (throwingProvider.getOverview as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("overview query timed out");
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => throwingProvider);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [connections[0]] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { status: string; databaseSizeBytes?: number }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].status).toBe("healthy");
    expect(data.results[0].databaseSizeBytes).toBeUndefined();
  });

  test("an engine that offers the overview but not table statistics is asked for it once and carries its byte figure", async () => {
    expect(ENGINE_FACETS.kafka.monitoring.overview).toBe("offered");
    expect(ENGINE_FACETS.kafka.monitoring.tables).toBe("not-offered");
    const kafkaProvider = createMockProvider({ type: "kafka" });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => kafkaProvider);
    const kafka = {
      id: "conn-kafka",
      name: "Events",
      type: "kafka",
      host: "broker.example.com",
      port: 9092,
      database: "",
      createdAt: new Date(),
    };

    const req = createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections: [kafka] } });
    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { databaseSizeBytes?: number }[] }>(res);

    expect(res.status).toBe(200);
    expect(kafkaProvider.getOverview).toHaveBeenCalledTimes(1);
    expect(data.results[0].databaseSizeBytes).toBe(268435456);
  });

  test("an engine that does not offer the overview panel is never asked for it, and its row carries no byte figure", async () => {
    const s3Provider = createMockProvider({ type: "s3" });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => s3Provider);
    const s3 = {
      id: "conn-s3",
      name: "Objects",
      type: "s3",
      host: "objects.example.com",
      port: 9000,
      database: "",
      createdAt: new Date(),
    };

    const req = createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections: [s3] } });
    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { status: string; databaseSizeBytes?: number }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0].status).toBe("healthy");
    expect(s3Provider.getHealth).toHaveBeenCalledTimes(1);
    expect(s3Provider.getOverview).not.toHaveBeenCalled();
    expect("databaseSizeBytes" in data.results[0]).toBe(false);
  });

  test("returns 403 for non-admin user", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain("Unauthorized");
  });

  // Guarded by guardRoute now: an unauthenticated caller is rejected at the session check,
  // before the route's own admin-role check ever runs, so this is 401 ("not authenticated"),
  // distinct from "returns 403 for non-admin user" above ("authenticated but forbidden").
  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns 400 when connections is missing", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: {},
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("connections");
  });

  test("connection error results in error status for that item", async () => {
    let callCount = 0;
    mockGetOrCreateMetadataProvider.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Connection refused");
      }
      return mockProvider;
    });

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; status: string; error?: string }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results.length).toBe(2);
    const errorItem = data.results.find((r) => r.status === "error");
    expect(errorItem).toBeDefined();
    expect(errorItem!.error).toContain("Connection refused");
  });

  test("an item whose check fails with an error holding its connection's credential answers the withheld sentence, and the other items are unchanged", async () => {
    const password = crypto.randomUUID();
    const failing = (error: Error) => {
      const provider = createMockProvider();
      (provider.getHealth as ReturnType<typeof mock>).mockRejectedValue(error);
      return provider;
    };
    const providers: Record<string, ReturnType<typeof createMockProvider>> = {
      "conn-1": failing(new ConnectionError(`could not connect as ${password}`, "postgres")),
      "conn-2": mockProvider,
      "conn-3": failing(new ConnectionError("could not connect", "postgres")),
    };
    mockGetOrCreateMetadataProvider.mockImplementation(
      (async (resolved: { id: string }) => providers[resolved.id]) as never,
    );
    const items = [
      { ...connections[0], password },
      connections[1],
      { ...connections[0], id: "conn-3", name: "Reporting DB", password: password },
    ];

    const res = await POST(
      createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections: items } }),
    );
    const data = await parseResponseJSON<{ results: { connectionId: string; status: string; error?: string }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results.map(({ connectionId, status, error }) => ({ connectionId, status, error }))).toEqual([
      { connectionId: "conn-1", status: "error", error: withheldErrorMessage("ConnectionError") },
      { connectionId: "conn-2", status: "healthy", error: undefined },
      { connectionId: "conn-3", status: "error", error: "could not connect" },
    ]);
    expect(JSON.stringify(data)).not.toContain(password);
  });

  test("an item whose check throws a value that is not an Error answers Connection failed", async () => {
    mockGetOrCreateMetadataProvider.mockImplementation((async (resolved: { id: string }) => {
      if (resolved.id !== "conn-1") return mockProvider;
      const provider = createMockProvider();
      (provider.getHealth as ReturnType<typeof mock>).mockRejectedValue("socket closed");
      return provider;
    }) as never);

    const res = await POST(createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections } }));
    const data = await parseResponseJSON<{ results: { connectionId: string; status: string; error?: string }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0]).toMatchObject({ connectionId: "conn-1", status: "error", error: "Connection failed" });
    expect(data.results[1]).toMatchObject({ connectionId: "conn-2", status: "healthy" });
  });

  test("invalid JSON body returns 500", async () => {
    const req = new Request("http://localhost:3000/api/admin/fleet-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-valid-json{{{",
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  // ALLOW_CUSTOM_CONNECTIONS off: a connection the caller supplied is refused by resolveConnection
  // before the factory is reached, and the refusal is reported as that item's error.
  test("reports a connection of the caller's own as refused, and builds nothing, while custom connections are off", async () => {
    process.env.ALLOW_CUSTOM_CONNECTIONS = "false";
    try {
      const req = createMockRequest("/api/admin/fleet-health", {
        method: "POST",
        body: { connections: [connections[0]] },
      });

      const res = await POST(req);
      const data = await parseResponseJSON<{
        results: { connectionId: string; status: string; error?: string }[];
      }>(res);

      expect(res.status).toBe(200);
      expect(data.results).toEqual([
        expect.objectContaining({
          connectionId: "conn-1",
          status: "error",
          error: "Custom connections are disabled on this server",
        }),
      ]);
      expect(mockGetOrCreateMetadataProvider).not.toHaveBeenCalled();
    } finally {
      delete process.env.ALLOW_CUSTOM_CONNECTIONS;
    }
  });

  test("empty connections array returns empty results", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: unknown[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toBeArray();
    expect(data.results.length).toBe(0);
  });
});

// ─── Billed compute ─────────────────────────────────────────────────────────
// A connection whose provider declares `resumesBilledCompute` (a Databend Cloud warehouse) wakes
// on any statement and is charged until it suspends again, so a fleet check every 60 s would keep
// it awake for as long as the dashboard is open. The route reads the declaration off an unconnected
// provider and answers that row `not-checked`, building no cached provider and sending nothing.
describe("POST /api/admin/fleet-health billed compute", () => {
  const billed = {
    id: "conn-billed",
    name: "Cloud Warehouse",
    type: "postgres",
    host: "warehouse.example.com",
    port: 443,
    database: "default",
    environment: "production",
    createdAt: new Date(),
  };

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateMetadataProvider.mockClear();
    mockReadProviderDeclarations.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  test("a resumesBilledCompute connection is answered not-checked, with no cached provider and no statement", async () => {
    const billedProvider = createMockProvider({ capabilities: { resumesBilledCompute: true } });
    const controlProvider = createMockProvider();
    mockReadProviderDeclarations.mockImplementation(async (conn) =>
      declarationsOf(conn.id === billed.id ? billedProvider : createMockProvider()),
    );
    mockGetOrCreateMetadataProvider.mockImplementation(async () => controlProvider);

    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: [billed, connections[0]] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: Record<string, unknown>[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results[0]).toEqual({
      connectionId: "conn-billed",
      connectionName: "Cloud Warehouse",
      type: "postgres",
      environment: "production",
      status: "not-checked",
      latencyMs: 0,
    });
    // Nothing was opened, cached or sent for the billed connection.
    expect(billedProvider.connect).not.toHaveBeenCalled();
    expect(billedProvider.query).not.toHaveBeenCalled();
    expect(billedProvider.getHealth).not.toHaveBeenCalled();
    expect(billedProvider.getOverview).not.toHaveBeenCalled();
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(1);
    expect((mockGetOrCreateMetadataProvider.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe("conn-1");

    // The control connection beside it is checked as before.
    expect(data.results[1].connectionId).toBe("conn-1");
    expect(data.results[1].status).toBe("healthy");
    expect(controlProvider.getHealth).toHaveBeenCalledTimes(1);
  });

  test("a tunnelled connection's declarations are read without opening its tunnel (FND-2 slice 5)", async () => {
    mockReadProviderDeclarations.mockImplementationOnce(realReadProviderDeclarations as never);
    const tunnelled = {
      ...connections[0],
      id: "conn-tunnelled",
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "jump", authMethod: "password" },
    };

    const res = await POST(
      createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections: [tunnelled] } }),
    );
    const data = await parseResponseJSON<{ results: { connectionId: string; status: string }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toMatchObject([{ connectionId: "conn-tunnelled", status: "healthy" }]);
    expect(mockReadProviderDeclarations).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(1);
  });

  test("other connections are checked as before", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: { status: string }[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results.map((r) => r.status)).toEqual(["healthy", "healthy"]);
    expect(mockReadProviderDeclarations).toHaveBeenCalledTimes(2);
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(2);
  });
});

// ─── Fan-out width ──────────────────────────────────────────────────────────
// Threat: guardRoute bounds how OFTEN this route may be called, never how WIDE one call fans out.
// Before the cap, a single admin-authenticated POST naming an arbitrarily long connections array
// opened that many provider connections concurrently and the rate limiter saw one request.
describe("POST /api/admin/fleet-health fan-out cap", () => {
  function fleet(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `conn-${i}`,
      name: `DB ${i}`,
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "db",
      createdAt: new Date(),
    }));
  }

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateMetadataProvider.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  test("returns 400 above the cap, names the bound, and opens nothing", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: fleet(101) },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("100");
    expect(mockGetOrCreateMetadataProvider).not.toHaveBeenCalled();
  });

  test("accepts exactly the cap", async () => {
    const req = createMockRequest("/api/admin/fleet-health", {
      method: "POST",
      body: { connections: fleet(100) },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ results: unknown[] }>(res);

    expect(res.status).toBe(200);
    expect(data.results.length).toBe(100);
  });
});

// The role denial's audit line is asserted in tests/security/route-auth.test.ts, not here: this
// file's process neighbours mock @/lib/audit process-wide (tests/api/db/maintenance.test.ts among
// them), so an assertion on the authoritative stdout line would read whichever mock happened to
// win the module registry. Nothing under tests/security mocks that module.

/**
 * What fleet health answers today, at the provider's own `getHealth` and `getOverview`, which the host core keeps when
 * the route reads them through the health call and monitoring.panel. `Date.now` reads a clock the test owns, which only
 * the health read advances, so a row's latency is the advance and no timer is awaited.
 */
describe("what fleet health answers today, which the host core keeps", () => {
  type Mocked = ReturnType<typeof mock>;
  let clock = 1_700_000_000_000;
  let now: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockReadProviderDeclarations.mockImplementation(async () => declarationsOf(mockProvider));
    now = spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    now.mockRestore();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  const health: HealthInfo = {
    activeConnections: 7,
    databaseSize: "8 MB",
    cacheHitRatio: "99%",
    slowQueries: [],
    activeSessions: [],
  };

  /** A provider whose health read advances the test's clock by `advance` ms, then answers `answer`. */
  function timedProvider(advance: number, answer: () => Promise<HealthInfo>) {
    const provider = createMockProvider();
    (provider.getHealth as Mocked).mockImplementation(async () => {
      clock += advance;
      return answer();
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => provider);
    return provider;
  }

  async function rowOf(): Promise<Record<string, unknown>> {
    const res = await POST(
      createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections: [connections[0]] } }),
    );
    expect(res.status).toBe(200);
    const data = await parseResponseJSON<{ results: Record<string, unknown>[] }>(res);
    expect(data.results).toHaveLength(1);
    return data.results[0] as Record<string, unknown>;
  }

  test("a row is healthy up to 5,000 ms of health latency and degraded past it", async () => {
    timedProvider(5000, async () => health);
    const atBound = await rowOf();
    timedProvider(5001, async () => health);
    const past = await rowOf();

    expect([atBound.status, atBound.latencyMs]).toEqual(["healthy", 5000]);
    expect([past.status, past.latencyMs]).toEqual(["degraded", 5001]);
  });

  test("a row carries the health read's connection count and size, and the overview's byte figure where the engine offers the overview", async () => {
    const databaseSize = crypto.randomUUID();
    const overview: DatabaseOverview = {
      version: crypto.randomUUID(),
      uptime: "3 days",
      maxConnections: 100,
      databaseSize,
      databaseSizeBytes: 8_388_608,
      tableCount: 2,
      indexCount: 1,
    };
    const provider = timedProvider(12, async () => ({ ...health, databaseSize }));
    (provider.getOverview as Mocked).mockImplementation(async () => overview);

    const row = await rowOf();

    expect((provider.getHealth as Mocked).mock.calls).toEqual([[]]);
    expect((provider.getOverview as Mocked).mock.calls).toEqual([[]]);
    expect(row).toEqual({
      connectionId: "conn-1",
      connectionName: "Production DB",
      type: "postgres",
      status: "healthy",
      latencyMs: 12,
      activeConnections: 7,
      databaseSize,
      databaseSizeBytes: 8_388_608,
    });
  });

  test("a row whose health read fails answers error with the error's sentence and the time it took", async () => {
    const sentence = `connection to ${crypto.randomUUID()} refused`;
    const provider = timedProvider(1234, async () => {
      throw new ConnectionError(sentence, "postgres", "localhost", 5432);
    });

    const row = await rowOf();

    expect(row).toEqual({
      connectionId: "conn-1",
      connectionName: "Production DB",
      type: "postgres",
      status: "error",
      latencyMs: 1234,
      error: sentence,
    });
    expect(provider.getOverview).not.toHaveBeenCalled();
  });
});

/**
 * Fleet health on the host core: each row's health read and overview read are host core calls, each under its own
 * deadline and the request's signal. A core of the test's own answers a stop where the real one would only at a real
 * deadline; `Date.now` reads a clock the test owns, so no timer is awaited.
 */
describe("fleet health on the host core", () => {
  type Mocked = ReturnType<typeof mock>;
  let clock = 1_700_000_000_000;
  let now: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockReadProviderDeclarations.mockImplementation(async () => declarationsOf(mockProvider));
    now = spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    now.mockRestore();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  const s3Connection = {
    id: "conn-s3",
    name: "Objects",
    type: "s3",
    host: "objects.example.com",
    port: 9000,
    database: "",
    createdAt: new Date(),
  };

  /** Runs `body` with the core `make` builds from the real one installed, then puts the real one back. */
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

  /** The rows fleet health answers for `items`, each served by a mock provider of its own type, the request's signal `signal`. */
  async function rowsOf(
    items: readonly { readonly type: string }[],
    signal?: AbortSignal,
  ): Promise<{ rows: Record<string, unknown>[]; providers: Map<string, ReturnType<typeof createMockProvider>> }> {
    const providers = new Map<string, ReturnType<typeof createMockProvider>>();
    mockGetOrCreateMetadataProvider.mockImplementation((async (connection: { type: string }) => {
      const provider = createMockProvider({ type: connection.type as never });
      providers.set(connection.type, provider);
      return provider;
    }) as never);
    const res = await POST(
      new Request("http://localhost:3000/api/admin/fleet-health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connections: items }),
        ...(signal === undefined ? {} : { signal }),
      }) as never,
    );
    expect(res.status).toBe(200);
    const data = await parseResponseJSON<{ results: Record<string, unknown>[] }>(res);
    return { rows: data.results, providers };
  }

  test("each row's health and overview are read through the host core, the overview only where the engine offers it", async () => {
    const health: unknown[] = [];
    const panels: unknown[] = [];
    const { rows, providers } = await withCore(
      (real) => ({
        ...real,
        healthCall: (session, ctx, ports) => {
          health.push(ctx);
          return real.healthCall(session, ctx, ports);
        },
        panelCall: (session, request, ctx, ports) => {
          panels.push(request);
          return real.panelCall(session, request, ctx, ports);
        },
      }),
      () => rowsOf([connections[0] as { type: string }, s3Connection]),
    );

    expect(health).toHaveLength(2);
    expect(panels).toEqual([{ panel: "overview" }]);
    expect(rows.map((row) => row.status)).toEqual(["healthy", "healthy"]);
    expect(rows[0]?.databaseSizeBytes).toBe(268435456);
    expect("databaseSizeBytes" in (rows[1] as object)).toBe(false);
    const postgres = providers.get("postgres");
    const s3 = providers.get("s3");
    if (postgres === undefined || s3 === undefined) throw new Error("A provider per row was expected.");
    expect((postgres.getOverview as Mocked).mock.calls).toEqual([[]]);
    expect(s3.getOverview).not.toHaveBeenCalled();
    expect((s3.getHealth as Mocked).mock.calls).toEqual([[]]);
  });

  test("a row whose health read the host stopped at its deadline answers error with the health read's sentence", async () => {
    const { rows, providers } = await withCore(
      (real) => ({
        ...real,
        healthCall: async (): Promise<HealthRecord> => {
          clock += 70_000;
          return {
            kind: "stopped",
            reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
            settled: Promise.resolve(),
          };
        },
      }),
      () => rowsOf([connections[0] as { type: string }]),
    );

    expect(rows).toEqual([
      {
        connectionId: "conn-1",
        connectionName: "Production DB",
        type: "postgres",
        status: "error",
        latencyMs: 70_000,
        error:
          "The health read did not answer within the statement timeout of 60 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
      },
    ]);
    expect(providers.get("postgres")?.getOverview).not.toHaveBeenCalled();
  });

  test("a row whose overview read the host stopped stays healthy and carries no byte figure", async () => {
    const { rows } = await withCore(
      (real) => ({
        ...real,
        panelCall: async (): Promise<PanelRecord> => ({
          kind: "stopped",
          reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
          settled: Promise.resolve(),
        }),
      }),
      () => rowsOf([connections[0] as { type: string }]),
    );

    expect(rows[0]?.status).toBe("healthy");
    expect("databaseSizeBytes" in (rows[0] as object)).toBe(false);
  });

  test("a request already gone answers each row error with the cancelled sentence and reads no health", async () => {
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const { rows, providers } = await rowsOf(connections, caller.signal);

    expect(rows.map((row) => [row.status, row.error])).toEqual([
      ["error", "The query was cancelled."],
      ["error", "The query was cancelled."],
    ]);
    for (const provider of providers.values()) {
      expect(provider.getHealth).not.toHaveBeenCalled();
      expect(provider.getOverview).not.toHaveBeenCalled();
    }
    expect(providers.size).toBe(2);
  });
});

describe("fleet health on the metadata session", () => {
  type Mocked = ReturnType<typeof mock>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateMetadataProvider.mockClear();
    mockReadProviderDeclarations.mockClear();
    mockReadProviderDeclarations.mockImplementation(async () => declarationsOf(mockProvider));
  });

  afterEach(() => {
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider);
  });

  const check = () => POST(createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections } }));

  test("each row's health and overview are read on the connection's metadata session, opened under the posture its declarations were read with", async () => {
    const metadata = new Map<string, ReturnType<typeof createMockProvider>>();
    mockGetOrCreateMetadataProvider.mockImplementation((async (connection: { id: string }) => {
      const provider = createMockProvider();
      metadata.set(connection.id, provider);
      return provider;
    }) as never);
    const editor = createMockProvider();
    mockGetOrCreateProvider.mockImplementation(async () => editor);

    const res = await check();

    expect(res.status).toBe(200);
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(2);
    for (const [connection, options, execution] of mockGetOrCreateMetadataProvider.mock.calls) {
      const id = (connection as { id: string }).id;
      const declarationsRead = mockReadProviderDeclarations.mock.calls.find(([read]) => read.id === id);
      expect([id, options]).toEqual([id, {}]);
      // The execution context the row's declarations read received, built for the same session and connection, so the
      // two reads keep one posture.
      expect(execution).toEqual((declarationsRead as unknown[] | undefined)?.[1]);
      expect(execution).toEqual({ allowExternalFileAccess: true });
      expect(metadata.has(id)).toBe(true);
      const provider = metadata.get(id) as DatabaseProvider;
      expect([id, (provider.getHealth as Mocked).mock.calls.length]).toEqual([id, 1]);
      expect([id, (provider.getOverview as Mocked).mock.calls.length]).toEqual([id, 1]);
    }
    expect([...metadata.keys()].sort()).toEqual(["conn-1", "conn-2"]);
    expect(editor.getHealth).not.toHaveBeenCalled();
    expect(editor.getOverview).not.toHaveBeenCalled();
  });

  test("a row answers while the editor's provider holds every read, without waiting for it", async () => {
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
      health: { activeConnections: 3, databaseSize, cacheHitRatio: "99%", slowQueries: [], activeSessions: [] },
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata);

    const answering = check();
    const first = await Promise.race([answering, reached.promise]);
    held.reject(new Error("released by the test"));
    const response = await answering;
    await held.promise.catch(() => undefined);

    expect(first).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    const { results } = await parseResponseJSON<{ results: Record<string, unknown>[] }>(response);
    expect(results.map((row) => [row.connectionId, row.status, row.activeConnections, row.databaseSize])).toEqual([
      ["conn-1", "healthy", 3, databaseSize],
      ["conn-2", "healthy", 3, databaseSize],
    ]);
    expect(editor.getHealth).not.toHaveBeenCalled();
  });
});
