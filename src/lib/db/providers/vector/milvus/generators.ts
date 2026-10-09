/**
 * The Milvus texts the object tree writes: the tree click's query, run on the user's behalf,
 * and Generate Command's search, written into a tab and not run. `DIALECT_GENERATORS.milvus` in
 * `src/lib/query-generators.ts` names them as `table` and `select` once the type is registered.
 *
 * Pure and browser-safe. It reads the collection's path, `[database, collection]`, and the columns describeObject
 * answered, whose type spelling carries each vector field's kind and dimension (`FloatVector(8)`, read by
 * type-spelling.ts), and nothing else: `generateSelectQuery` hands a generator only the path, the columns, the
 * capabilities and the scope, and a `ColumnSchema` carries no metric, index or function parameter, so the comment
 * names no metric and the score column states it once the search runs. The probe is `probeVector()`'s, printed
 * as the shortest decimal of each float32 element, so it passes the field's own dense check; a field whose dimension
 * Studio cannot read
 * gets a comment that asks for a vector, never a probe of a wrong length.
 */
import type { VectorTarget } from "@/lib/db/vector/dense";
import { probeVector } from "@/lib/db/vector/probe";
import type { ColumnSchema } from "@/lib/types";
import { shortestFloat32 } from "./float32-text";
import { functionOfType, STRUCT_ARRAY_TYPE, vectorTargetOfType } from "./type-spelling";

/** The click's page: the REST default and etcd's first page; an empty filter needs an explicit limit. */
export const MILVUS_CLICK_LIMIT = 100;

/** Generate Command's top k. */
export const MILVUS_SEARCH_LIMIT = 10;

const ROUTE = "POST /v2/vectordb/entities/";
const FLOAT_DTYPES: ReadonlySet<string> = new Set(["float32", "float64", "float16", "bfloat16"]);

interface VectorColumn {
  readonly name: string;
  readonly type: string;
  readonly target: VectorTarget;
  /** The BM25 function that produces this sparse field, where one does. */
  readonly bm25?: string;
}

const quoted = (value: string): string => JSON.stringify(value);

/** The request's address, from the path `[database, collection]`. */
function address(path: readonly string[]): string {
  const collection = `"collectionName": ${quoted(path[path.length - 1])}`;
  return path.length >= 2 ? `"dbName": ${quoted(path[path.length - 2])}, ${collection}` : collection;
}

/**
 * The tree click: the collection's first 100 entities with an empty filter, which needs an explicit limit,
 * and no `outputFields`, which means the scalar and dynamic fields; on an unloaded collection it answers the
 * not-loaded sentence, never by loading.
 */
export function milvusTableQuery(path: readonly string[]): string {
  return `${ROUTE}query\n{${address(path)}, "filter": "", "limit": ${MILVUS_CLICK_LIMIT}}`;
}

function vectorColumns(columns: readonly ColumnSchema[]): VectorColumn[] {
  return columns.flatMap((column): VectorColumn[] => {
    const target = vectorTargetOfType(column.name, column.type);
    if (target === null) return [];
    const producer = functionOfType(column.type);
    return [
      { name: column.name, type: column.type, target, ...(producer?.type === "BM25" ? { bm25: producer.name } : {}) },
    ];
  });
}

function element(value: number, dtype: string): string {
  return String(FLOAT_DTYPES.has(dtype) ? shortestFloat32(value) : value);
}

/** `probeVector()`'s probe of one field as request JSON, or undefined where the dimension is unknown. */
export function milvusProbeText(target: VectorTarget): string | undefined {
  const probe = probeVector(target);
  if (probe === null) return undefined;
  switch (probe.kind) {
    case "dense":
      return `[[${probe.values.map((value) => element(value, target.dtype)).join(", ")}]]`;
    case "multi":
      return `[[${probe.rows.map((row) => `[${row.map((value) => element(value, target.dtype)).join(", ")}]`).join(", ")}]]`;
    case "sparse":
      return `[{${probe.vector.indices.map((index, at) => `${quoted(String(index))}: ${element(probe.vector.values[at], "float32")}`).join(", ")}}]`;
  }
}

/** A field as the comments name it: "vec, FloatVector, dim 8". */
function describedAs(vector: VectorColumn): string {
  const base = vector.type.split("(")[0];
  const { dimension, kind } = vector.target;
  return `${vector.name}, ${base}${dimension === null || kind === "sparse" ? "" : `, dim ${dimension}`}`;
}

function searchBody(
  path: readonly string[],
  annsField: string,
  data: string,
  outputs: readonly string[],
  lineBreaks: boolean,
): string {
  const separator = lineBreaks ? ",\n " : ", ";
  const fields = outputs.length === 0 ? "" : `"outputFields": [${outputs.map(quoted).join(", ")}], `;
  return `{${address(path)}, "annsField": ${quoted(annsField)}${separator}"data": ${data}${separator}${fields}"limit": ${MILVUS_SEARCH_LIMIT}}`;
}

function otherFields(vectors: readonly VectorColumn[], chosen: VectorColumn): string[] {
  return vectors
    .filter((vector) => vector !== chosen)
    .map(
      (vector) => `# Other vector field: ${describedAs(vector)}; set annsField to ${quoted(vector.name)} to search it`,
    );
}

/** A comment-only template: every vector field with a request to copy, none of which runs as written. */
function commentTemplate(
  path: readonly string[],
  vectors: readonly VectorColumn[],
  outputs: readonly string[],
): string {
  const collection = path[path.length - 1];
  const lines = [
    `# Collection ${collection} has no dense vector field whose dimension Studio can read, so this search does not run as written: copy one request below without its # marks and put your own query in data.`,
  ];
  for (const vector of vectors) {
    const data = milvusProbeText(vector.target);
    if (vector.target.kind === "sparse" && data !== undefined) {
      lines.push(
        `# ${describedAs(vector)}: a sparse vector, as a map of index to value, or as text where a BM25 function produces the field`,
        `# ${ROUTE}search`,
        `# ${searchBody(path, vector.name, data, outputs, false)}`,
        `# ${searchBody(path, vector.name, '["search text"]', outputs, false)}`,
      );
    } else {
      lines.push(
        `# ${describedAs(vector)}: ${data === undefined ? "Studio cannot read this field's dimension; write one query vector of that many elements in data" : "replace data with your query"}`,
        `# ${ROUTE}search`,
        `# ${searchBody(path, vector.name, data ?? "[[]]", outputs, false)}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Generate Command: a runnable search over the collection's first dense field with a readable dimension,
 * its probe in data and a comment naming the field, its type and its dimension, then one comment line for each other
 * vector field; else a runnable text search over a field a BM25 function produces; else a comment-only template. The
 * output fields are the scalar and dynamic fields, never a vector nor a struct array field, which may hold an
 * embedding list. Request $meta explicitly so dynamic keys are included when outputFields is present.
 */
export function milvusSelectQuery(path: readonly string[], columns: readonly ColumnSchema[]): string {
  const vectors = vectorColumns(columns);
  if (vectors.length === 0) {
    return `# Collection ${path[path.length - 1]} has no vector field, so there is nothing to search: this reads its entities.\n${milvusTableQuery(path)}`;
  }
  const outputs = columns
    .filter((column) => column.type !== STRUCT_ARRAY_TYPE && vectorTargetOfType(column.name, column.type) === null)
    .map((column) => column.name);
  const dense = vectors.find((vector) => vector.target.kind === "dense" && vector.target.dimension !== null);
  const denseData = dense === undefined ? undefined : milvusProbeText(dense.target);
  if (dense !== undefined && denseData !== undefined) {
    return [
      `# Replace data with your query vector: ${describedAs(dense)}`,
      ...otherFields(vectors, dense),
      `${ROUTE}search`,
      searchBody(path, dense.name, denseData, outputs, true),
    ].join("\n");
  }
  const text = vectors.find((vector) => vector.bm25 !== undefined);
  if (text !== undefined) {
    return [
      `# Replace the search text with your own words: ${describedAs(text)}, produced by BM25 function ${text.bm25}`,
      ...otherFields(vectors, text),
      `${ROUTE}search`,
      searchBody(path, text.name, '["search text"]', outputs, true),
    ].join("\n");
  }
  return commentTemplate(path, vectors, outputs);
}
