/**
 * The Milvus console's dialect and its route table (vector-family spec 5.4, 5.6): pure data, shipped to the browser.
 *
 * The console text is one `POST /v2/vectordb/<route>` line and one JSON body, the form of Milvus's REST reference,
 * which the provider lowers to typed gRPC calls and never forwards. Every v1 route reads, and each has its own key
 * schema, never merged rows. The keys a route accepts, the documented keys it refuses and why, the keys refused in
 * every release (E34), the bounds of 5.6 and the search-parameter table of E28 are declared here and read by
 * request.ts, so a reviewer reads one table, and tests/unit/db/milvus/routes-drift.test.ts holds it to the vendor's
 * pinned reference.
 */
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import type { MilvusVersionGate } from "./versions";

/** The dialect of 5.4; the parser bounds are R51 U16's starting values, assumptions until QM11 runs. */
export const MILVUS_CONSOLE: ConsoleDialectSpec = {
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
};

export type MilvusOp =
  | "databases/list"
  | "databases/describe"
  | "collections/list"
  | "collections/describe"
  | "collections/get_stats"
  | "collections/get_load_state"
  | "partitions/list"
  | "indexes/list"
  | "indexes/describe"
  | "aliases/list"
  | "aliases/describe"
  | "entities/query"
  | "entities/get"
  | "entities/search"
  | "entities/hybrid_search";

interface RouteRow {
  readonly op: MilvusOp;
  /** "optional": an absent body is `{}`, as the vendor's reference marks the route. */
  readonly body: "optional" | "required";
  /** Every key the route accepts, in the order 5.4 lists them. */
  readonly keys: readonly string[];
  readonly required: readonly string[];
}

/** The v1 route table of 5.4, one row per route (R51 U21 A). */
const ROUTE_ROWS: readonly RouteRow[] = [
  { op: "databases/list", body: "optional", keys: [], required: [] },
  { op: "databases/describe", body: "required", keys: ["dbName"], required: ["dbName"] },
  { op: "collections/list", body: "optional", keys: ["dbName"], required: [] },
  { op: "collections/describe", body: "required", keys: ["dbName", "collectionName"], required: ["collectionName"] },
  { op: "collections/get_stats", body: "required", keys: ["dbName", "collectionName"], required: ["collectionName"] },
  {
    op: "collections/get_load_state",
    body: "required",
    keys: ["dbName", "collectionName", "partitionNames"],
    required: ["collectionName"],
  },
  { op: "partitions/list", body: "required", keys: ["dbName", "collectionName"], required: ["collectionName"] },
  { op: "indexes/list", body: "required", keys: ["dbName", "collectionName"], required: ["collectionName"] },
  {
    op: "indexes/describe",
    body: "required",
    keys: ["dbName", "collectionName", "indexName"],
    required: ["collectionName", "indexName"],
  },
  { op: "aliases/list", body: "optional", keys: ["dbName", "collectionName"], required: [] },
  { op: "aliases/describe", body: "required", keys: ["dbName", "aliasName"], required: ["aliasName"] },
  {
    op: "entities/query",
    body: "required",
    keys: [
      "dbName",
      "collectionName",
      "filter",
      "outputFields",
      "limit",
      "offset",
      "partitionNames",
      "exprParams",
      "consistencyLevel",
      "orderByFields",
    ],
    required: ["collectionName"],
  },
  {
    op: "entities/get",
    body: "required",
    keys: ["dbName", "collectionName", "id", "outputFields", "partitionNames", "consistencyLevel"],
    required: ["collectionName", "id"],
  },
  {
    op: "entities/search",
    body: "required",
    keys: [
      "dbName",
      "collectionName",
      "data",
      "ids",
      "annsField",
      "filter",
      "limit",
      "offset",
      "outputFields",
      "searchParams",
      "partitionNames",
      "exprParams",
      "consistencyLevel",
      "groupingField",
      "groupSize",
      "strictGroupSize",
    ],
    required: ["collectionName", "annsField"],
  },
  {
    op: "entities/hybrid_search",
    body: "required",
    keys: [
      "dbName",
      "collectionName",
      "search",
      "rerank",
      "limit",
      "offset",
      "outputFields",
      "partitionNames",
      "consistencyLevel",
      "groupingField",
      "groupSize",
      "strictGroupSize",
    ],
    required: ["collectionName", "search", "rerank"],
  },
];

/** The console's route table: every route a POST under the prefix, every one a read (5.4). */
export const MILVUS_ROUTES: readonly RouteSpec<MilvusOp>[] = ROUTE_ROWS.map((row) => ({
  method: "POST",
  template: row.op,
  op: row.op,
  class: "read",
  params: {},
  query: {},
  body: row.body,
}));

/** The keys each route accepts; anything else is refused by name, because Milvus and REST drop it (R08 F15). */
export const MILVUS_ROUTE_KEYS: Readonly<Record<MilvusOp, readonly string[]>> = Object.fromEntries(
  ROUTE_ROWS.map((row) => [row.op, row.keys]),
) as Record<MilvusOp, readonly string[]>;

export const MILVUS_REQUIRED_KEYS: Readonly<Record<MilvusOp, readonly string[]>> = Object.fromEntries(
  ROUTE_ROWS.map((row) => [row.op, row.required]),
) as Record<MilvusOp, readonly string[]>;

/** The keys E34 refuses in every release, on both search routes: they can make the server call a service. */
export const MILVUS_PERMANENT_REFUSALS: readonly string[] = ["functionScore", "functionChains", "searchAggregation"];

export function permanentRefusalSentence(key: string): string {
  return `${key} is refused in every release: a search function, ranker chain or aggregation can make Milvus send the request's data to a service it calls, and Studio never sends a request that can reach one.`;
}

/** The documented keys a route refuses, each with its reason; the drift test holds this to the vendor's table. */
export const MILVUS_DOCUMENTED_REFUSALS: Readonly<Partial<Record<MilvusOp, Readonly<Record<string, string>>>>> = {
  "entities/get": {
    partitionName: "partitionName is not read by Studio: name the partitions in partitionNames, a list.",
  },
  "entities/search": {
    functionScore: permanentRefusalSentence("functionScore"),
    functionChains: permanentRefusalSentence("functionChains"),
    searchAggregation: permanentRefusalSentence("searchAggregation"),
    params:
      "params on entities/search is never read by Milvus, so Studio refuses it: put search parameters in searchParams.params.",
  },
  "entities/hybrid_search": {
    functionScore: permanentRefusalSentence("functionScore"),
  },
};

/** Keys the vendor does not document for the route, refused with a reason of their own rather than as unknown. */
export const MILVUS_UNDOCUMENTED_REFUSALS: Readonly<Partial<Record<MilvusOp, Readonly<Record<string, string>>>>> = {
  "entities/query": {
    groupByFields:
      "groupByFields is not available: Milvus documents no REST form of query aggregation, so Studio does not send it.",
  },
  "entities/hybrid_search": {
    functionChains: permanentRefusalSentence("functionChains"),
    searchAggregation: permanentRefusalSentence("searchAggregation"),
  },
};

/** The keys of one hybrid sub-request, as the vendor's Hybrid Search page documents them (5.4). */
export const MILVUS_SUB_REQUEST_KEYS: readonly string[] = [
  "annsField",
  "data",
  "filter",
  "exprParams",
  "limit",
  "params",
  "metricType",
];

const TOP_LEVEL_ONLY = "belongs at the top level of entities/hybrid_search, where Milvus reads it";

/** Keys a sub-request refuses with a reason (5.4, R40 F3, M16, R43). */
export const MILVUS_SUB_REQUEST_REFUSALS: Readonly<Record<string, string>> = {
  offset: "offset is ignored by Milvus inside a hybrid sub-request: page with the top-level offset.",
  ignoreGrowing: "ignoreGrowing is not sent: no measurement reached it through Studio's client.",
  groupingField: `groupingField ${TOP_LEVEL_ONLY}.`,
  groupSize: `groupSize ${TOP_LEVEL_ONLY}.`,
  strictGroupSize: `strictGroupSize ${TOP_LEVEL_ONLY}.`,
  ids: "ids cannot search inside a hybrid sub-request: Milvus fails a sub-request that carries ids.",
  consistencyLevel: `consistencyLevel ${TOP_LEVEL_ONLY}; Milvus drops a sub-request's own level.`,
  searchParams: "a hybrid sub-request names its search parameters in params.",
  functionScore: permanentRefusalSentence("functionScore"),
};

/** The keys of `searchParams` on entities/search; index and range keys go in its `params` (5.6). */
export const MILVUS_SEARCH_PARAMS_KEYS: readonly string[] = ["metric_type", "params", "round_decimal"];

/** The rerank strategies of E35 and the one params key each takes. */
export const MILVUS_RERANK_PARAMS: Readonly<Record<"rrf" | "weighted", string>> = { rrf: "k", weighted: "weights" };

export const NORM_SCORE_REFUSAL =
  "norm_score is refused until a measurement shows its effect: three settings gave identical scores.";

/** What request.ts reads a search parameter as (5.6, E12's integer and number kinds). */
export type SearchParameterRule =
  | { readonly kind: "integer"; readonly min: number; readonly max: number; readonly atLeastK?: true }
  | {
      readonly kind: "number";
      readonly min: number;
      readonly max: number;
      readonly maxExclusive?: true;
      /** knowhere stores it as a 32-bit float, so the range is checked on Math.fround(value). */
      readonly float32: boolean;
    }
  | { readonly kind: "finite" };

/** Every key `searchParams.params` (or a sub-request's `params`) may carry, with its kind and range (5.6). */
export const MILVUS_SEARCH_PARAMETERS: Readonly<Record<string, SearchParameterRule>> = {
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
};

const RANGE: readonly string[] = ["radius", "range_filter"];

/**
 * The search parameters each index type takes, by the `index_type` DescribeIndex reports (5.6, R43 M8). A range
 * search's `radius` and `range_filter` apply to every dense and binary type; an index type not named here takes no
 * key at all, because Studio has not measured it.
 */
export const MILVUS_INDEX_SEARCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  FLAT: [...RANGE],
  BIN_FLAT: [...RANGE],
  IVF_FLAT: ["nprobe", ...RANGE],
  IVF_SQ8: ["nprobe", "refine_k", ...RANGE],
  IVF_PQ: ["nprobe", "refine_k", ...RANGE],
  IVF_RABITQ: ["nprobe", "refine_k", "rbq_bits_query", ...RANGE],
  BIN_IVF_FLAT: ["nprobe", ...RANGE],
  SCANN: ["nprobe", "reorder_k", ...RANGE],
  HNSW: ["ef", ...RANGE],
  HNSW_SQ: ["ef", "refine_k", ...RANGE],
  HNSW_PQ: ["ef", "refine_k", ...RANGE],
  HNSW_PRQ: ["ef", "refine_k", ...RANGE],
  AUTOINDEX: ["ef", "refine_k", ...RANGE],
  DISKANN: ["search_list", "filter_threshold", ...RANGE],
  AISAQ: ["search_list", "filter_threshold", "beamwidth", "vectors_beamwidth", ...RANGE],
  SPARSE_INVERTED_INDEX: ["drop_ratio_search", "dim_max_score_ratio", "refine_factor"],
  SPARSE_WAND: ["drop_ratio_search", "dim_max_score_ratio", "refine_factor"],
};

/** The metrics whose larger score is closer, so a range's range_filter lies above its radius (R43). */
export const MILVUS_SIMILARITY_METRICS: readonly string[] = ["IP", "COSINE", "BM25"];
/** The metrics whose smaller score is closer, so a range's range_filter lies below its radius. */
export const MILVUS_DISTANCE_METRICS: readonly string[] = ["L2", "HAMMING", "JACCARD", "MHJACCARD"];

/** Every bound of 5.6 that a request meets before it is sent, and the result bounds results.ts applies. */
export const MILVUS_BOUNDS = {
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
  /** Milvus refuses a sparse index of 2^32 - 1 or more (R45 F18). */
  sparseIndexBound: 4_294_967_295,
  minDenseDimension: 2,
  maxDenseDimension: 32_768,
  maxBinaryDimension: 262_144,
  maxRrfK: 16_384,
  resultBudgetBytes: 8_388_608,
  stringCellUnits: 65_536,
} as const;

/** The consistency levels Studio sends (R40 M24). */
export const MILVUS_CONSISTENCY_LEVELS: readonly string[] = ["Strong", "Bounded", "Eventually"];

/** The levels the vendor documents and Studio refuses, each with its reason (R40 F8). */
export const MILVUS_REFUSED_CONSISTENCY: Readonly<Record<string, string>> = {
  Session:
    "consistencyLevel Session is refused: Studio holds no write timestamp, so Session reads no newer data than Eventually.",
  Customized: "consistencyLevel Customized is refused: it needs a guarantee timestamp, which Studio does not send.",
};

/** The keys only a newer server honours; versions.ts holds the gates and request.ts applies them on the server. */
export const MILVUS_VERSION_GATED_KEYS: readonly {
  readonly op: MilvusOp;
  readonly key: string;
  readonly gate: MilvusVersionGate;
}[] = [{ op: "entities/query", key: "orderByFields", gate: "orderByFields" }];

/** Keys at any depth of searchParams and rerank.params that can name a service (E34). Compared case-insensitively. */
export const MILVUS_ENDPOINT_KEYS: readonly string[] = ["endpoint", "url", "provider", "credential", "api_key"];

export function endpointKeySentence(path: string): string {
  return `${path} is refused in every release: a key that can name a service, a model provider or a credential never reaches Milvus from Studio.`;
}

/** Routes that change what the server holds in memory: the Operations controls run them, never the console (E9). */
const MILVUS_OPERATIONS_ROUTES: readonly string[] = [
  "collections/load",
  "collections/release",
  "collections/refresh_load",
];

/** Documented routes that write entities. */
const MILVUS_WRITE_ROUTES: readonly string[] = ["entities/insert", "entities/upsert", "entities/delete"];

/** The refusal of a route the table does not hold, with the generated list of the routes it does (5.4). */
export function routeRefusalSentence(route: string, routeList: string): string {
  if (MILVUS_OPERATIONS_ROUTES.includes(route)) {
    return `${route} changes what Milvus holds in memory and does not run from the console: an admin loads and releases a collection from the Operations controls.`;
  }
  if (MILVUS_WRITE_ROUTES.includes(route)) {
    return `${route} is not available in this version of the Milvus provider, which reads only. Studio runs:\n${routeList}`;
  }
  return `Studio does not run POST /v2/vectordb/${route}; it runs:\n${routeList}`;
}

/** An unknown key's refusal, naming the route and the keys it takes. */
export function unknownKeySentence(where: string, key: string, accepted: readonly string[]): string {
  const takes = accepted.length === 0 ? "it takes no key" : `it takes ${accepted.join(", ")}`;
  return `${where} does not take ${key}: Studio refuses a key it does not know rather than let Milvus drop it, and ${takes}.`;
}
