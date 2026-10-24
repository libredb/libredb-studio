import type { ConsoleDialectSpec, QueryKeySpec, RouteSpec } from "@/lib/db/console/dialect";
import type { WeaviateConsoleOp, WeaviateOp } from "./client";

/**
 * The Weaviate console as data (#1566 spec 5.1): its dialect, its route table, the closed key sets of every request
 * body, its bounds and the sentences it refuses a route with.
 *
 * The console text is a Weaviate REST request line and one JSON body, the form Weaviate's own REST reference prints.
 * Every search is written in the REST search shape on every server, and `execute.ts` runs it over REST or GraphQL as
 * the server's version decides (spec 3.3). Every body key is closed: a key the OpenAPI document (v1.40.2; the top
 * level is the same on 1.38.22 and 1.39.8) does not declare at its level is refused by name, because the server
 * reads past an unknown key without a word, so a misspelled `where` returns unfiltered results (measured, spec A.6).
 *
 * Nothing here is derived at run time. Browser-safe: it imports types only.
 */

export const WEAVIATE_CONSOLE: ConsoleDialectSpec = Object.freeze({
  id: "weaviate",
  methods: Object.freeze(["GET", "POST"]),
  pathPrefix: "/v1/",
  shortForm: true,
  commentMarkers: Object.freeze(["//", "#"]),
  bodyComments: true,
  maxTextBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 4_096,
  maxNumericLeaves: 262_144,
  maxScalarLeaves: 32_768,
});

/** The request bodies a route takes, by their name in the OpenAPI document. */
export type WeaviateBodySchema =
  | "SearchBm25Request"
  | "SearchHybridRequest"
  | "SearchNearVectorRequest"
  | "SearchNearObjectRequest"
  | "AggregateRequest";

/** One route of the table: the shared route facts, and the schema its body is read by. */
export interface WeaviateRoute extends RouteSpec<WeaviateConsoleOp> {
  /** The body's schema, or null where the route takes no body. */
  readonly schema: WeaviateBodySchema | null;
}

const COLLECTION = Object.freeze({ collection: "name" } as const);
const TENANT = Object.freeze({ collection: "name", tenant: "name" } as const);
const ALIAS = Object.freeze({ alias: "name" } as const);
const OBJECT = Object.freeze({ collection: "name", id: "name" } as const);
const NONE = Object.freeze({});

const TEXT: QueryKeySpec = Object.freeze({ kind: "text" });
const POSITIVE: QueryKeySpec = Object.freeze({ kind: "positive-int" });

/** The query keys a route may declare, and the values each takes. */
export const WEAVIATE_QUERY_KEYS = Object.freeze({
  class: TEXT,
  limit: POSITIVE,
  after: TEXT,
  // Text here and read in phase 0 (request.ts): Weaviate takes an offset of 0, which the shared positive-int kind refuses.
  offset: TEXT,
  include: Object.freeze({ kind: "word-list", words: Object.freeze(["vector", "classification", "interpretation"]) }),
  sort: TEXT,
  order: Object.freeze({ kind: "word-list", words: Object.freeze(["asc", "desc"]) }),
  tenant: TEXT,
  output: Object.freeze({ kind: "word-list", words: Object.freeze(["minimal", "verbose"]) }),
} as const satisfies Readonly<Record<string, QueryKeySpec>>);

const K = WEAVIATE_QUERY_KEYS;
const OBJECTS_QUERY = Object.freeze({
  class: K.class,
  limit: K.limit,
  after: K.after,
  offset: K.offset,
  include: K.include,
  sort: K.sort,
  order: K.order,
  tenant: K.tenant,
});
const OBJECT_QUERY = Object.freeze({ include: K.include, tenant: K.tenant });
const SHARDS_QUERY = Object.freeze({ tenant: K.tenant });
const NODES_QUERY = Object.freeze({ output: K.output });

function route(
  method: "GET" | "POST",
  template: string,
  op: WeaviateConsoleOp,
  params: WeaviateRoute["params"],
  query: WeaviateRoute["query"],
  body: WeaviateRoute["body"],
  schema: WeaviateBodySchema | null,
): WeaviateRoute {
  return Object.freeze({ method, template, op, class: "read", params, query, body, schema });
}

/**
 * The 17 routes version 1 runs, every one a read, in the order the REST reference lists them. A template is the path
 * after the dialect's prefix `/v1/`. The aggregate body is optional and an absent one is sent as `{}`.
 */
export const WEAVIATE_ROUTES: readonly WeaviateRoute[] = Object.freeze([
  route("GET", "meta", "meta", NONE, NONE, "none", null),
  route("GET", "schema", "schema", NONE, NONE, "none", null),
  route("GET", "schema/{collection}", "collection", COLLECTION, NONE, "none", null),
  route("GET", "schema/{collection}/shards", "shards", COLLECTION, SHARDS_QUERY, "none", null),
  route("GET", "schema/{collection}/tenants", "tenants", COLLECTION, NONE, "none", null),
  route("GET", "schema/{collection}/tenants/{tenant}", "tenant", TENANT, NONE, "none", null),
  route("GET", "aliases", "aliases", NONE, NONE, "none", null),
  route("GET", "aliases/{alias}", "alias", ALIAS, NONE, "none", null),
  route("GET", "nodes", "nodes", NONE, NODES_QUERY, "none", null),
  route("GET", "nodes/{collection}", "collection_nodes", COLLECTION, NODES_QUERY, "none", null),
  route("GET", "objects", "objects", NONE, OBJECTS_QUERY, "none", null),
  route("GET", "objects/{collection}/{id}", "object", OBJECT, OBJECT_QUERY, "none", null),
  route("POST", "search/{collection}/bm25", "search_bm25", COLLECTION, NONE, "required", "SearchBm25Request"),
  route("POST", "search/{collection}/hybrid", "search_hybrid", COLLECTION, NONE, "required", "SearchHybridRequest"),
  route(
    "POST",
    "search/{collection}/near-vector",
    "search_near_vector",
    COLLECTION,
    NONE,
    "required",
    "SearchNearVectorRequest",
  ),
  route(
    "POST",
    "search/{collection}/near-object",
    "search_near_object",
    COLLECTION,
    NONE,
    "required",
    "SearchNearObjectRequest",
  ),
  route("POST", "aggregate/{collection}", "aggregate", COLLECTION, NONE, "optional", "AggregateRequest"),
]);

/**
 * Every operation's method, path and query keys, as the client is built with them: the console's routes, then the
 * two the provider writes itself and no console text can name.
 */
export const WEAVIATE_CLIENT_ROUTES: Readonly<
  Record<WeaviateOp, { readonly method: "GET" | "POST"; readonly path: string; readonly query: readonly string[] }>
> = Object.freeze({
  ...(Object.fromEntries(
    WEAVIATE_ROUTES.map((entry) => [
      entry.op,
      Object.freeze({
        method: entry.method as "GET" | "POST",
        path: `${WEAVIATE_CONSOLE.pathPrefix}${entry.template}`,
        query: Object.freeze(Object.keys(entry.query)),
      }),
    ]),
  ) as Record<WeaviateConsoleOp, { method: "GET" | "POST"; path: string; query: readonly string[] }>),
  ready: Object.freeze({ method: "GET", path: "/v1/.well-known/ready", query: Object.freeze([]) }),
  graphql: Object.freeze({ method: "POST", path: "/v1/graphql", query: Object.freeze([]) }),
});

/** One closed object level: the keys it takes, and the keys it cannot go without. */
export interface KeySet {
  readonly keys: readonly string[];
  readonly required: readonly string[];
}

const COMMON = [
  "where",
  "limit",
  "offset",
  "autoLimit",
  "returnProperties",
  "returnMetadata",
  "tenant",
  "consistencyLevel",
] as const;

/** Every object a version 1 body can hold, with the keys the document declares for it and version 1 takes. */
export const WEAVIATE_KEYS = {
  SearchBm25Request: { keys: [...COMMON, "query", "queryProperties"], required: ["query"] },
  SearchHybridRequest: {
    keys: [...COMMON, "query", "queryProperties", "alpha", "fusionType", "maxVectorDistance", "targetVector"],
    required: ["query", "alpha"],
  },
  SearchNearVectorRequest: {
    keys: [...COMMON, "vector", "targetVector", "distance", "certainty"],
    required: ["vector"],
  },
  SearchNearObjectRequest: {
    keys: [...COMMON, "id", "targetVector", "distance", "certainty"],
    required: ["id"],
  },
  AggregateRequest: { keys: ["where", "tenant", "groupBy", "limit", "returnMetrics"], required: [] },
  WhereFilter: {
    keys: [
      "operator",
      "operands",
      "path",
      "valueInt",
      "valueNumber",
      "valueBoolean",
      "valueString",
      "valueText",
      "valueDate",
      "valueIntArray",
      "valueNumberArray",
      "valueBooleanArray",
      "valueStringArray",
      "valueTextArray",
      "valueDateArray",
      "valueGeoRange",
    ],
    required: ["operator"],
  },
  WhereFilterGeoRange: { keys: ["geoCoordinates", "distance"], required: ["geoCoordinates", "distance"] },
  GeoCoordinates: { keys: ["latitude", "longitude"], required: ["latitude", "longitude"] },
  GeoDistance: { keys: ["max"], required: ["max"] },
} as const satisfies Readonly<Record<string, KeySet>>;

export type WeaviateObjectName = keyof typeof WEAVIATE_KEYS;

/**
 * The body keys the document declares that version 1 refuses by name, with the reason each is refused. The first
 * three make the server call a model provider (spec W3); the others are reserved (the 1.40.2 OpenAPI text answers
 * them "Returns 422, not yet supported") or not yet measured on the GraphQL path (spec WM7).
 */
export const WEAVIATE_REFUSED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  singlePrompt: "generative search sends the results to a model provider",
  groupedTask: "generative search sends the results to a model provider",
  rerank: "reranking sends the results to a model provider",
  groupBy: "grouped search is reserved in Weaviate's REST search",
  numberOfGroups: "grouped search is reserved in Weaviate's REST search",
  objectsPerGroup: "grouped search is reserved in Weaviate's REST search",
  returnReferences: "returning cross-references is outside this version of the console",
  over: "aggregate over a search is reserved in Weaviate's REST aggregate",
  objectLimit: "aggregate over a search is reserved in Weaviate's REST aggregate",
});

/** The enumerations a request names, with the words each takes. */
export const WEAVIATE_ENUMS = Object.freeze({
  operator: Object.freeze([
    "And",
    "Or",
    "Not",
    "Equal",
    "NotEqual",
    "Like",
    "GreaterThan",
    "GreaterThanEqual",
    "LessThan",
    "LessThanEqual",
    "WithinGeoRange",
    "IsNull",
    "ContainsAny",
    "ContainsAll",
    "ContainsNone",
  ]),
  returnMetadata: Object.freeze(["distance", "certainty", "score", "explainScore", "creationTime", "lastUpdateTime"]),
  consistencyLevel: Object.freeze(["ONE", "QUORUM", "ALL"]),
  fusionType: Object.freeze(["ranked", "relativeScore"]),
  returnMetrics: Object.freeze(["count"]),
} as const);

/** Every bound of the console, the results and the calls, as one table. */
export const WEAVIATE_BOUNDS = Object.freeze({
  /** Sent explicitly where an object list names no limit: Weaviate's own default for `GET /v1/objects`. */
  defaultObjectsLimit: 25,
  /** Sent explicitly where a search names no limit, so REST and GraphQL answer the same rows: QUERY_DEFAULTS_LIMIT. */
  defaultSearchLimit: 10,
  /** Groups an aggregate with groupBy answers when it names no limit, written out: the server's own default on both paths. */
  defaultGroupsLimit: 100,
  /** Rows one request may ask for: a limit, an offset plus a limit. Below Weaviate's QUERY_MAXIMUM_RESULTS (10,000). */
  maxRows: 1_000,
  maxDenseSize: 65_536,
  maxFilterBytes: 65_536,
  maxFilterConditions: 256,
  maxFilterDepth: 8,
  maxFilterListEntries: 10_000,
  maxNameLength: 255,
  maxPropertyList: 256,
  /** Past this the transport drops the answer and keeps no row. */
  transportCapBytes: 16_777_216,
  /** Counted in the bytes the conversion produces; rows past it are dropped whole. */
  resultBudgetBytes: 8_388_608,
  /** UTF-16 code units a text cell keeps; a vector cell is never cut. */
  stringCellUnits: 65_536,
  /** A metadata route's deadline and a search's, each at most the query timeout and below the 60 s write timeout. */
  metadataDeadlineMs: 10_000,
  searchDeadlineMs: 30_000,
  perProvider: 4,
  perEngine: 16,
  queueDepth: 64,
  describeConcurrency: 4,
  tablesPanelCollections: 200,
  /** The tenants a Source lists by name, as Milvus lists partitions (spec 4.4). */
  sourceTenants: 1_024,
});

/** What version 1 runs, said after every refusal of a route it does not run. */
export const WEAVIATE_RUNS =
  "This console runs Weaviate's read requests only, with GET and POST: the meta, schema, shard, tenant, alias and node " +
  "reads, object list and read by id, the bm25, hybrid, near-vector and near-object searches, and aggregate counts.";

/**
 * The routes version 1 does not run, by what they are. A pattern is the path after the prefix, `*` standing for one
 * segment and a trailing `**` for the rest; the first row that matches names the route, so narrower rows come first.
 */
interface RefusedRouteClass {
  readonly what: string;
  readonly patterns: readonly string[];
  readonly methods?: readonly string[];
}

const WEAVIATE_REFUSED_ROUTES: readonly RefusedRouteClass[] = Object.freeze([
  {
    what: "a search that sends its text or media to a model provider",
    patterns: ["search/*/near-text", "search/*/near-image", "search/*/near-media"],
  },
  {
    what: "a GraphQL request, which this console writes for you from a REST search",
    patterns: ["graphql", "graphql/**"],
  },
  { what: "a batch write", patterns: ["batch", "batch/**"] },
  { what: "a backup route", patterns: ["backups", "backups/**"] },
  { what: "a user, role or permission route", patterns: ["authz", "authz/**", "users", "users/**"] },
  { what: "a replication route", patterns: ["replication", "replication/**"] },
  { what: "a namespace route", patterns: ["namespaces", "namespaces/**"] },
  { what: "the server's MCP endpoint", patterns: ["mcp", "mcp/**"] },
  { what: "a classification route", patterns: ["classifications", "classifications/**"] },
  { what: "a tokenize route", patterns: ["tokenize", "schema/*/properties/*/tokenize"] },
  { what: "an export or import route", patterns: ["export", "export/**", "experimental/**"] },
  { what: "a health or readiness route", patterns: [".well-known/**"] },
  { what: "an object write", patterns: ["objects", "objects/**"], methods: ["POST", "PUT", "PATCH", "DELETE", "HEAD"] },
  { what: "a schema, tenant, index or alias change", patterns: ["schema", "schema/**", "aliases", "aliases/**"] },
]);

function matches(pattern: string, segments: readonly string[]): boolean {
  const parts = pattern.split("/");
  const open = parts[parts.length - 1] === "**";
  const fixed = open ? parts.slice(0, -1) : parts;
  if (open ? segments.length <= fixed.length : segments.length !== fixed.length) return false;
  return fixed.every((part, index) => part === "*" || part === segments[index]);
}

/**
 * The sentence for a request line version 1 does not run: what the route is, where a row names it, and what the
 * console runs. `path` is the request's path as written, with or without the prefix and any query string.
 */
export function refusedRouteSentence(method: string, path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  const relative = bare.startsWith(WEAVIATE_CONSOLE.pathPrefix)
    ? bare.slice(WEAVIATE_CONSOLE.pathPrefix.length)
    : bare.replace(/^\/+/, "");
  const segments = relative.split("/");
  const found = WEAVIATE_REFUSED_ROUTES.find(
    (row) =>
      (row.methods === undefined || row.methods.includes(method)) &&
      row.patterns.some((pattern) => matches(pattern, segments)),
  );
  const line = `${method} ${WEAVIATE_CONSOLE.pathPrefix}${relative}`;
  if (found !== undefined) return `${line} is ${found.what}, which this console does not run. ${WEAVIATE_RUNS}`;
  if (!WEAVIATE_CONSOLE.methods.includes(method)) {
    return `${line} is not a request this console runs: it sends ${WEAVIATE_CONSOLE.methods.join(" and ")} only. ${WEAVIATE_RUNS}`;
  }
  return `${line} is not a route this console runs. ${WEAVIATE_RUNS}`;
}
