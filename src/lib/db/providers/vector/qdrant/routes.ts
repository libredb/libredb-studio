import type { ConsoleDialectSpec, QueryKeySpec, RouteSpec } from "@/lib/db/console/dialect";
import type { QdrantOp } from "./client";

/**
 * The Qdrant console as data: its dialect, its route table, the closed key sets of every request body, its bounds,
 * its version gates and the sentences it refuses a route with.
 *
 * The console text is a Qdrant request line and one JSON body, the form Qdrant's own documentation prints. Version
 * 1 runs 17 read operations with GET and POST only, and every body key is closed: a key the pinned OpenAPI
 * document (tag v1.19.1) does not declare at its level is refused by name, because the server reads past an
 * unknown key without a word, so a misspelled `filter` would return unfiltered rows.
 *
 * Nothing here is derived at run time. The table and the key sets are written out, and
 * tests/unit/db/qdrant/routes-drift.test.ts holds them equal to tests/fixtures/qdrant/openapi-schemas.json, which
 * tests/live/qdrant-openapi.ts writes from the pinned document. Browser-safe: it imports types only.
 */

export const QDRANT_CONSOLE: ConsoleDialectSpec = Object.freeze({
  id: "qdrant",
  methods: Object.freeze(["GET", "POST"]),
  pathPrefix: "/",
  shortForm: true,
  commentMarkers: Object.freeze(["//", "#"]),
  bodyComments: true,
  maxTextBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 4_096,
  maxNumericLeaves: 262_144,
  maxScalarLeaves: 32_768,
});

/** The request bodies of the pinned OpenAPI document that a version 1 route takes. */
export type QdrantBodySchema =
  | "PointRequest"
  | "ScrollRequest"
  | "CountRequest"
  | "FacetRequest"
  | "QueryRequest"
  | "QueryRequestBatch"
  | "QueryGroupsRequest";

/** One route of the table: the shared route facts, and the schema its body is read by. */
export interface QdrantRoute extends RouteSpec<QdrantOp> {
  /** The body's schema, or null where the route takes no body. */
  readonly schema: QdrantBodySchema | null;
}

const NAME = Object.freeze({ collection_name: "name" } as const);
const POINT = Object.freeze({ collection_name: "name", id: "point-id" } as const);
const NONE = Object.freeze({});

/** The query keys a route may declare, and the values each takes. `wait` and `ordering` are never accepted. */
const QDRANT_QUERY_KEYS: Readonly<Record<"consistency" | "timeout" | "with" | "completed_limit", QueryKeySpec>> =
  Object.freeze({
    consistency: Object.freeze({ kind: "positive-int-or-words", words: Object.freeze(["majority", "quorum", "all"]) }),
    timeout: Object.freeze({ kind: "positive-int" }),
    with: Object.freeze({ kind: "word-list", words: Object.freeze(["queued", "completed", "idle_segments"]) }),
    completed_limit: Object.freeze({ kind: "positive-int" }),
  });

const POINT_READ = Object.freeze({
  consistency: QDRANT_QUERY_KEYS.consistency,
  timeout: QDRANT_QUERY_KEYS.timeout,
});
const OPTIMIZATIONS = Object.freeze({
  with: QDRANT_QUERY_KEYS.with,
  completed_limit: QDRANT_QUERY_KEYS.completed_limit,
});

function route(
  method: "GET" | "POST",
  template: string,
  op: QdrantOp,
  params: QdrantRoute["params"],
  query: QdrantRoute["query"],
  body: QdrantRoute["body"],
  schema: QdrantBodySchema | null,
): QdrantRoute {
  return Object.freeze({ method, template, op, class: "read", params, query, body, schema });
}

/**
 * The 17 routes version 1 runs, every one a read, in the order the documentation lists them. A template is the
 * path after the dialect's prefix `/`, so the root route's template is empty. A body is `required` where its
 * schema names a required key and `optional` otherwise, and an optional body left out is sent as `{}`.
 */
export const QDRANT_ROUTES: readonly QdrantRoute[] = Object.freeze([
  route("GET", "", "root", NONE, NONE, "none", null),
  route("GET", "collections", "get_collections", NONE, NONE, "none", null),
  route("GET", "collections/{collection_name}", "get_collection", NAME, NONE, "none", null),
  route("GET", "collections/{collection_name}/exists", "collection_exists", NAME, NONE, "none", null),
  route("GET", "aliases", "get_collections_aliases", NONE, NONE, "none", null),
  route("GET", "collections/{collection_name}/aliases", "get_collection_aliases", NAME, NONE, "none", null),
  route("POST", "collections/{collection_name}/points", "get_points", NAME, POINT_READ, "required", "PointRequest"),
  route("GET", "collections/{collection_name}/points/{id}", "get_point", POINT, POINT_READ, "none", null),
  route(
    "POST",
    "collections/{collection_name}/points/scroll",
    "scroll_points",
    NAME,
    POINT_READ,
    "optional",
    "ScrollRequest",
  ),
  route(
    "POST",
    "collections/{collection_name}/points/count",
    "count_points",
    NAME,
    POINT_READ,
    "optional",
    "CountRequest",
  ),
  route("POST", "collections/{collection_name}/facet", "facet", NAME, POINT_READ, "required", "FacetRequest"),
  route(
    "POST",
    "collections/{collection_name}/points/query",
    "query_points",
    NAME,
    POINT_READ,
    "optional",
    "QueryRequest",
  ),
  route(
    "POST",
    "collections/{collection_name}/points/query/batch",
    "query_batch_points",
    NAME,
    POINT_READ,
    "required",
    "QueryRequestBatch",
  ),
  route(
    "POST",
    "collections/{collection_name}/points/query/groups",
    "query_points_groups",
    NAME,
    POINT_READ,
    "required",
    "QueryGroupsRequest",
  ),
  route("GET", "collections/{collection_name}/optimizations", "get_optimizations", NAME, OPTIMIZATIONS, "none", null),
  route("GET", "collections/{collection_name}/snapshots", "list_snapshots", NAME, NONE, "none", null),
  route("GET", "collections/{collection_name}/cluster", "collection_cluster_info", NAME, NONE, "none", null),
]);

/** An operation's method and path, the path with the prefix and its parameters as `{name}`. */
export interface QdrantRoutePath {
  readonly method: "GET" | "POST";
  readonly path: string;
}

/**
 * Each operation's method and path, from the table: what the client that builds a request's URL is constructed
 * with, so it builds no path the table does not hold.
 */
export const QDRANT_ROUTE_PATHS: Readonly<Record<QdrantOp, QdrantRoutePath>> = Object.freeze(
  Object.fromEntries(
    QDRANT_ROUTES.map((entry) => [
      entry.op,
      Object.freeze({ method: entry.method as "GET" | "POST", path: `${QDRANT_CONSOLE.pathPrefix}${entry.template}` }),
    ]),
  ) as Record<QdrantOp, QdrantRoutePath>,
);

/** One closed object level: the keys it takes, and the keys it cannot go without. */
export interface KeySet {
  readonly keys: readonly string[];
  readonly required: readonly string[];
}

/**
 * Every object a version 1 body can hold, by its name in the pinned OpenAPI document, with the keys the document
 * declares for it. `request.ts` refuses any other key at that level by name.
 */
export const QDRANT_KEYS = {
  AbsExpression: { keys: ["abs"], required: ["abs"] },
  AcornSearchParams: { keys: ["enable", "max_selectivity"], required: [] },
  AcoshExpression: { keys: ["acosh"], required: ["acosh"] },
  ContextPair: { keys: ["positive", "negative"], required: ["negative", "positive"] },
  ContextQuery: { keys: ["context"], required: ["context"] },
  CountRequest: { keys: ["shard_key", "filter", "exact"], required: [] },
  DatetimeExpression: { keys: ["datetime"], required: ["datetime"] },
  DatetimeKeyExpression: { keys: ["datetime_key"], required: ["datetime_key"] },
  DatetimeRange: { keys: ["lt", "gt", "gte", "lte"], required: [] },
  DecayParamsExpression: { keys: ["x", "target", "scale", "midpoint"], required: ["x"] },
  DiscoverInput: { keys: ["target", "context"], required: ["context", "target"] },
  DiscoverQuery: { keys: ["discover"], required: ["discover"] },
  DivExpression: { keys: ["div"], required: ["div"] },
  DivParams: { keys: ["left", "right", "by_zero_default"], required: ["left", "right"] },
  Document: { keys: ["text", "model", "options"], required: ["model", "text"] },
  ExpDecayExpression: { keys: ["exp_decay"], required: ["exp_decay"] },
  ExpExpression: { keys: ["exp"], required: ["exp"] },
  FacetRequest: { keys: ["shard_key", "key", "limit", "filter", "exact"], required: ["key"] },
  FeedbackItem: { keys: ["example", "score"], required: ["example", "score"] },
  FieldCondition: {
    keys: [
      "key",
      "match",
      "range",
      "geo_bounding_box",
      "geo_radius",
      "geo_polygon",
      "values_count",
      "is_empty",
      "is_null",
    ],
    required: ["key"],
  },
  Filter: { keys: ["should", "min_should", "must", "must_not"], required: [] },
  FormulaQuery: { keys: ["formula", "defaults"], required: ["formula"] },
  FusionQuery: { keys: ["fusion"], required: ["fusion"] },
  GaussDecayExpression: { keys: ["gauss_decay"], required: ["gauss_decay"] },
  GeoBoundingBox: { keys: ["top_left", "bottom_right"], required: ["bottom_right", "top_left"] },
  GeoDistance: { keys: ["geo_distance"], required: ["geo_distance"] },
  GeoDistanceParams: { keys: ["origin", "to"], required: ["origin", "to"] },
  GeoLineString: { keys: ["points"], required: ["points"] },
  GeoPoint: { keys: ["lon", "lat"], required: ["lat", "lon"] },
  GeoPolygon: { keys: ["exterior", "interiors"], required: ["exterior"] },
  GeoRadius: { keys: ["center", "radius"], required: ["center", "radius"] },
  HasIdCondition: { keys: ["has_id"], required: ["has_id"] },
  HasVectorCondition: { keys: ["has_vector"], required: ["has_vector"] },
  IdfCorpusParams: { keys: ["corpus"], required: ["corpus"] },
  Image: { keys: ["image", "model", "options"], required: ["image", "model"] },
  InferenceObject: { keys: ["object", "model", "options"], required: ["model", "object"] },
  IsEmptyCondition: { keys: ["is_empty"], required: ["is_empty"] },
  IsNullCondition: { keys: ["is_null"], required: ["is_null"] },
  LinDecayExpression: { keys: ["lin_decay"], required: ["lin_decay"] },
  LnExpression: { keys: ["ln"], required: ["ln"] },
  Log10Expression: { keys: ["log10"], required: ["log10"] },
  LookupLocation: { keys: ["collection", "vector", "shard_key"], required: ["collection"] },
  MatchAny: { keys: ["any"], required: ["any"] },
  MatchExcept: { keys: ["except"], required: ["except"] },
  MatchPhrase: { keys: ["phrase"], required: ["phrase"] },
  MatchPrefix: { keys: ["prefix"], required: ["prefix"] },
  MatchText: { keys: ["text"], required: ["text"] },
  MatchTextAny: { keys: ["text_any"], required: ["text_any"] },
  MatchValue: { keys: ["value"], required: ["value"] },
  MaxExpression: { keys: ["max"], required: ["max"] },
  MinExpression: { keys: ["min"], required: ["min"] },
  MinShould: { keys: ["conditions", "min_count"], required: ["conditions", "min_count"] },
  Mmr: { keys: ["diversity", "candidates_limit"], required: [] },
  MultExpression: { keys: ["mult"], required: ["mult"] },
  NaiveFeedbackStrategy: { keys: ["naive"], required: ["naive"] },
  NaiveFeedbackStrategyParams: { keys: ["a", "b", "c"], required: ["a", "b", "c"] },
  NearestQuery: { keys: ["nearest", "mmr"], required: ["nearest"] },
  NegExpression: { keys: ["neg"], required: ["neg"] },
  Nested: { keys: ["key", "filter"], required: ["filter", "key"] },
  NestedCondition: { keys: ["nested"], required: ["nested"] },
  OrderBy: { keys: ["key", "direction", "start_from"], required: ["key"] },
  OrderByQuery: { keys: ["order_by"], required: ["order_by"] },
  PayloadField: { keys: ["key"], required: ["key"] },
  PayloadSelectorExclude: { keys: ["exclude"], required: ["exclude"] },
  PayloadSelectorInclude: { keys: ["include"], required: ["include"] },
  PointRequest: { keys: ["shard_key", "ids", "with_payload", "with_vector"], required: ["ids"] },
  PowExpression: { keys: ["pow"], required: ["pow"] },
  PowParams: { keys: ["base", "exponent"], required: ["base", "exponent"] },
  Prefetch: {
    keys: ["prefetch", "query", "using", "filter", "params", "score_threshold", "limit", "lookup_from"],
    required: [],
  },
  QuantizationSearchParams: { keys: ["ignore", "rescore", "oversampling"], required: [] },
  QueryGroupsRequest: {
    keys: [
      "shard_key",
      "prefetch",
      "query",
      "using",
      "filter",
      "params",
      "score_threshold",
      "with_vector",
      "with_payload",
      "lookup_from",
      "group_by",
      "group_size",
      "limit",
      "with_lookup",
    ],
    required: ["group_by"],
  },
  QueryRequest: {
    keys: [
      "shard_key",
      "prefetch",
      "query",
      "using",
      "filter",
      "params",
      "score_threshold",
      "limit",
      "offset",
      "with_vector",
      "with_payload",
      "lookup_from",
    ],
    required: [],
  },
  QueryRequestBatch: { keys: ["searches"], required: ["searches"] },
  Range: { keys: ["lt", "gt", "gte", "lte"], required: [] },
  RecommendInput: { keys: ["positive", "negative", "strategy"], required: [] },
  RecommendQuery: { keys: ["recommend"], required: ["recommend"] },
  RelevanceFeedbackInput: { keys: ["target", "feedback", "strategy"], required: ["feedback", "strategy", "target"] },
  RelevanceFeedbackQuery: { keys: ["relevance_feedback"], required: ["relevance_feedback"] },
  Rrf: { keys: ["k", "weights"], required: [] },
  RrfQuery: { keys: ["rrf"], required: ["rrf"] },
  SampleQuery: { keys: ["sample"], required: ["sample"] },
  ScrollRequest: {
    keys: ["shard_key", "offset", "limit", "filter", "with_payload", "with_vector", "order_by"],
    required: [],
  },
  SearchParams: { keys: ["hnsw_ef", "exact", "quantization", "indexed_only", "acorn", "idf"], required: [] },
  ShardKeyWithFallback: { keys: ["target", "fallback"], required: ["fallback", "target"] },
  Slice: { keys: ["total", "index"], required: ["index", "total"] },
  SliceCondition: { keys: ["slice"], required: ["slice"] },
  SparseVector: { keys: ["indices", "values"], required: ["indices", "values"] },
  SqrtExpression: { keys: ["sqrt"], required: ["sqrt"] },
  SumExpression: { keys: ["sum"], required: ["sum"] },
  ValuesCount: { keys: ["lt", "gt", "gte", "lte"], required: [] },
  WithLookup: { keys: ["collection", "with_payload", "with_vectors"], required: ["collection"] },
} as const satisfies Readonly<Record<string, KeySet>>;

export type QdrantObjectName = keyof typeof QDRANT_KEYS;

/**
 * The objects the document's bodies reach that no request walks: they sit inside an inference object's `options`,
 * and a body that holds an `options` key is refused whole.
 */
export const QDRANT_KEYS_NOT_WALKED: readonly string[] = Object.freeze([
  "Bm25Config",
  "DisabledStemmerParams",
  "SnowballParams",
  "StopwordsSet",
]);

/**
 * The one key a query body takes that the pinned document does not declare: the server reads `with_vectors` as
 * `with_vector` on a query and a query batch's searches, as the documentation's own examples write it (measured
 * on 1.19.1: the vectors come back). It is sent as typed; a body that writes both is refused.
 */
export const QDRANT_QUERY_ALIAS = Object.freeze({ alias: "with_vectors", key: "with_vector" } as const);

/** The unions a request walks, each member by its object name, in the order the server tries them. */
export const QDRANT_UNIONS = Object.freeze({
  Condition: Object.freeze([
    "FieldCondition",
    "IsEmptyCondition",
    "IsNullCondition",
    "HasIdCondition",
    "HasVectorCondition",
    "SliceCondition",
    "NestedCondition",
    "Filter",
  ]),
  Match: Object.freeze([
    "MatchValue",
    "MatchText",
    "MatchTextAny",
    "MatchPhrase",
    "MatchPrefix",
    "MatchAny",
    "MatchExcept",
  ]),
  Query: Object.freeze([
    "NearestQuery",
    "RecommendQuery",
    "DiscoverQuery",
    "ContextQuery",
    "OrderByQuery",
    "FusionQuery",
    "RrfQuery",
    "FormulaQuery",
    "SampleQuery",
    "RelevanceFeedbackQuery",
  ]),
  Expression: Object.freeze([
    "GeoDistance",
    "DatetimeExpression",
    "DatetimeKeyExpression",
    "MultExpression",
    "SumExpression",
    "MaxExpression",
    "MinExpression",
    "NegExpression",
    "AbsExpression",
    "DivExpression",
    "SqrtExpression",
    "PowExpression",
    "ExpExpression",
    "Log10Expression",
    "LnExpression",
    "AcoshExpression",
    "LinDecayExpression",
    "ExpDecayExpression",
    "GaussDecayExpression",
  ]),
} as const satisfies Readonly<Record<string, readonly QdrantObjectName[]>>);

/** The enumerations a request names, with the words each takes. */
export const QDRANT_ENUMS = Object.freeze({
  Direction: Object.freeze(["asc", "desc"]),
  Fusion: Object.freeze(["rrf", "dbsf"]),
  IdfScope: Object.freeze(["global"]),
  RecommendStrategy: Object.freeze(["average_vector", "best_score", "sum_scores"]),
  Sample: Object.freeze(["random"]),
} as const);

/**
 * The model names the server runs itself, from its own local_model.rs: the one inference input the console sends,
 * written exactly so, in lower case, with no `options`, aimed at a sparse vector.
 */
export const QDRANT_LOCAL_MODELS: readonly string[] = Object.freeze(["qdrant/bm25", "bm25"]);

/** Every bound of the console, the results and the calls, as one table. */
export const QDRANT_BOUNDS = Object.freeze({
  /** Sent explicitly where a query, a scroll, a facet or a grouped query names no limit. */
  defaultLimit: 10,
  defaultGroupSize: 3,
  /** Rows one request may ask for: a limit, an id count, a batch's summed limits, or limit times group_size. */
  maxRows: 1_000,
  maxBatchSearches: 10,
  maxPrefetchDepth: 2,
  maxPrefetchPerList: 4,
  /** Prefetch nodes in the whole request, every search of a batch counted together. */
  maxPrefetchNodes: 10,
  /** What a prefetch entry with no limit counts as in the candidate sum; it is not sent. */
  countedPrefetchLimit: 10,
  /** The sum over every query node of (offset + limit) times its oversampling. */
  maxCandidates: 10_000,
  maxHnswEf: 1_024,
  maxOversampling: 8,
  maxMmrCandidates: 1_024,
  maxFacetLimit: 1_000,
  /** Every filter of a request, serialised, together. */
  maxFilterBytes: 65_536,
  /** Conditions in one filter tree. */
  maxFilterConditions: 256,
  maxNestedLevels: 4,
  /** Entries of a `match.any`, a `match.except` or a `has_id` list. */
  maxFilterListEntries: 10_000,
  maxFormulaDepth: 12,
  maxFormulaNodes: 128,
  maxDenseSize: 65_536,
  /** A multivector's rows times its size stays below 1,048,576. */
  maxMultivectorElements: 1_048_575,
  /** A sparse index is a uint32, so 4294967295 is one. */
  sparseIndexBoundExclusive: 4_294_967_296,
  maxCollectionNameLength: 255,
  maxVectorNameBytes: 200,
  /** Past this the transport drops the answer and keeps no row. */
  transportCapBytes: 16_777_216,
  /** Counted in the bytes the conversion produces; rows past it are dropped whole. */
  resultBudgetBytes: 8_388_608,
  /** UTF-16 code units a text cell keeps; a vector cell is never cut. */
  stringCellUnits: 65_536,
  payloadSamplePoints: 1_000,
  metadataDeadlineMs: 10_000,
  pointReadDeadlineMs: 30_000,
  perProvider: 4,
  perEngine: 16,
  queueDepth: 64,
  describeConcurrency: 4,
  tablesPanelCollections: 200,
});

/** A key a server older than `needs` does not read: some ignore it without a word, some answer an error naming no key. */
export interface QdrantGate {
  /** The key as a refusal names it. */
  readonly key: string;
  /** The first server version that reads it. */
  readonly needs: string;
}

export const QDRANT_GATES = Object.freeze({
  rrfWeights: Object.freeze({ key: "rrf.weights", needs: "1.17.0" }),
  relevanceFeedback: Object.freeze({ key: "relevance_feedback", needs: "1.17.0" }),
  paramsIdf: Object.freeze({ key: "params.idf", needs: "1.19.0" }),
  matchPrefix: Object.freeze({ key: "match.prefix", needs: "1.19.0" }),
  slice: Object.freeze({ key: "slice", needs: "1.19.0" }),
  formulaAcosh: Object.freeze({ key: "formula acosh", needs: "1.19.1" }),
  formulaMax: Object.freeze({ key: "formula max", needs: "1.19.1" }),
  formulaMin: Object.freeze({ key: "formula min", needs: "1.19.1" }),
} as const satisfies Readonly<Record<string, QdrantGate>>);

export type QdrantGateId = keyof typeof QDRANT_GATES;

/** The characters a vector name may not hold, as the server's own validator lists them. */
export const QDRANT_VECTOR_NAME_FORBIDDEN: readonly string[] = Object.freeze([
  "<",
  ">",
  ":",
  '"',
  "/",
  "\\",
  "|",
  "?",
  "*",
  "\u0000",
  "\u001f",
]);

/** What version 1 runs, said after every refusal of a route it does not run. */
export const QDRANT_RUNS =
  "This console runs Qdrant's read requests only, with GET and POST: the collection, alias, optimization, " +
  "snapshot-list and cluster-info reads, and point retrieve, scroll, count, facet, query, query/batch and query/groups.";

/**
 * The routes version 1 does not run, by what they are. A pattern is the path after the prefix, `*` standing for
 * one segment and a trailing `**` for the rest; the first row that matches names the route, so the narrower rows
 * come first. A row with methods matches those methods only.
 */
interface RefusedRouteClass {
  readonly what: string;
  readonly patterns: readonly string[];
  readonly methods?: readonly string[];
}

const QDRANT_REFUSED_ROUTES: readonly RefusedRouteClass[] = Object.freeze([
  {
    what: "a snapshot create, delete, download, upload or recover route",
    patterns: [
      "snapshots",
      "snapshots/**",
      "collections/*/snapshots",
      "collections/*/snapshots/**",
      "collections/*/shards/*/snapshot",
      "collections/*/shards/*/snapshot/**",
      "collections/*/shards/*/snapshots",
      "collections/*/shards/*/snapshots/**",
    ],
  },
  {
    what: "a shard, peer or cluster route",
    patterns: ["cluster", "cluster/**", "collections/*/cluster", "collections/*/shards", "collections/*/shards/**"],
  },
  {
    what: "a service route (telemetry, metrics, issues, quotas, health or diagnostics)",
    patterns: [
      "telemetry",
      "metrics",
      "issues",
      "quotas",
      "healthz",
      "livez",
      "readyz",
      "debugger",
      "logger",
      "stacktrace",
      "profiler/**",
      "audit/**",
      "collections/*/memory",
      "collections/*/debug",
      "collections/*/truncate_unapplied_wal",
    ],
  },
  {
    what: "a distance matrix route",
    patterns: ["collections/*/points/search/matrix/**"],
  },
  {
    what: "a legacy search, recommend or discover route, which POST /collections/{collection_name}/points/query replaces",
    patterns: [
      "collections/*/points/search",
      "collections/*/points/search/**",
      "collections/*/points/recommend",
      "collections/*/points/recommend/**",
      "collections/*/points/discover",
      "collections/*/points/discover/**",
    ],
  },
  {
    what: "a vector or index change",
    patterns: [
      "collections/*/points/vectors",
      "collections/*/points/vectors/**",
      "collections/*/index",
      "collections/*/index/**",
      "collections/*/vectors/**",
    ],
  },
  {
    what: "a point or payload write",
    patterns: [
      "collections/*/points/delete",
      "collections/*/points/payload",
      "collections/*/points/payload/**",
      "collections/*/points/batch",
    ],
  },
  { what: "a point or payload write", patterns: ["collections/*/points"], methods: ["PUT", "DELETE", "PATCH"] },
  { what: "a collection or alias change", patterns: ["collections/aliases"] },
  { what: "a collection or alias change", patterns: ["collections/*"], methods: ["PUT", "DELETE", "PATCH", "POST"] },
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
  const relative = bare.startsWith(QDRANT_CONSOLE.pathPrefix) ? bare.slice(QDRANT_CONSOLE.pathPrefix.length) : bare;
  const segments = relative.split("/");
  const found = QDRANT_REFUSED_ROUTES.find(
    (row) =>
      (row.methods === undefined || row.methods.includes(method)) &&
      row.patterns.some((pattern) => matches(pattern, segments)),
  );
  const line = `${method} ${QDRANT_CONSOLE.pathPrefix}${relative}`;
  if (found !== undefined) return `${line} is ${found.what}, which this console does not run. ${QDRANT_RUNS}`;
  if (!QDRANT_CONSOLE.methods.includes(method)) {
    return `${line} is not a request this console runs: it sends ${QDRANT_CONSOLE.methods.join(" and ")} only. ${QDRANT_RUNS}`;
  }
  return `${line} is not a route this console runs. ${QDRANT_RUNS}`;
}
