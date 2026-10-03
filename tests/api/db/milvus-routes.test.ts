/**
 * The maintenance, preview and cancel routes over the real Milvus provider and a fake client. Load and Release
 * run only for an admin and leave an audit row on success, on a refusal of the server and on a throw; the row names
 * the Studio user, the Milvus principal, the database and the collection, and never any part of a secret. The preview
 * route is admin-only too, makes read calls only, and refuses an unknown collection after exactly one
 * DescribeCollection. A console run is named by its id: the cancel route stops exactly that run, and an id that names
 * no run answers false.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  isAuthenticationError,
  isConnectionError,
  isDatabaseError,
  isQueryError,
  isRetryableError,
  isTimeoutError,
  mapDatabaseError,
  PoolExhaustedError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import type { DatabaseConnection } from "@/lib/db/types";
import { expectCalls } from "../../helpers/call-log";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  type FakeMilvusClient,
  failedStatus,
  plainCollection,
  SYSTEM_INFO,
  settle,
  wireIndex,
} from "../../helpers/milvus-catalog-client";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const TEST_TOKEN = "password-second";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "ada" }),
);
const auditEvents: Record<string, unknown>[] = [];
let provider: MilvusProvider;
let client: FakeMilvusClient;

// The spread form, not a hand-written stub: only `getSession` is replaced.
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));

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
  return { resolveConnection: mock(async (body: Record<string, unknown>) => body.connection), SeedConnectionError };
});

mock.module("@/lib/audit", () => ({
  getServerAuditBuffer: () => ({ push: (event: Record<string, unknown>) => auditEvents.push(event) }),
  emitAuditEvent: (event: Record<string, unknown>) => {
    auditEvents.push(event);
  },
  AuditRingBuffer: class {},
  loadAuditFromStorage: () => [],
  saveAuditToStorage: () => {},
}));

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mock(async () => provider),
  createDatabaseProvider: mock(async () => provider),
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
  isRetryableError,
  mapDatabaseError,
}));

const maintenance = (await import("@/app/api/db/maintenance/route")).POST;
const preview = (await import("@/app/api/db/maintenance/preview/route")).POST;
const cancel = (await import("@/app/api/db/cancel/route")).POST;

const CONNECTION: DatabaseConnection = {
  id: "milvus-routes",
  name: "milvus routes",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

/** A connected provider behind the routes, as `connection` configures it. */
async function serve(connection: DatabaseConnection = CONNECTION): Promise<DatabaseConnection> {
  client = createFakeMilvusClient({
    databases: {
      default: [
        { describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000" },
        { describe: plainCollection("noidx"), loadState: "LoadStateNotLoad" },
        { describe: plainCollection("plain"), indexes: [wireIndex("vec", "FLAT", "L2")] },
      ],
    },
    metrics: SYSTEM_INFO,
  });
  provider = new MilvusProvider(connection, {}, {}, async () => client);
  await provider.connect();
  client.calls.length = 0;
  return connection;
}

const post = (path: string, body: unknown) => createMockRequest(path, { method: "POST", body });
const methods = () => client.calls.map((call) => call.method);
const QUERY = 'POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "", "limit": 5}';

beforeEach(() => {
  clearRateLimitState();
  auditEvents.length = 0;
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "ada" }));
});

describe("POST /api/db/maintenance: Load and Release", () => {
  test("a user is refused with 403 and an audit row, and nothing is sent", async () => {
    const connection = await serve();
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "ulf" }));
    for (const type of ["load", "release"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      const response = await maintenance(
        post("/api/db/maintenance", { connection, type, target: "docs_int64", container: "default" }),
      );
      expect(response.status).toBe(403);
    }
    expect(auditEvents).toHaveLength(2);
    expect(JSON.stringify(auditEvents)).toContain("ulf");
    expect(client.calls).toEqual([]);
  });

  test("an admin's Load is sent, and its row names the Studio user, the Milvus principal, the database and the collection", async () => {
    const connection = await serve({ ...CONNECTION, user: "reader", password: TEST_PASSWORD });
    const response = await maintenance(
      post("/api/db/maintenance", { connection, type: "load", target: "docs_int64", container: "default" }),
    );
    expect(response.status).toBe(200);
    expect((await parseResponseJSON<{ message: string }>(response)).message).toStartWith("Loaded:");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      type: "maintenance",
      action: "LOAD",
      target: "docs_int64",
      container: "default",
      user: "ada",
      engineUser: "reader",
      result: "success",
    });
    expect(JSON.stringify(auditEvents)).not.toContain(TEST_PASSWORD);
  });

  test("a LoadCollection the server rejects is audited as a failure that names all four", async () => {
    const connection = await serve({ ...CONNECTION, user: "reader", password: TEST_PASSWORD });
    client.on("loadCollection", () => failedStatus(700, "IndexNotExist", "index not found[collection=noidx]"));
    const response = await maintenance(
      post("/api/db/maintenance", { connection, type: "load", target: "noidx", container: "default" }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toStartWith(
      "Milvus refused the Load of collection noidx with code 700 (IndexNotExist).",
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "LOAD",
      target: "noidx",
      container: "default",
      user: "ada",
      engineUser: "reader",
      result: "failure",
      reason: "maintenance_execution_failed",
    });
  });

  test("a Release is audited as RELEASE", async () => {
    const connection = await serve();
    const response = await maintenance(
      post("/api/db/maintenance", { connection, type: "release", target: "docs_int64", container: "default" }),
    );
    expect(response.status).toBe(200);
    expect(auditEvents[0]).toMatchObject({
      action: "RELEASE",
      target: "docs_int64",
      container: "default",
      result: "success",
    });
    expect(methods()).toEqual(["releaseCollection"]);
  });

  test("the row of a token connection records the word token, a user:password token its user and nothing after the colon, and no credential no principal", async () => {
    const token = await serve({ ...CONNECTION, password: TEST_TOKEN });
    await maintenance(
      post("/api/db/maintenance", { connection: token, type: "release", target: "docs_int64", container: "default" }),
    );
    expect(auditEvents[0]).toMatchObject({ engineUser: "token" });

    auditEvents.length = 0;
    const pair = await serve({ ...CONNECTION, password: `reader:${TEST_PASSWORD}` });
    await maintenance(
      post("/api/db/maintenance", { connection: pair, type: "release", target: "docs_int64", container: "default" }),
    );
    expect(auditEvents[0]).toMatchObject({ engineUser: "reader" });
    expect(JSON.stringify(auditEvents)).not.toContain(TEST_PASSWORD);

    auditEvents.length = 0;
    const open = await serve();
    await maintenance(
      post("/api/db/maintenance", { connection: open, type: "release", target: "docs_int64", container: "default" }),
    );
    expect("engineUser" in auditEvents[0]).toBe(false);
  });

  test("Load with no target is refused by the route: it runs against one collection at a time", async () => {
    const connection = await serve();
    const response = await maintenance(post("/api/db/maintenance", { connection, type: "load" }));
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      "Load requires a target on this database: it runs against one object at a time.",
    );
    expect(client.calls).toEqual([]);
  });
});

describe("POST /api/db/maintenance/preview", () => {
  test("a user is refused with 403 and an audit row, and nothing is read", async () => {
    const connection = await serve();
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "ulf" }));
    const response = await preview(
      post("/api/db/maintenance/preview", { connection, type: "load", target: "docs_int64", container: "default" }),
    );
    expect(response.status).toBe(403);
    expect(auditEvents).toHaveLength(1);
    expect(client.calls).toEqual([]);
  });

  test("an admin's preview answers the facts with read calls only: no load and no release", async () => {
    const connection = await serve();
    const response = await preview(
      post("/api/db/maintenance/preview", { connection, type: "load", target: "docs_int64", container: "default" }),
    );
    expect(response.status).toBe(200);
    const body = await parseResponseJSON<{ preview: { facts: { label: string }[]; refusal?: string } }>(response);
    expect(body.preview.facts.map((fact) => fact.label)).toContain("Query-node memory");
    expect(body.preview.refusal).toBeUndefined();
    expect(methods()).not.toContain("loadCollection");
    expect(methods()).not.toContain("releaseCollection");
    expect(auditEvents).toEqual([]);
  });

  test("an unknown collection is refused with the collection sentence after exactly one DescribeCollection", async () => {
    const connection = await serve();
    const response = await preview(
      post("/api/db/maintenance/preview", { connection, type: "release", target: "gone", container: "default" }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toStartWith(
      "Collection gone does not exist in database default.",
    );
    expectCalls(client, [{ method: "describeCollection", args: ["default", { collection_name: "gone" }] }]);
  });
});

describe("POST /api/db/cancel", () => {
  test("two runs in flight are cancelled independently by their ids, and an unknown id answers false", async () => {
    const connection = await serve();
    client.hold("query");
    const first = provider.query(QUERY, [], "q-1759400000000-a").catch((error: unknown) => error);
    const second = provider.query(QUERY, [], "q-1759400000000-b").catch((error: unknown) => error);
    await settle();
    const cancelled = await cancel(post("/api/db/cancel", { connection, queryId: "q-1759400000000-a" }) as never);
    expect(await parseResponseJSON<{ cancelled: boolean }>(cancelled)).toEqual({ cancelled: true });
    expect(await first).toBeInstanceOf(QueryCancelledError);
    expect(client.inFlight()).toBe(1);
    const unknown = await cancel(post("/api/db/cancel", { connection, queryId: "q-1759400000000-z" }) as never);
    expect(await parseResponseJSON<{ cancelled: boolean }>(unknown)).toEqual({ cancelled: false });
    const other = await cancel(post("/api/db/cancel", { connection, queryId: "q-1759400000000-b" }) as never);
    expect(await parseResponseJSON<{ cancelled: boolean }>(other)).toEqual({ cancelled: true });
    expect(await second).toBeInstanceOf(QueryCancelledError);
    expect(client.inFlight()).toBe(0);
  });

  test("an id that has ended answers false, and a user may cancel: the route asks for a session, not for a role", async () => {
    const connection = await serve();
    await provider.query(QUERY, [], "q-1759400000000-c");
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "ulf" }));
    const response = await cancel(post("/api/db/cancel", { connection, queryId: "q-1759400000000-c" }) as never);
    expect(response.status).toBe(200);
    expect(await parseResponseJSON<{ cancelled: boolean }>(response)).toEqual({ cancelled: false });
  });
});
