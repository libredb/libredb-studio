import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { INVENTORY_LIMIT, INVENTORY_PAIR_LIMIT } from "@/lib/api/object-route";
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

  test("every one of the six routes refuses an unauthenticated caller", async () => {
    const routes = [containersRoute, countsRoute, listRoute, describeRoute, searchRoute, inventoryRoute];
    for (const route of routes) {
      mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });
      const response = await route.POST(
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
