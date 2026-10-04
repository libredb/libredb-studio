/**
 * Every route that opens a provider hands it the DuckDB file-access posture the session and the
 * resolved connection decide (B1 / K1), never a constant and never nothing.
 *
 * `tests/api/db/duckdb-file-access.test.ts` proves the posture end to end on the routes that run a
 * caller's statement. This file holds the other half: each handle-opening route passes
 * `editorExecutionContext(session, connection)` to the factory, so a route that forged the admin
 * posture, or dropped the argument and so took the admin's file access away, fails here by name.
 *
 * The factory is replaced, so what each route hands it is read back from the mock; the session,
 * the seed loader and `resolveConnection` are the real ones, so a seed resolves to the record the
 * product builds. Each request carries only the fields its route checks before opening a provider.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actualDb from "@/lib/db";
import * as actualFactory from "@/lib/db/factory";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetCache as resetSeedCache } from "@/lib/seed/config-loader";
import { createMockProvider } from "../../helpers/mock-provider";
import { createMockRequest } from "../../helpers/mock-next";

const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async (...args: unknown[]) => {
  void args;
  return mockProvider;
});
const mockCreateDatabaseProvider = mock(async (...args: unknown[]) => {
  void args;
  return mockProvider;
});
const mockFindOpenSingleWriterProvider = mock((...args: unknown[]) => {
  void args;
  return null;
});

let role = "user";
const mockGetSession = mock(async () => ({ role, username: role }));

// The spread form, not a hand-written stub: only getSession is replaced (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
mock.module("@/lib/db", () => ({
  ...actualDb,
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mockCreateDatabaseProvider,
}));
mock.module("@/lib/db/factory", () => ({
  ...actualFactory,
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mockCreateDatabaseProvider,
  findOpenSingleWriterProvider: mockFindOpenSingleWriterProvider,
  isSingleWriterFileOpen: mock(() => false),
}));

type Handler = (request: never) => Promise<Response>;

const handlers: Record<string, Handler> = {
  query: (await import("@/app/api/db/query/route")).POST as Handler,
  "multi-query": (await import("@/app/api/db/multi-query/route")).POST as Handler,
  transaction: (await import("@/app/api/db/transaction/route")).POST as Handler,
  profile: (await import("@/app/api/db/profile/route")).POST as Handler,
  monitoring: (await import("@/app/api/db/monitoring/route")).POST as Handler,
  health: (await import("@/app/api/db/health/route")).POST as Handler,
  cancel: (await import("@/app/api/db/cancel/route")).POST as Handler,
  "pool-stats": (await import("@/app/api/db/pool-stats/route")).POST as Handler,
  maintenance: (await import("@/app/api/db/maintenance/route")).POST as Handler,
  "maintenance/preview": (await import("@/app/api/db/maintenance/preview/route")).POST as Handler,
  "objects/containers": (await import("@/app/api/db/objects/containers/route")).POST as Handler,
  "objects/counts": (await import("@/app/api/db/objects/counts/route")).POST as Handler,
  "objects/describe": (await import("@/app/api/db/objects/describe/route")).POST as Handler,
  "objects/edit-apply": (await import("@/app/api/db/objects/edit-apply/route")).POST as Handler,
  "objects/edit-plan": (await import("@/app/api/db/objects/edit-plan/route")).POST as Handler,
  "objects/inventory": (await import("@/app/api/db/objects/inventory/route")).POST as Handler,
  "objects/list": (await import("@/app/api/db/objects/list/route")).POST as Handler,
  "objects/search": (await import("@/app/api/db/objects/search/route")).POST as Handler,
  "objects/source": (await import("@/app/api/db/objects/source/route")).POST as Handler,
  "keys/scan": (await import("@/app/api/db/keys/scan/route")).POST as Handler,
  "provider-meta": (await import("@/app/api/db/provider-meta/route")).POST as Handler,
  "test-connection": (await import("@/app/api/db/test-connection/route")).POST as Handler,
};
const fleetHealth = (await import("@/app/api/admin/fleet-health/route")).POST as Handler;

/** The fields each route checks before it opens a provider; every other route needs none. */
const EXTRA: Record<string, Record<string, unknown>> = {
  query: { sql: "SELECT 1" },
  "multi-query": { sql: "SELECT 1" },
  transaction: { action: "begin" },
  profile: { tablePath: ["main", "t"] },
  monitoring: {},
  cancel: { queryId: "q-1" },
  maintenance: { type: "vacuum" },
  "maintenance/preview": { type: "vacuum", target: "t" },
};

/** The routes refused to every role but admin before any provider is opened. */
const ADMIN_ONLY = new Set(["maintenance", "maintenance/preview"]);

/** The routes that build their own provider rather than take a cached one. */
const BUILDS_ITS_OWN = new Set(["provider-meta", "test-connection"]);

const workDir = mkdtempSync(join(tmpdir(), "libredb-duckdb-posture-routes-"));
const seedConfigFile = join(workDir, "seed-connections.json");
writeFileSync(
  seedConfigFile,
  JSON.stringify({
    version: "1",
    connections: [
      { id: "duck-shared", name: "Shared", type: "duckdb", database: join(workDir, "shared.duckdb"), roles: ["*"] },
      { id: "duck-admin", name: "Admin", type: "duckdb", database: join(workDir, "admin.duckdb"), roles: ["admin"] },
    ],
  }),
);
const previousSeedConfigPath = process.env.SEED_CONFIG_PATH;
process.env.SEED_CONFIG_PATH = seedConfigFile;

const INLINE = {
  connection: { id: "inline-duck", name: "Inline", type: "duckdb", database: join(workDir, "inline.duckdb") },
};

/** What the route handed the factory as its third argument, the execution context. */
async function postureFrom(route: string, target: Record<string, unknown>): Promise<unknown> {
  await handlers[route](
    createMockRequest(`/api/db/${route}`, { method: "POST", body: { ...target, ...EXTRA[route] } }) as never,
  );
  const calls = BUILDS_ITS_OWN.has(route) ? mockCreateDatabaseProvider.mock.calls : mockGetOrCreateProvider.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]?.[2];
}

beforeEach(() => {
  clearRateLimitState();
  resetSeedCache();
  mockGetOrCreateProvider.mockClear();
  mockCreateDatabaseProvider.mockClear();
  mockFindOpenSingleWriterProvider.mockClear();
});

afterAll(() => {
  if (previousSeedConfigPath === undefined) delete process.env.SEED_CONFIG_PATH;
  else process.env.SEED_CONFIG_PATH = previousSeedConfigPath;
  resetSeedCache();
  rmSync(workDir, { recursive: true, force: true });
});

const ROUTES = Object.keys(handlers);
const OPEN_TO_EVERY_ROLE = ROUTES.filter((route) => !ADMIN_ONLY.has(route));

describe("each handle-opening route passes the posture the session and the connection decide (B1/K1)", () => {
  test.each(OPEN_TO_EVERY_ROLE)("%s: a user's inline DuckDB connection is denied file access", async (route) => {
    role = "user";
    expect(await postureFrom(route, INLINE)).toEqual({ allowExternalFileAccess: false });
  });

  test.each(ROUTES)("%s: an admin's inline DuckDB connection keeps the full reach", async (route) => {
    role = "admin";
    expect(await postureFrom(route, INLINE)).toEqual({ allowExternalFileAccess: true });
  });

  test.each(ROUTES)("%s: an admin on a seed every role can use is denied too", async (route) => {
    role = "admin";
    expect(await postureFrom(route, { connectionId: "seed:duck-shared" })).toEqual({ allowExternalFileAccess: false });
  });

  test.each(ROUTES)("%s: an admin on a seed only admins can use keeps the full reach", async (route) => {
    role = "admin";
    expect(await postureFrom(route, { connectionId: "seed:duck-admin" })).toEqual({ allowExternalFileAccess: true });
  });

  test("test-connection asks the single-writer borrow under the same posture", async () => {
    role = "user";
    await postureFrom("test-connection", INLINE);
    expect(mockFindOpenSingleWriterProvider.mock.calls[0]?.[1]).toBe(false);

    mockFindOpenSingleWriterProvider.mockClear();
    mockCreateDatabaseProvider.mockClear();
    role = "admin";
    await postureFrom("test-connection", INLINE);
    expect(mockFindOpenSingleWriterProvider.mock.calls[0]?.[1]).toBe(true);
  });
});

describe("POST /api/admin/fleet-health passes the same posture for each connection it checks (B1/K1)", () => {
  async function fleetPosture(connection: Record<string, unknown>): Promise<unknown> {
    role = "admin";
    await fleetHealth(
      createMockRequest("/api/admin/fleet-health", { method: "POST", body: { connections: [connection] } }) as never,
    );
    expect(mockGetOrCreateProvider.mock.calls.length).toBe(1);
    return mockGetOrCreateProvider.mock.calls[0]?.[2];
  }

  test("an inline DuckDB connection keeps the admin's full reach", async () => {
    expect(await fleetPosture(INLINE.connection)).toEqual({ allowExternalFileAccess: true });
  });

  test("a managed seed every role can use is resolved, and denied", async () => {
    expect(
      await fleetPosture({
        id: "seed:duck-shared",
        name: "Shared",
        type: "duckdb",
        managed: true,
        seedId: "duck-shared",
      }),
    ).toEqual({ allowExternalFileAccess: false });
  });
});
