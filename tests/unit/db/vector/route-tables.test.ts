/**
 * The vector consoles' route tables as test data (tests/fixtures/vector/routes/, derived by
 * tests/live/vector-route-tables.ts; vector-family spec 3.4 and 8.2): the derivation's rules over small inputs, and
 * the committed tables' shape, which PR 4's and PR 4q's routes.ts tests later hold route for route.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MILVUS_TSV_SHA256,
  MILVUS_V1_ROUTES,
  milvusRoutesFromTsv,
  type BodyKey,
  type FixtureRoute,
  QDRANT_SPEC_SHA256,
  QDRANT_V1_OPERATIONS,
  QDRANT_V1_QUERY_KEYS,
  qdrantRoutesFromOpenApi,
  type RouteTable,
  sha256Hex,
} from "../../../live/vector-route-tables";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const table = (name: string): RouteTable =>
  JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/vector/routes", name), "utf8")) as RouteTable;

/** One summary row per v1 route, in the summary's own column layout, and one route v1 does not run. */
function summary(routes: readonly string[]): string {
  const rows = routes.map(
    (route) => `POST\t/v2/vectordb/${route}\t${route}\tdbName:string, collectionName*:string\t\tv2/x.mdx\t3.0.x\tNone`,
  );
  return [...rows, "POST\t/v2/vectordb/collections/drop\tDrop\tcollectionName*:string\t\tv2/x.mdx\t3.0.x\tNone"].join(
    "\n",
  );
}

describe("milvusRoutesFromTsv", () => {
  test("keeps the v1 routes alone, in table order, with each body key's type and whether it is required", () => {
    const routes = milvusRoutesFromTsv(summary([...MILVUS_V1_ROUTES].reverse()));
    expect(routes.map((route) => route.op)).toEqual([...MILVUS_V1_ROUTES]);
    expect(routes[0]).toEqual({
      method: "POST",
      path: "/v2/vectordb/databases/list",
      op: "databases/list",
      params: {},
      query: [],
      body: "required",
      bodyKeys: [
        { name: "dbName", type: "string", required: false },
        { name: "collectionName", type: "string", required: true },
      ],
    });
  });

  test("a route with no required key has an optional body", () => {
    const text = summary(MILVUS_V1_ROUTES.filter((route) => route !== "databases/list")).concat(
      "\nPOST\t/v2/vectordb/databases/list\tList Databases\t\t\tv2/x.mdx\t3.0.x\tNone",
    );
    expect(milvusRoutesFromTsv(text)[0]).toMatchObject({ body: "optional", bodyKeys: [] });
  });

  test("a v1 route the summary lacks, or lists twice, is refused", () => {
    expect(() => milvusRoutesFromTsv(summary(MILVUS_V1_ROUTES.slice(1)))).toThrow(
      "the summary has no row for /v2/vectordb/databases/list",
    );
    expect(() => milvusRoutesFromTsv(summary([...MILVUS_V1_ROUTES, "entities/get"]))).toThrow(
      "the summary lists /v2/vectordb/entities/get twice",
    );
  });
});

const OPENAPI = {
  paths: {
    "/collections/{collection_name}/points/{id}": {
      get: {
        operationId: "get_point",
        parameters: [
          { name: "collection_name", in: "path" },
          { name: "id", in: "path" },
          { name: "consistency", in: "query" },
          { name: "timeout", in: "query" },
        ],
      },
    },
    "/collections/{collection_name}/points": {
      put: {
        operationId: "upsert_points",
        parameters: [{ name: "wait", in: "query" }],
        requestBody: { required: true },
      },
      post: {
        operationId: "get_points",
        parameters: [{ name: "collection_name", in: "path" }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PointRequest" } } } },
      },
      parameters: [],
    },
  },
};

describe("qdrantRoutesFromOpenApi", () => {
  test("the full table keeps every operation, every query key, and the body's presence and schema", () => {
    expect(qdrantRoutesFromOpenApi(OPENAPI, "full")).toEqual([
      {
        method: "GET",
        path: "/collections/{collection_name}/points/{id}",
        op: "get_point",
        params: { collection_name: "name", id: "point-id" },
        query: ["consistency", "timeout"],
        body: "none",
        bodySchema: null,
      },
      {
        method: "PUT",
        path: "/collections/{collection_name}/points",
        op: "upsert_points",
        params: {},
        query: ["wait"],
        body: "required",
        bodySchema: null,
      },
      {
        method: "POST",
        path: "/collections/{collection_name}/points",
        op: "get_points",
        params: { collection_name: "name" },
        query: [],
        body: "optional",
        bodySchema: "PointRequest",
      },
    ]);
  });

  test("the v1 table refuses a document that lacks a v1 operation", () => {
    expect(() => qdrantRoutesFromOpenApi(OPENAPI, "v1")).toThrow(
      "the OpenAPI document lacks or repeats a v1 operation: found get_point, get_points",
    );
  });

  test("an operation without an operationId is refused", () => {
    expect(() => qdrantRoutesFromOpenApi({ paths: { "/": { get: {} } } }, "full")).toThrow("GET / has no operationId");
  });
});

describe("the committed route tables", () => {
  const milvus = table("milvus-v1.json");
  const qdrantV1 = table("qdrant-v1.json");
  const qdrantFull = table("qdrant-full.json");

  test("each records the generator, its pinned source's sha256 and its scope", () => {
    expect(milvus.$generated).toMatchObject({
      by: "tests/live/vector-routes.ts",
      sha256: MILVUS_TSV_SHA256,
      scope: "v1",
    });
    expect(qdrantV1.$generated).toMatchObject({ sha256: QDRANT_SPEC_SHA256, scope: "v1" });
    expect(qdrantFull.$generated).toMatchObject({ sha256: QDRANT_SPEC_SHA256, scope: "full" });
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("Milvus v1 is the 15 routes, every one a POST under /v2/vectordb/ with no query string", () => {
    expect(milvus.prefix).toBe("/v2/vectordb/");
    expect(milvus.routes.map((route) => route.op)).toEqual([...MILVUS_V1_ROUTES]);
    for (const route of milvus.routes) {
      expect(route).toMatchObject({ method: "POST", path: `/v2/vectordb/${route.op}`, query: [], params: {} });
    }
    const search = milvus.routes.find((route) => route.op === "entities/search");
    expect(search?.bodyKeys?.filter((key) => key.required).map((key) => key.name)).toEqual(["collectionName", "data"]);
  });

  test("Qdrant v1 is the 17 operations, each a GET or a POST", () => {
    expect(qdrantV1.routes.map((route) => route.op).sort()).toEqual([...QDRANT_V1_OPERATIONS].sort());
    for (const route of qdrantV1.routes) expect(["GET", "POST"]).toContain(route.method);
  });

  test("Qdrant v1 takes consistency and timeout on the eight point reads, with and completed_limit on optimizations, and nothing elsewhere", () => {
    const pointReads = [
      "get_point",
      "get_points",
      "scroll_points",
      "count_points",
      "facet",
      "query_points",
      "query_batch_points",
      "query_points_groups",
    ];
    for (const route of qdrantV1.routes) {
      const expected = pointReads.includes(route.op)
        ? ["consistency", "timeout"]
        : route.op === "get_optimizations"
          ? ["with", "completed_limit"]
          : [];
      expect({ op: route.op, query: route.query }).toEqual({ op: route.op, query: expected });
    }
  });

  test("every query key of the v1 table is one of QDRANT_V1_QUERY_KEYS, and each of those is used", () => {
    const routes: readonly FixtureRoute[] = qdrantV1.routes;
    const used = [...new Set(routes.flatMap((route) => route.query))].sort();
    expect(used).toEqual([...QDRANT_V1_QUERY_KEYS].sort());
  });

  test("every Milvus body key names its type and whether it is required", () => {
    const keys: readonly BodyKey[] = milvus.routes.flatMap((route) => route.bodyKeys ?? []);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect({ name: typeof key.name, type: typeof key.type, required: typeof key.required }).toEqual({
        name: "string",
        type: "string",
        required: "boolean",
      });
    }
  });

  test("a point id is the one path parameter of kind point-id", () => {
    const point = qdrantV1.routes.find((route) => route.op === "get_point");
    expect(point?.params).toEqual({ collection_name: "name", id: "point-id" });
  });

  test("the full Qdrant table holds all 69 operations of v1.19.1, the v1 table among them", () => {
    expect(qdrantFull.routes).toHaveLength(69);
    const full = new Set(qdrantFull.routes.map((route) => `${route.method} ${route.path}`));
    for (const route of qdrantV1.routes) expect(full.has(`${route.method} ${route.path}`)).toBe(true);
  });
});
