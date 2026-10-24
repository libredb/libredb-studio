/**
 * WeaviateProvider at its own seam (#1566 spec 2.3, 3.1, 6.2, 7, 9): the declarations with no client; the connect
 * sequence of exactly one `GET /v1/meta`, closing what it built on a failure; the warning below the floor; a console
 * request's failures worded by errors.ts with the request's deadline; a cancel by `queryId`; one limiter permit per
 * call; the container guard; and that every surface answers what the module that owns it answers over the same
 * answers, so the provider composes and never reshapes.
 *
 * Every client comes from `fakeClients` (tests/helpers/weaviate-surface.ts), answering from the captures of the
 * seeded servers or from answers written here in the shape the captures show.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  WEAVIATE_LIMITER_OPTIONS,
  WEAVIATE_ROUTE_TEMPLATES,
  WeaviateProvider,
} from "@/lib/db/providers/vector/weaviate/index";
import { WEAVIATE_LABELS } from "@/lib/db/providers/vector/weaviate/labels";
import {
  readWeaviateHealth,
  readWeaviateIndexStats,
  readWeaviateOverview,
  readWeaviateTableStats,
} from "@/lib/db/providers/vector/weaviate/monitoring-reads";
import {
  countWeaviateObjects,
  describeWeaviateObject,
  describeWeaviateObjects,
  listWeaviateObjects,
  readWeaviateObjectSource,
  VISIBLE_TO_CREDENTIAL,
  WEAVIATE_OBJECT_KINDS,
  type WeaviateSurfaceContext,
} from "@/lib/db/providers/vector/weaviate/objects";
import { WEAVIATE_CLIENT_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import type { DatabaseConnection, ProviderExecutionContext, ProviderOptions } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { expectCalls } from "../../../helpers/call-log";
import {
  type Answering,
  answer,
  capturedServer,
  fakeClients,
  hanging,
  json,
  overriding,
  rejection,
  version,
  WEAVIATE_TEST_CONNECTION,
} from "../../../helpers/weaviate-surface";

const TEST_KEY = "replay-reader-key";

const SURFACE = capturedServer("weaviate/surface.json");
const SURFACE_1_37 = capturedServer("weaviate-1-37/surface.json");
const READS = capturedServer("weaviate/reads.json");
const SEARCHES_1_38 = capturedServer("weaviate-1-38/searches.json");

function providerOf(
  answering: Answering = SURFACE,
  connection: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
  execution: ProviderExecutionContext = {},
) {
  const clients = fakeClients(answering);
  const provider = new WeaviateProvider(
    { ...WEAVIATE_TEST_CONNECTION, ...connection } as DatabaseConnection,
    options,
    execution,
    clients.factory,
  );
  return { provider, clients };
}

async function connected(...args: Parameters<typeof providerOf>) {
  const built = providerOf(...args);
  await built.provider.connect();
  built.clients.calls.length = 0;
  return built;
}

/** The context a module function is handed, over the same answers and the same version as the provider's. */
function contextOf(
  answering: Answering,
  serverVersion = "1.40.2",
  scoped = false,
): WeaviateSurfaceContext<
  "schema" | "collection" | "objects" | "aliases" | "shards" | "tenants" | "aggregate" | "graphql" | "meta" | "ready"
> {
  const known = new Map();
  return {
    send: async (request, signal) => answering(request, signal),
    signal: new AbortController().signal,
    version: version(serverVersion),
    paths: { get: (kind) => known.get(kind), set: (kind, path) => void known.set(kind, path) },
    scoped,
  };
}

describe("declarations", () => {
  test("the constructor validates nothing and builds no client", () => {
    const { provider, clients } = providerOf(SURFACE, { user: "refused-at-connect" });
    expect(provider.isConnected()).toBe(false);
    expect(clients.built).toEqual([]);
  });

  test("every capability is written out", () => {
    const capabilities: object = providerOf().provider.getCapabilities();
    expect(capabilities).toEqual({
      queryLanguage: "json",
      queryDialect: "weaviate",
      supportsExplain: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      statementTerminator: "none",
      defaultPort: 8080,
      containerLevels: [],
      objectKinds: WEAVIATE_OBJECT_KINDS,
      enforcesReadOnly: true,
      schemaRefreshPattern: "(?!)",
    });
  });

  test("no request refreshes the schema: the refresh pattern matches nothing", () => {
    const pattern = new RegExp(providerOf().provider.getCapabilities().schemaRefreshPattern as string);
    for (const text of ["", "GET /v1/schema", "POST /v1/schema", "DELETE /v1/schema/Article"]) {
      expect(pattern.test(text), text).toBe(false);
    }
  });

  test("the labels are labels.ts's, as a copy", () => {
    const { provider } = providerOf();
    expect(provider.getLabels()).toEqual(WEAVIATE_LABELS);
    expect(provider.getLabels()).not.toBe(WEAVIATE_LABELS);
  });

  test("a request is run as written: no limit is added and there is no page two", () => {
    expect(providerOf().provider.prepareQuery("GET /v1/objects?class=Article")).toEqual({
      query: "GET /v1/objects?class=Article",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });

  test("the limiter's bounds and the client's route table", () => {
    expect(WEAVIATE_LIMITER_OPTIONS).toEqual({ perProvider: 4, perEngine: 16, queueDepth: 64 });
    expect(WEAVIATE_ROUTE_TEMPLATES).toBe(WEAVIATE_CLIENT_ROUTES);
    expect(Object.keys(WEAVIATE_ROUTE_TEMPLATES)).toHaveLength(19);
  });

  test("there is no read-only query method and no transaction method", () => {
    const provider = providerOf().provider as unknown as Record<string, unknown>;
    expect(provider.queryReadOnly).toBeUndefined();
    expect(provider.beginTransaction).toBeUndefined();
  });
});

describe("connect", () => {
  test("exactly one request, GET /v1/meta, with the route table and the connection's options", async () => {
    const { provider, clients } = providerOf();
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expectCalls(clients, [{ method: "meta", args: [{ op: "meta", params: {}, query: {} }] }]);
    expect(clients.built).toHaveLength(1);
    expect(clients.built[0].origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 8080 });
    expect(clients.built[0].headers).toEqual({});
  });

  test("the key travels in the options as one bearer header; the execution profile's read-only mode too", async () => {
    const { provider, clients } = providerOf(SURFACE, { password: TEST_KEY }, {}, { readOnly: true });
    await provider.connect();
    expect(clients.built[0].headers).toEqual({ authorization: `Bearer ${TEST_KEY}` });
    expect(clients.built[0].readOnly).toBe("execution-profile");
  });

  test("a refused connection builds no client and sends nothing", async () => {
    const { provider, clients } = providerOf(SURFACE, { user: "admin" });
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    expect(clients.built).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("a 401 on meta is the key's refusal, and the client built is closed", async () => {
    const refused = json({ code: 401, message: "anonymous access not enabled" }, 401);
    const { provider, clients } = providerOf(() => refused);
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe(
      "Weaviate refused the API key or token. (Weaviate: anonymous access not enabled)",
    );
    expect(clients.closed).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });

  test("a 403 on meta says the credential may not read the server's meta", async () => {
    const forbidden = json({ error: [{ message: "rbac: authorization, forbidden action(s)" }] }, 403);
    const { provider } = providerOf(() => forbidden);
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toStartWith("The credential is not allowed to read this server's meta.");
  });

  test("a transport failure at connect is worded with the surface's deadline", async () => {
    const { provider, clients } = providerOf(
      () => Promise.reject(new TransportError("timeout", "timed out")),
      {},
      { queryTimeout: 4_000 },
    );
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe(
      "The request to Weaviate did not finish within 4000 ms, so Studio stopped waiting.",
    );
    expect(clients.closed).toBe(1);
  });

  test("a server older than 1.37 connects with one warning; a supported or unread version with none", async () => {
    const old = providerOf(overriding(SURFACE, { meta: () => json({ version: "1.36.9" }) })).provider;
    expect(old.connectWarnings()).toEqual([]);
    await old.connect();
    expect(old.connectWarnings()).toEqual([
      {
        message:
          "This Weaviate server is 1.36.9, older than 1.37, the oldest line Studio supports; nothing below it is tested.",
      },
    ]);
    const current = (await connected()).provider;
    expect(current.connectWarnings()).toEqual([]);
    const unread = (await connected(overriding(SURFACE, { meta: () => json({}) }))).provider;
    expect(unread.connectWarnings()).toEqual([]);
  });

  test("disconnect closes the one client, and a second disconnect closes nothing", async () => {
    const { provider, clients } = await connected();
    await provider.disconnect();
    expect(clients.closed).toBe(1);
    expect(provider.isConnected()).toBe(false);
    expect(provider.connectWarnings()).toEqual([]);
    await provider.disconnect();
    expect(clients.closed).toBe(1);
  });
});

describe("a console request", () => {
  test("is refused before connect", async () => {
    const { provider, clients } = providerOf();
    await expect(provider.query("GET /v1/meta")).rejects.toThrow("Provider is not connected");
    expectCalls(clients, []);
  });

  test("bound params are refused before anything is sent; an empty list is no params", async () => {
    const { provider, clients } = await connected(READS);
    const error = await rejection(provider.query("GET /v1/meta", ["x"]));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as Error).message).toBe("Bound params are not supported: a Weaviate request has no placeholders");
    expectCalls(clients, []);
    expect((await provider.query("GET /v1/meta", [])).rowCount).toBe(1);
  });

  test("runs over the version connect read: GraphQL on 1.38, with the path named on the result", async () => {
    const { provider, clients } = await connected(SEARCHES_1_38);
    const result = await provider.query(
      'POST /v1/search/Article/bm25 {"query": "vector", "limit": 3, "returnProperties": ["title", "wordCount"], "returnMetadata": ["score"]}',
    );
    expectCalls(clients, ["collection", "graphql"]);
    expect(result.warnings).toEqual([{ message: "Answered via GraphQL." }]);
    expect(result.fields).toEqual(["$id", "title", "wordCount", "$score"]);
  });

  test("a failed answer is worded by errors.ts: a missing collection, a GraphQL error under 200", async () => {
    const { provider } = await connected(READS);
    await expect(provider.query("GET /v1/schema/Missing")).rejects.toThrow(
      new QueryError("The collection does not exist or is not visible to this credential.", "weaviate"),
    );
    const graphql = await connected(
      overriding(SEARCHES_1_38, { graphql: () => json({ errors: [{ message: "unexpected token" }] }) }),
    );
    const error = await rejection(graphql.provider.query('POST /v1/search/Article/bm25 {"query": "vector"}'));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "Weaviate did not accept the request as written. (Weaviate: unexpected token)",
    );
  });

  test("a transport failure is worded with the search's deadline, at most the query timeout", async () => {
    const timedOut = () => Promise.reject(new TransportError("timeout", "timed out"));
    const { provider } = await connected(overriding(READS, { objects: timedOut }), {}, { queryTimeout: 12_000 });
    await expect(provider.query("GET /v1/objects?class=Article&limit=3")).rejects.toThrow(
      "The request to Weaviate did not finish within 12000 ms, so Studio stopped waiting.",
    );
    const long = await connected(overriding(READS, { objects: timedOut }), {}, { queryTimeout: 120_000 });
    await expect(long.provider.query("GET /v1/objects?class=Article&limit=3")).rejects.toThrow(
      "did not finish within 30000 ms",
    );
  });

  test("a COLD tenant is refused by the guard after its record", async () => {
    const { provider, clients } = await connected(READS);
    const error = await rejection(provider.query("GET /v1/objects?class=TenantNotes&limit=2&tenant=initech"));
    expect(error).toBeInstanceOf(RequestRefusal);
    expectCalls(clients, ["collection", "tenant"]);
  });

  test("a running request is cancelled by its queryId; an unknown id answers false", async () => {
    const { provider } = await connected(overriding(READS, { objects: hanging }));
    const running = provider.query("GET /v1/objects?class=Article&limit=3", undefined, "q-cancel");
    await Bun.sleep(1);
    expect(await provider.cancelQuery("q-cancel")).toBe(true);
    expect(await rejection(running)).toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("q-cancel")).toBe(false);
    expect(await provider.cancelQuery("q-never")).toBe(false);
  });
});

describe("the surface", () => {
  test("every call is refused before connect", async () => {
    const { provider, clients } = providerOf();
    for (const call of [
      () => provider.listContainers(),
      () => provider.countObjects([]),
      () => provider.getHealth(),
      () => provider.getOverview(),
      () => provider.getPerformanceMetrics(),
      () => provider.getSlowQueries(),
      () => provider.getActiveSessions(),
      () => provider.getStorageStats(),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, each refused alone.
      expect(await rejection(call())).toBeInstanceOf(DatabaseConfigError);
    }
    expectCalls(clients, []);
  });

  test("there is no container level: the list is empty and any container is refused", async () => {
    const { provider, clients } = await connected();
    expect(await provider.listContainers()).toEqual([]);
    for (const call of [
      () => provider.countObjects(["db"]),
      () => provider.listObjects(["db"], "collection"),
      () => provider.describeObjects(["db"], "collection"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, each refused alone.
      const error = await rejection(call());
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe('A Weaviate connection has no container level; received ["db"]');
    }
    expectCalls(clients, []);
  });

  test("the tree, the columns and the Source are objects.ts's over the same answers", async () => {
    const { provider } = await connected();
    const context = contextOf(SURFACE);
    expect(await provider.countObjects([])).toEqual(await countWeaviateObjects(context));
    expect(await provider.countObjects([])).toEqual({ collection: { count: 7 } });
    expect(await provider.listObjects([], "collection")).toEqual(await listWeaviateObjects(context, "collection"));
    expect(await provider.describeObject(["Article"], "collection")).toEqual(
      await describeWeaviateObject(context, ["Article"], "collection"),
    );
    expect(await provider.describeObjects([], "collection", 2)).toEqual(
      await describeWeaviateObjects(context, "collection", 2),
    );
    expect(await provider.readObjectSource(["TenantNotes"], "collection")).toEqual(
      await readWeaviateObjectSource(context, ["TenantNotes"], "collection"),
    );
  });

  test("the panels are monitoring-reads.ts's over the same answers", async () => {
    const { provider, clients } = await connected();
    const context = contextOf(SURFACE);
    expect(await provider.getHealth()).toEqual(await readWeaviateHealth(context));
    expect(await provider.getOverview()).toEqual(await readWeaviateOverview(context));
    expect(await provider.getTableStats()).toEqual(await readWeaviateTableStats(context));
    expect(await provider.getIndexStats()).toEqual(await readWeaviateIndexStats(context));
    expect(clients.calls.map((call) => call.method).slice(0, 3)).toEqual(["ready", "meta", "schema"]);
  });

  test("a count on 1.37 goes over GraphQL, the version connect read deciding", async () => {
    const { provider, clients } = await connected(SURFACE_1_37);
    const stats = await provider.getTableStats();
    expect(stats).toEqual(await readWeaviateTableStats(contextOf(SURFACE_1_37, "1.37.4")));
    expect(clients.calls.filter((call) => call.method === "graphql")).toHaveLength(stats.length);
  });

  test("a credential scopes the counts: the listing says what it may see", async () => {
    const { provider } = await connected(SURFACE, { password: TEST_KEY });
    expect(await provider.countObjects([])).toEqual({
      collection: { count: 7, sampledFrom: VISIBLE_TO_CREDENTIAL },
    });
    expect((await provider.getOverview()).tableCountSampledFrom).toBe(VISIBLE_TO_CREDENTIAL);
  });

  test("a surface failure is worded by errors.ts in the request phase", async () => {
    const forbidden = json({ error: [{ message: "rbac: authorization, forbidden action(s) read_schema" }] }, 403);
    const { provider } = await connected(overriding(SURFACE, { schema: () => forbidden }));
    const error = await rejection(provider.listObjects([], "collection"));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "The credential is not allowed to run this request. (Weaviate: rbac: authorization, forbidden action(s) read_schema)",
    );
    const missing = await connected(overriding(SURFACE, { collection: () => answer(404, "", null) }));
    await expect(missing.provider.describeObject(["Missing"], "collection")).rejects.toThrow(
      'Collection "Missing": The collection does not exist or is not visible to this credential.',
    );
    const unready = await connected(overriding(SURFACE, { ready: () => json("", 503) }));
    expect(await rejection(unready.provider.getHealth())).toBeInstanceOf(ConnectionError);
  });

  test("each surface call takes its own permit: at most four in flight", async () => {
    const slow: Answering = async (request) => {
      await Bun.sleep(2);
      return SURFACE(request);
    };
    const { provider, clients } = await connected(slow);
    await Promise.all(Array.from({ length: 10 }, () => provider.getHealth()));
    expect(clients.calls).toHaveLength(10);
    expect(clients.maxInFlight).toBe(4);
  });

  test("each surface call runs under a live deadline signal", async () => {
    const { provider, clients } = await connected();
    await provider.getHealth();
    expect(clients.signals.at(-1)?.aborted).toBe(false);
  });

  test("Weaviate reports no performance, slow queries, sessions or storage: each is empty", async () => {
    const { provider, clients } = await connected();
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    expectCalls(clients, []);
  });

  test("maintenance is refused, and nothing is sent", async () => {
    const { provider, clients } = await connected();
    const error = await rejection(provider.runMaintenance());
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "Weaviate has no maintenance operation in this version of Studio, so nothing was sent.",
    );
    expectCalls(clients, []);
  });
});
