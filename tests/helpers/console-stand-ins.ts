/**
 * Stand-in console dialects for the shared grammar's tests (vector-family spec 3.4).
 *
 * The two shapes the Milvus and Qdrant consoles take, as data, with bounds this repository's tests choose: the
 * providers hold the real dialects and route tables, and once they ship, their tests read those instead. A stand-in
 * route table is built from the committed route fixtures under tests/fixtures/vector/routes/.
 */
import type { ConsoleDialectSpec, QueryKeySpec, RouteClass, RouteSpec } from "@/lib/db/console/dialect";

/** A POST-only console under a long prefix, `#` comments before the request line only, no body comments. */
export const MILVUS_STAND_IN: ConsoleDialectSpec = Object.freeze({
  id: "milvus-stand-in",
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

/** A GET and POST console under `/`, `//` and `#` comments before the request line, `//` comments in the body. */
export const QDRANT_STAND_IN: ConsoleDialectSpec = Object.freeze({
  id: "qdrant-stand-in",
  methods: ["GET", "POST"],
  pathPrefix: "/",
  shortForm: true,
  commentMarkers: ["//", "#"],
  bodyComments: true,
  maxTextBytes: 2_097_152,
  maxDepth: 32,
  maxNodes: 4_096,
  maxNumericLeaves: 262_144,
  maxScalarLeaves: 32_768,
});

/** A route as tests/fixtures/vector/routes/*.json holds it (tests/live/vector-route-tables.ts, FixtureRoute). */
export interface FixtureRouteJson {
  readonly method: string;
  readonly path: string;
  readonly op: string;
  readonly params: Readonly<Record<string, "name" | "point-id">>;
  readonly query: readonly string[];
  readonly body: "none" | "optional" | "required";
}

export interface RouteTableJson {
  readonly engine: "milvus" | "qdrant";
  readonly prefix: string;
  readonly routes: readonly FixtureRouteJson[];
}

/**
 * The values each query key takes in the stand-in tables. The four keys the Qdrant v1 table declares are typed as
 * the pinned OpenAPI types them; every other key of the full table takes the boolean and enumeration words the
 * documentation passes such keys.
 */
const QUERY_KEYS: Readonly<Record<string, QueryKeySpec>> = {
  consistency: { kind: "positive-int-or-words", words: ["majority", "quorum", "all"] },
  timeout: { kind: "positive-int" },
  with: { kind: "word-list", words: ["queued", "completed", "idle_segments"] },
  completed_limit: { kind: "positive-int" },
};
const OTHER_QUERY_KEY: QueryKeySpec = {
  kind: "word-list",
  words: ["true", "false", "weak", "medium", "strong", "replica", "snapshot", "no_sync"],
};

/** A stand-in route table from a committed route fixture, each route's template its path after the prefix. */
export function standInRoutes(table: RouteTableJson, classOf: (route: FixtureRouteJson) => RouteClass): RouteSpec[] {
  return table.routes.map((route) => {
    if (!route.path.startsWith(table.prefix)) {
      throw new Error(`${route.method} ${route.path} does not start with the table's prefix ${table.prefix}`);
    }
    return {
      method: route.method,
      template: route.path.slice(table.prefix.length),
      op: route.op,
      class: classOf(route),
      params: route.params,
      query: Object.fromEntries(route.query.map((key) => [key, QUERY_KEYS[key] ?? OTHER_QUERY_KEY])),
      body: route.body,
    };
  });
}

/** A small route table in each stand-in's shape, for the grammar's own tests. */
export const MILVUS_ROUTES: readonly RouteSpec[] = [
  {
    method: "POST",
    template: "collections/list",
    op: "collections.list",
    class: "read",
    params: {},
    query: {},
    body: "optional",
  },
  {
    method: "POST",
    template: "entities/search",
    op: "entities.search",
    class: "read",
    params: {},
    query: {},
    body: "required",
  },
  {
    method: "POST",
    template: "entities/query",
    op: "entities.query",
    class: "read",
    params: {},
    query: {},
    body: "required",
  },
];

export const QDRANT_ROUTES: readonly RouteSpec[] = [
  { method: "GET", template: "", op: "root", class: "read", params: {}, query: {}, body: "none" },
  { method: "GET", template: "collections", op: "get_collections", class: "read", params: {}, query: {}, body: "none" },
  {
    method: "GET",
    template: "collections/aliases",
    op: "get_collections_aliases",
    class: "read",
    params: {},
    query: {},
    body: "none",
  },
  {
    method: "GET",
    template: "collections/{collection_name}",
    op: "get_collection",
    class: "read",
    params: { collection_name: "name" },
    query: {},
    body: "none",
  },
  {
    method: "GET",
    template: "collections/{collection_name}/points/{id}",
    op: "get_point",
    class: "read",
    params: { collection_name: "name", id: "point-id" },
    query: { consistency: QUERY_KEYS.consistency, timeout: QUERY_KEYS.timeout },
    body: "none",
  },
  {
    method: "GET",
    template: "collections/{collection_name}/optimizations",
    op: "get_optimizations",
    class: "read",
    params: { collection_name: "name" },
    query: { with: QUERY_KEYS.with, completed_limit: QUERY_KEYS.completed_limit },
    body: "none",
  },
  {
    method: "POST",
    template: "collections/{collection_name}/points/query",
    op: "query_points",
    class: "read",
    params: { collection_name: "name" },
    query: { consistency: QUERY_KEYS.consistency, timeout: QUERY_KEYS.timeout },
    body: "required",
  },
  {
    method: "POST",
    template: "collections/{collection_name}/points/scroll",
    op: "scroll_points",
    class: "read",
    params: { collection_name: "name" },
    query: {},
    body: "optional",
  },
];
