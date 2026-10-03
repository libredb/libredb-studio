/**
 * QdrantProvider at its own seam (vector-family spec 3.13, 6.2, 6.7): the declarations with no client; the
 * connect sequence with its two requests; the version's gate reaching the payload sample; one limiter permit per
 * read; and that every surface answers exactly what the module that owns it answers over the same answers, so the
 * provider composes and never reshapes.
 *
 * Every client comes from `recordingClientFactory` (tests/helpers/qdrant-surface-client.ts), which answers from
 * the captures of the seeded server; the real REST client over a recording transport runs in
 * `tests/integration/db/qdrant-provider.test.ts`. The credential is the stand-in TEST_PASSWORD.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { QdrantAnswer, QdrantRequest, QdrantRouteTemplates } from "@/lib/db/providers/vector/qdrant/client";
import { QDRANT_DEFAULT_PORT } from "@/lib/db/providers/vector/qdrant/connection-options";
import { qdrantTableQuery } from "@/lib/db/providers/vector/qdrant/generators";
import { QDRANT_LIMITER_OPTIONS, QDRANT_ROUTE_TEMPLATES, QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { QDRANT_LABELS } from "@/lib/db/providers/vector/qdrant/labels";
import { toQdrantIndexStats, toQdrantTableStats } from "@/lib/db/providers/vector/qdrant/monitoring";
import { QDRANT_OBJECT_KINDS, VISIBLE_TO_CREDENTIAL } from "@/lib/db/providers/vector/qdrant/objects";
import { readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { expectCalls } from "../../../helpers/call-log";
import { QDRANT_FIXTURE_ROUTES } from "../../../helpers/qdrant-routes";
import { recordingClientFactory } from "../../../helpers/qdrant-surface-client";
import { recordedAnswer, resultOf, SEEDED_COLLECTIONS, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";

const TEST_PASSWORD = "password";

const CONNECTION: DatabaseConnection = {
  id: "qdrant-unit",
  name: "Qdrant",
  type: "qdrant",
  host: "127.0.0.1",
  port: QDRANT_DEFAULT_PORT,
  createdAt: new Date(0),
};

const status = (code: number, text: string): QdrantAnswer => ({
  status: code,
  contentType: "text/plain",
  retryAfter: null,
  text,
});

/** The recorded server, with one operation's answer replaced. */
function answering(op: QdrantRequest["op"], answer: QdrantAnswer) {
  return (request: QdrantRequest) => (request.op === op ? answer : recordedAnswer(request));
}

function providerOf(
  answer?: (request: QdrantRequest) => QdrantAnswer | Promise<QdrantAnswer>,
  connection: Partial<DatabaseConnection> = {},
  execution: ProviderExecutionContext = {},
) {
  const clients = recordingClientFactory(answer);
  const provider = new QdrantProvider({ ...CONNECTION, ...connection }, {}, execution, clients.factory);
  return { provider, clients };
}

async function connected(...args: Parameters<typeof providerOf>) {
  const built = providerOf(...args);
  await built.provider.connect();
  built.clients.calls.length = 0;
  return built;
}

const DESCRIBED = SEEDED_COLLECTIONS.map((name) =>
  readQdrantCollection(name, resultOf(vectorCapture(`describe-${name}`))),
);

describe("declarations", () => {
  test("the constructor validates nothing and builds no client", () => {
    const { provider, clients } = providerOf(undefined, { user: "refused-at-connect" });
    expect(provider.isConnected()).toBe(false);
    expect(clients.built).toEqual([]);
  });

  test("every capability is written out", () => {
    // Read as a plain record: until the type-id is registered, "qdrant" is not yet a member of the dialect union.
    const capabilities: object = providerOf().provider.getCapabilities();
    expect(capabilities).toEqual({
      queryLanguage: "json",
      queryDialect: "qdrant",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      statementTerminator: "none",
      defaultPort: 6333,
      containerLevels: [],
      objectKinds: QDRANT_OBJECT_KINDS,
      enforcesReadOnly: true,
      schemaRefreshPattern: "(?!)",
    });
  });

  test("the labels are labels.ts's, as a copy", () => {
    const { provider } = providerOf();
    expect(provider.getLabels()).toEqual(QDRANT_LABELS);
    expect(provider.getLabels()).not.toBe(QDRANT_LABELS);
  });

  test("a request is run as written: no limit is added and there is no page two", () => {
    expect(providerOf().provider.prepareQuery("GET /collections")).toEqual({
      query: "GET /collections",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });

  test("the limiter's bounds are spec 6.6's", () => {
    expect(QDRANT_LIMITER_OPTIONS).toEqual({ perProvider: 4, perEngine: 16, queueDepth: 64 });
  });

  test("the client's route table is the 17 routes of the pinned OpenAPI's v1 fixture", () => {
    // The client reads a route's query keys as a set, so their order is not compared.
    const normalised = (table: QdrantRouteTemplates) =>
      Object.fromEntries(
        Object.entries(table).map(([op, route]) => [op, { ...route, query: [...route.query].sort() }]),
      );
    expect(normalised(QDRANT_ROUTE_TEMPLATES)).toEqual(normalised(QDRANT_FIXTURE_ROUTES));
    expect(Object.keys(QDRANT_ROUTE_TEMPLATES)).toHaveLength(17);
  });
});

describe("connect", () => {
  test("exactly two requests, GET / and then GET /collections, with the route table", async () => {
    const { provider, clients } = providerOf();
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expectCalls(clients, ["root", "get_collections"]);
    expect(clients.built).toHaveLength(1);
    expect(clients.built[0].routes).toBe(QDRANT_ROUTE_TEMPLATES);
  });

  test("the execution profile's read-only mode reaches the connection options", async () => {
    const { provider, clients } = providerOf(undefined, {}, { readOnly: true });
    await provider.connect();
    expect(clients.built[0].options.readOnly).toBe("execution-profile");
  });

  test("a refused connection builds no client and sends nothing", async () => {
    const { provider, clients } = providerOf(undefined, { user: "admin" });
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    expect(clients.built).toEqual([]);
    expectCalls(clients, []);
    expect(provider.isConnected()).toBe(false);
  });

  test("a 401 on the collection list is the API key's refusal, and the client is closed", async () => {
    const { provider, clients } = providerOf(answering("get_collections", status(401, "Invalid API key or JWT")));
    await expect(provider.connect()).rejects.toThrow(AuthenticationError);
    await expect(provider.connect()).rejects.toThrow("Qdrant refused the API key or JWT");
    expect(clients.closed()).toBe(2);
    expect(provider.isConnected()).toBe(false);
  });

  test("a 403 on the collection list says the credential may not list collections", async () => {
    const forbidden = {
      ...status(403, '{"status":{"error":"Forbidden: Global access is required"}}'),
      contentType: "application/json",
    };
    const { provider } = providerOf(answering("get_collections", forbidden));
    await expect(provider.connect()).rejects.toThrow("not allowed to list collections");
  });

  test("an empty collection list connects with no warning", async () => {
    const empty = {
      ...status(200, '{"result":{"collections":[]},"status":"ok","time":0}'),
      contentType: "application/json",
    };
    const { provider } = providerOf(answering("get_collections", empty));
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
  });

  test("disconnect closes the one client", async () => {
    const { provider, clients } = await connected();
    await provider.disconnect();
    expect(clients.closed()).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });
});

describe("the version reaches the payload sample", () => {
  test.each([
    ["1.19.1", true],
    ["1.19.0", true],
    ["1.18.3", false],
    ["1.20.0-dev", false],
  ])("a server reporting %s samples by slice: %s", async (version, slice) => {
    const root = { ...status(200, JSON.stringify({ title: "qdrant", version })), contentType: "application/json" };
    const { provider, clients } = await connected(answering("root", root));
    await provider.describeObject(["docs"], "collection");
    expect(String(clients.calls[1].args?.[1]).includes('"slice"')).toBe(slice);
  });

  test("a server reporting no version connects and samples the first page", async () => {
    const root = { ...status(200, '{"title":"qdrant"}'), contentType: "application/json" };
    const { provider, clients } = await connected(answering("root", root));
    await provider.describeObject(["docs"], "collection");
    expect(clients.calls[1].args?.[1]).toBe('{"limit":1000,"with_payload":true,"with_vector":false}');
  });
});

describe("the surfaces compose and never reshape", () => {
  test("the tree: no container, the count, the listing", async () => {
    const { provider, clients } = await connected();
    expect(await provider.listContainers()).toEqual([]);
    expect(await provider.countObjects([])).toEqual({ collection: { count: 7 } });
    expect((await provider.listObjects([], "collection")).map((object) => object.name)).toEqual([
      ...SEEDED_COLLECTIONS,
    ]);
    expectCalls(clients, ["get_collections", "get_collections"]);
  });

  test("with a credential the listing is labelled as what it may see", async () => {
    const { provider } = await connected(undefined, { password: TEST_PASSWORD });
    expect(await provider.countObjects([])).toEqual({ collection: { count: 7, sampledFrom: VISIBLE_TO_CREDENTIAL } });
  });

  test("a container path is refused with no request", async () => {
    const { provider, clients } = await connected();
    await expect(provider.countObjects(["default"])).rejects.toThrow("has no container level");
    await expect(provider.listObjects(["default"], "collection")).rejects.toThrow("has no container level");
    await expect(provider.describeObjects(["default"], "collection")).rejects.toThrow("has no container level");
    expectCalls(clients, []);
  });

  test("describeObject, describeObjects and the Source make objects.ts's reads", async () => {
    const { provider, clients } = await connected();
    await provider.describeObject(["plain"], "collection");
    expectCalls(clients, ["get_collection", "scroll_points"]);
    clients.calls.length = 0;
    const batch = await provider.describeObjects([], "collection", 3);
    expect(batch.details).toHaveLength(3);
    expectCalls(clients, ["get_collections", "get_collection", "get_collection", "get_collection"]);
    clients.calls.length = 0;
    await provider.readObjectSource(["docs"], "collection");
    expect(clients.calls).toHaveLength(6);
  });

  test("the panels are monitoring.ts's over the same descriptions", async () => {
    const { provider } = await connected();
    expect(await provider.getTableStats()).toEqual(toQdrantTableStats(DESCRIBED));
    expect(await provider.getIndexStats()).toEqual(toQdrantIndexStats(DESCRIBED));
    expect((await provider.getOverview()).version).toBe("1.19.1");
    expect((await provider.getHealth()).databaseSize).toBe("N/A");
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("a surface's failure is worded by errors.ts: a 503 is a connection error", async () => {
    const { provider } = await connected(answering("get_collection", status(503, "Service Unavailable")));
    await expect(provider.describeObject(["docs"], "collection")).rejects.toThrow(ConnectionError);
  });

  test("a surface read takes one permit each: twenty descriptions never put five in flight", async () => {
    const names = Array.from({ length: 20 }, (_, index) => `c${index}`);
    const { provider, clients } = await connected(async (request) => {
      if (request.op === "get_collections") {
        return {
          ...status(200, JSON.stringify({ result: { collections: names.map((name) => ({ name })) } })),
          contentType: "application/json",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return recordedAnswer({ ...request, params: { collection_name: "plain" } });
    });
    await provider.describeObjects([], "collection");
    expect(clients.maxInFlight()).toBeLessThanOrEqual(4);
  });

  test("before connect every surface refuses with no request", async () => {
    const { provider, clients } = providerOf();
    await expect(provider.countObjects([])).rejects.toThrow();
    await expect(provider.getOverview()).rejects.toThrow();
    await expect(provider.getPerformanceMetrics()).rejects.toThrow();
    expectCalls(clients, []);
  });
});

describe("the query path", () => {
  test("bound parameters are refused; an empty list binds nothing", async () => {
    const { provider, clients } = await connected();
    await expect(provider.query("GET /collections", ["x"])).rejects.toThrow("Bound params are not supported");
    expectCalls(clients, []);
    await provider.query("GET /collections", []);
    expectCalls(clients, ["get_collections"]);
  });

  test("a request is execute.ts's: one call for one request", async () => {
    const { provider, clients } = await connected();
    await provider.query("GET /collections/docs");
    expectCalls(clients, ["get_collection"]);
  });

  test("a legacy name such as a:b, listed by the server, opens from the tree with exactly one scroll of that collection", async () => {
    const listed = {
      ...status(200, '{"result":{"collections":[{"name":"a:b"}]},"status":"ok","time":0}'),
      contentType: "application/json",
    };
    const scrolled = {
      ...status(200, '{"result":{"points":[],"next_page_offset":null},"status":"ok","time":0}'),
      contentType: "application/json",
    };
    const { provider, clients } = await connected((request) =>
      request.op === "get_collections"
        ? listed
        : request.op === "scroll_points"
          ? scrolled
          : recordedAnswer({ ...request, params: { collection_name: "plain" } }),
    );
    const [object] = await provider.listObjects([], "collection");
    clients.calls.length = 0;
    await provider.query(qdrantTableQuery(object.path));
    // execute.ts describes a point route's collection before it runs the request (spec 6.6, phase 1).
    expect(clients.calls.map((call) => [call.method, call.args?.[0]])).toEqual([
      ["get_collection", "a:b"],
      ["scroll_points", "a:b"],
    ]);
  });

  test("a console request's failure is worded by errors.ts, with the request's own deadline", async () => {
    const missing = { ...status(404, "Not found: Collection `gone` doesn't exist!"), contentType: "text/plain" };
    const { provider } = await connected(answering("get_collection", missing));
    await expect(provider.query("GET /collections/gone")).rejects.toThrow(
      "The collection does not exist or is not visible to this credential.",
    );
    const broken = await connected((request) => {
      if (request.op === "get_collection") throw new Error("socket closed");
      return recordedAnswer(request);
    });
    await expect(broken.provider.query("GET /collections/docs")).rejects.toThrow("in a way Studio does not recognise");
  });

  test("cancelQuery answers false for a run it does not know", async () => {
    const { provider } = await connected();
    expect(await provider.cancelQuery("q-1-unknown")).toBe(false);
  });
});

describe("maintenance", () => {
  test("there is none in this version: refused with no request", async () => {
    const { provider, clients } = await connected();
    await expect(provider.runMaintenance()).rejects.toThrow(QueryError);
    await expect(provider.runMaintenance()).rejects.toThrow("no maintenance operation");
    expectCalls(clients, []);
  });
});
