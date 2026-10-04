/**
 * The part of Qdrant's OpenAPI document the v1 console is held to (vector-family spec 6.4, QE10, QE21), derived by a
 * pure function so tests/unit/db/qdrant/openapi-extract.test.ts holds its rules over small documents.
 *
 * The source is docs/redoc/master/openapi.json of github.com/qdrant/qdrant at tag v1.19.1, pinned by its sha256 and
 * never by `info.version`, which reads `master`. The extract keeps, for each of the 17 operations, its method, path,
 * path parameters, query parameters and the schema its request body references, and every schema a request body
 * reaches, with its prose removed: the key sets a closed console refuses an unknown key by, `Filter` and each
 * `Condition` variant among them. tests/live/qdrant-evidence.ts writes it to tests/fixtures/qdrant/openapi-extract.json.
 */

/**
 * The sha256 of the pinned document (QE21).
 * The type annotation is deliberate: without it, the scanner of committed credentials takes this public digest for one.
 */
export const QDRANT_OPENAPI_SHA256: string = "eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a";
export const QDRANT_OPENAPI_SOURCE = "github.com/qdrant/qdrant docs/redoc/master/openapi.json at tag v1.19.1";

/** The 17 operation ids of the v1 console (decision QD3). */
export const QDRANT_V1_OPERATION_IDS = [
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
  "facet",
  "query_points",
  "query_batch_points",
  "query_points_groups",
  "get_optimizations",
  "list_snapshots",
  "collection_cluster_info",
] as const;

export interface ExtractedOperation {
  readonly op: string;
  readonly method: string;
  readonly path: string;
  readonly pathParameters: readonly string[];
  readonly queryParameters: readonly string[];
  /** The schema the request body references; null where the operation takes no body. */
  readonly requestBody: string | null;
  readonly requestBodyRequired: boolean;
}

export interface QdrantOpenApiExtract {
  readonly $generated: { readonly by: string; readonly source: string; readonly sha256: string };
  readonly operations: readonly ExtractedOperation[];
  /** Every schema a request body of the 17 operations reaches, by name, sorted, without its prose. */
  readonly schemas: Readonly<Record<string, unknown>>;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const PROSE_KEYS = new Set(["description", "example", "examples", "title", "externalDocs"]);
const REF_PREFIX = "#/components/schemas/";
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function isObject(value: unknown): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A schema node without its prose. A property that happens to be named like a prose key is kept. */
function withoutProse(node: Json, underProperties = false): Json {
  if (Array.isArray(node)) return node.map((item) => withoutProse(item));
  if (!isObject(node)) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => underProperties || !PROSE_KEYS.has(key))
      .map(([key, value]) => [key, withoutProse(value, !underProperties && key === "properties")]),
  );
}

function references(node: Json, found: Set<string>, schemas: { readonly [key: string]: Json }): void {
  if (Array.isArray(node)) {
    for (const item of node) references(item, found, schemas);
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      if (!value.startsWith(REF_PREFIX)) throw new Error(`the document references ${value}, outside its schemas`);
      const name = value.slice(REF_PREFIX.length);
      if (found.has(name)) continue;
      if (!Object.hasOwn(schemas, name))
        throw new Error(`the document references the schema ${name}, which it does not define`);
      found.add(name);
      references(schemas[name], found, schemas);
    } else {
      references(value, found, schemas);
    }
  }
}

function parameterNames(operation: { readonly [key: string]: Json }, place: string): string[] {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  return parameters.flatMap((parameter) =>
    isObject(parameter) && parameter.in === place && typeof parameter.name === "string" ? [parameter.name] : [],
  );
}

/** The extract of a parsed OpenAPI document. Throws, naming what is missing, when an operation of the 17 is not in it. */
export function qdrantOpenApiExtract(document: unknown, by: string): QdrantOpenApiExtract {
  if (!isObject(document) || !isObject(document.paths) || !isObject(document.components)) {
    throw new Error("the document is not an OpenAPI document with paths and components");
  }
  const schemas = document.components.schemas;
  if (!isObject(schemas)) throw new Error("the document defines no schemas");
  const wanted = new Set<string>(QDRANT_V1_OPERATION_IDS);
  const found = new Map<string, ExtractedOperation>();
  const reached = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation) || typeof operation.operationId !== "string" || !wanted.has(operation.operationId))
        continue;
      if (found.has(operation.operationId)) throw new Error(`the document declares ${operation.operationId} twice`);
      const body = isObject(operation.requestBody) ? operation.requestBody : null;
      const schema = body === null ? null : bodySchema(body, operation.operationId);
      if (body !== null) references(body, reached, schemas);
      found.set(operation.operationId, {
        op: operation.operationId,
        method: method.toUpperCase(),
        path,
        pathParameters: parameterNames(operation, "path"),
        queryParameters: parameterNames(operation, "query"),
        requestBody: schema,
        requestBodyRequired: body !== null && body.required === true,
      });
    }
  }
  const missing = QDRANT_V1_OPERATION_IDS.filter((op) => !found.has(op));
  if (missing.length > 0) throw new Error(`the document does not declare ${missing.join(", ")}`);
  return {
    $generated: { by, source: QDRANT_OPENAPI_SOURCE, sha256: QDRANT_OPENAPI_SHA256 },
    operations: QDRANT_V1_OPERATION_IDS.map((op) => found.get(op) as ExtractedOperation),
    schemas: Object.fromEntries([...reached].sort().map((name) => [name, withoutProse(schemas[name])])),
  };
}

function bodySchema(body: { readonly [key: string]: Json }, op: string): string {
  const content = isObject(body.content) ? body.content["application/json"] : undefined;
  const schema = isObject(content) && isObject(content.schema) ? content.schema.$ref : undefined;
  if (typeof schema !== "string" || !schema.startsWith(REF_PREFIX)) {
    throw new Error(`the request body of ${op} does not reference a schema`);
  }
  return schema.slice(REF_PREFIX.length);
}
