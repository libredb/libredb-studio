import { describe, test, expect, mock, beforeEach } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  INVENTORY_LIMIT,
  INVENTORY_PAIR_LIMIT,
  ObjectRouteError,
  handleObjectRequest,
  readBoundedJson,
  type ObjectRequestContext,
} from "@/lib/api/object-route";
import { SOURCE_CHARACTER_LIMIT, SOURCE_PART_LIMIT, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
// The CLIENT's shape check, imported into the route's own suite on purpose: the route carries a
// refusal sentence through untouched and the client refuses that document, and one test pinning
// both ends is the only thing that keeps the pair from drifting into a contradiction (#789).
import { isSourceDocumentShape } from "@/components/object-source/source-reader";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { QueryError } from "@/lib/db/errors";
import type {
  Container,
  ContainerLevels,
  ContainerLevelSpec,
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  TimeoutError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";

// NOTE: the mocks below are inline rather than in a shared helper, and the request is built by
// `createMockRequest` with the session supplied by a mocked `@/lib/auth`. That is the ONE pattern
// every file under tests/api/ already uses; `tests/api/db/schema-list.test.ts` records why
// (bun's `mock.module()` is scoped per test FILE, so hoisting these into a helper breaks
// re-application). The brief's `tests/helpers/authed-request.ts` would be a second pattern for the
// same job, so it is deliberately not introduced.

let activeProvider: DatabaseProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => activeProvider);

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }) as unknown);
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
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
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection ?? { id: "seed-1", name: "Seeded", type: "postgres" };
    }),
    SeedConnectionError,
  };
});

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
  isRetryableError,
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

const containersRoute = await import("@/app/api/db/objects/containers/route");
const countsRoute = await import("@/app/api/db/objects/counts/route");
const listRoute = await import("@/app/api/db/objects/list/route");
const describeRoute = await import("@/app/api/db/objects/describe/route");
const searchRoute = await import("@/app/api/db/objects/search/route");
const inventoryRoute = await import("@/app/api/db/objects/inventory/route");
const sourceRoute = await import("@/app/api/db/objects/source/route");
const editPlanRoute = await import("@/app/api/db/objects/edit-plan/route");
const editApplyRoute = await import("@/app/api/db/objects/edit-apply/route");

/**
 * The NINE handlers KEYED BY THE DIRECTORY each one lives in, so the census can be checked
 * against `src/app/api/db/objects/` rather than against itself.
 *
 * SEVEN became NINE with #789 Phase 3's two edit routes, and the numeral moved WITH ITS BASIS
 * rather than as a bare digit: the basis is the route directories under
 * `src/app/api/db/objects/`, which is what the test below reads from disk, and
 * `src/lib/api/rate-limit.ts` and `src/lib/api/object-route.ts` carry the same census and moved
 * with it. A numeral left behind by its basis is this epic's stale-numeral defect.
 *
 * The two are FLAT SIBLINGS and never `objects/edit/plan`. A nested pair would leave `edit/` with
 * no `route.ts`, the enumeration below would filter it out, and two new provider-reaching routes
 * would be uncensused and unasserted for the 401 path while this census kept passing.
 */
const objectRoutes: Record<string, { POST: (req: never) => Promise<Response> }> = {
  containers: containersRoute,
  counts: countsRoute,
  list: listRoute,
  describe: describeRoute,
  search: searchRoute,
  inventory: inventoryRoute,
  source: sourceRoute,
  "edit-plan": editPlanRoute,
  "edit-apply": editApplyRoute,
};

const OBJECT_ROUTE_DIR = path.resolve(import.meta.dir, "../..", "src/app/api/db/objects");

// ============================================================================
// Fixtures
// ============================================================================

const connection = { id: "test-1", name: "Test DB", type: "postgres", host: "localhost", database: "testdb" };

const SCHEMA_LEVEL: ContainerLevelSpec = { id: "schema", label: "Schema", labelPlural: "Schemas" };
const CATALOG_LEVEL: ContainerLevelSpec = { id: "catalog", label: "Catalog", labelPlural: "Catalogs" };

const TABLE_KIND: ObjectKindSpec = { id: "table", role: "relation", label: "Table", labelPlural: "Tables" };
const VIEW_KIND: ObjectKindSpec = { id: "view", role: "relation", label: "View", labelPlural: "Views" };

interface ProviderShape {
  type?: DatabaseProvider["type"];
  containerLevels?: ContainerLevels;
  objectKinds?: readonly ObjectKindSpec[];
  listContainers?: DatabaseProvider["listContainers"];
  countObjects?: DatabaseProvider["countObjects"];
  listObjects?: DatabaseProvider["listObjects"];
  describeObject?: DatabaseProvider["describeObject"];
  describeObjects?: DatabaseProvider["describeObjects"];
  readObjectSource?: DatabaseProvider["readObjectSource"];
}

/** A provider that declares one schema level and two kinds unless the test says otherwise. */
function objectProvider(shape: ProviderShape = {}): DatabaseProvider {
  const provider = createMockProvider({
    type: shape.type,
    capabilities: {
      containerLevels: shape.containerLevels ?? [SCHEMA_LEVEL],
      objectKinds: shape.objectKinds ?? [TABLE_KIND, VIEW_KIND],
    },
  });
  if (shape.listContainers) provider.listContainers = shape.listContainers;
  if (shape.countObjects) provider.countObjects = shape.countObjects;
  if (shape.listObjects) provider.listObjects = shape.listObjects;
  if (shape.describeObject) provider.describeObject = shape.describeObject;
  if (shape.describeObjects) provider.describeObjects = shape.describeObjects;
  if (shape.readObjectSource) provider.readObjectSource = shape.readObjectSource;
  return provider;
}

function object(path: readonly string[], kind: string): DatabaseObject {
  return { path, name: path[path.length - 1], kind };
}

const emptyDetail = (path: readonly string[]): ObjectDetail => ({
  path,
  columns: [],
  indexes: [],
  foreignKeys: [],
});

beforeEach(() => {
  clearRateLimitState();
  mockGetSession.mockClear();
  mockGetOrCreateProvider.mockClear();
  activeProvider = objectProvider();
});

// ============================================================================
// The guard, and the ordering it depends on
// ============================================================================

describe("the shared guard", () => {
  test("refuses a caller with no session before parsing the body", async () => {
    mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });

    // No body at all. A route that parsed first would answer 400 "Empty request body", so a 401
    // here is evidence of the ordering and not just of the denial.
    const response = await countsRoute.POST(
      new Request("http://localhost:3000/api/db/objects/counts", { method: "POST" }) as never,
    );

    expect(response.status).toBe(401);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Authentication required");
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test("every route directory under api/db/objects is censused, and every one refuses an unauthenticated caller", async () => {
    // Derived from the DIRECTORY rather than from the array literal this replaced. That literal
    // certified only what it happened to hold: deleting one handler from it left this file at
    // 71 pass, 0 fail with the test still naming a count, so an eighth route could have landed
    // uncensused. The population is now the filesystem, and a route directory with no handler
    // here fails by name (#789).
    const directories = readdirSync(OBJECT_ROUTE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(OBJECT_ROUTE_DIR, entry.name, "route.ts")))
      .map((entry) => entry.name)
      .sort();

    // The zero-iteration case certifies nothing, so it is refused BY NAME: a readdir that found
    // no route directory would otherwise run the loop below zero times and pass.
    if (directories.length === 0) {
      throw new Error(`no route.ts found under ${OBJECT_ROUTE_DIR}, so this census would certify nothing`);
    }
    expect(Object.keys(objectRoutes).sort()).toEqual(directories);

    for (const name of directories) {
      if (!Object.hasOwn(objectRoutes, name)) {
        throw new Error(`this census holds no handler for src/app/api/db/objects/${name}/route.ts`);
      }
      mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });
      const response = await objectRoutes[name].POST(
        new Request("http://localhost:3000/api/db/objects/x", { method: "POST" }) as never,
      );
      expect(response.status).toBe(401);
    }
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test("refuses an unparseable body", async () => {
    const response = await countsRoute.POST(
      new Request("http://localhost:3000/api/db/objects/counts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Empty request body");
  });

  test("refuses an empty JSON object body", async () => {
    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: {} }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Empty request body");
  });

  test("refuses a body that names neither a connection nor a connection id", async () => {
    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: { container: ["app"] } }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("connectionId");
  });

  test("refuses a resolved connection with no type", async () => {
    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection: { id: "x", name: "No type" }, container: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("Valid connection configuration");
  });

  test("maps a provider error through the shared error mapper", async () => {
    activeProvider = objectProvider({
      countObjects: mock(async () => {
        throw new QueryError("relation does not exist", "postgres");
      }),
    });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("relation does not exist");
  });

  test("maps an unexpected error to 500", async () => {
    activeProvider = objectProvider({
      countObjects: mock(async () => {
        throw new Error("socket hang up");
      }),
    });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(500);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe("socket hang up");
  });
});

// ============================================================================
// containers
// ============================================================================

describe("POST /api/db/objects/containers", () => {
  test("lists the top level when no parent is given", async () => {
    const listContainers = mock(async (): Promise<Container[]> => [{ path: ["app"], name: "app", level: 0 }]);
    activeProvider = objectProvider({ listContainers });

    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", { method: "POST", body: { connection } }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<Container[]>(response)).toEqual([{ path: ["app"], name: "app", level: 0 }]);
    expect(listContainers).toHaveBeenCalledWith(undefined);
  });

  test("passes a parent through at a depth the engine declares", async () => {
    const listContainers = mock(async (): Promise<Container[]> => []);
    activeProvider = objectProvider({ containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL], listContainers });

    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", {
        method: "POST",
        body: { connection, parent: ["main"] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listContainers).toHaveBeenCalledWith(["main"]);
  });

  test("refuses a parent deeper than the engine declares", async () => {
    const listContainers = mock(async (): Promise<Container[]> => []);
    activeProvider = objectProvider({ listContainers });

    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", {
        method: "POST",
        body: { connection, parent: ["app", "nested"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("container depth");
    expect(listContainers).toHaveBeenCalledTimes(0);
  });

  test("refuses a parent that is not an array of strings", async () => {
    // ONE segment, so the depth check cannot fire and the shape check is the only thing that can
    // refuse this. Written as `["app", null]` first, it passed against a shape check that only
    // called `Array.isArray`: the depth check answered it instead, and the assertion was vacuous.
    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", {
        method: "POST",
        body: { connection, parent: [null] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"parent" must be an array of path segments',
    );
  });
});

// ============================================================================
// counts
// ============================================================================

describe("POST /api/db/objects/counts", () => {
  test("returns the per-kind counts for one container", async () => {
    const counts: Record<string, KindCount> = { table: { count: 3 }, view: { unavailable: "permission denied" } };
    const countObjects = mock(async () => counts);
    activeProvider = objectProvider({ countObjects });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<Record<string, KindCount>>(response)).toEqual(counts);
    expect(countObjects).toHaveBeenCalledWith(["app"]);
  });

  test("refuses a container path deeper than the engine declares", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({ countObjects });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connectionId: "pg", container: ["app", "nested"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON(response)).toMatchObject({ error: expect.stringContaining("container depth") });
    expect(countObjects).toHaveBeenCalledTimes(0);
  });

  test("carries no code on a 400, so the two refusal shapes stay distinguishable", async () => {
    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["app", "nested"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON(response)).not.toHaveProperty("code");
  });

  test("refuses a missing container", async () => {
    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: { connection } }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"container" must be an array of path segments',
    );
  });

  test("refuses a container that is a string rather than a path", async () => {
    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: "app" },
      }) as never,
    );

    expect(response.status).toBe(400);
    // The exact message, not just the word: a string container has a `.length` of its own, so
    // dropping the shape check would still produce a 400 from the DEPTH check and a loose
    // assertion would not notice.
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"container" must be an array of path segments',
    );
  });
});

// ============================================================================
// list
// ============================================================================

describe("POST /api/db/objects/list", () => {
  test("returns the objects of one kind in one container", async () => {
    const listObjects = mock(async () => [object(["app", "orders"], "table")]);
    activeProvider = objectProvider({ listObjects });

    const response = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["app"], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<DatabaseObject[]>(response)).toEqual([
      { path: ["app", "orders"], name: "orders", kind: "table" },
    ]);
    expect(listObjects).toHaveBeenCalledWith(["app"], "table");
  });

  test("refuses a container deeper than the engine declares", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({ listObjects });

    const response = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["app", "nested"], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("container depth");
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  test("refuses a missing kind", async () => {
    activeProvider = objectProvider({ listObjects: mock(async () => []) });

    const response = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("kind");
  });

  test("refuses an empty kind", async () => {
    activeProvider = objectProvider({ listObjects: mock(async () => []) });

    const response = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["app"], kind: "   " },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("kind");
  });

  test("trims the kind before it reaches the catalog lookup", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({ listObjects });

    await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["app"], kind: "  table  " },
      }) as never,
    );

    expect(listObjects).toHaveBeenCalledWith(["app"], "table");
  });
});

// ============================================================================
// describe
// ============================================================================

describe("POST /api/db/objects/describe", () => {
  test("passes the kind alongside the path, because the provider branches on it", async () => {
    const detail: ObjectDetail = {
      path: ["app", "orders"],
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
    };
    const describeObject = mock(async () => detail);
    activeProvider = objectProvider({ describeObject });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: ["app", "orders"], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<ObjectDetail>(response)).toEqual(detail);
    expect(describeObject).toHaveBeenCalledWith(["app", "orders"], "table");
  });

  test("refuses an empty path", async () => {
    activeProvider = objectProvider({ describeObject: mock(async () => emptyDetail([])) });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: [], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"path" must name an object, and an empty path names none',
    );
  });

  test("refuses a missing kind, since the one-argument form is dead", async () => {
    activeProvider = objectProvider({ describeObject: mock(async () => emptyDetail(["app", "orders"])) });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: ["app", "orders"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("kind");
  });

  test("answers the provider's ObjectDetail verbatim, indexes and foreign keys included", async () => {
    // The object tree reads only the COLUMNS out of this answer, and the route still hands the
    // whole detail over unreshaped, which is what lets a later phase draw the indexes and the
    // foreign keys with no second round trip. Asserted with all three arrays non-empty rather
    // than with the columns alone: a route that dropped either of the other two would still pass
    // the column-only comparison above.
    const detail: ObjectDetail = {
      path: ["app", "orders"],
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimary: true },
        { name: "total", type: "numeric(12,2)", nullable: true, isPrimary: false, defaultValue: "0" },
      ],
      indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
    };
    activeProvider = objectProvider({ describeObject: mock(async () => detail) });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: ["app", "orders"], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<ObjectDetail>(response)).toEqual(detail);
  });

  test("answers three empty arrays for a kind that has no columns, rather than refusing", async () => {
    // A kind with nothing to describe is a 200 carrying three empty arrays, and that is a
    // contract the tree depends on rather than an accident: the twisty is gated on the kind's own
    // `hasColumns` declaration and never on the answer, so a caller that asks anyway must get an
    // answer it can render as "none" instead of the engine's-fault path. Two providers reach this
    // shape without touching the wire at all - oracle returns it for any kind whose role is not
    // `relation` (`src/lib/db/providers/sql/oracle.ts:2015-2017`) and mysql for any kind its own
    // `hasColumns` predicate rejects (`src/lib/db/providers/sql/mysql.ts:2518-2520`).
    const describeObject = mock(async () => emptyDetail(["app", "order_total(integer)"]));
    activeProvider = objectProvider({ describeObject });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: ["app", "order_total(integer)"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<ObjectDetail>(response)).toEqual({
      path: ["app", "order_total(integer)"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(describeObject).toHaveBeenCalledWith(["app", "order_total(integer)"], "function");
  });

  // An object dropped between the listing and the expand has TWO answers in the shipped fleet, and
  // the pair below is pinned so a later reader cannot assume either one is THE behaviour.
  // PostgreSQL checks for a zero-row catalog answer and raises `No detail row for ...`
  // (`src/lib/db/providers/sql/postgres.ts:3021`); oracle, mysql and couchbase have no such check
  // and answer three empty arrays, couchbase because a rejected INFER is deliberately not an error
  // (`src/lib/db/providers/document/couchbase/introspect.ts:206-215`). Both cases are driven
  // through DOUBLES over one missing path and are never asserted as a count of engines.
  const DROPPED_PATH = ["app", "orders_dropped"];

  test("maps a provider that raises for a path it cannot find to 400 QUERY_ERROR", async () => {
    activeProvider = objectProvider({
      describeObject: mock(async () => {
        throw new QueryError(`No detail row for ${DROPPED_PATH.join(".")}`, "postgres");
      }),
    });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: DROPPED_PATH, kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(400);
    const body = await parseResponseJSON<{ error: string; code: string }>(response);
    expect(body.error).toBe("No detail row for app.orders_dropped");
    expect(body.code).toBe(ApiErrorCode.QUERY_ERROR);
  });

  test("answers 200 and three empty arrays for the SAME missing path when the provider does not check", async () => {
    activeProvider = objectProvider({ describeObject: mock(async () => emptyDetail(DROPPED_PATH)) });

    const response = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: DROPPED_PATH, kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<ObjectDetail>(response)).toEqual({
      path: DROPPED_PATH,
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
  });
});

// ============================================================================
// search
// ============================================================================

describe("POST /api/db/objects/search", () => {
  function searchProvider(): DatabaseProvider {
    return objectProvider({
      listContainers: mock(async () => [
        { path: ["app"], name: "app", level: 0 },
        { path: ["ops"], name: "ops", level: 0 },
      ]),
      listObjects: mock(async (container: readonly string[], kind: string) => {
        if (kind === "table") return [object([...container, `${container[0]}_orders`], "table")];
        return [object([...container, `${container[0]}_ORDER_SUMMARY`], "view")];
      }),
    });
  }

  test("matches across every container and every declared kind, case insensitively", async () => {
    activeProvider = searchProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "OrDeR_s" } }) as never,
    );

    expect(response.status).toBe(200);
    expect((await parseResponseJSON<DatabaseObject[]>(response)).map((found) => found.path)).toEqual([
      ["app", "app_ORDER_SUMMARY"],
      ["ops", "ops_ORDER_SUMMARY"],
    ]);
  });

  test("narrows to the kinds the caller asked for", async () => {
    activeProvider = searchProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", {
        method: "POST",
        body: { connection, term: "order", kinds: ["table"] },
      }) as never,
    );

    expect((await parseResponseJSON<DatabaseObject[]>(response)).map((found) => found.kind)).toEqual([
      "table",
      "table",
    ]);
  });

  test("refuses a kind the engine does not declare rather than answering nothing", async () => {
    activeProvider = searchProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", {
        method: "POST",
        body: { connection, term: "order", kinds: ["materialized_view"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("materialized_view");
  });

  test("refuses an empty term", async () => {
    activeProvider = searchProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "  " } }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("term");
  });

  test("refuses a kinds filter that is not an array of strings", async () => {
    activeProvider = searchProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", {
        method: "POST",
        body: { connection, term: "order", kinds: "table" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("kinds");
  });

  test("searches an engine with no containers at all", async () => {
    activeProvider = objectProvider({
      containerLevels: [],
      listObjects: mock(async (container: readonly string[], kind: string) =>
        kind === "table" ? [object(["orders"], "table")] : [],
      ),
    });

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "ord" } }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<DatabaseObject[]>(response)).toEqual([
      { path: ["orders"], name: "orders", kind: "table" },
    ]);
  });

  test("walks both levels of a two-level engine", async () => {
    const listContainers = mock(async (parent?: readonly string[]) =>
      parent === undefined
        ? [{ path: ["main"], name: "main", level: 0 }]
        : [{ path: [...parent, "app"], name: "app", level: 1 }],
    );
    activeProvider = objectProvider({
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      objectKinds: [TABLE_KIND],
      listContainers,
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "orders" } }) as never,
    );

    expect(response.status).toBe(200);
    expect((await parseResponseJSON<DatabaseObject[]>(response)).map((found) => found.path)).toEqual([
      ["main", "app", "orders"],
    ]);
    expect(listContainers).toHaveBeenCalledWith(["main"]);
  });
});

// ============================================================================
// inventory
// ============================================================================

describe("POST /api/db/objects/inventory", () => {
  test("reports truncation rather than answering a slice as a whole inventory", async () => {
    const many = Array.from({ length: 6000 }, (_, index) => object(["app", `t${index}`], "table"));
    const listObjects = mock(async (_container: readonly string[], kind: string) => (kind === "table" ? many : []));
    activeProvider = objectProvider({
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects,
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    const body = await parseResponseJSON<{ objects: DatabaseObject[]; truncated: unknown }>(response);
    expect(body.objects).toHaveLength(5000);
    expect(body.truncated).toEqual({ limit: 5000, reason: "inventory limit reached" });
  });

  test("omits truncated entirely when the whole inventory fits", async () => {
    activeProvider = objectProvider({
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async (container: readonly string[], kind: string) => [
        object([...container, `${kind}_one`], kind),
      ]),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    // Read the wire form: `truncated: undefined` and an omitted key are the same bytes, and the
    // bytes are the contract this asserts.
    const text = await response.text();
    expect(text).not.toContain("truncated");
    expect(JSON.parse(text).objects).toHaveLength(2);
  });

  test("stops scanning once the limit is reached instead of listing the rest", async () => {
    const many = Array.from({ length: 5000 }, (_, index) => object(["app", `t${index}`], "table"));
    const listObjects = mock(async (_container: readonly string[], kind: string) => (kind === "table" ? many : []));
    activeProvider = objectProvider({
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects,
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    const body = await parseResponseJSON<{ objects: DatabaseObject[]; truncated: unknown }>(response);
    expect(body.objects).toHaveLength(5000);
    expect(body.truncated).toEqual({ limit: 5000, reason: "inventory limit reached" });
    // The view listing was never requested: the scan stopped at the limit.
    expect(listObjects).toHaveBeenCalledTimes(1);
  });

  test("ignores a caller-supplied limit, because no caller may ask for an unbounded read", async () => {
    const many = Array.from({ length: 6000 }, (_, index) => object(["app", `t${index}`], "table"));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () => many),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, limit: 6000 },
      }) as never,
    );

    const body = await parseResponseJSON<{ objects: DatabaseObject[]; truncated: unknown }>(response);
    expect(body.objects).toHaveLength(5000);
    expect(body.truncated).toEqual({ limit: 5000, reason: "inventory limit reached" });
  });

  test("takes the containers the caller named instead of enumerating", async () => {
    const listContainers = mock(async () => [{ path: ["app"], name: "app", level: 0 }]);
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers,
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["ops"]] },
      }) as never,
    );

    expect((await parseResponseJSON<{ objects: DatabaseObject[] }>(response)).objects.map((o) => o.path)).toEqual([
      ["ops", "orders"],
    ]);
    expect(listContainers).toHaveBeenCalledTimes(0);
  });

  // ---------------------------------------------------------------------------
  // includeColumns (#789)
  // ---------------------------------------------------------------------------
  //
  // Re-introduced as ONE `describeObjects` per container-and-kind PAIR, where the spelling
  // Task 4 removed was one `describeObject` per OBJECT, up to 5000 sequential round trips.
  // The pairs are the ones the listing loop already walks, under the same pair limit, so
  // asking for columns at most doubles the round trips rather than multiplying them.

  test("columns are not read at all unless the caller asks", async () => {
    const describeObjects = mock(async () => ({ details: [] }));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () => [object(["app", "orders"], "table")]),
      describeObjects,
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    const body = await parseResponseJSON<{ objects: DatabaseObject[]; details?: unknown }>(response);
    expect(describeObjects).toHaveBeenCalledTimes(0);
    // ABSENT, not empty: an empty array would say every object was described and none had
    // anything, which is a different claim from "nobody asked".
    expect("details" in body).toBe(false);
  });

  test("includeColumns reads the whole folder once, bounded by the objects it is handing over", async () => {
    const describeObjects = mock(async (container: readonly string[], kind: string, limit?: number) => ({
      details: [
        {
          path: [...container, "orders"],
          columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
          indexes: [],
          foreignKeys: [],
        },
      ],
      calledWith: { container, kind, limit },
    }));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () => [object(["app", "orders"], "table")]),
      describeObjects: describeObjects as unknown as DatabaseProvider["describeObjects"],
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: true },
      }) as never,
    );

    const body = await parseResponseJSON<{ objects: DatabaseObject[]; details: ObjectDetail[] }>(response);
    expect(describeObjects).toHaveBeenCalledTimes(1);
    // The bound is the number of objects this answer carries for that pair: describing more
    // would buy columns for objects the caller is not being given.
    expect(describeObjects.mock.calls[0]).toEqual([["app"], "table", 1]);
    // A SEPARATE array keyed by path, never merged onto the objects: what the engine NAMED
    // and what it could DESCRIBE are two facts.
    expect(body.objects.map((entry) => entry.path)).toEqual([["app", "orders"]]);
    expect(body.details.map((detail) => detail.path)).toEqual([["app", "orders"]]);
    expect(body.details[0].columns).toHaveLength(1);
  });

  test("a pair that named nothing buys no round trip", async () => {
    const describeObjects = mock(async () => ({ details: [] }));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND, VIEW_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async (_container: readonly string[], kind: string) =>
        kind === "table" ? [object(["app", "orders"], "table")] : [],
      ),
      describeObjects,
    });

    await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: true },
      }) as never,
    );

    // One call, for the kind that listed something. The empty folder is not described.
    expect(describeObjects).toHaveBeenCalledTimes(1);
  });

  test("a provider that bounded its own column read says so, in its own words", async () => {
    // Reported even though the LISTING fitted: a complete list of objects whose columns were
    // cut is still an incomplete answer, and a reader that trusted it would read a missing
    // column as an absent one.
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () => [object(["app", "orders"], "table")]),
      describeObjects: mock(async () => ({
        details: [],
        truncated: { limit: 1, reason: "the bulk column read was bounded at 1 object by its caller" },
      })),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: true },
      }) as never,
    );

    const body = await parseResponseJSON<{ truncated?: { limit: number; reason: string } }>(response);
    expect(body.truncated).toEqual({
      limit: 1,
      reason: "the bulk column read was bounded at 1 object by its caller",
    });
  });

  /**
   * The precedence, stated because the code used to have none: the last describe bound simply
   * overwrote whatever was recorded before it, a pair limit and an object limit included.
   *
   * A MISSING OBJECT outranks a missing COLUMN. The reader of this answer, the agent, treats an
   * object it was not shown as an object the database does not hold (#414), while a short column
   * read still names every object. So the object limit wins, then the pair limit, then the
   * provider's own column bound.
   */
  test("an object overflow outranks a column bound reported in the same pair", async () => {
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () =>
        Array.from({ length: INVENTORY_LIMIT + 1 }, (_unused, index) => object(["app", `t${index}`], "table")),
      ),
      describeObjects: mock(async () => ({
        details: [],
        truncated: { limit: 1, reason: "the bulk column read was bounded at 1 object by its caller" },
      })),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: true },
      }) as never,
    );

    const body = await parseResponseJSON<{ truncated?: { limit: number; reason: string } }>(response);
    expect(body.truncated).toEqual({ limit: INVENTORY_LIMIT, reason: "inventory limit reached" });
  });

  test("a pair overflow outranks a column bound, because both objects and columns are missing", async () => {
    const containers = Array.from({ length: INVENTORY_PAIR_LIMIT + 1 }, (_unused, index) => ({
      path: [`c${index}`],
      name: `c${index}`,
      level: 0,
    }));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => containers),
      listObjects: mock(async (container: readonly string[]) => [object([container[0], "orders"], "table")]),
      describeObjects: mock(async () => ({
        details: [],
        truncated: { limit: 1, reason: "the bulk column read was bounded at 1 object by its caller" },
      })),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: true },
      }) as never,
    );

    const body = await parseResponseJSON<{ truncated?: { limit: number; reason: string } }>(response);
    expect(body.truncated).toEqual({
      limit: INVENTORY_PAIR_LIMIT,
      reason: "container and kind pair limit reached",
    });
  });

  test("includeDefaultSql asks describeObjects for default SQL, and only then is an options argument passed", async () => {
    // #1031: MySQL's catalog spells a default as a value, so the SQL text costs one DDL read per
    // table. Only SchemaDiff asks. The call without the flag is byte-for-byte the call above.
    const describeObjects = mock<DatabaseProvider["describeObjects"]>(async () => ({ details: [] }));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () => [object(["app", "orders"], "table")]),
      describeObjects,
    });

    await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: true, includeDefaultSql: true },
      }) as never,
    );

    expect(describeObjects.mock.calls[0]).toEqual([["app"], "table", 1, { defaultSql: true }]);
  });

  test.each([
    [
      "is not a boolean",
      { includeColumns: true, includeDefaultSql: "true" },
      '"includeDefaultSql" must be true or false',
    ],
    [
      "comes without includeColumns, where there is no column to carry it",
      { includeDefaultSql: true },
      '"includeDefaultSql" needs "includeColumns": default SQL is carried on the columns',
    ],
  ])("includeDefaultSql that %s is a caller mistake", async (_label, flags, error) => {
    activeProvider = objectProvider({
      listContainers: mock(async () => []),
      listObjects: mock(async () => []),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection, ...flags } }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(error);
  });

  test("includeColumns must be a boolean, and anything else is a caller mistake", async () => {
    // Answering the cheap read to a caller who is about to render an empty column list is the
    // silent degradation this surface exists to avoid.
    activeProvider = objectProvider({
      listContainers: mock(async () => []),
      listObjects: mock(async () => []),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, includeColumns: "true" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe('"includeColumns" must be true or false');
  });

  test("refuses a named container deeper than the engine declares", async () => {
    activeProvider = objectProvider({
      listContainers: mock(async () => []),
      listObjects: mock(async () => []),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["app", "nested"]] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("container depth");
  });

  test("refuses a containers value that is not a list of paths", async () => {
    activeProvider = objectProvider({ listObjects: mock(async () => []) });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"containers" must be an array of container paths',
    );
  });

  test("refuses a kind the engine does not declare", async () => {
    activeProvider = objectProvider({ listObjects: mock(async () => []) });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, kinds: ["sequence"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("sequence");
  });

  test("inventories an engine that declares no container level", async () => {
    const listObjects = mock(async (_container: readonly string[], kind: string) => [object([`${kind}_one`], kind)]);
    activeProvider = objectProvider({ containerLevels: [], objectKinds: [TABLE_KIND], listObjects });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    expect((await parseResponseJSON<{ objects: DatabaseObject[] }>(response)).objects).toEqual([
      { path: ["table_one"], name: "table_one", kind: "table" },
    ]);
    expect(listObjects).toHaveBeenCalledWith([], "table");
  });

  test("caps the container and kind fan-out, and says it did", async () => {
    // One kind, so the pair count IS the container count, and the container count is derived from
    // the constant rather than pinned to a magnitude of its own.
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listObjects,
      listContainers: mock(async () =>
        Array.from({ length: INVENTORY_PAIR_LIMIT + 1 }, (_, index) => ({
          path: [`s${index}`],
          name: `s${index}`,
          level: 0,
        })),
      ),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    const body = await parseResponseJSON<{ objects: DatabaseObject[]; truncated: unknown }>(response);
    // Every listing answers zero objects, so the OBJECT budget never advances. Without a fan-out
    // cap this request issues one round trip per container and then reports itself as complete.
    expect(listObjects).toHaveBeenCalledTimes(INVENTORY_PAIR_LIMIT);
    expect(body.truncated).toEqual({ limit: INVENTORY_PAIR_LIMIT, reason: "container and kind pair limit reached" });
    expect(body.objects).toHaveLength(0);
  });

  test("a caller cannot buy extra round trips with duplicate containers", async () => {
    const listObjects = mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]);
    activeProvider = objectProvider({ objectKinds: [TABLE_KIND], listObjects });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["app"], ["app"], ["ops"], ["app"]] },
      }) as never,
    );

    expect(listObjects).toHaveBeenCalledTimes(2);
    expect((await parseResponseJSON<{ objects: DatabaseObject[] }>(response)).objects.map((o) => o.path)).toEqual([
      ["app", "orders"],
      ["ops", "orders"],
    ]);
  });

  test("refuses an explicitly empty containers list rather than answering an empty inventory", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({ listObjects });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("containers");
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  /*
    The session default container, read off the walk this route already does (#789).

    The flat schema reading the object browser joins against is a reading of ONE container
    and drops that container from every name it writes, so a bare flat name ties against
    every same-named object on the server and the join refused the tie. The default
    container is what breaks it, and this is the only surface that knows it: the provider
    answers `isSessionDefault` on `listContainers`, which nothing downstream sees. No extra
    round trip, because the enumeration is already happening.
  */
  test("answers the session default container off the enumeration it already ran", async () => {
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [
        { path: ["ops"], name: "ops", level: 0 },
        { path: ["app"], name: "app", level: 0, isSessionDefault: true },
      ]),
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    expect((await parseResponseJSON<{ defaultContainer: unknown }>(response)).defaultContainer).toEqual(["app"]);
  });

  test("the default is the DEEPEST level's, which is the one an object's container is", async () => {
    // Standing ruling 5a2: a two-level engine marks `isSessionDefault` at EVERY level, so
    // the outer catalog carries the flag too. An object's container is `[catalog, schema]`,
    // and answering `[main]` would name a container no object sits in and break no tie.
    activeProvider = objectProvider({
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      objectKinds: [TABLE_KIND],
      listContainers: mock(async (parent?: readonly string[]) =>
        parent === undefined
          ? [{ path: ["main"], name: "main", level: 0, isSessionDefault: true }]
          : [
              { path: [...parent, "sales"], name: "sales", level: 1 },
              { path: [...parent, "dbo"], name: "dbo", level: 1, isSessionDefault: true },
            ],
      ),
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    expect((await parseResponseJSON<{ defaultContainer: unknown }>(response)).defaultContainer).toEqual([
      "main",
      "dbo",
    ]);
  });

  test("omits the default when no container declares itself the session's", async () => {
    // Absent is a fact: several engines cannot say which container the session is in, and
    // a caller told `[]` would be told the root container, which on a two-level engine is
    // not a container at all. The join keeps its refusal instead.
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    const body = await parseResponseJSON<Record<string, unknown>>(response);
    expect("defaultContainer" in body).toBe(false);
  });

  test("omits the default when the caller named the containers, because nothing was enumerated", async () => {
    // The flag lives on `listContainers`, and a body naming containers skips that call
    // entirely. Answering a default from a walk that never happened would be an invention.
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0, isSessionDefault: true }]),
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["ops"]] },
      }) as never,
    );

    const body = await parseResponseJSON<Record<string, unknown>>(response);
    expect("defaultContainer" in body).toBe(false);
  });
});

// ============================================================================
// source
// ============================================================================

describe("POST /api/db/objects/source", () => {
  const FUNCTION_KIND: ObjectKindSpec = {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: "sql",
  };

  function readablePart(overrides: Partial<Extract<ObjectSourcePart, { text: string }>> = {}): ObjectSourcePart {
    return {
      id: "body",
      label: "Body",
      text: "CREATE FUNCTION order_total(integer) RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql",
      language: "sql",
      form: "complete",
      origin: "regenerated",
      ...overrides,
    };
  }

  /**
   * A provider that answers only the kind it declares and raises its OWN error for anything else.
   *
   * The raise is what makes the gate's two conjuncts distinguishable. A double that answered any
   * kind would turn the undeclared-kind test into a 200-versus-400 comparison, and deleting the
   * declaration conjunct would then be caught by the status alone. Raising a `QueryError` is what
   * a real provider does when asked for an object it cannot read, and `createErrorResponse` maps
   * it to the same 400 the gate uses, so only the SENTENCE separates the two.
   */
  function sourceProviderReading(document: ObjectSourceDocument): DatabaseProvider {
    return objectProvider({
      objectKinds: [TABLE_KIND, FUNCTION_KIND],
      readObjectSource: mock(async (path: readonly string[], kind: string) => {
        if (kind !== "function") {
          throw new QueryError(`the engine has no readable ${kind} at ${path.join(".")}`, "postgres");
        }
        return document;
      }),
    });
  }

  function documentWithOnePart(part: ObjectSourcePart = readablePart()): ObjectSourceDocument {
    return { path: ["app", "order_total(integer)"], kind: "function", parts: [part] };
  }

  test("answers the provider's document for a source-bearing kind, bounded by the route", async () => {
    const read = mock(async () => documentWithOnePart());
    activeProvider = objectProvider({ objectKinds: [TABLE_KIND, FUNCTION_KIND], readObjectSource: read });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "order_total(integer)"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    expect(body).toEqual(documentWithOnePart());
    // The route names its own bound rather than leaving `limit` absent, which is what makes a
    // provider that honours the argument bound the same way the route would have bounded it.
    expect(read).toHaveBeenCalledWith(["app", "order_total(integer)"], "function", SOURCE_CHARACTER_LIMIT);
  });

  test("calls the reader with the provider as its receiver, so a method reading `this` still works", async () => {
    // Every shipped provider reads `this` in this method: it is where the pool, the config and the
    // escaper live. The reader is taken off the instance as a VALUE here, and a value called with
    // no receiver has `this === undefined` under a module's strict mode, so the label below is
    // read from the receiver rather than closed over. Unbound, this double raises a TypeError
    // instead of answering, which is the difference a 200 and a label can see.
    activeProvider = objectProvider({
      objectKinds: [FUNCTION_KIND],
      readObjectSource: mock(async function (this: DatabaseProvider) {
        return documentWithOnePart(readablePart({ label: this.type }));
      }),
    });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    const [part] = (await parseResponseJSON<ObjectSourceDocument>(response)).parts;
    expect(part.label).toBe("postgres");
  });

  test("refuses a kind that declares no source, naming the engine and the kind", async () => {
    activeProvider = sourceProviderReading(documentWithOnePart());

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "orders"], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(400);
    // The SENTENCE and not the status: the double raises its own error for this kind, and that
    // error also maps to 400, so a status-only assertion survives deleting the declaration
    // conjunct of the gate.
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      'postgres declares no readable source for kind "table"',
    );
  });

  test("refuses a provider that declares hasSource and implements no method, with the same sentence", async () => {
    activeProvider = objectProvider({ objectKinds: [TABLE_KIND, FUNCTION_KIND] });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      'postgres declares no readable source for kind "function"',
    );
  });

  test("refuses a kind the engine does not declare at all", async () => {
    activeProvider = sourceProviderReading(documentWithOnePart());

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "procedure" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      'postgres declares no readable source for kind "procedure"',
    );
  });

  test("refuses an empty path", async () => {
    activeProvider = sourceProviderReading(documentWithOnePart());

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: [], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("must name an object");
  });

  test("refuses a missing kind", async () => {
    activeProvider = sourceProviderReading(documentWithOnePart());

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain('"kind" must be a non-empty string');
  });

  test("bounds a provider that ignores the limit, and marks what it bounded", async () => {
    activeProvider = sourceProviderReading(
      documentWithOnePart(readablePart({ text: "x".repeat(SOURCE_CHARACTER_LIMIT + 10) })),
    );

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    const [part] = body.parts;
    if ("unavailable" in part) throw new Error("the double answers a readable part");
    expect(part.text).toHaveLength(SOURCE_CHARACTER_LIMIT);
    expect(part.truncated).toEqual({
      limit: SOURCE_CHARACTER_LIMIT,
      reason: sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT),
    });
  });

  test("joins its own sentence to a bound the provider already reported", async () => {
    activeProvider = sourceProviderReading(
      documentWithOnePart(
        readablePart({
          text: "y".repeat(SOURCE_CHARACTER_LIMIT + 10),
          truncated: { limit: 4000, reason: "the engine stopped at 4,000 characters" },
        }),
      ),
    );

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    const [part] = body.parts;
    if ("unavailable" in part) throw new Error("the double answers a readable part");
    // Two bounds are two facts, so the engine's own sentence is kept beside the route's rather
    // than replaced by it.
    expect(part.truncated?.reason).toBe(
      `the engine stopped at 4,000 characters; ${sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT)}`,
    );
    expect(part.truncated?.limit).toBe(SOURCE_CHARACTER_LIMIT);
  });

  test("leaves a part that already fits exactly as the provider wrote it", async () => {
    const exact = readablePart({ text: "z".repeat(SOURCE_CHARACTER_LIMIT) });
    activeProvider = sourceProviderReading(documentWithOnePart(exact));

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    const [part] = body.parts;
    if ("unavailable" in part) throw new Error("the double answers a readable part");
    // An exact answer is never marked: marking one teaches a reader to discount every mark.
    expect(part.truncated).toBeUndefined();
    expect(part.text).toHaveLength(SOURCE_CHARACTER_LIMIT);
  });

  test("bounds a part that is not the first one, so the walk is not a first-part special case", async () => {
    const document: ObjectSourceDocument = {
      path: ["app", "pkg"],
      kind: "function",
      parts: [
        readablePart({ id: "spec", label: "Specification", text: "SHORT" }),
        readablePart({ id: "body", label: "Body", text: "w".repeat(SOURCE_CHARACTER_LIMIT + 1) }),
      ],
    };
    activeProvider = sourceProviderReading(document);

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "pkg"], kind: "function" },
      }) as never,
    );

    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    const [spec, second] = body.parts;
    if ("unavailable" in spec || second === undefined || "unavailable" in second) {
      throw new Error("the double answers two readable parts");
    }
    expect(spec.truncated).toBeUndefined();
    expect(second.text).toHaveLength(SOURCE_CHARACTER_LIMIT);
    expect(second.truncated?.reason).toBe(sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT));
  });

  test("drops a surrogate pair whole when the bound lands inside it, the way applySourceBound does", async () => {
    /*
     * ONE SLICER, and this is the test that makes the route use it (#789). The bound counts
     * UTF-16 CODE UNITS, so it can land BETWEEN the two halves of an astral character: a
     * PL/pgSQL body or a Lua library holding an emoji at exactly that offset. The route sliced
     * with a bare `text.slice(0, limit)` while every one of the sixteen providers bounded
     * through `applySourceBound`, which drops the orphaned half. MEASURED on the bare slice: the
     * text came back ending in `\ud83d`, which is not a character, JSON serialises it as a lone
     * escape and Monaco draws a replacement glyph.
     *
     * The pair sits ON the boundary by construction, so the assertion cannot pass by accident:
     * the high half is the last unit a `slice(0, limit)` would keep.
     */
    const straddling = `${"a".repeat(SOURCE_CHARACTER_LIMIT - 1)}\u{1F600}b`;
    // The floor: without it a future constant could move the pair off the boundary and this
    // test would certify a bound that never cut a pair at all.
    expect(straddling.charCodeAt(SOURCE_CHARACTER_LIMIT - 1)).toBe(0xd83d);
    expect(straddling.charCodeAt(SOURCE_CHARACTER_LIMIT)).toBe(0xde00);
    activeProvider = sourceProviderReading(documentWithOnePart(readablePart({ text: straddling })));

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    const [part] = body.parts;
    if ("unavailable" in part) throw new Error("the double answers a readable part");
    expect(part.text).toHaveLength(SOURCE_CHARACTER_LIMIT - 1);
    const last = part.text.charCodeAt(part.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    // `truncated.limit` still names the CALLER's number and not the emitted length.
    expect(part.truncated?.limit).toBe(SOURCE_CHARACTER_LIMIT);
    expect(part.truncated?.reason).toBe(sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT));
  });

  test("carries a refused part through untouched, and the CLIENT is where that document is refused", async () => {
    /*
     * TWO FILES ON THIS BRANCH PIN ONE INPUT, and this docblock is what stops the pair reading
     * as a contradiction (#789 fix round 1). The route keeps an over-long refusal SENTENCE
     * whole, deliberately: the sentence is the engine's or the provider's own words, and the
     * refused arm carries no `truncated` mark in the type, so slicing it would ship half a
     * sentence with nothing on screen saying a cut was made.
     *
     * What a person then sees is NOT this document. `isSourceDocumentShape` bounds the sentence
     * at the client seam, so on the standalone path this 1,000,010-character refusal reaches the
     * viewer, fails the shape check and draws "The source read answered with a body this viewer
     * cannot render." instead of the engine's sentence. The route's name used to promise a
     * guarantee that does not hold end to end; the assertion below now pins BOTH ends, so a
     * later change to either side makes one of them fail rather than leaving the pair silently
     * inconsistent.
     */
    const refusal: ObjectSourcePart = {
      id: "body",
      label: "Body",
      unavailable: "u".repeat(SOURCE_CHARACTER_LIMIT + 10),
    };
    activeProvider = sourceProviderReading(documentWithOnePart(refusal));

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    const [part] = body.parts;
    if (!("unavailable" in part)) throw new Error("the double answers a refused part");
    expect(part.unavailable).toHaveLength(SOURCE_CHARACTER_LIMIT + 10);
    // The other end of the same input, in one assertion: what the route carries, the client
    // refuses. Without this line the two files pin opposite behaviours and neither says so.
    expect(isSourceDocumentShape(body)).toBe(false);
  });

  test("refuses a part that carries both a refusal and a text, rather than shipping one over the other", async () => {
    // MEASURED against tsc 6.0.3 and recorded on `ObjectSourcePart`: a literal carrying
    // `unavailable` BESIDE `text` COMPILES, because the excess-property check on a union admits
    // any property declared on ANY member of it. `isSourcePartUnavailable` then narrows it to the
    // refusal arm, so the route's character bound would return it untouched and a 2 MB definition
    // would reach `NextResponse.json` under a 1,000,000 bound while the client rendered a refusal
    // over it. No cast is needed to build one and none is used here.
    const hybrid = {
      ...readablePart({ text: "x".repeat(SOURCE_CHARACTER_LIMIT * 2) }),
      unavailable: "the engine refused this body",
    } satisfies ObjectSourcePart;
    activeProvider = sourceProviderReading(documentWithOnePart(hybrid));

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      "the source read answered a part that carries both a refusal and a text; a refusal and a definition " +
        "are different facts and a reader must never be shown one over the other",
    );
  });

  test("refuses a document that carries no parts at all, by name and not by a TypeError", async () => {
    // `parts` is a NON-EMPTY tuple in the type, and a JS caller or a host is not held to it. Before
    // this guard an empty array reached `"unavailable" in part` on `undefined` and the TypeError
    // went to `createErrorResponse` as an unhandled error, so the walk's zero-part case certified
    // nothing. The cast is what a type-checked caller CANNOT write, which is the point.
    activeProvider = sourceProviderReading({
      path: ["app", "f"],
      kind: "function",
      parts: [] as unknown as ObjectSourceDocument["parts"],
    });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      "the source read answered a document with no parts, and a source document names at least one",
    );
  });

  test("refuses a document carrying more parts than the route will carry", async () => {
    const parts = Array.from({ length: SOURCE_PART_LIMIT + 1 }, (_unused, index) =>
      readablePart({ id: `p${index}`, label: `Part ${index}` }),
    ) as unknown as ObjectSourceDocument["parts"];
    activeProvider = sourceProviderReading({ path: ["app", "f"], kind: "function", parts });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      `the source read answered ${SOURCE_PART_LIMIT + 1} parts and this route carries at most ${SOURCE_PART_LIMIT}`,
    );
  });

  test("carries a document holding exactly the part limit", async () => {
    const parts = Array.from({ length: SOURCE_PART_LIMIT }, (_unused, index) =>
      readablePart({ id: `p${index}`, label: `Part ${index}`, text: "ok" }),
    ) as unknown as ObjectSourceDocument["parts"];
    activeProvider = sourceProviderReading({ path: ["app", "f"], kind: "function", parts });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect((await parseResponseJSON<ObjectSourceDocument>(response)).parts).toHaveLength(SOURCE_PART_LIMIT);
  });

  test("carries the engine's own error to a 400 rather than inventing one", async () => {
    activeProvider = objectProvider({
      objectKinds: [FUNCTION_KIND],
      readObjectSource: mock(async () => {
        throw new QueryError("permission denied for schema app", "postgres");
      }),
    });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(400);
    const body = await parseResponseJSON<{ error: string; code: string }>(response);
    expect(body.error).toBe("permission denied for schema app");
    expect(body.code).toBe(ApiErrorCode.QUERY_ERROR);
  });

  test("refuses an unauthenticated caller before parsing a body", async () => {
    mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });

    const response = await sourceRoute.POST(
      new Request("http://localhost:3000/api/db/objects/source", { method: "POST" }) as never,
    );

    expect(response.status).toBe(401);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });
});

// ============================================================================
// The two seams Phase 3 added to the handler, driven THROUGH the handler
// ============================================================================

/**
 * `options.readBody` and the three-field context are the plumbing the two edit routes are built on,
 * and until these tests existed NOTHING in this repository passed `options` or read a single field
 * of the context. Measured by mutation at the commit that added them: replacing the substitution arm
 * with a copy of the default arm left 188 tests passing, and fabricating the session and the route in
 * the context literal left the same 188 passing. A deliverable with no caller is a deliverable with
 * no guard, so the caller is built here rather than waited for (#789).
 *
 * The handler is driven DIRECTLY rather than through one of the seven routes, because the two routes
 * that will pass `options` do not exist yet and a test that waited for them would be a test this
 * phase's own defect could not reach.
 */
describe("the body read the handler actually performs", () => {
  const probeRoute = "api/db/objects/probe";
  const post = (body: unknown) =>
    createMockRequest(`/${probeRoute}`, { method: "POST", body }) as never as Parameters<typeof handleObjectRequest>[0];

  test("options.readBody SUBSTITUTES the default, measured on a body the DEFAULT refuses", async () => {
    // `{}` is the discriminating body: `readDefaultBody` answers 400 "Empty request body" for it, so
    // a handler that reached the default instead of the double cannot answer 200 here. That is what
    // makes this kill an inverted ternary or a drifted option name rather than merely execute a line.
    const request = post({});
    let sawRequest: unknown;
    let sawBody: unknown;
    const response = await handleObjectRequest(
      request,
      probeRoute,
      async (_provider, body) => {
        sawBody = body;
        return { ok: true };
      },
      {
        readBody: async (req) => {
          sawRequest = req;
          return { connectionId: "seed-1", marker: "read-by-the-substitute" };
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({ ok: true });
    expect(sawRequest).toBe(request);
    expect(sawBody).toEqual({ connectionId: "seed-1", marker: "read-by-the-substitute" });
  });

  test("with NO options the default read runs, and it refuses that same body", async () => {
    // The control. Without it, a `readBody` that was never consulted and a default that never runs
    // are indistinguishable.
    const response = await handleObjectRequest(post({}), probeRoute, async () => ({ ok: true }));

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({ error: "Empty request body" });
  });

  test("the two reads DIVERGE on an empty JSON object, and the divergence is pinned here", async () => {
    // `readDefaultBody` refuses `{}` itself; `readBoundedJson` RETURNS it and `resolveConnection` is
    // what then refuses. Both answers are 400 and both sentences are true of the body, but they are
    // different sentences on one handler, so the pair is asserted rather than left for a later reader
    // to discover from a bug report.
    const response = await handleObjectRequest(post({}), probeRoute, async () => ({ ok: true }), {
      readBody: (req) => readBoundedJson(req, 1024),
    });

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toMatchObject({
      error: "Either connection or connectionId is required",
    });
  });

  test("readBoundedJson's 413 reaches the wire THROUGH the handler, sentence and status", async () => {
    // The edit routes' exact call shape, with a small limit standing in for EDIT_BODY_BYTE_LIMIT so
    // the body is a test-sized one. Before this, `readBoundedJson` had never once been reached
    // through `handleObjectRequest`, so nothing proved its `ObjectRouteError` was rendered by the
    // catch rather than escaping as a 500.
    const response = await handleObjectRequest(
      post({ text: "x".repeat(2048) }),
      probeRoute,
      async () => ({ ok: true }),
      { readBody: (req) => readBoundedJson(req, 1024) },
    );

    expect(response.status).toBe(413);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: "this request body is larger than 1024 bytes",
    });
  });

  test("a refusal carrying a code renders the code on a REAL response", async () => {
    // The `code` arm was unit-tested through `objectRouteErrorBody` and had never been driven through
    // an HTTP response. The edit routes are its live producer; this is the shape they will answer.
    const response = await handleObjectRequest(post({ connectionId: "seed-1" }), probeRoute, async () => {
      throw new ObjectRouteError("that plan is not one this server will run", 400, ApiErrorCode.EDIT_PLAN_INVALID);
    });

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: "that plan is not one this server will run",
      code: "EDIT_PLAN_INVALID",
    });
  });
});

/**
 * The three fields an audit event for an applied DDL is attributed with. A wrong binding here names
 * the wrong caller or the wrong route on a write against a live engine, and no other test in this
 * phase would go red for it (#789).
 */
describe("the context the handler hands run", () => {
  const probeRoute = "api/db/objects/probe";
  const post = (body: unknown) =>
    createMockRequest(`/${probeRoute}`, { method: "POST", body }) as never as Parameters<typeof handleObjectRequest>[0];

  test("it carries the RESOLVED connection, the guard's session and the route, and nothing else", async () => {
    let seen: ObjectRequestContext | undefined;
    // The body names a connectionId and NO connection, so an object taken from the BODY cannot be
    // what the context carries: only the resolution answers `{ id: "seed-1", name: "Seeded", ... }`.
    const response = await handleObjectRequest(post({ connectionId: "seed-1" }), probeRoute, async (_p, _b, ctx) => {
      seen = ctx;
      return { ok: true };
    });

    expect(response.status).toBe(200);
    expect(seen?.connection).toEqual({ id: "seed-1", name: "Seeded", type: "postgres" } as never);
    expect(seen?.session).toEqual({ role: "admin", username: "admin" });
    expect(seen?.route).toBe(probeRoute);
    expect(Object.keys(seen ?? {}).sort()).toEqual(["connection", "route", "session"]);
  });

  test("an INLINE connection reaches the context as the resolution answered it", async () => {
    let seen: ObjectRequestContext | undefined;
    await handleObjectRequest(post({ connection }), probeRoute, async (_p, _b, ctx) => {
      seen = ctx;
      return { ok: true };
    });

    expect(seen?.connection).toEqual(connection as never);
  });

  test("the session is the one the guard answered, not a second read of it", async () => {
    // A second `getSession` inside the handler would answer this one; the guard's answer is the
    // first. Asserting the SECOND value would pass either way, so the override is queued once and
    // the context must still carry the FIRST.
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "auditor" } as unknown as {
      role: string;
      username: string;
    });
    let seen: ObjectRequestContext | undefined;
    await handleObjectRequest(post({ connectionId: "seed-1" }), probeRoute, async (_p, _b, ctx) => {
      seen = ctx;
      return { ok: true };
    });

    expect(seen?.session).toEqual({ role: "user", username: "auditor" });
  });
});
