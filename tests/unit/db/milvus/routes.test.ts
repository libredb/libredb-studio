/**
 * The Milvus console's dialect and route table (vector-family spec 5.4, 5.6): the dialect's values, the table route
 * for route against the fixture PR 1v generated from the vendor's pinned reference, the bounds, the search-parameter
 * table of E28 and the refusal sentences.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MILVUS_BOUNDS,
  MILVUS_CONSOLE,
  MILVUS_INDEX_SEARCH_KEYS,
  MILVUS_ROUTES,
  MILVUS_SEARCH_PARAMETERS,
  MILVUS_VERSION_GATED_KEYS,
  permanentRefusalSentence,
  routeRefusalSentence,
  unknownKeySentence,
} from "@/lib/db/providers/vector/milvus/routes";

interface FixtureRoute {
  readonly method: string;
  readonly path: string;
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly query: readonly unknown[];
  readonly body: string;
}

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "vector", "routes", "milvus-v1.json"), "utf8"),
) as { readonly prefix: string; readonly routes: readonly FixtureRoute[] };

describe("MILVUS_CONSOLE (5.4)", () => {
  test("is the dialect of 5.4, value for value", () => {
    expect(MILVUS_CONSOLE).toEqual({
      id: "milvus",
      methods: ["POST"],
      pathPrefix: "/v2/vectordb/",
      shortForm: true,
      commentMarkers: ["#"],
      bodyComments: false,
      maxTextBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 4_096,
      maxNumericLeaves: 262_144,
      maxScalarLeaves: 32_768,
    });
  });
});

describe("MILVUS_ROUTES", () => {
  test("equals the generated v1 fixture route for route, in its order", () => {
    expect(FIXTURE.prefix).toBe(MILVUS_CONSOLE.pathPrefix);
    const actual: unknown = MILVUS_ROUTES.map((route) => ({
      method: route.method,
      path: `${MILVUS_CONSOLE.pathPrefix}${route.template}`,
      op: route.op,
      params: route.params,
      query: Object.keys(route.query),
      body: route.body,
    }));
    expect(actual).toEqual(
      FIXTURE.routes.map((route) => ({
        method: route.method,
        path: route.path,
        op: route.op,
        params: route.params,
        query: [...route.query],
        body: route.body,
      })),
    );
  });

  test("every v1 route reads, so the confirmation gate asks for none (5.4, E10)", () => {
    expect(MILVUS_ROUTES).toHaveLength(15);
    for (const route of MILVUS_ROUTES) expect(route.class).toBe("read");
  });
});

describe("MILVUS_BOUNDS (5.6)", () => {
  test("holds every request and result bound of 5.6", () => {
    expect(MILVUS_BOUNDS).toEqual({
      defaultLimit: 100,
      maxRows: 1_000,
      queryWindow: 16_384,
      maxNq: 10,
      maxTopK: 1_024,
      maxSearchEntries: 10_240,
      maxSubRequests: 10,
      maxGroupSize: 10,
      maxFilterBytes: 65_536,
      maxExprParamKeys: 32,
      maxExprParamArray: 1_000,
      maxGetIds: 1_000,
      maxSearchIds: 10,
      maxOutputFields: 256,
      maxPartitionNames: 1_024,
      maxNameBytes: 255,
      maxEmbeddingElements: 262_144,
      sparseIndexBound: 4_294_967_295,
      minDenseDimension: 2,
      maxDenseDimension: 32_768,
      maxBinaryDimension: 262_144,
      maxRrfK: 16_384,
      resultBudgetBytes: 8_388_608,
      stringCellUnits: 65_536,
    });
  });

  test("the embedding-list bound is the parser's numeric-leaf bound (5.6)", () => {
    const elements: number = MILVUS_BOUNDS.maxEmbeddingElements;
    expect(elements).toBe(MILVUS_CONSOLE.maxNumericLeaves);
  });
});

describe("the search-parameter table (5.6, E28)", () => {
  test("names each key's kind and range", () => {
    expect(MILVUS_SEARCH_PARAMETERS).toEqual({
      nprobe: { kind: "integer", min: 1, max: 65_536 },
      ef: { kind: "integer", min: 1, max: 65_536, atLeastK: true },
      reorder_k: { kind: "integer", min: 1, max: 65_536, atLeastK: true },
      search_list: { kind: "integer", min: 1, max: 65_536, atLeastK: true },
      refine_k: { kind: "number", min: 1, max: 64, float32: true },
      rbq_bits_query: { kind: "integer", min: 0, max: 8 },
      drop_ratio_search: { kind: "number", min: 0, max: 1, maxExclusive: true, float32: true },
      dim_max_score_ratio: { kind: "number", min: 0.5, max: 1.3, float32: true },
      refine_factor: { kind: "integer", min: 1, max: 64 },
      filter_threshold: { kind: "number", min: -1, max: 1, float32: true },
      beamwidth: { kind: "integer", min: 1, max: 16 },
      vectors_beamwidth: { kind: "integer", min: 1, max: 4 },
      radius: { kind: "finite" },
      range_filter: { kind: "finite" },
    });
  });

  test.each([
    ["FLAT", ["radius", "range_filter"]],
    ["BIN_FLAT", ["radius", "range_filter"]],
    ["IVF_FLAT", ["nprobe", "radius", "range_filter"]],
    ["IVF_SQ8", ["nprobe", "refine_k", "radius", "range_filter"]],
    ["IVF_PQ", ["nprobe", "refine_k", "radius", "range_filter"]],
    ["IVF_RABITQ", ["nprobe", "refine_k", "rbq_bits_query", "radius", "range_filter"]],
    ["BIN_IVF_FLAT", ["nprobe", "radius", "range_filter"]],
    ["SCANN", ["nprobe", "reorder_k", "radius", "range_filter"]],
    ["HNSW", ["ef", "radius", "range_filter"]],
    ["HNSW_SQ", ["ef", "refine_k", "radius", "range_filter"]],
    ["HNSW_PQ", ["ef", "refine_k", "radius", "range_filter"]],
    ["HNSW_PRQ", ["ef", "refine_k", "radius", "range_filter"]],
    ["AUTOINDEX", ["ef", "refine_k", "radius", "range_filter"]],
    ["DISKANN", ["search_list", "filter_threshold", "radius", "range_filter"]],
    ["AISAQ", ["search_list", "filter_threshold", "beamwidth", "vectors_beamwidth", "radius", "range_filter"]],
    ["SPARSE_INVERTED_INDEX", ["drop_ratio_search", "dim_max_score_ratio", "refine_factor"]],
    ["SPARSE_WAND", ["drop_ratio_search", "dim_max_score_ratio", "refine_factor"]],
  ])("%s takes exactly %j", (indexType, keys) => {
    expect(MILVUS_INDEX_SEARCH_KEYS[indexType]).toEqual(keys);
  });

  test("names no index type beyond the measured ones, and every key it names has a rule", () => {
    expect(Object.keys(MILVUS_INDEX_SEARCH_KEYS)).toHaveLength(17);
    for (const keys of Object.values(MILVUS_INDEX_SEARCH_KEYS)) {
      for (const key of keys) expect(MILVUS_SEARCH_PARAMETERS[key]).toBeDefined();
    }
  });
});

describe("refusal sentences (5.4, E9, E34)", () => {
  const LIST = "POST /v2/vectordb/databases/list";

  test("a load, release or refresh points at the Operations controls", () => {
    for (const route of ["collections/load", "collections/release", "collections/refresh_load"]) {
      expect(routeRefusalSentence(route, LIST)).toBe(
        `${route} changes what Milvus holds in memory and does not run from the console: an admin loads and releases a collection from the Operations controls.`,
      );
    }
  });

  test("a write says the provider reads only, then lists the routes", () => {
    expect(routeRefusalSentence("entities/insert", LIST)).toBe(
      `entities/insert is not available in this version of the Milvus provider, which reads only. Studio runs:\n${LIST}`,
    );
  });

  test("any other route names the routes Studio runs", () => {
    expect(routeRefusalSentence("users/list", LIST)).toBe(
      `Studio does not run POST /v2/vectordb/users/list; it runs:\n${LIST}`,
    );
  });

  test("an unknown key names the route and what it takes", () => {
    expect(unknownKeySentence("databases/list", '"x"', [])).toBe(
      'databases/list does not take "x": Studio refuses a key it does not know rather than let Milvus drop it, and it takes no key.',
    );
    expect(unknownKeySentence("collections/list", '"x"', ["dbName"])).toBe(
      'collections/list does not take "x": Studio refuses a key it does not know rather than let Milvus drop it, and it takes dbName.',
    );
  });

  test("a permanent refusal names its key and says why", () => {
    expect(permanentRefusalSentence("functionScore")).toBe(
      "functionScore is refused in every release: a search function, ranker chain or aggregation can make Milvus send the request's data to a service it calls, and Studio never sends a request that can reach one.",
    );
  });

  test("orderByFields is the one version-gated key (5.9)", () => {
    expect(MILVUS_VERSION_GATED_KEYS).toEqual([{ op: "entities/query", key: "orderByFields", gate: "orderByFields" }]);
  });
});
