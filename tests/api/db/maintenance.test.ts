import { afterAll, beforeAll, describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../helpers/etcd-fake-client";
import { KEY_SPACE_HEADER } from "../../helpers/etcd-key-space";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { EtcdAlarm, EtcdMember, EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { readOnlySentence } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import type { DatabaseConnection } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { editorEntryOf } from "../../helpers/editor-session-entry";
import { buildQueryEvent } from "@/lib/query-events/build";
import type { QueryEventInput } from "@/lib/query-events/types";
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
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { TIMEOUT_SENTENCE } from "@/lib/api/error-body";
import { errorKind } from "@/lib/db/error-record";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { MaintenanceRunRecord, MaintenanceSession } from "@/lib/provider-host/core/maintenance";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";

// The route runs and previews through the process's host core (src/lib/provider-host/instance.ts), so this file
// composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider as never);

/**
 * The provider the factory stand-in last built, whose capabilities the declarations read answers: a route's connected
 * checks and the session's maintenance then agree, as they do for every shipped provider.
 */
let lastBuilt: { getCapabilities(): unknown } = mockProvider;
const mockReadProviderDeclarations = mock(async (...args: unknown[]) => {
  void args;
  return { capabilities: lastBuilt.getCapabilities(), labels: {}, supportsQueryCancel: false };
});

// ─── Mock getSession for auth ───────────────────────────────────────────────
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock audit buffer ──────────────────────────────────────────────────────
const mockAuditPush = mock((_event?: unknown) => ({
  id: "1",
  timestamp: new Date().toISOString(),
  type: "maintenance",
  action: "VACUUM",
  target: "all",
  user: "admin",
  result: "success" as const,
}));

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
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
  const connectionOfBody = mock(async (body: Record<string, unknown>) => {
    if (!body.connection && !body.connectionId) {
      throw new SeedConnectionError("Either connection or connectionId is required", 400);
    }
    return body.connection;
  });
  return {
    // The served resolve the route reads: the same resolution, with the record of the resolved type's engine, a legacy
    // engine's, as the server catalog holds it, and its refusal of a type it does not serve.
    resolveServedConnection: async (body: Record<string, unknown>) => {
      const connection = (await connectionOfBody(body)) as { type?: unknown };
      return { connection, engine: servedEngineRecord(connection.type) };
    },
    SeedConnectionError,
  };
});

mock.module("@/lib/audit", () => ({
  getServerAuditBuffer: () => ({ push: mockAuditPush }),
  // The route calls emitAuditEvent (the sanitizing boundary), not buffer.push, directly. This
  // delegates to the same push mock the test suite already exercises, so no assertion elsewhere
  // needs to change target.
  emitAuditEvent: (event: Record<string, unknown>) => mockAuditPush(event as never),
  AuditRingBuffer: class {},
  loadAuditFromStorage: () => [],
  saveAuditToStorage: () => {},
}));

mock.module("@/lib/db", () => ({
  getOrCreateProvider: async (...args: unknown[]) => {
    const built = await (mockGetOrCreateProvider as (...given: unknown[]) => Promise<{ getCapabilities(): unknown }>)(
      ...args,
    );
    lastBuilt = built;
    return built;
  },
  readProviderDeclarations: mockReadProviderDeclarations,
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

// ─── Mock @/lib/db/factory BEFORE importing the route ───────────────────────
/**
 * The metadata session a kill runs on (docs/providers/CONTRACT.md, clause C-66), answered by default with the same
 * `mockProvider` the editor's stand-in answers, so a kill test written against the editor's provider passes unchanged.
 * The route opens the editor's session through `getOrCreateEditorSession` and the metadata session through
 * `getOrCreateMetadataSession`, whose stand-ins answer the entry a legacy record's open answers for the provider the
 * barrel's `getOrCreateProvider` stand-in, or `mockGetOrCreateMetadataProvider`, answers with the same arguments. Each
 * records what it built, so the declarations read agrees.
 */
const mockGetOrCreateMetadataProvider = mock<(...args: unknown[]) => Promise<never>>(async () => mockProvider as never);
/** The provider `build` answers for `connection` under `execution`, recorded as the last one built. */
async function built(
  build: (...given: unknown[]) => Promise<unknown>,
  connection: unknown,
  execution: unknown,
): Promise<DatabaseProvider> {
  const provider = (await build(connection, {}, execution)) as DatabaseProvider;
  lastBuilt = provider;
  return provider;
}
mock.module("@/lib/db/factory", () => ({
  // src/lib/api/editor-provider.ts imports it, and the route loads that module; this route reads no cached entry.
  findCachedEditorEntry: mock(() => null),
  getOrCreateEditorSession: async (connection: unknown, _engine: unknown, execution: unknown) =>
    editorEntryOf(
      await built(mockGetOrCreateProvider as (...given: unknown[]) => Promise<unknown>, connection, execution),
    ),
  getOrCreateMetadataSession: async (connection: unknown, _engine: unknown, execution: unknown) =>
    editorEntryOf(await built(mockGetOrCreateMetadataProvider, connection, execution)),
}));

// ─── Mock the query event sink and the admission gate (docs/GOVERNANCE.md#query-events) ───
// The recorder captures each event the route describes, and a test builds its row with the real builder. The gate
// admits by default, which is what it does with governance off; a test makes it refuse.
const mockRecordQueryEvent = mock((_input: QueryEventInput) => {});
const mockAdmitQueryExecution = mock(() => {});
const realSink = { ...(await import("@/lib/query-events/sink")) };
mock.module("@/lib/query-events/sink", () => ({ ...realSink, recordQueryEvent: mockRecordQueryEvent }));
mock.module("@/lib/query-events/admission", () => ({ admitQueryExecution: mockAdmitQueryExecution }));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/maintenance/route");
const { SeedConnectionError } = await import("@/lib/seed/resolve-connection");

// ─── Helpers ────────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

/** A single-member etcd with authentication off, for E6 through this route (#1089, spec 3.6). */
const etcdConnection = {
  id: "etcd-e6",
  name: "etcd E6",
  type: "etcd",
  host: "etcd.test",
  port: 2379,
};

const ETCD_STATUS: EtcdStatus = {
  header: KEY_SPACE_HEADER,
  version: "3.7.2",
  dbSize: "20480",
  dbSizeInUse: "16384",
  dbSizeQuota: "0",
  leader: KEY_SPACE_HEADER.memberId,
  raftIndex: "40",
  raftTerm: "2",
  raftAppliedIndex: "40",
  errors: [],
  isLearner: false,
  storageVersion: "3.7.0",
};
const ETCD_MEMBER: EtcdMember = {
  id: KEY_SPACE_HEADER.memberId,
  name: "etcd-1",
  peerUrls: ["http://127.0.0.1:2380"],
  clientUrls: ["http://127.0.0.1:2379"],
  isLearner: false,
};
/** A raised NOSPACE alarm, so a disarm has a request to send. */
const ETCD_ALARM: EtcdAlarm = { memberId: ETCD_MEMBER.id, alarm: "nospace" };

/** One provider the factory stand-in built, its client, and how many calls its connect sent. */
interface OpenedEtcd {
  readonly client: FakeEtcdClient;
  readonly connectCalls: number;
}

/**
 * The next `getOrCreateProvider` call answered as the factory answers an etcd connection: a provider built
 * from the connection this route hands it, connected to a fake client that records every call. It reads the
 * route's argument, so a route that dropped or rewrote the posted connection's `readOnly` on its way to the
 * factory builds a read-write provider here, and the operation is sent.
 */
function nextEtcdProvider(opened: OpenedEtcd[]): void {
  mockGetOrCreateProvider.mockImplementationOnce(async (...args: unknown[]) => {
    const client = createFakeEtcdClient({
      authStatus: async () => ({ enabled: false, authRevision: "1" }),
      status: async () => ETCD_STATUS,
      memberList: async () => ({ header: KEY_SPACE_HEADER, members: [ETCD_MEMBER] }),
      compact: async () => {},
      defragment: async () => {},
      alarmList: async () => [ETCD_ALARM],
      alarmDisarm: async (alarm) => [alarm],
      close: async () => {},
    });
    const etcd = new EtcdProvider(args[0] as DatabaseConnection, {}, {}, async () => client);
    await etcd.connect();
    opened.push({ client, connectCalls: client.calls.length });
    return etcd as never;
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/maintenance", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockAuditPush.mockClear();
    mockRecordQueryEvent.mockClear();
    mockAdmitQueryExecution.mockReset();
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockClear();
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockClear();

    // Reset implementations
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    mockGetOrCreateMetadataProvider.mockReset();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
      success: true,
      executionTime: 100,
      message: "OK",
    }));
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: "sql",
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze", "reindex"],
      supportsConnectionString: true,
      defaultPort: 5432,
      schemaRefreshPattern: "(?:CREATE|ALTER|DROP|TRUNCATE)\\s",
    }));
  });

  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["text that is not JSON", "{"],
  ])("a body that is %s answers 400 with a fixed sentence and opens no provider", async (_label, raw) => {
    const res = await POST(
      new Request("http://localhost:3000/api/db/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON<{ error: string }>(res)).toEqual({ error: "Invalid request body" });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () =>
      POST(createMockRequest("/api/db/maintenance", { method: "POST", body: { type: "vacuum", connection } }) as never);
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw Object.assign(new Error(`at or near ${password}: syntax error`), { code: "42601" });
    });
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(400);
    expect(body).toMatchObject({ code: "QUERY_ERROR", error: withheldErrorMessage("QueryError") });
    expect(JSON.stringify(body)).not.toContain(password);

    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw Object.assign(new Error("at or near vacuum: syntax error"), { code: "42601" });
    });
    const clean = await send();
    expect(clean.status).toBe(400);
    expect(await parseResponseJSON(clean)).toMatchObject({
      code: "QUERY_ERROR",
      error: "at or near vacuum: syntax error",
    });
  });

  test("a maintenance message that holds the connection's credential answers the withheld sentence, and a clean message and the rows as the provider answered them", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () =>
      POST(createMockRequest("/api/db/maintenance", { method: "POST", body: { type: "vacuum", connection } }) as never);
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      executionTime: 3,
      message: `ERR invalid password ${password}`,
    });
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(200);
    expect(body).toEqual({ success: false, executionTime: 3, message: PROVIDER_TEXT_WITHHELD });
    expect(JSON.stringify(body)).not.toContain(password);

    const clean = { success: true, executionTime: 2, message: "VACUUM completed" };
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockResolvedValueOnce(clean);
    expect(await parseResponseJSON(await send())).toEqual(clean);

    const read = {
      success: true,
      executionTime: 1,
      message: "INFO read 1 line",
      rows: [{ section: "server", key: "redis_version", value: "7.2.4" }],
      fields: ["section", "key", "value"],
    };
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockResolvedValueOnce(read);
    expect(await parseResponseJSON(await send())).toEqual(read);
  });

  test("admin with valid params returns maintenance result", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; executionTime: number; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.executionTime).toBe(100);
    expect(data.message).toBe("OK");
  });

  // #772: the wire contract carries the table's container beside its target, and the route
  // passes it through untouched. Reading only `target` was the whole defect - every provider
  // then had to guess a namespace from a bare name.
  test("passes the container through to the provider", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", container: "reporting", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledWith("vacuum", "users", "reporting");
  });

  // #1091 review: the audit row recorded only `target`, so `app.orders` and `public.orders`
  // logged identically. The container is what tells them apart.
  test("the audit event records the container beside the target", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "orders", container: "app", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.target).toBe("orders");
    expect(event.container).toBe("app");
  });

  test("a whole-database request records no container, and the target keeps its `all` fallback", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.target).toBe("all");
    expect(event.container).toBeUndefined();
  });

  test("a request with no container reaches the provider with it undefined", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    await POST(req as never);

    expect(mockProvider.runMaintenance).toHaveBeenCalledWith("vacuum", "users", undefined);
  });

  // #1091 review: a non-string container used to reach the provider, where it failed as
  // `identifier.replace is not a function` - a 500 for what is a malformed request. The route
  // answers 400 and runs nothing.
  test.each<[string, unknown]>([
    ["an object", { schema: "app" }],
    ["a number", 7],
    ["an array", ["app"]],
    ["null", null],
    ["false", false],
  ])("a non-string container (%s) answers 400 and runs nothing", async (_label, container) => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", container, connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("container");
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  // A non-string target reached the provider the same way, where a number failed as
  // `identifier.replace is not a function` (a 500 quoting provider source), and the audit row
  // recorded the serialized value. The route answers 400, opens no provider and records nothing.
  test.each<[string, unknown]>([
    ["an object", { name: "users" }],
    ["a number", 7],
    ["an array", ["users"]],
    ["null", null],
    ["false", false],
  ])("a non-string target (%s) answers 400 and runs nothing", async (_label, target) => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target, connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    expect(await parseResponseJSON<{ error: string }>(res)).toEqual({
      error: `"target" must be a string naming the object to run against`,
    });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test("an empty-string container is a container the caller omitted, not a malformed one", async () => {
    // The same reading `target: ""` gets below: a falsy string is the absence of the field.
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", container: "", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledWith("vacuum", "users", undefined);
  });

  // Threat: runMaintenance() has already completed by the time emitAuditEvent runs (see the route's
  // own comment). Before this fix, a broken audit sink shared the operation's try/catch, so a
  // throw here would 500 a client that must not be told to retry an operation - possibly a
  // destructive one, like "kill" - that already succeeded.
  test("a broken audit sink does not turn a completed maintenance operation into a 500", async () => {
    mockAuditPush.mockImplementationOnce(() => {
      throw new Error("audit sink unavailable");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; executionTime: number; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe("OK");
  });

  // The audit log is where an operator reconstructs what was done to a database, so a
  // refusal recorded as a completed operation is worse than no record. This became routine
  // rather than theoretical on 2026-08-25: MySQL and Oracle now read the engine's own
  // verdict, so `success: false` on an HTTP 200 is the ordinary answer for a target the
  // engine would not touch.
  test("an operation the engine refused is audited as a failure, not as success", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
      success: false,
      executionTime: 3,
      message: "OPTIMIZE failed: u9v.missing: Table 'u9v.missing' doesn't exist",
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "missing", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);

    // Still a 200: the request was well formed and the statement reached the engine. What
    // the engine answered travels in the body, and in the audit row.
    expect(res.status).toBe(200);
    expect(data.success).toBe(false);
    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    expect((mockAuditPush.mock.calls[0]![0] as { result: string }).result).toBe("failure");
  });

  test("non-admin user returns 403", async () => {
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "user" }),
    );

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain("Unauthorized");
  });

  // Threat: a role denial that leaves no trace. An authenticated caller probing for a role it does
  // not hold was invisible in the one channel this project treats as authoritative.
  test("non-admin denial emits permission_denied with reason insufficient_role", async () => {
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "bob" }),
    );

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0][0] as Record<string, unknown>;
    expect(event.type).toBe("permission_denied");
    expect(event.reason).toBe("insufficient_role");
    expect(event.user).toBe("bob");
    expect(event.target).toBe("POST /api/db/maintenance");
  });

  test("a broken audit sink does not turn the role denial into a 500", async () => {
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "bob" }),
    );
    mockAuditPush.mockImplementationOnce(() => {
      throw new Error("audit sink unavailable");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(403);
  });

  // Guarded by guardRoute now: an unauthenticated caller is rejected at the session check,
  // before the route's own admin-role check ever runs, so this is 401 ("not authenticated"),
  // distinct from "non-admin user returns 403" above ("authenticated but forbidden").
  test("no session returns 401", async () => {
    mockGetSession.mockImplementation(async () => null);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("missing connection returns 400", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("missing type returns 400", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Maintenance type is required");
  });

  test("provider without maintenance support returns 400", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: "sql",
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 0,
      schemaRefreshPattern: "",
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    // The row offers vacuum on PostgreSQL, so the refusal comes from the connected server, after connect.
    expect(res.status).toBe(400);
    expect(data.code).toBe("FACET_NOT_OFFERED");
    expect(data.error).toBe(
      '"vacuum" is not a maintenance operation the PostgreSQL server this connection reaches accepts, which accepts none; nothing was run.',
    );
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
  });

  test("unsupported operation type returns 400", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "optimize", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.code).toBe("FACET_NOT_OFFERED");
    expect(data.error).toBe(
      '"optimize" is not a maintenance operation LibreDB Studio offers on PostgreSQL, which offers vacuum, analyze, reindex, kill; no connection was opened and nothing was run.',
    );
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  // FND-4: the record's maintenance list, the engine facets row of a legacy engine, is read before any provider is
  // built, so an operation the engine does not offer
  // opens no provider, no SSH tunnel and no connection, and is refused by name.
  test("an operation the engine does not offer is refused FACET_NOT_OFFERED by name before any provider is built", async () => {
    const res = await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "vacuum", connection: { ...validConnection, type: "kafka", port: 9092 } },
      }) as never,
    );
    const data = await parseResponseJSON<{
      error: string;
      code: string;
      statusCode: number;
      kind: string;
      outcome: string;
    }>(res);

    expect(res.status).toBe(400);
    expect(data).toEqual({
      error:
        '"vacuum" is not a maintenance operation LibreDB Studio offers on Apache Kafka, which offers none; no connection was opened and nothing was run.',
      code: "FACET_NOT_OFFERED",
      statusCode: 400,
      kind: "not-offered",
      outcome: "not-sent",
    });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
    expect(mockRecordQueryEvent).not.toHaveBeenCalled();
  });

  test("an operation outside the engine's set is refused the same way, naming the operations it offers", async () => {
    const res = await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "vacuum", target: "users", connection: { ...validConnection, type: "mysql", port: 3306 } },
      }) as never,
    );
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.code).toBe("FACET_NOT_OFFERED");
    expect(data.error).toBe(
      '"vacuum" is not a maintenance operation LibreDB Studio offers on MySQL, which offers analyze, optimize, check, kill; no connection was opened and nothing was run.',
    );
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test("an operation the connected server does not accept is refused FACET_NOT_OFFERED after connect, naming what it accepts", async () => {
    // YugabyteDB's shape: a PostgreSQL wire server that accepts no REINDEX, narrowed at connect.
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: "sql",
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze", "kill"],
      supportsConnectionString: true,
      defaultPort: 5432,
      schemaRefreshPattern: "",
    }));

    const res = await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "reindex", target: "users", connection: validConnection },
      }) as never,
    );
    const data = await parseResponseJSON<{ error: string; code: string; outcome: string }>(res);

    expect(res.status).toBe(400);
    expect(data.code).toBe("FACET_NOT_OFFERED");
    expect(data.outcome).toBe("not-sent");
    expect(data.error).toBe(
      '"reindex" is not a maintenance operation the PostgreSQL server this connection reaches accepts, which accepts vacuum, analyze, kill; nothing was run.',
    );
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test.each<[string, unknown]>([
    ["the number 5", 5],
    ["true", true],
    ["an object", {}],
    ["an array", []],
  ])(
    "a type that is not text is refused with a fixed sentence before any provider is built: %s",
    async (_label, type) => {
      const res = await POST(
        createMockRequest("/api/db/maintenance", {
          method: "POST",
          body: { type, target: "users", connection: validConnection },
        }) as never,
      );

      expect(res.status).toBe(400);
      expect(await parseResponseJSON<{ error: string }>(res)).toEqual({
        error: '"type" must be a string naming a maintenance operation',
      });
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    },
  );

  test("a connection whose type names no provider is refused PROVIDER_UNKNOWN before any provider is built", async () => {
    const res = await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "vacuum", connection: { ...validConnection, type: "acmefoo" } },
      }) as never,
    );
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.code).toBe("PROVIDER_UNKNOWN");
    expect(data.error).toBe('No provider for the connection type "acmefoo" is installed in this LibreDB Studio.');
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  // ─── U20: the route gates on WHAT an operation can be pointed at ──────────
  //
  // `maintenanceOperations` says only that an operation EXISTS on this engine; each
  // provider also declares what KIND of target it takes (`maintenanceOperationSpecs`),
  // and both UI surfaces already gate on `maintenanceControl`. The route did not, so a
  // caller reaching the API directly bypassed the only declaration that says a target
  // is meaningless here. The U20 backlog entry reports that gap from a live SQLite run:
  // POST {type:"vacuum", target:"users"} answered 200 and vacuumed the whole file - the
  // reading `perEntity: false` exists to withhold.
  //
  // These tests measure the status code and the message, not that run: the capabilities
  // below are SQLite-SHAPED mocks, so what is asserted is that the route now refuses the
  // request the declaration says is meaningless and attempts nothing.
  const sqliteShapedCapabilities = () => ({
    queryLanguage: "sql",
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsMaintenance: true,
    maintenanceOperations: ["vacuum", "analyze", "reindex"],
    maintenanceOperationSpecs: {
      // SQLite's VACUUM rewrites the whole file and ignores a target entirely.
      vacuum: { label: "Vacuum Database", perEntity: false, global: true },
      analyze: { label: "Analyze Database", perEntity: true, global: true },
      // Couchbase-shaped half of the same field: BUILD INDEX needs one keyspace and
      // has no whole-database form.
      reindex: { label: "Build Indexes", perEntity: true, global: false },
    },
    supportsConnectionString: true,
    defaultPort: 0,
    schemaRefreshPattern: "",
  });

  test("an operation that takes no target refuses a request that names one", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; success?: boolean }>(res);

    expect(res.status).toBe(400);
    // The provider's own wording for the control, and what it does accept.
    expect(data.error).toContain("Vacuum Database");
    expect(data.error).toContain("whole database");
    // A client error, not a maintenance verdict: no `success` field for a caller to
    // read as "the engine refused the work".
    expect(data.success).toBeUndefined();
    // Nothing was attempted, so nothing may be recorded as done.
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test("an operation that requires a target refuses a request without one", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "reindex", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Build Indexes");
    expect(data.error).toContain("target");
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test("an empty target string reads as the whole-database form, not as a target", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "", connection: validConnection },
    });

    const res = await POST(req as never);

    // Same reading the audit row below already uses (`target || "all"`).
    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
  });

  test("a target an operation does accept still runs", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(sqliteShapedCapabilities);

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "analyze", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
    expect(mockAuditPush).toHaveBeenCalledTimes(1);
  });

  // Every provider that declares `kill` declares it `perEntity: false, global: false`:
  // its target is a session or query id, which no table row and no whole-database card
  // can supply. Both halves false therefore does NOT mean "takes no target" - it means
  // the target comes from somewhere neither placement describes (the Sessions panel),
  // so the placement gate has nothing to say and must not refuse it.
  test("kill keeps its session-id target, which neither placement describes", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...sqliteShapedCapabilities(),
      maintenanceOperations: ["vacuum", "kill"],
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Database", perEntity: false, global: true },
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      },
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "kill", target: "4711", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
    expect((mockAuditPush.mock.calls[0]![0] as { type: string }).type).toBe("kill_session");
  });

  // A provider that declares no specs at all is offered in both placements - the
  // documented compatibility reading of the optional field, and what the route did for
  // every provider before this change.
  test("a provider declaring no operation specs accepts a target as before", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockProvider.runMaintenance).toHaveBeenCalledTimes(1);
  });

  test("DatabaseError from runMaintenance returns 500", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new DatabaseError("Internal maintenance failure", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain("Internal maintenance failure");
  });

  // #1387: the engine refusing the statement is the engine's answer, not Studio failing. These are
  // the driver errors measured on 2026-10-04, raw as the driver raises them, which the route used
  // to hand to the generic branch as a 500 INTERNAL_ERROR.
  test.each<[string, Error]>([
    [
      "CockroachDB's syntax error for VACUUM",
      Object.assign(new Error('at or near "vacuum": syntax error'), { code: "42601" }),
    ],
    [
      "TiDB's CHECK TABLE parse error",
      Object.assign(new Error('You have an error in your SQL syntax; ... near "CHECK TABLE t"'), {
        errno: 1064,
        sqlState: "42000",
      }),
    ],
    ["YugabyteDB's REINDEX refusal", Object.assign(new Error("REINDEX not supported yet"), { code: "0A000" })],
  ])("%s answers 400 QUERY_ERROR with the engine's own message", async (_label, refusal) => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw refusal;
    });

    const res = await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "vacuum", connection: validConnection },
      }) as never,
    );
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.code).toBe("QUERY_ERROR");
    expect(data.error).toBe(refusal.message);
  });

  test("a thrown error that carries no statement code still answers 500", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new TypeError("rows.filter is not a function");
    });

    const res = await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "analyze", connection: validConnection },
      }) as never,
    );

    expect(res.status).toBe(500);
  });

  // #1091 review (R04 G8): a runMaintenance that threw left no audit event at all, so the log an
  // operator reconstructs a database's history from had no line for an operation that may have
  // reached the engine before it failed. The row is the success row's shape with a closed reason
  // and the time the call took, and it never carries the thrown message.
  test("a maintenance run that throws is audited as a failure with a closed reason", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new DatabaseError("Internal maintenance failure", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "orders", container: "app", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.type).toBe("maintenance");
    expect(event.action).toBe("VACUUM");
    expect(event.target).toBe("orders");
    expect(event.container).toBe("app");
    expect(event.connectionName).toBe("Test DB");
    expect(event.user).toBe("admin");
    expect(event.result).toBe("failure");
    expect(event.reason).toBe("maintenance_execution_failed");
    expect(typeof event.duration).toBe("number");
    expect(JSON.stringify(event)).not.toContain("Internal maintenance failure");
  });

  test("a thrown whole-database run is audited with the `all` target and no container", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new DatabaseError("Internal maintenance failure", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", connection: { ...validConnection, name: "" } },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.target).toBe("all");
    expect(event.container).toBeUndefined();
    expect(event.connectionName).toBe("testdb");
  });

  test("a thrown kill is audited as a kill_session failure", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      supportsMaintenance: true,
      maintenanceOperations: ["kill"],
    }));
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new DatabaseError("backend already gone", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "kill", target: "4711", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    const event = mockAuditPush.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.type).toBe("kill_session");
    expect(event.action).toBe("KILL");
    expect(event.target).toBe("4711");
    expect(event.result).toBe("failure");
  });

  // The HTTP answer for a thrown run is the one the thrown error maps to, before and after the
  // audit row existed: the row records the failure and changes nothing the caller reads.
  test.each<[string, Error, number]>([
    ["a DatabaseError", new DatabaseError("Internal maintenance failure", "postgres", "DATABASE_ERROR"), 500],
    ["a QueryError", new QueryError("relation does not exist", "postgres"), 400],
  ])("a thrown run answers what %s maps to", async (_label, thrown, status) => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw thrown;
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(status);
    expect(data.error).toContain(thrown.message);
  });

  // A broken sink must not replace the operation's own failure with its own: the caller still
  // reads what the thrown error maps to, not a 500 about the audit log.
  test("a broken audit sink does not change the answer for a thrown run", async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new QueryError("relation does not exist", "postgres");
    });
    mockAuditPush.mockImplementationOnce(() => {
      throw new Error("audit sink unavailable");
    });

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("relation does not exist");
    expect(data.error).not.toContain("audit sink");
  });

  // The closed reason names a thrown run and nothing else: a completed run, and one the engine
  // refused in its own answer, carry no reason, so the three stay apart in the log.
  test.each<[string, boolean]>([
    ["a completed run", true],
    ["a run the engine refused", false],
  ])("%s carries no reason", async (_label, success) => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
      success,
      executionTime: 1,
      message: "done",
    }));

    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "vacuum", target: "users", connection: validConnection },
    });

    await POST(req as never);

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    expect((mockAuditPush.mock.calls[0]![0] as Record<string, unknown>).reason).toBeUndefined();
  });

  // Refusals the route decides before calling the provider are not maintenance runs and write no
  // maintenance row, thrown or otherwise.
  test("a request refused before the provider is called writes no maintenance row", async () => {
    const req = createMockRequest("/api/db/maintenance", {
      method: "POST",
      body: { type: "optimize", target: "users", connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  // #1089 E6: the provider refuses every maintenance operation on a read-only connection, and only the
  // connection this route hands the factory tells it so.
  test.each([
    ["compact", "compact"],
    ["defragment", "defragment"],
    ["disarm", "alarmDisarm"],
  ] as const)(
    "an etcd %s on a connection carrying readOnly: true answers 400 naming the mode and sends nothing; without it, it sends %s",
    async (type, rpc) => {
      const opened: OpenedEtcd[] = [];
      nextEtcdProvider(opened);
      const refused = await POST(
        createMockRequest("/api/db/maintenance", {
          method: "POST",
          body: { type, connection: { ...etcdConnection, readOnly: true } },
        }) as never,
      );
      expect(refused.status).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(refused)).error).toBe(readOnlySentence("connection"));
      const [readOnlyProvider] = opened;
      expect(readOnlyProvider.client.calls.slice(readOnlyProvider.connectCalls)).toEqual([]);

      // The control: the same request on the connection without readOnly sends the operation's own call.
      nextEtcdProvider(opened);
      const ran = await POST(
        createMockRequest("/api/db/maintenance", {
          method: "POST",
          body: { type, connection: etcdConnection },
        }) as never,
      );
      expect(ran.status).toBe(200);
      const [, writer] = opened;
      expect(writer.client.calls.slice(writer.connectCalls).map((call) => call.method)).toContain(rpc);
    },
  );

  // Spec 3.11: every row this route writes names the engine principal, for a provider that reports one. The shared
  // mock provider implements no `engineUser`, so each test adds it and takes it away again.
  const reportingEngineUser = (name: string | undefined): (() => void) => {
    const provider = mockProvider as { engineUser?: () => string | undefined };
    provider.engineUser = mock(() => name);
    return () => {
      delete provider.engineUser;
    };
  };

  test.each<[string, () => void, "success" | "failure"]>([
    ["a completed run", () => {}, "success"],
    [
      "a run the engine refused",
      () => {
        (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
          success: false,
          executionTime: 1,
          message: "refused",
        }));
      },
      "failure",
    ],
    [
      "a run that throws",
      () => {
        (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
          throw new DatabaseError("Internal maintenance failure", "postgres", "DATABASE_ERROR");
        });
      },
      "failure",
    ],
  ])("%s writes the engine principal on its row", async (_label, arrange, result) => {
    const restore = reportingEngineUser("app_maintainer");
    try {
      arrange();
      await POST(
        createMockRequest("/api/db/maintenance", {
          method: "POST",
          body: { type: "vacuum", target: "orders", container: "app", connection: validConnection },
        }) as never,
      );

      expect(mockAuditPush).toHaveBeenCalledTimes(1);
      const event = mockAuditPush.mock.calls[0]![0] as Record<string, unknown>;
      expect(event.engineUser).toBe("app_maintainer");
      expect(event.result).toBe(result);
    } finally {
      restore();
    }
  });

  test("a provider that does not implement engineUser writes a row with no such key", async () => {
    await POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { type: "vacuum", target: "orders", connection: validConnection },
      }) as never,
    );

    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(mockAuditPush.mock.calls[0]![0] as object, "engineUser")).toBe(false);
  });

  test("a provider whose engineUser names no one writes a row with no such key", async () => {
    const restore = reportingEngineUser(undefined);
    try {
      await POST(
        createMockRequest("/api/db/maintenance", {
          method: "POST",
          body: { type: "vacuum", target: "orders", connection: validConnection },
        }) as never,
      );

      expect(mockAuditPush).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn(mockAuditPush.mock.calls[0]![0] as object, "engineUser")).toBe(false);
    } finally {
      restore();
    }
  });
  describe("governance query events", () => {
    const SUBJECT = "8d0f6a4e-2b1c-4f3a-9e7d-5c6b4a3f2e1d";
    /** A governed connection as `resolveServedConnection` hands it out: the `seed:` id and the level of its credential. */
    const governedConnection = { ...validConnection, id: "seed:orders", grantLevel: "write" };

    beforeEach(() => {
      mockGetSession.mockImplementation(
        async () => ({ role: "admin", username: "ada", idpSubject: SUBJECT }) as { role: string; username: string },
      );
    });

    const recorded = (): QueryEventInput[] => mockRecordQueryEvent.mock.calls.map(([input]) => input);
    const maintenance = (body: Record<string, unknown>) =>
      POST(
        createMockRequest("/api/db/maintenance", {
          method: "POST",
          body: { connection: governedConnection, ...body },
        }) as never,
      );

    test("governance: one maintenance event per action with its status", async () => {
      const runMaintenance = mockProvider.runMaintenance as ReturnType<typeof mock>;
      expect((await maintenance({ type: "vacuum", target: "orders" })).status).toBe(200);
      // The engine's verdict, not the request's: a run the engine would not do is an error.
      runMaintenance.mockImplementationOnce(async () => ({ success: false, executionTime: 1, message: "refused" }));
      expect((await maintenance({ type: "analyze" })).status).toBe(200);
      // A run that threw may have reached the engine, so it is recorded too.
      runMaintenance.mockImplementationOnce(async () => {
        throw new QueryError('relation "orders" does not exist', "postgres");
      });
      expect((await maintenance({ type: "reindex", target: "orders" })).status).toBe(400);

      expect(recorded().map(({ source, status }) => [source, status])).toEqual([
        ["maintenance", "success"],
        ["maintenance", "error"],
        ["maintenance", "error"],
      ]);
      expect(mockAdmitQueryExecution).toHaveBeenCalledTimes(3);

      const row = buildQueryEvent(
        recorded()[0]!,
        { statementCapture: "full", maxStatementBytes: 4096 },
        { studioInstance: "libredb-studio" },
      );
      expect(row).toMatchObject({
        source: "maintenance",
        status: "success",
        subject: SUBJECT,
        username: "ada",
        session_role: "admin",
        connection_id: "orders",
        connection_name: "Test DB",
        engine: "postgres",
        access_level: "write",
        // The provider builds the statement inside `runMaintenance`, so the route has no text to record.
        statement: null,
        statement_type: "OTHER",
        error_code: null,
      });
    });

    test("governance: refuse mode answers 503 AUDIT_UNAVAILABLE before the action runs and records a refused event", async () => {
      mockAdmitQueryExecution.mockImplementationOnce(() => {
        throw Object.assign(new SeedConnectionError("Query execution is unavailable", 503), {
          code: "AUDIT_UNAVAILABLE",
        });
      });

      const res = await maintenance({ type: "vacuum", target: "orders" });

      expect(res.status).toBe(503);
      expect((await parseResponseJSON<{ code: string }>(res)).code).toBe("AUDIT_UNAVAILABLE");
      expect(mockProvider.runMaintenance).not.toHaveBeenCalled();
      expect(mockAuditPush).not.toHaveBeenCalled();
      expect(recorded()).toHaveLength(1);
      expect(recorded()[0]).toMatchObject({
        source: "maintenance",
        status: "refused",
        errorCode: "AUDIT_UNAVAILABLE",
        statement: null,
        connection: { id: "seed:orders", engine: "postgres", accessLevel: "write" },
      });
    });

    test("a request refused before the action is admitted records nothing", async () => {
      const res = await maintenance({ type: "optimize", target: "orders" });

      expect(res.status).toBe(400);
      expect(mockAdmitQueryExecution).not.toHaveBeenCalled();
      expect(recorded()).toEqual([]);
    });
  });
});

describe("what the maintenance route answers today, which the host core keeps", () => {
  /** Each Studio error class a provider raises, and the status, code and retry hint its answer carries. */
  const STUDIO_ERRORS: readonly {
    readonly name: string;
    readonly raise: (text: string) => Error;
    readonly status: number;
    readonly code: string;
    readonly retryable?: true;
    readonly sentence?: string;
  }[] = [
    { name: "QueryError", raise: (text) => new QueryError(text, "postgres"), status: 400, code: "QUERY_ERROR" },
    {
      name: "ConnectionError",
      raise: (text) => new ConnectionError(text, "postgres"),
      status: 503,
      code: "CONNECTION_ERROR",
      retryable: true,
    },
    {
      name: "TimeoutError",
      raise: (text) => new TimeoutError(text, "postgres", 1000),
      status: 504,
      code: "TIMEOUT_ERROR",
      retryable: true,
      sentence: TIMEOUT_SENTENCE,
    },
    {
      name: "PoolExhaustedError",
      raise: (text) => new PoolExhaustedError(text, "postgres", 10),
      status: 503,
      code: "POOL_EXHAUSTED",
      retryable: true,
    },
    {
      name: "PermissionDeniedError",
      raise: (text) => new PermissionDeniedError(text, "postgres"),
      status: 403,
      code: "PERMISSION_DENIED",
    },
  ];

  const runMaintenance = mockProvider.runMaintenance as ReturnType<typeof mock>;

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    mockGetOrCreateMetadataProvider.mockReset();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider as never);
    mockAdmitQueryExecution.mockReset();
    runMaintenance.mockReset();
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: "sql",
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze", "reindex", "kill"],
      supportsConnectionString: true,
      defaultPort: 5432,
      schemaRefreshPattern: "(?:CREATE|ALTER|DROP|TRUNCATE)\\s",
    }));
  });

  function post(body: Record<string, unknown>): Promise<Response> {
    return POST(
      createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: { connection: validConnection, ...body },
      }) as never,
    );
  }

  test("a run's Studio error answers by its class, with its code, kind and outcome", async () => {
    for (const studio of STUDIO_ERRORS) {
      const text = `refused ${crypto.randomUUID()}`;
      const error = studio.raise(text);
      runMaintenance.mockImplementation(async () => {
        throw error;
      });

      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const response = await post({ type: "vacuum", target: "users", container: "app" });
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect([studio.name, response.status]).toEqual([studio.name, studio.status]);
      expect([studio.name, body]).toEqual([
        studio.name,
        {
          error: studio.sentence ?? text,
          code: studio.code,
          statusCode: studio.status,
          ...(studio.retryable === undefined ? {} : { retryable: true }),
          kind: errorKind(error),
          outcome: "unknown",
        },
      ]);
    }
  });

  // The run route maps a provider's raw error with mapDatabaseError before it answers, so an error without a statement
  // code answers as a DatabaseError, where the preview route, which maps nothing, answers INTERNAL_ERROR.
  test("a run's error without a statement code answers 500 DATABASE_ERROR with its own words, kind database and outcome unknown", async () => {
    const text = `socket ${crypto.randomUUID()}`;
    runMaintenance.mockImplementation(async () => {
      throw new Error(text);
    });

    const response = await post({ type: "vacuum", target: "users", container: "app" });
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: text,
      code: "DATABASE_ERROR",
      statusCode: 500,
      kind: "database",
      outcome: "unknown",
    });
  });

  test("the provider is asked once with the operation, the target the request names, none for an empty one, and the container, and the answer is its result", async () => {
    const result = {
      success: true,
      executionTime: 7,
      message: `vacuumed ${crypto.randomUUID()}`,
      rows: [{ section: "server", key: "uptime", value: 12 }],
      fields: ["section", "key", "value"],
    };
    const calls: [Record<string, unknown>, unknown[]][] = [
      [{ type: "vacuum", target: "users", container: "app" }, ["vacuum", "users", "app"]],
      [{ type: "vacuum", target: "" }, ["vacuum", undefined, undefined]],
      [{ type: "kill", target: "4711" }, ["kill", "4711", undefined]],
    ];

    for (const [body, args] of calls) {
      runMaintenance.mockReset();
      runMaintenance.mockImplementation(async () => result);

      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each call is its own request's.
      const response = await post(body);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const answer = await parseResponseJSON<Record<string, unknown>>(response);

      expect([body, response.status]).toEqual([body, 200]);
      expect([body, runMaintenance.mock.calls]).toEqual([body, [args]]);
      expect([body, answer]).toEqual([body, result]);
    }
  });
});

describe("the maintenance route on the host core", () => {
  const runMaintenance = mockProvider.runMaintenance as ReturnType<typeof mock>;

  /** A capability set with vacuum on a row and whole, and kill on neither placement. */
  const KILLING = () => ({
    queryLanguage: "sql",
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsMaintenance: true,
    maintenanceOperations: ["vacuum", "analyze", "kill"],
    maintenanceOperationSpecs: {
      vacuum: { label: "Vacuum", perEntity: true, global: true },
      analyze: { label: "Analyze", perEntity: true, global: false },
      kill: { label: "Terminate", perEntity: false, global: false },
    },
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: "(?:CREATE|ALTER|DROP|TRUNCATE)\\s",
  });

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockReset();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    mockGetOrCreateMetadataProvider.mockReset();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider as never);
    mockReadProviderDeclarations.mockClear();
    mockAuditPush.mockClear();
    mockRecordQueryEvent.mockClear();
    mockAdmitQueryExecution.mockReset();
    runMaintenance.mockReset();
    runMaintenance.mockImplementation(async () => ({ success: true, executionTime: 1, message: "OK" }));
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(KILLING);
  });

  /** A maintenance request whose signal is `signal`, as a browser that may leave sends it. */
  function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return POST(
      new Request("http://localhost:3000/api/db/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: validConnection, ...body }),
        ...(signal === undefined ? {} : { signal }),
      }) as never,
    );
  }

  /** Runs `body` with a core `make` builds around the real one installed, then puts the real one back. */
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

  /** The audit rows the route wrote. */
  const auditRows = () => mockAuditPush.mock.calls.map((call) => call[0] as Record<string, unknown>);

  test("the route reads the provider's declarations once, after its own checks, and none for a request it refuses", async () => {
    mockGetSession.mockImplementationOnce(async () => ({ role: "user", username: "user" }));
    const refused = [
      await post({ type: "vacuum" }),
      await POST(
        new Request("http://localhost:3000/api/db/maintenance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        }) as never,
      ),
      await post({ type: "optimize" }),
      await post({ type: "reindex" }),
      await post({ type: "kill" }),
      await post({ type: "analyze" }),
    ];

    expect(refused.map((response) => response.status)).toEqual([403, 400, 400, 400, 200, 400]);
    // Only the kill, which passes every check of the route, read the declarations.
    expect(mockReadProviderDeclarations).toHaveBeenCalledTimes(1);
    mockReadProviderDeclarations.mockClear();
    mockGetOrCreateProvider.mockClear();

    const response = await post({ type: "vacuum", target: "users", container: "app" });

    expect(response.status).toBe(200);
    expect(mockReadProviderDeclarations).toHaveBeenCalledTimes(1);
    const [connection, execution] = mockReadProviderDeclarations.mock.calls[0] ?? [];
    expect(connection).toEqual(validConnection);
    expect(execution).toEqual((mockGetOrCreateProvider.mock.calls[0] as unknown[] | undefined)?.[2]);
    expect(execution).toBeDefined();
  });

  test("a run whose request leaves while the provider runs answers 499 at once, outcome unknown, and is audited as an unknown outcome", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const pending = Promise.withResolvers<never>();
    const reached = Promise.withResolvers<void>();
    runMaintenance.mockImplementation(() => {
      reached.resolve();
      return pending.promise;
    });
    const caller = new AbortController();
    try {
      const answering = post({ type: "vacuum", target: "users", container: "app" }, caller.signal);
      await reached.promise;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      const response = await answering;
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect(response.status).toBe(499);
      expect(body).toMatchObject({ code: "QUERY_CANCELLED", outcome: "unknown" });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          type: "maintenance",
          action: "VACUUM",
          target: "users",
          container: "app",
          result: "failure",
          reason: "maintenance_outcome_unknown",
          duration: expect.any(Number),
        }),
      ]);
      expect(mockRecordQueryEvent.mock.calls.map((call) => call[0].status)).toEqual(["cancelled"]);
      pending.reject(new Error(crypto.randomUUID()));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      warn.mockRestore();
    }
  });

  test("a run whose request is already gone answers 499 not-sent, asks the provider nothing and writes no audit row", async () => {
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const response = await post({ type: "vacuum" }, caller.signal);
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(499);
    expect(body).toMatchObject({ code: "QUERY_CANCELLED", outcome: "not-sent" });
    expect(runMaintenance).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
    expect(mockRecordQueryEvent.mock.calls.map((call) => call[0].status)).toEqual(["cancelled"]);
  });

  test("a run past its deadline answers 504 studio-timeout-refusal naming the run, and is audited as an unknown outcome", async () => {
    const response = await withCore(
      (real) => ({
        ...real,
        maintenanceRunCall: async (): Promise<MaintenanceRunRecord> => ({
          kind: "stopped",
          reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
          settled: Promise.resolve(),
        }),
      }),
      () => post({ type: "vacuum" }),
    );
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(504);
    expect(body).toMatchObject({ code: "TIMEOUT_ERROR", kind: "studio-timeout-refusal", outcome: "unknown" });
    expect(body.error).toBe(
      "The maintenance run did not answer within the statement timeout of 60 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
    expect(auditRows()).toEqual([
      expect.objectContaining({ result: "failure", reason: "maintenance_outcome_unknown", target: "all" }),
    ]);
    expect(mockRecordQueryEvent.mock.calls.map((call) => call[0].status)).toEqual(["error"]);
  });

  test("a broken audit sink does not change the answer for a run Studio stopped waiting for", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    mockAuditPush.mockImplementationOnce(() => {
      throw new Error("audit sink down");
    });
    try {
      const response = await withCore(
        (real) => ({
          ...real,
          maintenanceRunCall: async (): Promise<MaintenanceRunRecord> => ({
            kind: "stopped",
            reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
            settled: Promise.resolve(),
          }),
        }),
        () => post({ type: "vacuum" }),
      );

      expect(response.status).toBe(504);
      expect(await parseResponseJSON(response)).toMatchObject({ kind: "studio-timeout-refusal" });
      expect(logged.mock.calls.map((call) => call[0])).toContain("Failed to record maintenance audit event");
    } finally {
      logged.mockRestore();
    }
  });

  test("a run the host refuses before the call answers as a defect of Studio and writes no audit row", async () => {
    const error = mock(() => {});
    const logged = spyOn(logger, "error").mockImplementation(error);
    try {
      const response = await withCore(
        (real) => ({
          ...real,
          maintenanceRunCall: async (): Promise<MaintenanceRunRecord> => ({
            kind: "refused",
            called: false,
            refusals: [{ rule: "request-operation-not-offered", pointer: "/operation" }],
          }),
        }),
        () => post({ type: "vacuum" }),
      );
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect(response.status).toBe(500);
      expect(body).toMatchObject({ code: "INTERNAL_ERROR" });
      expect(String(body.error).startsWith(HOST_DEFECT_PREFIX)).toBe(true);
      expect(body.error).toContain('"/operation"');
      expect(runMaintenance).not.toHaveBeenCalled();
      expect(auditRows()).toEqual([]);
      expect(mockRecordQueryEvent.mock.calls.map((call) => call[0].status)).toEqual(["error"]);
    } finally {
      logged.mockRestore();
    }
  });

  test("an error the host raises before the provider is called is not audited as an execution failure", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => {});
    const real = hostCore();
    try {
      // No core installed: the process was composed wrong, and nothing reached the provider.
      forgetHostCore();
      const unbooted = await post({ type: "vacuum" });
      installHostCore(real, "test");
      // A declaration whose spec names an operation outside the vocabulary: the session's maintenance refuses its
      // narrowing as a CallRefusalError before the call.
      mockReadProviderDeclarations.mockImplementationOnce(async () => ({
        capabilities: {
          ...KILLING(),
          maintenanceOperations: ["vacuum", "shrink"],
          maintenanceOperationSpecs: { ...KILLING().maintenanceOperationSpecs, shrink: { label: "Shrink" } },
        },
        labels: {},
        supportsQueryCancel: false,
      }));
      const unreadable = await post({ type: "vacuum" });

      expect([unbooted.status, unreadable.status]).toEqual([500, 500]);
      expect(runMaintenance).not.toHaveBeenCalled();
      expect(auditRows().map((row) => row.reason)).not.toContain("maintenance_execution_failed");
      expect(auditRows()).toEqual([]);
      expect(mockRecordQueryEvent.mock.calls.map((call) => call[0].status)).toEqual(["error", "error"]);
    } finally {
      forgetHostCore();
      installHostCore(real, "test");
      logged.mockRestore();
    }
  });

  test("a connection whose connected maintenance is narrower than its declaration is refused the placement its session's maintenance withdrew", async () => {
    // Declared: vacuum on a row and whole, analyze on a row. Connected: vacuum whole only, analyze withdrawn.
    mockReadProviderDeclarations.mockImplementation(async () => ({
      capabilities: KILLING(),
      labels: {},
      supportsQueryCancel: false,
    }));
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...KILLING(),
      maintenanceOperations: ["vacuum", "kill"],
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum", perEntity: false, global: true },
        kill: { label: "Terminate", perEntity: false, global: false },
      },
    }));
    const sessions: MaintenanceSession[] = [];
    try {
      const [onRow, withdrawn, whole] = await withCore(
        (real) => ({
          ...real,
          maintenanceRunCall: (session, request, ctx, ports) => {
            sessions.push(session);
            return real.maintenanceRunCall(session, request, ctx, ports);
          },
        }),
        async () => [
          await post({ type: "vacuum", target: "users" }),
          await post({ type: "analyze", target: "users" }),
          await post({ type: "vacuum" }),
        ],
      );

      expect([onRow.status, withdrawn.status, whole.status]).toEqual([400, 400, 200]);
      expect((await parseResponseJSON<{ error: string }>(onRow)).error).toBe(
        "Vacuum takes no target on this database: it runs over the whole database. Omit 'target'.",
      );
      expect(await parseResponseJSON(withdrawn)).toMatchObject({ code: "FACET_NOT_OFFERED" });
      expect(runMaintenance.mock.calls).toEqual([["vacuum", undefined, undefined]]);
      // The one run the route sent was held to the session's maintenance: the declaration narrowed as connected.
      expect(sessions.map((session) => session.maintenance)).toEqual([
        {
          maintenance: ["vacuum", "kill"],
          maintenanceSpecs: [
            expect.objectContaining({ operation: "vacuum", perEntity: false, global: true }),
            expect.objectContaining({ operation: "kill", perEntity: false, global: false }),
          ],
        },
      ]);
      expect(auditRows()).toEqual([expect.objectContaining({ action: "VACUUM", target: "all", result: "success" })]);
    } finally {
      mockReadProviderDeclarations.mockImplementation(async () => ({
        capabilities: lastBuilt.getCapabilities(),
        labels: {},
        supportsQueryCancel: false,
      }));
    }
  });

  test("kill's session target passes the host's placement check, which neither placement describes", async () => {
    const response = await post({ type: "kill", target: "4711" });

    expect(response.status).toBe(200);
    expect(runMaintenance.mock.calls).toEqual([["kill", "4711", undefined]]);
    expect(auditRows()).toEqual([expect.objectContaining({ type: "kill_session", result: "success" })]);
  });

  /** A provider of the KILLING capabilities whose `runMaintenance` answers `answer`, apart from `mockProvider`. */
  function killingProvider(answer: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
    const provider = createMockProvider();
    (provider.getCapabilities as ReturnType<typeof mock>).mockImplementation(KILLING);
    (provider.runMaintenance as ReturnType<typeof mock>).mockImplementation(answer);
    return Object.assign(provider, extra);
  }

  test("a kill runs on the connection's metadata session, opened with the editor's connection and posture, and every other operation on the editor's provider", async () => {
    const metadata = killingProvider(async () => ({ success: true, executionTime: 1, message: "Terminated" }), {
      engineUser: () => "studio_admin",
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata as never);

    const killed = await post({ type: "kill", target: "4711" });

    expect(killed.status).toBe(200);
    expect(await parseResponseJSON(killed)).toMatchObject({ success: true, message: "Terminated" });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(1);
    const [connection, options, execution] = mockGetOrCreateMetadataProvider.mock.calls[0] ?? [];
    expect(connection).toEqual(validConnection);
    expect(options).toEqual({});
    // The execution the declarations read receives: the session's editor posture.
    expect(execution).toEqual(mockReadProviderDeclarations.mock.calls[0]?.[1]);
    expect(execution).toBeDefined();
    expect((metadata.runMaintenance as ReturnType<typeof mock>).mock.calls).toEqual([["kill", "4711", undefined]]);
    expect(runMaintenance).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([
      expect.objectContaining({ type: "kill_session", result: "success", engineUser: "studio_admin" }),
    ]);

    mockAuditPush.mockClear();
    const vacuumed = await post({ type: "vacuum", target: "users" });
    const analyzed = await post({ type: "analyze", target: "users" });

    expect([vacuumed.status, analyzed.status]).toEqual([200, 200]);
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(2);
    expect(runMaintenance.mock.calls).toEqual([
      ["vacuum", "users", undefined],
      ["analyze", "users", undefined],
    ]);
    expect((metadata.runMaintenance as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("a kill answers while the editor's provider holds every run, without waiting for it", async () => {
    // The editor's provider holds: its run signals `reached` and settles only when this test rejects it.
    const held = Promise.withResolvers<never>();
    const reached = Promise.withResolvers<"editor held">();
    runMaintenance.mockImplementation(() => {
      reached.resolve("editor held");
      return held.promise;
    });
    const marker = `killed ${crypto.randomUUID()}`;
    const metadata = killingProvider(async () => ({ success: true, executionTime: 1, message: marker }));
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata as never);

    const answering = post({ type: "kill", target: "4711" });
    const first = await Promise.race([answering, reached.promise]);
    held.reject(new Error("released by the test"));
    const response = await answering;
    await held.promise.catch(() => undefined);

    expect(first).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await parseResponseJSON(response)).toMatchObject({ success: true, message: marker });
    expect(runMaintenance).not.toHaveBeenCalled();
    expect((metadata.runMaintenance as ReturnType<typeof mock>).mock.calls).toEqual([["kill", "4711", undefined]]);
  });

  test("a kill's catalog runs on that database's session of the metadata session, and a catalog the connection cannot honour is refused as the editor's provider refuses it, with nothing run or audited", async () => {
    const shop = killingProvider(async () => ({ success: true, executionTime: 1, message: "Terminated in shop" }));
    const serverLevel = { ...validConnection, database: "" };
    const root = killingProvider(async () => ({ success: true, executionTime: 1, message: "root" }), {
      config: serverLevel,
      forCatalog: mock(async (catalog: string) => (catalog === "shop" ? shop : undefined)),
    });
    (root.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...KILLING(),
      catalogSessions: true,
    }));
    mockGetOrCreateMetadataProvider.mockImplementation(async () => root as never);

    const inShop = await post({ type: "kill", target: "4711", catalog: "shop", connection: serverLevel });

    expect(inShop.status).toBe(200);
    expect(await parseResponseJSON(inShop)).toMatchObject({ message: "Terminated in shop" });
    expect((shop.runMaintenance as ReturnType<typeof mock>).mock.calls).toEqual([["kill", "4711", undefined]]);
    expect(root.runMaintenance).not.toHaveBeenCalled();
    expect(root.forCatalog).toHaveBeenCalledWith("shop");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();

    // A connection that names its database honours no catalog, on the metadata session as on the editor's.
    mockAuditPush.mockClear();
    mockRecordQueryEvent.mockClear();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => mockProvider as never);
    const killRefused = await post({ type: "kill", target: "4711", catalog: "shop" });
    const vacuumRefused = await post({ type: "vacuum", target: "users", catalog: "shop" });

    expect([killRefused.status, vacuumRefused.status]).toEqual([400, 400]);
    const killBody = await parseResponseJSON<Record<string, unknown>>(killRefused);
    expect(killBody).toEqual(await parseResponseJSON<Record<string, unknown>>(vacuumRefused));
    expect(killBody.error).toContain('cannot run one in "shop"');
    expect(runMaintenance).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
    expect(mockRecordQueryEvent).not.toHaveBeenCalled();
  });
});
