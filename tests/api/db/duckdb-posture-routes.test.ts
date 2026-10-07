/**
 * Every route that opens a provider hands it the DuckDB file-access posture the session and the
 * resolved connection decide (non-admin DuckDB file access), never a constant and never nothing.
 *
 * `tests/api/db/duckdb-file-access.test.ts` proves the posture end to end on the routes that run a
 * caller's statement. This file holds the other half: each handle-opening route passes
 * `editorExecutionContext(session, connection)` to the factory, so a route that forged the admin
 * posture, took it from the request body, or dropped the argument and so took the admin's file access
 * away, fails here by name.
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
import { resetCache as resetSeedCache } from "@/lib/seed";
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

describe("each handle-opening route passes the posture the session and the connection decide (non-admin DuckDB file access)", () => {
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

/**
 * Every spelling of the admin posture a request body could carry: the execution context's own field,
 * a nested execution object, and a role beside the session's. A route that read any of them would hand
 * a standard user full file access, the discovery export included, so none may reach the factory.
 */
const FORGED_POSTURE = { allowExternalFileAccess: true, execution: { allowExternalFileAccess: true }, role: "admin" };

/** The request with the forged posture at its top level and inside its connection, which also claims `roles: [admin]`. */
function forged(target: Record<string, unknown>): Record<string, unknown> {
  const connection = target.connection as Record<string, unknown>;
  return { ...target, ...FORGED_POSTURE, connection: { ...connection, ...FORGED_POSTURE, roles: ["admin"] } };
}

/** The shared seed claimed inline, the way a browser copy of a `managed: false` seed arrives. */
const SHARED_SEED_CLAIM = {
  connection: { id: "seed:duck-shared", name: "Shared", type: "duckdb", database: join(workDir, "shared.duckdb") },
};

describe("no route takes the posture from the request body (non-admin DuckDB file access)", () => {
  test.each(OPEN_TO_EVERY_ROLE)(
    "%s: a user's body claiming the full reach still gets the denied posture",
    async (route) => {
      role = "user";
      expect(await postureFrom(route, forged(INLINE))).toEqual({ allowExternalFileAccess: false });
    },
  );

  test.each(ROUTES)("%s: an admin's body cannot narrow a shared seed's audience to admins", async (route) => {
    // The body claims the seed id with `roles: [admin]`, which would give the admin the full reach if it
    // were believed; the operator's record, offered to every role, decides instead.
    role = "admin";
    expect(await postureFrom(route, forged(SHARED_SEED_CLAIM))).toEqual({ allowExternalFileAccess: false });
  });

  test.each(ROUTES)(
    "%s: an empty connectionId does not turn a shared seed claim into the caller's own record",
    async (route) => {
      // An empty id is falsy but not nullish; were it kept, the claim would be dropped and the body's
      // `roles: [admin]` would decide the posture.
      role = "admin";
      const response = await handlers[route](
        createMockRequest(`/api/db/${route}`, {
          method: "POST",
          body: { ...forged(SHARED_SEED_CLAIM), connectionId: "", ...EXTRA[route] },
        }) as never,
      );
      expect(response.status).toBe(400);
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(mockCreateDatabaseProvider).not.toHaveBeenCalled();
    },
  );
});

describe("POST /api/admin/fleet-health passes the same posture for each connection it checks (non-admin DuckDB file access)", () => {
  async function fleetPosture(
    connection: Record<string, unknown>,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    role = "admin";
    await fleetHealth(
      createMockRequest("/api/admin/fleet-health", {
        method: "POST",
        body: { ...body, connections: [connection] },
      }) as never,
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

  test("an unmanaged copy of a seed every role can use is resolved, so its body cannot narrow the audience", async () => {
    // A `managed: false` seed reaches the browser with its `seed:` id, and the dashboard sends that copy
    // back. Its `roles: [admin]` is the body's claim; the operator offers the seed to every role.
    expect(await fleetPosture({ ...SHARED_SEED_CLAIM.connection, roles: ["admin"] })).toEqual({
      allowExternalFileAccess: false,
    });
  });

  test("an unmanaged copy of a seed that no longer exists is an error row, and no handle is opened", async () => {
    role = "admin";
    const response = await fleetHealth(
      createMockRequest("/api/admin/fleet-health", {
        method: "POST",
        body: {
          connections: [{ id: "seed:duck-gone", name: "Gone", type: "duckdb", database: join(workDir, "gone.duckdb") }],
        },
      }) as never,
    );
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: Array<{ status: string; error?: string }> };
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("error");
    expect(results[0].error).toMatch(/not found/i);
    expect(mockGetOrCreateProvider.mock.calls.length).toBe(0);
  });

  test("a forged posture on the request or on a managed seed is ignored", async () => {
    const managedShared = {
      id: "seed:duck-shared",
      name: "Shared",
      type: "duckdb",
      managed: true,
      seedId: "duck-shared",
    };
    expect(await fleetPosture({ ...managedShared, ...FORGED_POSTURE, roles: ["admin"] }, FORGED_POSTURE)).toEqual({
      allowExternalFileAccess: false,
    });
  });
});
