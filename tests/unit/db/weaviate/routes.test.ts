/**
 * The Weaviate console as data (#1566 spec 5.1, 5.2, 5.7, 3.2, 3.3): the dialect, the 17 read routes in the REST
 * reference's order, the client's table of those plus the readiness probe and the GraphQL read, the closed body key
 * sets, the refused keys with their reasons, the bounds, and the sentence a route version 1 does not run is refused
 * with, naming what the route is and what the console runs.
 */
import { describe, expect, test } from "bun:test";
import { WEAVIATE_OPS } from "@/lib/db/providers/vector/weaviate/client";
import {
  refusedRouteSentence,
  WEAVIATE_BOUNDS,
  WEAVIATE_CLIENT_ROUTES,
  WEAVIATE_CONSOLE,
  WEAVIATE_ENUMS,
  WEAVIATE_KEYS,
  WEAVIATE_QUERY_KEYS,
  WEAVIATE_REFUSED_KEYS,
  WEAVIATE_ROUTES,
  WEAVIATE_RUNS,
} from "@/lib/db/providers/vector/weaviate/routes";

describe("the dialect and the route table", () => {
  test("a GET or POST line under /v1/, with // and # comments", () => {
    expect(WEAVIATE_CONSOLE).toEqual({
      id: "weaviate",
      methods: ["GET", "POST"],
      pathPrefix: "/v1/",
      shortForm: true,
      commentMarkers: ["//", "#"],
      bodyComments: true,
      maxTextBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 4_096,
      maxNumericLeaves: 262_144,
      maxScalarLeaves: 32_768,
    });
    expect(Object.isFrozen(WEAVIATE_CONSOLE)).toBe(true);
  });

  test("17 routes, every one a read, in the REST reference's order", () => {
    expect(WEAVIATE_ROUTES.map((route) => `${route.method} ${route.template}`)).toEqual([
      "GET meta",
      "GET schema",
      "GET schema/{collection}",
      "GET schema/{collection}/shards",
      "GET schema/{collection}/tenants",
      "GET schema/{collection}/tenants/{tenant}",
      "GET aliases",
      "GET aliases/{alias}",
      "GET nodes",
      "GET nodes/{collection}",
      "GET objects",
      "GET objects/{collection}/{id}",
      "POST search/{collection}/bm25",
      "POST search/{collection}/hybrid",
      "POST search/{collection}/near-vector",
      "POST search/{collection}/near-object",
      "POST aggregate/{collection}",
    ]);
    expect(WEAVIATE_ROUTES.every((route) => route.class === "read" && Object.isFrozen(route))).toBe(true);
    expect(WEAVIATE_ROUTES.map((route): string => route.op)).toEqual(WEAVIATE_OPS.slice(0, 17));
  });

  test("a GET takes no body; a search requires one, read by its schema; the aggregate body is optional", () => {
    const byOp = Object.fromEntries(WEAVIATE_ROUTES.map((route) => [route.op, route]));
    for (const route of WEAVIATE_ROUTES.filter((entry) => entry.method === "GET")) {
      expect(route.body, route.op).toBe("none");
      expect(route.schema, route.op).toBeNull();
    }
    expect(byOp.search_bm25).toMatchObject({ body: "required", schema: "SearchBm25Request" });
    expect(byOp.search_hybrid).toMatchObject({ body: "required", schema: "SearchHybridRequest" });
    expect(byOp.search_near_vector).toMatchObject({ body: "required", schema: "SearchNearVectorRequest" });
    expect(byOp.search_near_object).toMatchObject({ body: "required", schema: "SearchNearObjectRequest" });
    expect(byOp.aggregate).toMatchObject({ body: "optional", schema: "AggregateRequest" });
  });

  test("the query keys each route declares, and the values each key takes", () => {
    const keys = Object.fromEntries(WEAVIATE_ROUTES.map((route) => [route.op, Object.keys(route.query)]));
    expect(keys.objects).toEqual(["class", "limit", "after", "offset", "include", "sort", "order", "tenant"]);
    expect(keys.object).toEqual(["include", "tenant"]);
    expect(keys.shards).toEqual(["tenant"]);
    expect(keys.nodes).toEqual(["output"]);
    expect(keys.collection_nodes).toEqual(["output"]);
    expect(keys.meta).toEqual([]);
    expect(WEAVIATE_QUERY_KEYS.include).toEqual({
      kind: "word-list",
      words: ["vector", "classification", "interpretation"],
    });
    expect(WEAVIATE_QUERY_KEYS.limit).toEqual({ kind: "positive-int" });
    expect(WEAVIATE_QUERY_KEYS.output).toEqual({ kind: "word-list", words: ["minimal", "verbose"] });
  });

  test("the client's table: every operation, each route under /v1/, then the readiness probe and GraphQL", () => {
    expect(Object.keys(WEAVIATE_CLIENT_ROUTES)).toEqual([...WEAVIATE_OPS]);
    expect(WEAVIATE_CLIENT_ROUTES.search_near_vector).toEqual({
      method: "POST",
      path: "/v1/search/{collection}/near-vector",
      query: [],
    });
    expect(WEAVIATE_CLIENT_ROUTES.objects.query).toEqual([
      "class",
      "limit",
      "after",
      "offset",
      "include",
      "sort",
      "order",
      "tenant",
    ]);
    expect(WEAVIATE_CLIENT_ROUTES.ready).toEqual({ method: "GET", path: "/v1/.well-known/ready", query: [] });
    expect(WEAVIATE_CLIENT_ROUTES.graphql).toEqual({ method: "POST", path: "/v1/graphql", query: [] });
    expect(Object.values(WEAVIATE_CLIENT_ROUTES).every((route) => route.path.startsWith("/v1/"))).toBe(true);
  });
});

describe("the bodies", () => {
  test("every search takes the common keys and its own; the required keys", () => {
    const common = [
      "where",
      "limit",
      "offset",
      "autoLimit",
      "returnProperties",
      "returnMetadata",
      "tenant",
      "consistencyLevel",
    ];
    expect(WEAVIATE_KEYS.SearchBm25Request as unknown).toEqual({
      keys: [...common, "query", "queryProperties"],
      required: ["query"],
    });
    expect(WEAVIATE_KEYS.SearchHybridRequest.required).toEqual(["query", "alpha"]);
    expect(WEAVIATE_KEYS.SearchNearVectorRequest.required).toEqual(["vector"]);
    expect(WEAVIATE_KEYS.SearchNearObjectRequest.required).toEqual(["id"]);
    expect(WEAVIATE_KEYS.AggregateRequest as unknown).toEqual({
      keys: ["where", "tenant", "groupBy", "limit", "returnMetrics"],
      required: [],
    });
    expect(WEAVIATE_KEYS.WhereFilter.required).toEqual(["operator"]);
  });

  test("the keys that send text to a model are refused with the reason", () => {
    expect(WEAVIATE_REFUSED_KEYS.singlePrompt).toBe("generative search sends the results to a model provider");
    expect(WEAVIATE_REFUSED_KEYS.groupedTask).toBe("generative search sends the results to a model provider");
    expect(WEAVIATE_REFUSED_KEYS.rerank).toBe("reranking sends the results to a model provider");
    expect(Object.keys(WEAVIATE_REFUSED_KEYS)).toEqual([
      "singlePrompt",
      "groupedTask",
      "rerank",
      "groupBy",
      "numberOfGroups",
      "objectsPerGroup",
      "returnReferences",
      "over",
      "objectLimit",
    ]);
  });

  test("the enumerations", () => {
    expect(WEAVIATE_ENUMS.consistencyLevel).toEqual(["ONE", "QUORUM", "ALL"]);
    expect(WEAVIATE_ENUMS.fusionType).toEqual(["ranked", "relativeScore"]);
    expect(WEAVIATE_ENUMS.returnMetrics).toEqual(["count"]);
    expect(WEAVIATE_ENUMS.returnMetadata).toEqual([
      "distance",
      "certainty",
      "score",
      "explainScore",
      "creationTime",
      "lastUpdateTime",
    ]);
    expect(WEAVIATE_ENUMS.operator).toHaveLength(15);
  });
});

describe("the bounds", () => {
  test("deadlines below Weaviate's 60 s write timeout, the byte budgets, the in-flight bounds", () => {
    expect(WEAVIATE_BOUNDS).toMatchObject({
      defaultObjectsLimit: 25,
      defaultSearchLimit: 10,
      maxRows: 1_000,
      transportCapBytes: 16 * 1024 * 1024,
      resultBudgetBytes: 8 * 1024 * 1024,
      stringCellUnits: 65_536,
      metadataDeadlineMs: 10_000,
      searchDeadlineMs: 30_000,
      perProvider: 4,
      perEngine: 16,
      queueDepth: 64,
      tablesPanelCollections: 200,
      sourceTenants: 1_024,
    });
    expect(WEAVIATE_BOUNDS.searchDeadlineMs).toBeLessThan(60_000);
  });
});

describe("the refusal sentence", () => {
  const refused = (method: string, path: string, what: string) =>
    expect(refusedRouteSentence(method, path)).toBe(
      `${method} /v1/${path
        .replace(/^\/v1\//, "")
        .replace(/^\/+/, "")
        .replace(/[?#].*$/, "")} is ${what}, which this console does not run. ${WEAVIATE_RUNS}`,
    );

  test("a route is named by what it is", () => {
    refused("POST", "/v1/search/Article/near-text", "a search that sends its text or media to a model provider");
    refused("POST", "/v1/search/Article/near-image", "a search that sends its text or media to a model provider");
    refused("POST", "/v1/graphql", "a GraphQL request, which this console writes for you from a REST search");
    refused("POST", "/v1/batch/objects", "a batch write");
    refused("GET", "/v1/backups/filesystem", "a backup route");
    refused("GET", "/v1/authz/roles", "a user, role or permission route");
    refused("GET", "/v1/users/own-info", "a user, role or permission route");
    refused("GET", "/v1/replication/replicate", "a replication route");
    refused("GET", "/v1/mcp", "the server's MCP endpoint");
    refused("POST", "/v1/tokenize", "a tokenize route");
    refused("POST", "/v1/schema/Article/properties/title/tokenize", "a tokenize route");
    refused("GET", "/v1/.well-known/ready", "a health or readiness route");
    refused("DELETE", "/v1/schema/Article", "a schema, tenant, index or alias change");
    refused("PUT", "/v1/aliases/Articles", "a schema, tenant, index or alias change");
  });

  test("an object write is named by its method; an object read under another method is not a write", () => {
    refused("POST", "/v1/objects", "an object write");
    refused("DELETE", "/v1/objects/Article/9e6866af-ef70-5a5a-9b61-1ae7a41bad0d", "an object write");
    expect(refusedRouteSentence("GET", "/v1/objects/Article/x/y/z")).toBe(
      `GET /v1/objects/Article/x/y/z is not a route this console runs. ${WEAVIATE_RUNS}`,
    );
  });

  test("the prefix may be absent, and a query string or fragment is dropped", () => {
    refused("GET", "backups?limit=1", "a backup route");
    refused("GET", "//batch#x", "a batch write");
  });

  test("a method the console does not send, on a route no row names, says it sends GET and POST only", () => {
    expect(refusedRouteSentence("PATCH", "/v1/nodes")).toBe(
      `PATCH /v1/nodes is not a request this console runs: it sends GET and POST only. ${WEAVIATE_RUNS}`,
    );
  });

  test("anything else is not a route this console runs", () => {
    expect(refusedRouteSentence("GET", "/v1/cluster/statistics")).toBe(
      `GET /v1/cluster/statistics is not a route this console runs. ${WEAVIATE_RUNS}`,
    );
    expect(refusedRouteSentence("GET", "/v1/batch/x/y")).toContain("is a batch write");
    expect(refusedRouteSentence("GET", "/v1/tokenize/extra")).toBe(
      `GET /v1/tokenize/extra is not a route this console runs. ${WEAVIATE_RUNS}`,
    );
  });

  test("what the console runs is said after every refusal", () => {
    expect(WEAVIATE_RUNS).toBe(
      "This console runs Weaviate's read requests only, with GET and POST: the meta, schema, shard, tenant, alias and node reads, object list and read by id, the bm25, hybrid, near-vector and near-object searches, and aggregate counts.",
    );
  });
});
