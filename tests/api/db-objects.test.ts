import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { rabbitmqConnection } from "../helpers/rabbitmq-connection";
import { answerBroker, createManagementStub, manualDeadlines, segment } from "../helpers/rabbitmq-management-stub";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  INVENTORY_LIMIT,
  INVENTORY_PAIR_LIMIT,
  ObjectRouteError,
  handleObjectRequest,
  readObjectRouteBody,
  type ObjectRequestContext,
} from "@/lib/api/object-route";
import {
  isSourcePartStatement,
  SOURCE_CHARACTER_LIMIT,
  SOURCE_PART_LIMIT,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import { EDIT_BODY_BYTE_LIMIT } from "@/lib/db/object-edit";
// The CLIENT's shape check, imported into the route's own suite on purpose: the route carries a
// refusal sentence through untouched and the client refuses that document, and one test pinning
// both ends is the only thing that keeps the pair from drifting into a contradiction (#789).
import { isSourceDocumentShape } from "@/components/object-source/source-reader";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { TIMEOUT_SENTENCE } from "@/lib/api/error-body";
import { PermissionDeniedError, QueryError } from "@/lib/db/errors";
import { errorKind } from "@/lib/db/error-record";
import { PROVIDER_TEXT_WITHHELD, providerTextScrub, withheldErrorMessage } from "@/lib/db/operations/provider-text";
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
  ProviderCapabilities,
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
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import type { CallContext } from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import { waitedSeconds } from "@/lib/db/errors";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import { editorExecutionContext } from "@/lib/api/execution-context";
import type { UserPayload } from "@/lib/auth";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { ALLOWS_PRIVATE_HOSTS } from "../helpers/egress-decisions";

// NOTE: the mocks below are inline rather than in a shared helper, and the request is built by
// `createMockRequest` with the session supplied by a mocked `@/lib/auth`. That is the ONE pattern
// every file under tests/api/ already uses; `tests/api/db/schema-list.test.ts` records why
// (bun's `mock.module()` is scoped per test FILE, so hoisting these into a helper breaks
// re-application). The brief's `tests/helpers/authed-request.ts` would be a second pattern for the
// same job, so it is deliberately not introduced.

let activeProvider: DatabaseProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => activeProvider);
/** The tree routes' resolution (docs/providers/CONTRACT.md, clause C-66): the file's provider unless a test says otherwise. */
const answerActiveProvider = async () => activeProvider;
const mockGetOrCreateMetadataProvider = mock(answerActiveProvider);

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }) as unknown);
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

class SeedConnectionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SeedConnectionError";
  }
}

/** The resolution: an inline connection as given, or a seeded record for a connectionId. A test queues its own. */
const mockResolveConnection = mock(async (body: Record<string, unknown>): Promise<unknown> => {
  if (!body.connection && !body.connectionId) {
    throw new SeedConnectionError("Either connection or connectionId is required", 400);
  }
  return body.connection ?? { id: "seed-1", name: "Seeded", type: "postgres" };
});

mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: mockResolveConnection,
  SeedConnectionError,
}));

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  getOrCreateMetadataProvider: mockGetOrCreateMetadataProvider,
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

// The tree routes read the process's host core (src/lib/provider-host/instance.ts), so this file composes its own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

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
  containerPathShapes?: ProviderCapabilities["containerPathShapes"];
  catalogSessions?: true;
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
      ...(shape.containerPathShapes === undefined ? {} : { containerPathShapes: shape.containerPathShapes }),
      ...(shape.catalogSessions === undefined ? {} : { catalogSessions: shape.catalogSessions }),
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
  mockGetOrCreateMetadataProvider.mockReset();
  mockGetOrCreateMetadataProvider.mockImplementation(answerActiveProvider);
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

  test("a parent AT the declared depth reaches the provider", async () => {
    // On one level both rules accept `["app"]`, so this proves only that the route lets it through;
    // the test below is the one that tells the depth ceiling from the address rule.
    const listContainers = mock(async (): Promise<Container[]> => []);
    activeProvider = objectProvider({ listContainers });

    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", {
        method: "POST",
        body: { connection, parent: ["app"] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(await parseResponseJSON<Container[]>(response)).toEqual([]);
    expect(listContainers).toHaveBeenCalledWith(["app"]);
  });

  test("a parent SHORTER than an exact engine's address still passes", async () => {
    // The address rule would refuse `["main"]` on this declaration, so a 200 here proves `parent`
    // is checked by the depth ceiling and not by the address shapes.
    const listContainers = mock(async (): Promise<Container[]> => []);
    activeProvider = objectProvider({
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      containerPathShapes: "exact",
      listContainers,
    });

    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", {
        method: "POST",
        body: { connection, parent: ["main"] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listContainers).toHaveBeenCalledWith(["main"]);
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
    expect(await parseResponseJSON<Record<string, string>>(response)).toEqual({
      error: 'postgres accepts "container" as [schema], received ["app","nested"]',
      outcome: "not-sent",
    });
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
    // dropping the shape check would still produce a 400 from the ADDRESS check and a loose
    // assertion would not notice.
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"container" must be an array of path segments',
    );
  });

  test("refuses a container SHORTER than an exact engine accepts, at the edge and with no code", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({ countObjects });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: [] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(response)).toEqual({
      error: 'postgres accepts "container" as [schema], received []',
      outcome: "not-sent",
    });
    expect(countObjects).toHaveBeenCalledTimes(0);
  });

  test("a too-short and a too-long container meet one sentence and one wire shape", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({ countObjects });
    const post = async (container: readonly string[]) => {
      const response = await countsRoute.POST(
        createMockRequest("/api/db/objects/counts", { method: "POST", body: { connection, container } }) as never,
      );
      return { status: response.status, body: await parseResponseJSON<Record<string, string>>(response) };
    };

    const short = await post([]);
    const long = await post(["app", "nested"]);

    expect(short.status).toBe(400);
    expect(long.status).toBe(400);
    expect(Object.keys(short.body)).toEqual(["outcome", "error"]);
    expect(Object.keys(long.body)).toEqual(["outcome", "error"]);
    const opening = (body: Record<string, string>) => body.error.replace(/received .*$/, "");
    expect(opening(short.body)).toBe(opening(long.body));
    expect(opening(short.body)).toBe('postgres accepts "container" as [schema], ');
    expect(countObjects).toHaveBeenCalledTimes(0);
  });

  test("on a prefixes engine an outer-level container reaches the provider", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({
      type: "trino",
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      containerPathShapes: "prefixes",
      countObjects,
    });

    const outer = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["memory"] },
      }) as never,
    );
    expect(outer.status).toBe(200);
    expect(countObjects).toHaveBeenCalledWith(["memory"]);

    const full = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["memory", "app"] },
      }) as never,
    );
    expect(full.status).toBe(200);
    expect(countObjects).toHaveBeenCalledWith(["memory", "app"]);
  });

  test("on a prefixes engine the empty and the too-long container are refused naming every shape", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({
      type: "trino",
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      containerPathShapes: "prefixes",
      countObjects,
    });

    const empty = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: { connection, container: [] } }) as never,
    );
    expect(empty.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(empty)).toEqual({
      error: 'trino accepts "container" as [catalog] or [catalog, schema], received []',
      outcome: "not-sent",
    });

    const long = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["memory", "app", "x"] },
      }) as never,
    );
    expect(long.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(long)).toEqual({
      error: 'trino accepts "container" as [catalog] or [catalog, schema], received ["memory","app","x"]',
      outcome: "not-sent",
    });
    expect(countObjects).toHaveBeenCalledTimes(0);
  });

  test("an engine with no container level accepts only the empty container", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({ type: "sqlite", containerLevels: [], countObjects });

    const named = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", {
        method: "POST",
        body: { connection, container: ["main"] },
      }) as never,
    );
    expect(named.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(named)).toEqual({
      error: 'sqlite accepts "container" as empty, received ["main"]',
      outcome: "not-sent",
    });
    expect(countObjects).toHaveBeenCalledTimes(0);

    const empty = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: { connection, container: [] } }) as never,
    );
    expect(empty.status).toBe(200);
    expect(countObjects).toHaveBeenCalledWith([]);
  });

  test("the route spells a shape by the lowercased LABEL, whatever the provider spells", async () => {
    activeProvider = objectProvider({
      containerLevels: [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }],
    });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: { connection, container: [] } }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(response)).toEqual({
      error: 'postgres accepts "container" as [namespace], received []',
      outcome: "not-sent",
    });
  });

  test("a prefixes declaration with no level accepts no container at all", async () => {
    const countObjects = mock(async () => ({}));
    activeProvider = objectProvider({ containerLevels: [], containerPathShapes: "prefixes", countObjects });

    const response = await countsRoute.POST(
      createMockRequest("/api/db/objects/counts", { method: "POST", body: { connection, container: [] } }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(response)).toEqual({
      error: 'postgres accepts "container" as nothing: this declaration carries no container level, received []',
      outcome: "not-sent",
    });
    expect(countObjects).toHaveBeenCalledTimes(0);
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
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      'postgres accepts "container" as [schema], received ["app","nested"]',
    );
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

  test("refuses a container SHORTER than an exact engine accepts", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({ listObjects });

    const response = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: [], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, string>>(response)).toEqual({
      error: 'postgres accepts "container" as [schema], received []',
      outcome: "not-sent",
    });
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  test("on a prefixes engine an outer-level container reaches the provider", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      type: "trino",
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      containerPathShapes: "prefixes",
      listObjects,
    });

    const response = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["memory"], kind: "table" },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects).toHaveBeenCalledWith(["memory"], "table");
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
    // `relation` (`OracleProvider.describeObject` in `src/lib/db/providers/sql/oracle/index.ts`) and
    // mysql for any kind its own `hasColumns` predicate rejects (`MySQLProvider.describeObject`
    // in `src/lib/db/providers/sql/mysql.ts`).
    const describeObject = mock(async () => emptyDetail(["app", "order_total(integer)"]));
    const functionKind: ObjectKindSpec = {
      id: "function",
      role: "routine",
      label: "Function",
      labelPlural: "Functions",
    };
    activeProvider = objectProvider({ describeObject, objectKinds: [TABLE_KIND, VIEW_KIND, functionKind] });

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
  // (`describeObject` in `src/lib/db/providers/sql/postgres.ts`); oracle, mysql and couchbase have no such check
  // and answer three empty arrays, couchbase because a rejected INFER is deliberately not an error
  // (`inferColumns` in `src/lib/db/providers/document/couchbase/introspect.ts`). Both cases are driven
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
    const body = await parseResponseJSON<{ error: string }>(response);
    expect(body.error).toContain("term");
    // A caller mistake keeps the plain `{ error }`: only the pair bound carries a code.
    expect(Object.keys(body)).toEqual(["error"]);
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

  test("lists each container only for the kinds it holds", async () => {
    const listObjects = mock(async (container: readonly string[], kind: string) => {
      const holds = container[0] === "Cluster" ? kind === "nodes" : kind === "pods";
      if (!holds) throw new QueryError(`the container ${container[0]} holds no ${kind}`, "postgres");
      return [object([...container, `web-${kind}`], kind)];
    });
    activeProvider = objectProvider({
      objectKinds: [
        { id: "pods", role: "config", label: "Pod", labelPlural: "Pods" },
        { id: "nodes", role: "config", label: "Node", labelPlural: "Nodes" },
      ],
      listContainers: mock(async () => [
        { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] },
        { path: ["shop"], name: "shop", level: 0, kinds: ["pods"] },
      ]),
      listObjects,
    });

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "web" } }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects.mock.calls).toEqual([
      [["Cluster"], "nodes"],
      [["shop"], "pods"],
    ]);
    expect((await parseResponseJSON<DatabaseObject[]>(response)).map((found) => found.path)).toEqual([
      ["Cluster", "web-nodes"],
      ["shop", "web-pods"],
    ]);
  });

  /** `count` one-level containers holding no kinds of their own, so each pairs with both declared kinds. */
  function manyContainers(count: number): Container[] {
    return Array.from({ length: count }, (_unused, index) => ({ path: [`s${index}`], name: `s${index}`, level: 0 }));
  }

  test("searches a scan of exactly the inventory bound", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      listContainers: mock(async () => manyContainers(INVENTORY_PAIR_LIMIT / 2)),
      listObjects,
    });

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "x" } }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects).toHaveBeenCalledTimes(INVENTORY_PAIR_LIMIT);
  });

  test("refuses, before any listing, a search over more pairs than the inventory bound", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      listContainers: mock(async () => manyContainers(INVENTORY_PAIR_LIMIT / 2 + 1)),
      listObjects,
    });

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "x" } }) as never,
    );

    expect(response.status).toBe(400);
    // A code and the two numbers, so a client tells this refusal from every other 400 without
    // reading the sentence.
    expect(await parseResponseJSON(response)).toEqual({
      error:
        `this search would list ${INVENTORY_PAIR_LIMIT + 2} container and kind pairs, more than the ` +
        `${INVENTORY_PAIR_LIMIT} one search may list; name fewer kinds in "kinds"`,
      code: "INVENTORY_PAIR_LIMIT",
      limit: INVENTORY_PAIR_LIMIT,
      pairs: INVENTORY_PAIR_LIMIT + 2,
    });
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  test("naming fewer kinds brings a refused search under the bound", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      listContainers: mock(async () => manyContainers(INVENTORY_PAIR_LIMIT / 2 + 1)),
      listObjects,
    });

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", {
        method: "POST",
        body: { connection, term: "x", kinds: ["table"] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects).toHaveBeenCalledTimes(INVENTORY_PAIR_LIMIT / 2 + 1);
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
  // Kinds per container
  // ---------------------------------------------------------------------------
  //
  // A container may answer `kinds`, the enumerable kinds it holds, on an engine that declares
  // `containersNameKinds`. The route lists only those there, on the walk and for named containers
  // alike, so a cluster-scoped container is never asked for a namespaced kind, which its provider
  // would refuse with a sentence and end the whole read.

  const NODE_KIND: ObjectKindSpec = { id: "nodes", role: "config", label: "Node", labelPlural: "Nodes" };
  const POD_KIND: ObjectKindSpec = { id: "pods", role: "config", label: "Pod", labelPlural: "Pods" };
  const clusterContainers = async (): Promise<Container[]> => [
    { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] },
    { path: ["shop"], name: "shop", level: 0, kinds: ["pods"] },
  ];

  /**
   * A provider that declares `containersNameKinds`, refuses an inapplicable pair, as the contract asks,
   * and lists one object otherwise.
   */
  function clusterProvider() {
    const listObjects = mock(async (container: readonly string[], kind: string) => {
      const holds = container[0] === "Cluster" ? kind === "nodes" : kind === "pods";
      if (!holds) throw new QueryError(`the container ${container[0]} holds no ${kind}`, "postgres");
      return [object([...container, `${kind}-one`], kind)];
    });
    const provider = objectProvider({
      objectKinds: [POD_KIND, NODE_KIND],
      listContainers: mock(clusterContainers),
      listObjects,
    });
    const capabilities = { ...provider.getCapabilities(), containersNameKinds: true as const };
    provider.getCapabilities = () => capabilities;
    activeProvider = provider;
    return listObjects;
  }

  test("the walk lists each container's own kinds and never an inapplicable pair", async () => {
    const listObjects = clusterProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects.mock.calls).toEqual([
      [["Cluster"], "nodes"],
      [["shop"], "pods"],
    ]);
    expect((await parseResponseJSON<{ objects: DatabaseObject[] }>(response)).objects.map((o) => o.path)).toEqual([
      ["Cluster", "nodes-one"],
      ["shop", "pods-one"],
    ]);
  });

  test("named containers are listed for the kinds the provider says they hold, asked once", async () => {
    const listObjects = clusterProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["shop"], ["Cluster"]] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects.mock.calls).toEqual([
      [["shop"], "pods"],
      [["Cluster"], "nodes"],
    ]);
    expect(activeProvider.listContainers).toHaveBeenCalledTimes(1);
  });

  test("a named container the provider's listing does not hold is refused before any listing", async () => {
    const listObjects = clusterProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["Cluster"], ["gone"]] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      '"containers" names [["gone"]], which the provider\'s container listing does not hold, so the kinds held ' +
        "there are unknown; name containers the containers route lists",
    );
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  /**
   * A two-level engine that declares `containersNameKinds`, so naming a container costs a listing of
   * its parent. None ships today; the bound below is what keeps one from fanning out on a body's say.
   */
  function twoLevelNamingProvider() {
    const provider = objectProvider({
      objectKinds: [POD_KIND],
      listContainers: mock(async (parent?: readonly string[]) =>
        parent === undefined ? [] : [{ path: [...parent, "app"], name: "app", level: 1, kinds: ["pods"] }],
      ),
      listObjects: mock(async (container: readonly string[], kind: string) => [object([...container, "one"], kind)]),
    });
    const capabilities = {
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ] as ContainerLevels,
      containersNameKinds: true as const,
    };
    provider.getCapabilities = () => capabilities;
    activeProvider = provider;
    return provider;
  }

  test("named containers under more parents than the pair limit are refused before any container listing", async () => {
    const provider = twoLevelNamingProvider();
    const named = Array.from({ length: INVENTORY_PAIR_LIMIT + 1 }, (_unused, index) => [`c${index}`, "app"]);

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: named },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      `"containers" names containers under ${INVENTORY_PAIR_LIMIT + 1} parents, and the kinds each holds take one ` +
        `container listing per parent, more than the ${INVENTORY_PAIR_LIMIT} one inventory may issue; name fewer containers`,
    );
    expect(provider.listContainers).toHaveBeenCalledTimes(0);
    expect(provider.listObjects).toHaveBeenCalledTimes(0);
  });

  test("a named container repeated in the body costs one container listing per distinct parent", async () => {
    const provider = twoLevelNamingProvider();
    const named = [["main", "app"], ...Array.from({ length: 50 }, () => ["main", "app"]), ["other", "app"]];

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: named },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect((provider.listContainers as ReturnType<typeof mock>).mock.calls).toEqual([[["main"]], [["other"]]]);
    expect((provider.listObjects as ReturnType<typeof mock>).mock.calls).toEqual([
      [["main", "app"], "pods"],
      [["other", "app"], "pods"],
    ]);
  });

  test("the refusal of unlisted named containers echoes the first five and counts the rest, once each", async () => {
    clusterProvider();
    const gone = Array.from({ length: 7 }, (_unused, index) => [`gone${index}`]);

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [...gone, ...gone] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      `"containers" names ${JSON.stringify(gone.slice(0, 5))} and 2 more, which the provider's container listing ` +
        "does not hold, so the kinds held there are unknown; name containers the containers route lists",
    );
  });

  test("a requested kind is listed only where it applies", async () => {
    const listObjects = clusterProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, kinds: ["pods"] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects.mock.calls).toEqual([[["shop"], "pods"]]);
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
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      listContainers: mock(async () => []),
      listObjects,
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["app", "nested"]] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      'postgres accepts "containers" as [schema], received ["app","nested"]',
    );
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  test("refuses a named container shorter than an exact engine accepts, before any listing", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({ listContainers: mock(async () => []), listObjects });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["app"], []] },
      }) as never,
    );

    expect(response.status).toBe(400);
    // The first entry is valid, so a check that ran inside the fan-out would have listed it first.
    expect(await parseResponseJSON<Record<string, string>>(response)).toEqual({
      error: 'postgres accepts "containers" as [schema], received []',
      outcome: "not-sent",
    });
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  test("on a prefixes engine outer-level named containers reach the provider", async () => {
    const listObjects = mock(async () => []);
    activeProvider = objectProvider({
      type: "trino",
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      containerPathShapes: "prefixes",
      objectKinds: [TABLE_KIND],
      listObjects,
    });

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, containers: [["memory"], ["memory", "app"]] },
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(listObjects).toHaveBeenCalledWith(["memory"], "table");
    expect(listObjects).toHaveBeenCalledWith(["memory", "app"], "table");
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
// a kind only the Keys panel enumerates (#1089 3.4)
// ============================================================================

describe("a kind the Keys panel enumerates, on the inventory and search routes", () => {
  const PREFIX_KIND: ObjectKindSpec = {
    id: "prefix",
    role: "relation",
    label: "Key Prefix",
    labelPlural: "Key Prefixes",
  };
  const KEY_KIND: ObjectKindSpec = {
    id: "key",
    role: "config",
    label: "Key",
    labelPlural: "Keys",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "json",
  };
  const REFUSAL =
    'redis enumerates the kind "key" in the Keys panel alone, so no inventory or search lists it; browse it in the Keys panel';

  /**
   * No container level, a prefix kind and a key kind, and a `listObjects` that THROWS for the key kind,
   * as a provider declaring it refuses it by name: a route that walked it would answer that error
   * rather than the prefix groups, which is how each test below tells a kind left out from one listed.
   */
  function keyValueProvider() {
    const listObjects = mock(async (_container: readonly string[], kind: string) => {
      if (kind === "key") throw new QueryError('the kind "key" is listed by the Keys panel', "redis");
      return [object(["/app/*"], "prefix")];
    });
    activeProvider = objectProvider({
      type: "redis",
      containerLevels: [],
      objectKinds: [PREFIX_KIND, KEY_KIND],
      listObjects,
    });
    return listObjects;
  }

  test("an inventory that names no kinds answers the other kinds and never lists it", async () => {
    const listObjects = keyValueProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection } }) as never,
    );

    expect(response.status).toBe(200);
    expect((await parseResponseJSON<{ objects: DatabaseObject[] }>(response)).objects).toEqual([
      { path: ["/app/*"], name: "/app/*", kind: "prefix" },
    ]);
    expect(listObjects.mock.calls.map((call) => call[1])).toEqual(["prefix"]);
  });

  test("a search that names no kinds answers the other kinds and never lists it", async () => {
    const listObjects = keyValueProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "app" } }) as never,
    );

    expect(response.status).toBe(200);
    expect((await parseResponseJSON<DatabaseObject[]>(response)).map((found) => found.path)).toEqual([["/app/*"]]);
    expect(listObjects.mock.calls.map((call) => call[1])).toEqual(["prefix"]);
  });

  test("an inventory naming it is a 400 that points at the Keys panel, outcome not-sent, and lists nothing", async () => {
    const listObjects = keyValueProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", { method: "POST", body: { connection, kinds: ["key"] } }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({ error: REFUSAL, outcome: "not-sent" });
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  test("a search naming it beside another kind is the same 400, outcome not-sent, and lists nothing", async () => {
    const listObjects = keyValueProvider();

    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", {
        method: "POST",
        body: { connection, term: "app", kinds: ["prefix", "key"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({ error: REFUSAL, outcome: "not-sent" });
    expect(listObjects).toHaveBeenCalledTimes(0);
  });

  // The ORDER of the two refusals, pinned: a kind the engine never declared is a claim about the
  // engine, and telling the caller it lives in the Keys panel would name a kind that does not exist.
  test("a kind the engine does not declare is still refused as undeclared, never pointed at the Keys panel", async () => {
    const listObjects = keyValueProvider();

    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, kinds: ["value"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: 'redis declares no object kind "value"',
      outcome: "not-sent",
    });
    expect(listObjects).toHaveBeenCalledTimes(0);
  });
});

// ============================================================================
// source
// ============================================================================

// ============================================================================
// RabbitMQ over a recorded management API: the routes' own GET order (#1656, R-S14)
// ============================================================================

// The one case of this file that builds a real provider: the provider-management test drives the shared walk the
// two routes run, and this pins the order the route handlers themselves issue, so a change inside either route that
// reorders or adds a listing fails here. It adds no mock.module() of its own: the mocked getOrCreateProvider hands
// the routes a real provider built on the recording management API.
describe("the inventory and search routes over RabbitMQ's management API", () => {
  const STREAMS = (vhost: string) =>
    `GET /api/queues/${segment(vhost)}?columns=name,type,state&disable_stats=true&page=1&page_size=500&sort=type&sort_reverse=true`;
  const QUEUES = (vhost: string) =>
    `GET /api/queues/${segment(vhost)}?columns=name,type,state,messages,messages_ready,messages_unacknowledged&disable_stats=true&enable_queue_totals=true&page=1&page_size=500&sort=name`;
  const EXCHANGES = (vhost: string) =>
    `GET /api/exchanges/${segment(vhost)}?columns=name,type,durable,auto_delete,internal&page=1&page_size=500&sort=name`;

  async function rabbitmq() {
    const stub = createManagementStub();
    answerBroker(stub, {
      vhosts: {
        "/": { streams: ["st-orders"], queues: [["orders", "classic"]], exchanges: ["ex-topic"] },
        billing: { streams: ["st-audit"], queues: [["ledger", "quorum"]] },
      },
    });
    const provider = new RabbitMQProvider(
      rabbitmqConnection(),
      { queryTimeout: 60_000 },
      { egress: ALLOWS_PRIVATE_HOSTS },
      { managementTransport: stub.factory, deadlineSignal: manualDeadlines().factory },
    );
    await provider.connect();
    const mark = stub.requests.length;
    return { provider, since: () => stub.keys().slice(mark) };
  }

  test("the connection select's inventory: the virtual hosts, then one Streams page per virtual host", async () => {
    const { provider, since } = await rabbitmq();
    activeProvider = provider;
    const response = await inventoryRoute.POST(
      createMockRequest("/api/db/objects/inventory", {
        method: "POST",
        body: { connection, kinds: ["stream"], includeColumns: true },
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(since()).toEqual(["GET /api/vhosts", STREAMS("/"), STREAMS("billing")]);
  });

  test("the tree search: the virtual hosts, then the three pages per virtual host", async () => {
    const { provider, since } = await rabbitmq();
    activeProvider = provider;
    const response = await searchRoute.POST(
      createMockRequest("/api/db/objects/search", { method: "POST", body: { connection, term: "orders" } }) as never,
    );
    expect(response.status).toBe(200);
    expect(since()).toEqual([
      "GET /api/vhosts",
      STREAMS("/"),
      QUEUES("/"),
      EXCHANGES("/"),
      STREAMS("billing"),
      QUEUES("billing"),
      EXCHANGES("billing"),
    ]);
  });
});

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

  test("carries a statement part through with its marker, and the client reads it back as a statement", async () => {
    // The statement member is a superset of the refusal arm, so the route needs no rule of its own
    // for it: the bound skips it, an `edit` on it is stripped, and `statement: true` survives the
    // rest spread and the JSON body untouched.
    const statement = {
      id: "notes",
      label: "Notes",
      unavailable: "This object holds nothing that can be read without changing it.",
      statement: true,
      edit: { offered: true },
    } satisfies ObjectSourcePart;
    activeProvider = sourceProviderReading({
      path: ["app", "f"],
      kind: "function",
      parts: [readablePart(), statement],
    });

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    expect(body.parts[1]).toEqual({
      id: "notes",
      label: "Notes",
      unavailable: "This object holds nothing that can be read without changing it.",
      statement: true,
    });
    expect(isSourceDocumentShape(body)).toBe(true);
    expect(isSourcePartStatement(body.parts[1]!)).toBe(true);
  });

  test("refuses a statement part that also carries a text, with the refusal arm's hybrid sentence", async () => {
    // The statement member inherits the refusal arm's "never a text beside it" at the route as
    // well as at the client: a special case for `statement` in `boundPart` would let a definition
    // ship under a sentence the viewer draws instead of it.
    const hybrid = {
      ...readablePart({ text: "x".repeat(SOURCE_CHARACTER_LIMIT * 2) }),
      unavailable: "This object holds nothing that can be read without changing it.",
      statement: true,
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

  test("carries an over-long statement sentence whole, as it does a refusal, and the client refuses it", async () => {
    // Never truncated at the route, for the refusal arm's reason: the sentence carries no
    // `truncated` mark, so a cut would ship half a fact with nothing saying so. The client's bound
    // is where the document is refused, and both ends are pinned here.
    const statement = {
      id: "notes",
      label: "Notes",
      unavailable: "s".repeat(SOURCE_CHARACTER_LIMIT + 10),
      statement: true,
    } satisfies ObjectSourcePart;
    activeProvider = sourceProviderReading(documentWithOnePart(statement));

    const response = await sourceRoute.POST(
      createMockRequest("/api/db/objects/source", {
        method: "POST",
        body: { connection, path: ["app", "f"], kind: "function" },
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    expect(body.parts[0]).toEqual(statement);
    expect(isSourceDocumentShape(body)).toBe(false);
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
    // `readDefaultBody` refuses `{}` itself; `readObjectRouteBody` RETURNS it and `resolveConnection` is
    // what then refuses. Both answers are 400 and both sentences are true of the body, but they are
    // different sentences on one handler, so the pair is asserted rather than left for a later reader
    // to discover from a bug report.
    const response = await handleObjectRequest(post({}), probeRoute, async () => ({ ok: true }), {
      readBody: (req) => readObjectRouteBody(req, 1024),
    });

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toMatchObject({
      error: "Either connection or connectionId is required",
    });
  });

  test("readObjectRouteBody's 413 reaches the wire THROUGH the handler, sentence and status", async () => {
    // The edit routes' exact call shape, with a small limit standing in for EDIT_BODY_BYTE_LIMIT so
    // the body is a test-sized one. Before this, `readObjectRouteBody` had never once been reached
    // through `handleObjectRequest`, so nothing proved its `ObjectRouteError` was rendered by the
    // catch rather than escaping as a 500.
    const response = await handleObjectRequest(
      post({ text: "x".repeat(2048) }),
      probeRoute,
      async () => ({ ok: true }),
      { readBody: (req) => readObjectRouteBody(req, 1024) },
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
 * The two refusals the edit routes' body read took from the shared reader in
 * `src/lib/api/bounded-json.ts`, measured through the real route handlers. Before that reader, a
 * byte that is not UTF-8 was decoded to U+FFFD and parsed, and a declared Content-Length over the
 * bound was read before it was refused.
 */
describe("the edit routes' body read", () => {
  const editRoutes = ["edit-plan", "edit-apply"] as const;

  test("a body that is not valid UTF-8 answers 400 with the not-valid-JSON sentence", async () => {
    const prefix = new TextEncoder().encode('{"connectionId":"seed-1","sql":"');
    const bytes = new Uint8Array([...prefix, 0xff, 0x22, 0x7d]);
    for (const name of editRoutes) {
      // oxlint-disable-next-line no-await-in-loop -- one route after the other, so a failure names its route.
      const response = await objectRoutes[name].POST(
        new Request(`http://localhost:3000/api/db/objects/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bytes,
        }) as never,
      );
      expect(response.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop -- one route after the other, so a failure names its route.
      expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
        error: "this request body is not valid JSON",
      });
    }
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test("a declared Content-Length over the bound answers 413 before the body is read", async () => {
    for (const name of editRoutes) {
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode('{"connectionId":"seed-1"}'));
            controller.close();
          },
        },
        // No read-ahead: a pull happens only when the reader asks, so a zero count proves no read.
        { highWaterMark: 0 },
      );
      const request = new Request(`http://localhost:3000/api/db/objects/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(EDIT_BODY_BYTE_LIMIT + 1) },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      // oxlint-disable-next-line no-await-in-loop -- one route after the other, so a failure names its route.
      const response = await objectRoutes[name].POST(request as never);
      expect(response.status).toBe(413);
      // oxlint-disable-next-line no-await-in-loop -- one route after the other, so a failure names its route.
      expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
        error: `this request body is larger than ${EDIT_BODY_BYTE_LIMIT} bytes`,
      });
      expect(pulls).toBe(0);
      expect(request.bodyUsed).toBe(false);
    }
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });
});

describe("the connection's scrub on the object routes", () => {
  /** Generated at run time and holding a slash, so its URI-encoded form differs from the value itself. */
  const password = `${crypto.randomUUID()}/${crypto.randomUUID().slice(0, 8)}`;
  const scrubbed = { ...connection, password: password };
  const call = (route: { POST: (req: never) => Promise<Response> }, name: string, body: Record<string, unknown>) =>
    route.POST(createMockRequest(`/api/db/objects/${name}`, { method: "POST", body }) as never);
  const FUNCTION_SOURCE_KIND: ObjectKindSpec = {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: "sql",
    acceptsSourceEdits: true,
  };

  test("an error answer that holds the connection's credential keeps its status, code, kind and retryable and holds none of it", async () => {
    // Keyed by the container each case asks for, so the cases share one provider and run together.
    const cases = [
      [
        "app",
        new QueryError(`relation near ${password} does not exist`, "postgres"),
        400,
        "QUERY_ERROR",
        "query",
        undefined,
      ],
      [
        "ops",
        new ConnectionError(`could not connect as ${encodeURIComponent(password)}`, "postgres"),
        503,
        "CONNECTION_ERROR",
        "connection",
        true,
      ],
    ] as const;
    activeProvider = objectProvider({
      countObjects: mock(async (container: readonly string[]) => {
        throw cases.find(([name]) => name === container[0])?.[1];
      }),
    });
    const answers = await Promise.all(
      cases.map(async ([name]) => {
        const response = await call(countsRoute, "counts", { connection: scrubbed, container: [name] });
        return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
      }),
    );
    cases.forEach(([, error, status, code, kind, retryable], index) => {
      const { status: answered, body } = answers[index];
      expect(answered).toBe(status);
      expect(body).toMatchObject({ code, kind, error: withheldErrorMessage(error.name) });
      expect(body.retryable).toBe(retryable);
      expect(JSON.stringify(body)).not.toContain(password);
      expect(JSON.stringify(body)).not.toContain(encodeURIComponent(password));
    });

    activeProvider = objectProvider({
      countObjects: mock(async () => {
        throw new QueryError("relation does not exist", "postgres");
      }),
    });
    const clean = await call(countsRoute, "counts", { connection: scrubbed, container: ["app"] });
    expect(clean.status).toBe(400);
    expect(await parseResponseJSON(clean)).toMatchObject({ code: "QUERY_ERROR", error: "relation does not exist" });
  });

  test("counts answers an unavailable and a sampled sentence that hold the connection's credential withheld", async () => {
    activeProvider = objectProvider({
      countObjects: mock(async () => ({
        table: { count: 9, sampledFrom: `sampled as ${password}` },
        view: { unavailable: `permission denied for ${password}` },
      })),
    });
    const response = await call(countsRoute, "counts", { connection: scrubbed, container: ["app"] });
    expect(response.status).toBe(200);
    expect(await parseResponseJSON(response)).toEqual({
      table: { count: 9, sampledFrom: PROVIDER_TEXT_WITHHELD },
      view: { unavailable: PROVIDER_TEXT_WITHHELD },
    });
  });

  test("describe answers an unavailable index sentence that holds the connection's credential withheld", async () => {
    activeProvider = objectProvider({
      describeObject: mock(async (path: readonly string[]) => ({
        ...emptyDetail(path),
        indexes: { unavailable: `index read refused for ${password}` },
      })),
    });
    const response = await call(describeRoute, "describe", {
      connection: scrubbed,
      path: ["app", "orders"],
      kind: "table",
    });
    expect(response.status).toBe(200);
    expect(await parseResponseJSON(response)).toEqual({
      ...emptyDetail(["app", "orders"]),
      indexes: { unavailable: PROVIDER_TEXT_WITHHELD },
    });
  });

  test("inventory answers its details' and the provider's column bound sentences withheld, and keeps Studio's own bound sentence", async () => {
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () => [object(["app", "orders"], "table")]),
      describeObjects: mock(async () => ({
        details: [{ ...emptyDetail(["app", "orders"]), indexes: { unavailable: `refused for ${password}` } }],
        truncated: { limit: 1, reason: `bounded for ${password}` },
      })),
    });
    const response = await call(inventoryRoute, "inventory", { connection: scrubbed, includeColumns: true });
    const body = await parseResponseJSON<{ details: ObjectDetail[]; truncated: { limit: number; reason: string } }>(
      response,
    );
    expect(response.status).toBe(200);
    expect(body.details).toEqual([
      { ...emptyDetail(["app", "orders"]), indexes: { unavailable: PROVIDER_TEXT_WITHHELD } },
    ]);
    expect(body.truncated).toEqual({ limit: 1, reason: PROVIDER_TEXT_WITHHELD });

    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND],
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async () =>
        Array.from({ length: INVENTORY_LIMIT + 1 }, (_unused, index) => object(["app", `t${index}`], "table")),
      ),
      describeObjects: mock(async () => ({
        details: [],
        truncated: { limit: 1, reason: `bounded for ${password}` },
      })),
    });
    const studioBound = await call(inventoryRoute, "inventory", { connection: scrubbed, includeColumns: true });
    expect((await parseResponseJSON<{ truncated: unknown }>(studioBound)).truncated).toEqual({
      limit: INVENTORY_LIMIT,
      reason: "inventory limit reached",
    });
  });

  test("source answers a part's refusal, truncation and refused edit sentences withheld, and joins Studio's bound sentence after a withheld one", async () => {
    const document: ObjectSourceDocument = {
      path: ["app", "order_total(integer)"],
      kind: "function",
      parts: [
        { id: "definition", label: "Definition", unavailable: `refused for ${password}` },
        {
          id: "body",
          label: "Body",
          text: "x".repeat(SOURCE_CHARACTER_LIMIT + 1),
          language: "sql",
          form: "partial",
          origin: "stored",
          truncated: { limit: SOURCE_CHARACTER_LIMIT + 1, reason: `cut for ${password}` },
        },
        {
          id: "comment",
          label: "Comment",
          text: "COMMENT ON FUNCTION order_total(integer) IS 'kept'",
          language: "sql",
          form: "complete",
          origin: "rendered",
          edit: { offered: false, reason: `owned by ${password}` },
        },
      ],
    };
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND, FUNCTION_SOURCE_KIND],
      readObjectSource: mock(async () => document),
    });
    const response = await call(sourceRoute, "source", {
      connection: scrubbed,
      path: ["app", "order_total(integer)"],
      kind: "function",
    });
    const body = await parseResponseJSON<ObjectSourceDocument>(response);
    expect(response.status).toBe(200);
    expect(body.parts[0]).toEqual({ id: "definition", label: "Definition", unavailable: PROVIDER_TEXT_WITHHELD });
    expect(body.parts[1]).toMatchObject({
      truncated: {
        limit: SOURCE_CHARACTER_LIMIT,
        reason: `${PROVIDER_TEXT_WITHHELD}; ${sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT)}`,
      },
    });
    expect(body.parts[2]).toMatchObject({
      text: "COMMENT ON FUNCTION order_total(integer) IS 'kept'",
      edit: { offered: false, reason: PROVIDER_TEXT_WITHHELD },
    });
    expect(JSON.stringify(body)).not.toContain(password);
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

  test("it carries the RESOLVED connection, the guard's session, the route and that connection's scrub, and nothing else", async () => {
    let seen: ObjectRequestContext | undefined;
    // The body names a connectionId and NO connection, so an object taken from the BODY cannot be
    // what the context carries: only the resolution answers the seeded record, and only that record
    // holds the password, so a scrub built from the body would hold no form of it.
    const password = crypto.randomUUID();
    const resolved = { id: "seed-1", name: "Seeded", type: "postgres", password };
    mockResolveConnection.mockResolvedValueOnce(resolved);
    const response = await handleObjectRequest(post({ connectionId: "seed-1" }), probeRoute, async (_p, _b, ctx) => {
      seen = ctx;
      return { ok: true };
    });

    expect(response.status).toBe(200);
    expect(seen?.connection).toEqual(resolved as never);
    expect(seen?.session).toEqual({ role: "admin", username: "admin" });
    expect(seen?.route).toBe(probeRoute);
    expect(seen?.scrub).toEqual(providerTextScrub(resolved as never, "any"));
    expect(seen?.scrub.forms).toContain(password);
    expect(Object.keys(seen ?? {}).sort()).toEqual(["connection", "route", "scrub", "session"]);
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

// ============================================================================
// Server-level connections (#1530)
// ============================================================================

/** A server-level connection's root is every database, so a walk must name one database's containers. */
describe("a server-level connection's walks", () => {
  function serverLevel() {
    const listContainers = mock(async () => [{ path: ["shop"], name: "shop", level: 0 }]);
    activeProvider = objectProvider({
      containerLevels: [CATALOG_LEVEL, SCHEMA_LEVEL],
      catalogSessions: true,
      objectKinds: [TABLE_KIND],
      listContainers,
      listObjects: mock(async (container: readonly string[]) => [object([...container, "orders"], "table")]),
    });
    return listContainers;
  }
  const post = (route: typeof inventoryRoute, path: string, body: Record<string, unknown>) =>
    route.POST(createMockRequest(path, { method: "POST", body: { connection, ...body } }) as never);

  test("an inventory of one database's containers reads them, and an unscoped walk or search is refused", async () => {
    const listContainers = serverLevel();
    const inventory = await post(inventoryRoute, "/api/db/objects/inventory", { containers: [["shop", "public"]] });
    const body = await parseResponseJSON<{ objects: DatabaseObject[] }>(inventory);
    expect(body.objects.map((found) => found.path)).toEqual([["shop", "public", "orders"]]);
    expect((await post(inventoryRoute, "/api/db/objects/inventory", {})).status).toBe(400);
    expect((await post(searchRoute, "/api/db/objects/search", { term: "orders" })).status).toBe(400);
    expect(listContainers).not.toHaveBeenCalled();
  });
});

// ============================================================================
// What the tree routes answer today (the host core keeps it)
// ============================================================================

/**
 * What the four tree routes, the inventory and the search answer today for a provider's error and for a provider's
 * answer. Each title passes on the routes as they are and is the oracle the move of the tree onto the host core keeps
 * unchanged; what that move changes by design, a deadline and a caller that leaves, is its own.
 */
describe("what the tree routes answer today, which the host core keeps", () => {
  /** One tree route: its handler, its path, its body and the provider member it reaches. */
  interface TreeRoute {
    readonly name: string;
    readonly route: { POST: (req: never) => Promise<Response> };
    readonly body: Record<string, unknown>;
    readonly member: "listContainers" | "countObjects" | "listObjects" | "describeObject";
  }
  const TREE_ROUTES: readonly TreeRoute[] = [
    { name: "containers", route: containersRoute, body: {}, member: "listContainers" },
    { name: "counts", route: countsRoute, body: { container: ["app"] }, member: "countObjects" },
    { name: "list", route: listRoute, body: { container: ["app"], kind: "table" }, member: "listObjects" },
    {
      name: "describe",
      route: describeRoute,
      body: { path: ["app", "orders"], kind: "table" },
      member: "describeObject",
    },
  ];

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

  /** `route` posted with the connection and its own body. */
  function post(route: TreeRoute["route"], name: string, body: Record<string, unknown>): Promise<Response> {
    return route.POST(
      createMockRequest(`/api/db/objects/${name}`, { method: "POST", body: { connection, ...body } }) as never,
    );
  }

  /** The provider of a tree route whose member rejects with `error`. */
  function rejecting(member: TreeRoute["member"], error: Error): DatabaseProvider {
    return objectProvider({
      [member]: mock(async () => {
        throw error;
      }),
    });
  }

  test("each tree route answers a provider's Studio error by its class, with its code, kind and outcome", async () => {
    for (const tree of TREE_ROUTES) {
      for (const studio of STUDIO_ERRORS) {
        const text = `refused ${randomUUID()}`;
        const error = studio.raise(text);
        activeProvider = rejecting(tree.member, error);

        // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own provider's.
        const response = await post(tree.route, tree.name, tree.body);
        // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
        const body = await parseResponseJSON<Record<string, unknown>>(response);

        expect([tree.name, studio.name, response.status]).toEqual([tree.name, studio.name, studio.status]);
        expect([tree.name, studio.name, body]).toEqual([
          tree.name,
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
    }
  });

  test("each tree route answers a provider's raw error 500 INTERNAL_ERROR with its own words, and no kind or outcome", async () => {
    for (const tree of TREE_ROUTES) {
      const text = `socket ${randomUUID()}`;
      activeProvider = rejecting(tree.member, new Error(text));

      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own provider's.
      const response = await post(tree.route, tree.name, tree.body);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect([tree.name, response.status]).toEqual([tree.name, 500]);
      expect([tree.name, body]).toEqual([tree.name, { error: text, code: "INTERNAL_ERROR", statusCode: 500 }]);
    }
  });

  test("each tree route asks the provider once with the request's own arguments and answers what the provider answered", async () => {
    const containers: Container[] = [{ path: ["app"], name: "app", level: 0, isSessionDefault: true }];
    const counts: Record<string, KindCount> = {
      table: { count: 2 },
      view: { count: 1204, sampledFrom: `one walk ${randomUUID()}` },
      index: { unavailable: `refused ${randomUUID()}` },
    };
    const objects: DatabaseObject[] = [{ ...object(["app", "orders"], "table"), rowCount: 3 }];
    const detail: ObjectDetail = {
      path: ["app", "orders"],
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: { unavailable: `refused ${randomUUID()}` },
      foreignKeys: [],
    };
    const listContainers = mock(async () => containers);
    const countObjects = mock(async () => counts);
    const listObjects = mock(async () => objects);
    const describeObject = mock(async () => detail);
    activeProvider = objectProvider({ listContainers, countObjects, listObjects, describeObject });
    const answers: [TreeRoute, unknown, ReturnType<typeof mock>, unknown[]][] = [
      [TREE_ROUTES[0] as TreeRoute, containers, listContainers, [undefined]],
      [TREE_ROUTES[1] as TreeRoute, counts, countObjects, [["app"]]],
      [TREE_ROUTES[2] as TreeRoute, objects, listObjects, [["app"], "table"]],
      [TREE_ROUTES[3] as TreeRoute, detail, describeObject, [["app", "orders"], "table"]],
    ];

    for (const [tree, answer, member, args] of answers) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each call log is its own route's.
      const response = await post(tree.route, tree.name, tree.body);

      expect([tree.name, response.status]).toEqual([tree.name, 200]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      expect([tree.name, await parseResponseJSON<unknown>(response)]).toEqual([tree.name, answer]);
      expect([tree.name, member.mock.calls]).toEqual([tree.name, [args]]);
    }
  });

  test("an inventory whose listing or bulk read fails answers that error by its class, and no partial inventory", async () => {
    const listingText = `lost ${randomUUID()}`;
    activeProvider = objectProvider({
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async (container: readonly string[], kind: string) => {
        if (kind === "view") throw new ConnectionError(listingText, "postgres");
        return [object([...container, "orders"], kind)];
      }),
    });
    const listing = await post(inventoryRoute, "inventory", {});
    const listingBody = await parseResponseJSON<Record<string, unknown>>(listing);

    const bulkText = `refused ${randomUUID()}`;
    activeProvider = objectProvider({
      listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]),
      listObjects: mock(async (container: readonly string[], kind: string) => [object([...container, "orders"], kind)]),
      describeObjects: mock(async () => {
        throw new PermissionDeniedError(bulkText, "postgres");
      }),
    });
    const bulk = await post(inventoryRoute, "inventory", { includeColumns: true });
    const bulkBody = await parseResponseJSON<Record<string, unknown>>(bulk);

    expect(listing.status).toBe(503);
    expect(listingBody).toEqual({
      error: listingText,
      code: "CONNECTION_ERROR",
      statusCode: 503,
      retryable: true,
      kind: errorKind(new ConnectionError(listingText, "postgres")),
      outcome: "unknown",
    });
    expect(bulk.status).toBe(403);
    expect(bulkBody).toEqual({
      error: bulkText,
      code: "PERMISSION_DENIED",
      statusCode: 403,
      kind: errorKind(new PermissionDeniedError(bulkText, "postgres")),
      outcome: "unknown",
    });
  });

  test("a search whose listing fails answers that error by its class, and no partial match list", async () => {
    const text = `timed out ${randomUUID()}`;
    activeProvider = objectProvider({
      listContainers: mock(async () => [
        { path: ["app"], name: "app", level: 0 },
        { path: ["ops"], name: "ops", level: 0 },
      ]),
      listObjects: mock(async (container: readonly string[], kind: string) => {
        if (container[0] === "ops") throw new TimeoutError(text, "postgres", 1000);
        return [object([...container, "orders"], kind)];
      }),
    });

    const response = await post(searchRoute, "search", { term: "orders" });
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(504);
    expect(body).toEqual({
      error: TIMEOUT_SENTENCE,
      code: "TIMEOUT_ERROR",
      statusCode: 504,
      retryable: true,
      kind: errorKind(new TimeoutError(text, "postgres", 1000)),
      outcome: "unknown",
    });
  });
});

describe("the tree routes on the host core", () => {
  /** One single-read tree route: its handler, its path, its body, the provider member it reaches and its read's noun. */
  interface SingleRead {
    readonly name: string;
    readonly route: { POST: (req: never) => Promise<Response> };
    readonly body: Record<string, unknown>;
    readonly member: "listContainers" | "countObjects" | "listObjects" | "describeObject";
    readonly noun: string;
  }
  const SINGLE_READS: readonly SingleRead[] = [
    { name: "containers", route: containersRoute, body: {}, member: "listContainers", noun: "The container listing" },
    {
      name: "counts",
      route: countsRoute,
      body: { container: ["app"] },
      member: "countObjects",
      noun: "The object count",
    },
    {
      name: "list",
      route: listRoute,
      body: { container: ["app"], kind: "table" },
      member: "listObjects",
      noun: "The object listing",
    },
    {
      name: "describe",
      route: describeRoute,
      body: { path: ["app", "orders"], kind: "table" },
      member: "describeObject",
      noun: "The object description",
    },
  ];

  /** `route` posted with the connection, its own body and `signal`, as a request whose caller can leave. */
  function postWith(
    route: SingleRead["route"],
    name: string,
    body: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Response> {
    const request = new Request(`http://localhost:3000/api/db/objects/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connection, ...body }),
      signal,
    });
    return route.POST(request as never);
  }

  /** A provider member that signals when it is reached and answers only when the test settles it. */
  function heldMember<T>() {
    const answer = Promise.withResolvers<T>();
    const reached = Promise.withResolvers<void>();
    const member = mock(() => {
      reached.resolve();
      return answer.promise;
    });
    return { answer, reached: reached.promise, member };
  }

  /** D5's sentence for `noun` at Studio's default statement timeout, the mock connection's. */
  const deadlineSentence = (noun: string) =>
    `${noun} did not answer within the statement timeout of ${waitedSeconds(DEFAULT_QUERY_TIMEOUT)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`;

  /** Runs `body` with `make(real)` installed in place of the real host core, then puts the real one back. */
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

  test("a tree route whose request leaves while the provider reads answers 499 at once, outcome unknown", async () => {
    for (const tree of SINGLE_READS) {
      const held = heldMember<never>();
      activeProvider = objectProvider({ [tree.member]: held.member });
      const caller = new AbortController();

      const answering = postWith(tree.route, tree.name, tree.body, caller.signal);
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own provider's.
      await held.reached;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above, before its member settles.
      const response = await answering;
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const body = await parseResponseJSON<Record<string, unknown>>(response);
      held.answer.reject(new Error(randomUUID()));
      // oxlint-disable-next-line no-await-in-loop -- the member settles after the answer, with a plain await.
      await held.answer.promise.catch(() => undefined);

      expect([tree.name, response.status]).toEqual([tree.name, 499]);
      expect([tree.name, body]).toMatchObject([
        tree.name,
        { code: "QUERY_CANCELLED", kind: "cancelled", outcome: "unknown" },
      ]);
    }
  });

  test("a tree route whose request is already gone answers 499 not-sent and asks the provider nothing", async () => {
    for (const tree of SINGLE_READS) {
      const member = mock(async () => {
        throw new Error("a request already gone reached the provider");
      });
      activeProvider = objectProvider({ [tree.member]: member });
      const caller = new AbortController();
      caller.abort(new DOMException("The request went away.", "AbortError"));

      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own provider's.
      const response = await postWith(tree.route, tree.name, tree.body, caller.signal);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect([tree.name, response.status]).toEqual([tree.name, 499]);
      expect([tree.name, body]).toMatchObject([
        tree.name,
        { code: "QUERY_CANCELLED", kind: "cancelled", outcome: "not-sent" },
      ]);
      expect([tree.name, member.mock.calls.length]).toEqual([tree.name, 0]);
    }
    // The route's own checks still run first: a body with no container is the caller's mistake, a 400.
    const gone = new AbortController();
    gone.abort(new DOMException("The request went away.", "AbortError"));
    const refused = await postWith(countsRoute, "counts", {}, gone.signal);
    expect(refused.status).toBe(400);
  });

  test("an inventory or a search whose request leaves between its reads sends no further read", async () => {
    for (const [route, name, body] of [
      [inventoryRoute, "inventory", { includeColumns: true }],
      [searchRoute, "search", { term: "orders" }],
    ] as const) {
      const second = heldMember<DatabaseObject[]>();
      const listObjects = mock(async (container: readonly string[], kind: string) => {
        if (listObjects.mock.calls.length === 2) return second.member();
        return [object([...container, "orders"], kind)];
      });
      const describeObjects = mock(async () => ({ details: [] }));
      activeProvider = objectProvider({
        listContainers: mock(async () => [
          { path: ["app"], name: "app", level: 0 },
          { path: ["ops"], name: "ops", level: 0 },
        ]),
        listObjects,
        describeObjects,
      });
      const caller = new AbortController();

      const answering = postWith(route, name, body, caller.signal);
      // oxlint-disable-next-line no-await-in-loop -- one walk at a time, so each call log is its own route's.
      await second.reached;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      // oxlint-disable-next-line no-await-in-loop -- the answer of the walk above.
      const response = await answering;
      second.answer.resolve([object(["app", "orders"], "view")]);
      // oxlint-disable-next-line no-await-in-loop -- the held listing settles after the answer, with a plain await.
      await second.answer.promise;

      expect([name, response.status]).toEqual([name, 499]);
      expect([name, listObjects.mock.calls.length]).toEqual([name, 2]);
      // The inventory described the first pair's object before the second listing, and nothing after it.
      expect([name, describeObjects.mock.calls.length]).toEqual([name, name === "inventory" ? 1 : 0]);
    }
  });

  test("a tree route past its deadline answers 504 studio-timeout-refusal naming the read", async () => {
    const stopAt = (action: string) => (real: HostCore) => ({
      ...real,
      treeCall: (async (session, request, ctx, ports) =>
        request.action === action
          ? {
              kind: "stopped",
              reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
              settled: Promise.resolve(),
            }
          : real.treeCall(session, request, ctx, ports)) satisfies HostCore["treeCall"],
    });
    const actions: Record<SingleRead["name"], string> = {
      containers: "containers",
      counts: "count",
      list: "list",
      describe: "describe",
    };
    const answers: [string, Response, string][] = [];
    for (const tree of SINGLE_READS) {
      activeProvider = objectProvider();
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own core's.
      const response = await withCore(stopAt(actions[tree.name] as string), () =>
        postWith(tree.route, tree.name, tree.body),
      );
      answers.push([tree.name, response, tree.noun]);
    }
    activeProvider = objectProvider({ listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]) });
    const inventory = await withCore(stopAt("list"), () => postWith(inventoryRoute, "inventory", {}));
    answers.push(["inventory", inventory, "The object listing"]);

    for (const [name, response, noun] of answers) {
      // oxlint-disable-next-line no-await-in-loop -- each answer's body, read in order.
      const body = await parseResponseJSON<Record<string, unknown>>(response);
      expect([name, response.status]).toEqual([name, 504]);
      expect([name, body]).toMatchObject([
        name,
        {
          error: deadlineSentence(noun),
          code: "TIMEOUT_ERROR",
          kind: "studio-timeout-refusal",
          outcome: "unknown",
        },
      ]);
    }
  });

  test("every read of an inventory, its container walk included, is a host core tree call with a deadline of its own", async () => {
    activeProvider = objectProvider({
      listContainers: mock(async () => [
        { path: ["app"], name: "app", level: 0 },
        { path: ["ops"], name: "ops", level: 0 },
      ]),
      listObjects: mock(async (container: readonly string[], kind: string) =>
        container[0] === "app" ? [object([...container, `${kind}s`], kind)] : [],
      ),
      describeObjects: mock(async () => ({ details: [] })),
    });
    const calls: { readonly action: string; readonly ctx: CallContext }[] = [];
    const before = Date.now();
    const response = await withCore(
      (real) => ({
        ...real,
        treeCall: (session, request, ctx, ports) => {
          calls.push({ action: request.action, ctx });
          return real.treeCall(session, request, ctx, ports);
        },
      }),
      () => postWith(inventoryRoute, "inventory", { includeColumns: true }),
    );
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(calls.map(({ action }) => action)).toEqual([
      "containers",
      "list",
      "describeMany",
      "list",
      "describeMany",
      "list",
      "list",
    ]);
    const slack = DEFAULT_QUERY_TIMEOUT + EXECUTE_SLACK_MS;
    expect(new Set(calls.map(({ ctx }) => ctx)).size).toBe(calls.length);
    for (const { ctx } of calls) {
      expect(ctx.deadline).toBeGreaterThanOrEqual(before + slack);
      expect(ctx.deadline).toBeLessThanOrEqual(after + slack);
    }
    const deadlines = calls.map(({ ctx }) => ctx.deadline);
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  });

  test("a tree route reads no catalog, and its provider's forCatalog is never called", async () => {
    const forCatalog = mock(async () => {
      throw new Error("a tree route asked for another catalog");
    });
    const posts: [string, SingleRead["route"], Record<string, unknown>][] = [
      ...SINGLE_READS.map((tree): [string, SingleRead["route"], Record<string, unknown>] => [
        tree.name,
        tree.route,
        tree.body,
      ]),
      ["search", searchRoute, { term: "orders" }],
      ["inventory", inventoryRoute, { includeColumns: true }],
    ];
    const statuses: [string, number][] = [];
    for (const [name, route, body] of posts) {
      activeProvider = Object.assign(
        objectProvider({ listContainers: mock(async () => [{ path: ["app"], name: "app", level: 0 }]) }),
        { forCatalog },
      );
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own provider's.
      const response = await postWith(route, name, { ...body, catalog: `other_${randomUUID()}` });
      statuses.push([name, response.status]);
    }

    expect(statuses).toEqual(posts.map(([name]) => [name, 200]));
    expect(forCatalog).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The tree routes on the metadata session (docs/providers/CONTRACT.md, clause C-66)
// ============================================================================

describe("the tree routes on the metadata session", () => {
  /** The session the mocked guard answers, which every route derives its execution context from. */
  const ADMIN = { role: "admin", username: "admin" } as unknown as UserPayload;

  /** Each object route, the body it reads, and the session its provider resolves on. */
  const ROUTES: readonly [string, { POST: (req: never) => Promise<Response> }, Record<string, unknown>, string][] = [
    ["containers", containersRoute, {}, "metadata"],
    ["counts", countsRoute, { container: ["app"] }, "metadata"],
    ["list", listRoute, { container: ["app"], kind: "table" }, "metadata"],
    ["describe", describeRoute, { path: ["app", "orders"], kind: "table" }, "metadata"],
    ["search", searchRoute, { term: "orders" }, "metadata"],
    ["inventory", inventoryRoute, {}, "metadata"],
    ["source", sourceRoute, { path: ["app", "orders"], kind: "table" }, "editor"],
    ["edit-plan", editPlanRoute, { path: ["app", "orders"], kind: "table" }, "editor"],
    ["edit-apply", editApplyRoute, { path: ["app", "orders"], kind: "table" }, "editor"],
  ];

  const post = (name: string, route: { POST: (req: never) => Promise<Response> }, body: Record<string, unknown>) =>
    route.POST(
      createMockRequest(`/api/db/objects/${name}`, { method: "POST", body: { connection, ...body } }) as never,
    );

  test("each tree route reads on the connection's metadata session, and the source and edit routes on the editor's", async () => {
    // Every route on the file's census, so a tenth route is placed here too.
    expect(ROUTES.map(([name]) => name).sort()).toEqual(Object.keys(objectRoutes).sort());
    const context = editorExecutionContext(ADMIN, connection as never);
    for (const [name, route, body, session] of ROUTES) {
      mockGetOrCreateProvider.mockClear();
      mockGetOrCreateMetadataProvider.mockClear();
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each resolution count is its own route's.
      const response = await post(name, route, body);
      const resolved = session === "metadata" ? mockGetOrCreateMetadataProvider : mockGetOrCreateProvider;
      const other = session === "metadata" ? mockGetOrCreateProvider : mockGetOrCreateMetadataProvider;
      expect([name, resolved.mock.calls as unknown[][]]).toEqual([name, [[connection, {}, context]]]);
      expect([name, other.mock.calls.length]).toEqual([name, 0]);
      if (session === "metadata") expect([name, response.status]).toEqual([name, 200]);
    }
  });

  test("a tree route answers while the editor's provider holds every read, without waiting for it", async () => {
    // The editor's provider holds every tree read until the end, and signals when one reaches it.
    const reached = Promise.withResolvers<string>();
    const held = Promise.withResolvers<never>();
    const holds = (member: string) =>
      mock(() => {
        reached.resolve(member);
        return held.promise;
      });
    activeProvider = objectProvider({
      listContainers: holds("listContainers"),
      countObjects: holds("countObjects"),
      listObjects: holds("listObjects"),
      describeObject: holds("describeObject"),
      describeObjects: holds("describeObjects"),
    });
    const marker = `answered_${randomUUID().replaceAll("-", "")}`;
    const metadata = objectProvider({
      listContainers: mock(async () => [{ path: [marker], name: marker, level: 0 }]),
      countObjects: mock(async () => ({ [marker]: { count: 1 } })),
      listObjects: mock(async (container: readonly string[], kind: string) => [object([...container, marker], kind)]),
      describeObject: mock(async () => emptyDetail(["app", marker])),
    });
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata);

    const winners: [string, string, number, string][] = [];
    for (const [name, route, body] of ROUTES.filter(([each]) =>
      ["containers", "counts", "list", "describe", "inventory"].includes(each),
    )) {
      const answering = post(name, route, body);
      // A tree read that went to the editor's provider loses this race at once: `reached` resolves as it is called.
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each race is its own route's.
      const winner = await Promise.race([answering.then(() => "answer"), reached.promise.then(() => "editor")]);
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above, once it has won.
      const response = winner === "answer" ? await answering : undefined;
      // oxlint-disable-next-line no-await-in-loop -- the answer's body, read in order.
      const text = response === undefined ? "" : await response.text();
      winners.push([name, winner, response?.status ?? 0, text.includes(marker) ? "metadata answer" : text]);
    }
    held.reject(new Error("the test ended"));
    await held.promise.catch(() => undefined);

    expect(winners).toEqual(
      ["containers", "counts", "list", "describe", "inventory"].map((name) => [name, "answer", 200, "metadata answer"]),
    );
  });

  test("handleObjectRequest resolves the editor's provider by default and the metadata session when asked, after the guard and the connection's resolution", async () => {
    const probeRoute = "api/db/objects/probe";
    const request = () =>
      createMockRequest(`/${probeRoute}`, { method: "POST", body: { connection } }) as never as Parameters<
        typeof handleObjectRequest
      >[0];
    const answered = async (provider: DatabaseProvider) => ({ editor: provider === activeProvider });
    const metadata = objectProvider();
    mockGetOrCreateMetadataProvider.mockImplementation(async () => metadata);
    const context = editorExecutionContext(ADMIN, connection as never);

    const options: [string, Parameters<typeof handleObjectRequest>[3]][] = [
      ["no options", undefined],
      ["the editor's session", { session: "editor" }],
      ["the metadata session", { session: "metadata" }],
    ];
    const seen: [string, unknown, number, number][] = [];
    for (const [label, option] of options) {
      mockGetOrCreateProvider.mockClear();
      mockGetOrCreateMetadataProvider.mockClear();
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each resolution count is its own.
      const response = await handleObjectRequest(request(), probeRoute, answered, option);
      seen.push([
        label,
        // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
        await parseResponseJSON(response),
        mockGetOrCreateProvider.mock.calls.length,
        mockGetOrCreateMetadataProvider.mock.calls.length,
      ]);
    }
    expect(seen).toEqual([
      ["no options", { editor: true }, 1, 0],
      ["the editor's session", { editor: true }, 1, 0],
      ["the metadata session", { editor: false }, 0, 1],
    ]);
    expect(mockGetOrCreateMetadataProvider.mock.calls as unknown[][]).toEqual([[connection, {}, context]]);

    // The guard runs first: a caller with no session is refused before the connection is resolved or a session opened.
    mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });
    mockResolveConnection.mockClear();
    mockGetOrCreateMetadataProvider.mockClear();
    const refused = await handleObjectRequest(request(), probeRoute, answered, { session: "metadata" });
    expect(refused.status).toBe(401);
    expect(mockResolveConnection).toHaveBeenCalledTimes(0);
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(0);

    // A connection that does not resolve is refused before a metadata session is opened.
    mockResolveConnection.mockRejectedValueOnce(new SeedConnectionError("Connection not found", 404));
    const unresolved = await handleObjectRequest(request(), probeRoute, answered, { session: "metadata" });
    expect(unresolved.status).toBe(404);
    expect(mockGetOrCreateMetadataProvider).toHaveBeenCalledTimes(0);
  });
});

describe("the object model the routes read", () => {
  /** A source-bearing kind, editable or not. */
  const sourceKind = (id: string, acceptsSourceEdits: boolean): ObjectKindSpec => ({
    id,
    role: "routine",
    label: id,
    labelPlural: id,
    hasSource: true,
    sourceLanguage: "sql",
    acceptsSourceEdits,
  });

  test("a list or describe naming a kind the connection's object model does not state is refused before any provider call, outcome not-sent, in Studio's words", async () => {
    const listObjects = mock(async () => []);
    const describeObject = mock(async (path: readonly string[]) => emptyDetail(path));
    activeProvider = objectProvider({ listObjects, describeObject });
    const unstated = `kind${randomUUID().replaceAll("-", "")}`;

    const listed = await listRoute.POST(
      createMockRequest("/api/db/objects/list", {
        method: "POST",
        body: { connection, container: ["app"], kind: unstated },
      }) as never,
    );
    const described = await describeRoute.POST(
      createMockRequest("/api/db/objects/describe", {
        method: "POST",
        body: { connection, path: ["app", "orders"], kind: unstated },
      }) as never,
    );

    for (const response of [listed, described]) {
      expect(response.status).toBe(400);
      const body = await parseResponseJSON<Record<string, unknown>>(response);
      expect(body).toEqual({
        error:
          "The request names an object kind this connection's object model does not state, so Studio did not call the provider.",
        code: "QUERY_ERROR",
        statusCode: 400,
        kind: "studio-object-model-refusal",
        outcome: "not-sent",
      });
      expect(JSON.stringify(body)).not.toContain(unstated);
    }
    expect(listObjects).toHaveBeenCalledTimes(0);
    expect(describeObject).toHaveBeenCalledTimes(0);
  });

  test("the source route reads the object model the bridge states for the provider: an unstated kind is refused by name and the edit flag is the model's", async () => {
    const editablePart: ObjectSourcePart = {
      id: "body",
      label: "Body",
      text: "CREATE FUNCTION f() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql",
      language: "sql",
      form: "complete",
      origin: "regenerated",
      edit: { offered: true },
    };
    const readObjectSource = mock(async (path: readonly string[], kind: string) => ({
      path: [...path],
      kind,
      parts: [editablePart] as [ObjectSourcePart],
    }));
    activeProvider = objectProvider({
      objectKinds: [TABLE_KIND, sourceKind("function", true), sourceKind("view_source", false)],
      readObjectSource,
    });
    const post = async (kind: string) => {
      const response = await sourceRoute.POST(
        createMockRequest("/api/db/objects/source", {
          method: "POST",
          body: { connection, path: ["app", "f"], kind },
        }) as never,
      );
      return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
    };

    const unstated = await post("procedure");
    const editable = await post("function");
    const readOnly = await post("view_source");

    expect(unstated).toEqual({
      status: 400,
      body: { error: 'postgres declares no readable source for kind "procedure"', outcome: "not-sent" },
    });
    expect(readObjectSource.mock.calls.map(([, kind]) => kind)).toEqual(["function", "view_source"]);
    expect(editable.status).toBe(200);
    expect((editable.body as unknown as ObjectSourceDocument).parts[0]).toHaveProperty("edit", { offered: true });
    expect(readOnly.status).toBe(200);
    expect((readOnly.body as unknown as ObjectSourceDocument).parts[0]).not.toHaveProperty("edit");
  });

  test("a containers parent deeper than the connection's object model states is refused at the edge, outcome not-sent", async () => {
    const listContainers = mock(async () => []);
    activeProvider = objectProvider({ listContainers });

    const response = await containersRoute.POST(
      createMockRequest("/api/db/objects/containers", {
        method: "POST",
        body: { connection, parent: ["app", "nested"] },
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(await parseResponseJSON<Record<string, unknown>>(response)).toEqual({
      error: 'postgres declares a container depth of 1, and "parent" has 2 segments: ["app","nested"]',
      outcome: "not-sent",
    });
    expect(listContainers).toHaveBeenCalledTimes(0);
  });
});
