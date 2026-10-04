/**
 * The vector consoles' route tables as test data (vector-family spec 3.4 and 8.2), derived from two pinned sources
 * by tests/live/vector-routes.ts and committed under tests/fixtures/vector/routes/. Pure, so
 * tests/unit/db/vector/route-tables.test.ts holds every rule over small inputs.
 *
 * - Milvus: the 15 routes of the v1 console, read from a one-row-per-endpoint summary of Milvus's REST reference at
 *   v3.0.x (milvus-io/web-content, commit 78d9def7), pinned by its sha256: method, path, and each body key with its
 *   type and whether it is required.
 * - Qdrant: the 17 operations of the v1 console and the full v1.19.1 table, read from the OpenAPI document at tag
 *   v1.19.1, pinned by its sha256: method, path, path parameters, query keys, and the body's presence and schema.
 *
 * The Milvus and Qdrant providers each add a test that their routes.ts equals the matching file route for route.
 */
import { createHash } from "node:crypto";

export const MILVUS_TSV_SHA256 = "e85963fdb0aaf506f89ba0cc3825fbd480d61c671fa08b7ef7f6245acdabb723";
export const QDRANT_SPEC_SHA256 = "eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a";
export const MILVUS_PREFIX = "/v2/vectordb/";

/** The Milvus console's v1 routes, in the order its route table lists them. */
export const MILVUS_V1_ROUTES = [
  "databases/list",
  "databases/describe",
  "collections/list",
  "collections/describe",
  "collections/get_stats",
  "collections/get_load_state",
  "partitions/list",
  "indexes/list",
  "indexes/describe",
  "aliases/list",
  "aliases/describe",
  "entities/query",
  "entities/get",
  "entities/search",
  "entities/hybrid_search",
] as const;

/** The Qdrant console's 17 v1 read operations, by OpenAPI operationId. */
export const QDRANT_V1_OPERATIONS = [
  "root",
  "get_collections",
  "get_collection",
  "collection_exists",
  "get_collections_aliases",
  "get_collection_aliases",
  "get_points",
  "get_point",
  "scroll_points",
  "count_points",
  "query_points",
  "query_batch_points",
  "query_points_groups",
  "facet",
  "get_optimizations",
  "list_snapshots",
  "collection_cluster_info",
] as const;

/** The query keys v1 accepts, on the routes whose OpenAPI declares them. */
export const QDRANT_V1_QUERY_KEYS = ["consistency", "timeout", "with", "completed_limit"] as const;

export interface BodyKey {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface FixtureRoute {
  readonly method: string;
  /** The full path, the dialect prefix included, with Qdrant's path parameters as `{name}`. */
  readonly path: string;
  readonly op: string;
  readonly params: Readonly<Record<string, "name" | "point-id">>;
  readonly query: readonly string[];
  readonly body: "none" | "optional" | "required";
  /** Milvus: every body key the reference names. */
  readonly bodyKeys?: readonly BodyKey[];
  /** Qdrant: the OpenAPI schema the body references, or null where it references none. */
  readonly bodySchema?: string | null;
}

export interface RouteTable {
  readonly $generated: {
    readonly by: string;
    readonly source: string;
    readonly sha256: string;
    readonly scope: "v1" | "full";
  };
  readonly engine: "milvus" | "qdrant";
  readonly prefix: string;
  readonly routes: readonly FixtureRoute[];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function bodyKeys(cell: string, route: string): BodyKey[] {
  if (cell.trim() === "") return [];
  return cell.split(/,\s*/).map((entry) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\*?):(.+)$/.exec(entry.trim());
    if (match === null) throw new Error(`${route}: cannot read the body key "${entry}"`);
    return { name: match[1], type: match[3], required: match[2] === "*" };
  });
}

/** The 15 v1 routes, in table order; a route missing from the summary, or listed twice, is refused. */
export function milvusRoutesFromTsv(tsv: string): FixtureRoute[] {
  const rows = new Map<string, string[]>();
  for (const line of tsv.split("\n")) {
    const cells = line.split("\t");
    const target = cells[1] ?? "";
    if (cells.length < 4 || !target.startsWith(MILVUS_PREFIX)) continue;
    const route = target.slice(MILVUS_PREFIX.length);
    if (!(MILVUS_V1_ROUTES as readonly string[]).includes(route)) continue;
    if (rows.has(route)) throw new Error(`the summary lists ${MILVUS_PREFIX}${route} twice`);
    rows.set(route, cells);
  }
  return MILVUS_V1_ROUTES.map((route) => {
    const cells = rows.get(route);
    if (cells === undefined) throw new Error(`the summary has no row for ${MILVUS_PREFIX}${route}`);
    if (cells[0] !== "POST") throw new Error(`${MILVUS_PREFIX}${route} is ${cells[0]} in the summary, not POST`);
    const keys = bodyKeys(cells[3], route);
    return {
      method: "POST",
      path: `${MILVUS_PREFIX}${route}`,
      op: route,
      params: {},
      query: [],
      body: keys.some((key) => key.required) ? "required" : "optional",
      bodyKeys: keys,
    };
  });
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly parameters?: readonly { readonly name: string; readonly in: string }[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: Readonly<Record<string, { readonly schema?: { readonly $ref?: string } }>>;
  };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];

/**
 * Every operation of the document, in its own order, or the 17 v1 operations with only the v1 query keys; a v1
 * operation the document lacks or repeats is refused.
 */
export function qdrantRoutesFromOpenApi(document: unknown, scope: "v1" | "full"): FixtureRoute[] {
  const paths = (document as { paths?: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>> }).paths;
  if (paths === undefined) throw new Error("the OpenAPI document has no paths");
  const routes: FixtureRoute[] = [];
  for (const [template, operations] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const op = operation.operationId;
      if (op === undefined) throw new Error(`${method.toUpperCase()} ${template} has no operationId`);
      if (scope === "v1" && !(QDRANT_V1_OPERATIONS as readonly string[]).includes(op)) continue;
      const parameters = operation.parameters ?? [];
      const query = parameters.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name);
      const reference = operation.requestBody?.content?.["application/json"]?.schema?.$ref;
      routes.push({
        method: method.toUpperCase(),
        path: template,
        op,
        params: Object.fromEntries(
          parameters
            .filter((parameter) => parameter.in === "path")
            .map((parameter) => [parameter.name, parameter.name === "id" ? "point-id" : "name"]),
        ),
        query:
          scope === "v1" ? query.filter((key) => (QDRANT_V1_QUERY_KEYS as readonly string[]).includes(key)) : query,
        body:
          operation.requestBody === undefined
            ? "none"
            : operation.requestBody.required === true
              ? "required"
              : "optional",
        bodySchema: reference === undefined ? null : reference.replace("#/components/schemas/", ""),
      });
    }
  }
  if (scope === "v1") {
    const found = routes.map((route) => route.op).sort();
    const wanted = [...QDRANT_V1_OPERATIONS].sort();
    if (found.join(",") !== wanted.join(",")) {
      throw new Error(`the OpenAPI document lacks or repeats a v1 operation: found ${found.join(", ")}`);
    }
  }
  return routes;
}
