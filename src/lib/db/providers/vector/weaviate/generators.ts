/**
 * What a tree click and Generate Request write for a Weaviate collection (#1566 spec 6.4), read through
 * `DIALECT_GENERATORS.weaviate` in `src/lib/query-generators.ts`.
 *
 * The click runs at once: `GET /v1/objects` of the collection's first 50 objects. The generator is handed the path
 * and the columns, which carry no tenancy, and a click never names a tenant, so on a multi-tenant collection phase
 * 1 refuses the click with no call and names the request that lists its tenants and which are HOT (spec W6).
 * Generate Request opens without running: a near-vector search
 * over the first vector the columns declare with the shared probe vector when its dimension is known, then a BM25
 * search and an aggregate count as comments; when no object has shown the dimension, the BM25 search is the request
 * and the near-vector search a comment, since a guessed length is a server error.
 *
 * A collection name reaches the text only through `encodeURIComponent` in the request line, which the console
 * decodes back, and a vector name through `JSON.stringify`. Pure and browser-safe.
 */
import { toJsonText } from "@/lib/db/console/tagged-json";
import { type ProbeVector, probeVector } from "@/lib/db/vector/probe";
import type { ColumnSchema } from "@/lib/types";

/** The rows the tree click reads. */
const WEAVIATE_CLICK_LIMIT = 50;
/** The hits Generate Request asks for, Weaviate's own default written out. */
const WEAVIATE_GENERATED_LIMIT = 10;

const VECTOR_TYPE = /^Vector\((\d+|\?),/;

function collectionOf(path: readonly string[]): string {
  return encodeURIComponent(path[path.length - 1]);
}

/** The tree click: the collection's first objects. */
export function weaviateTableQuery(path: readonly string[]): string {
  return `GET /v1/objects?class=${collectionOf(path)}&limit=${WEAVIATE_CLICK_LIMIT}`;
}

interface DeclaredVector {
  readonly name: string;
  readonly dimension: number | null;
  readonly typeText: string;
}

function declaredVectors(columns: readonly ColumnSchema[]): readonly DeclaredVector[] {
  return columns.flatMap((column) => {
    if (column.name !== "$vector" && !column.name.startsWith("$vector.")) return [];
    const match = VECTOR_TYPE.exec(column.type);
    // A length of 0 is no length the probe can write, so it reads as unknown, as `?` does.
    const dimension = match === null || match[1] === "?" || match[1] === "0" ? null : Number(match[1]);
    const name = column.name === "$vector" ? "" : column.name.slice("$vector.".length);
    return [{ name, dimension, typeText: column.type }];
  });
}

function vectorText(dimension: number): string {
  const probe = probeVector({ name: "", kind: "dense", dtype: "float32", dimension }) as ProbeVector;
  const values = probe.kind === "dense" ? probe.values : [];
  return `[${values.map(toJsonText).join(", ")}]`;
}

/** Generate Request: a near-vector search over the first vector, then the other searches as comments. */
export function weaviateSelectQuery(path: readonly string[], columns: readonly ColumnSchema[]): string {
  const collection = collectionOf(path);
  const vectors = declaredVectors(columns);
  const keyword = [
    `// A keyword search: POST /v1/search/${collection}/bm25 {"query": "your words", "limit": ${WEAVIATE_GENERATED_LIMIT}}`,
    `// A count: POST /v1/aggregate/${collection} {}`,
  ];
  const chosen = vectors[0];
  if (chosen === undefined) {
    return [
      `// Collection ${JSON.stringify(path[path.length - 1])} declares no vector to search.`,
      `POST /v1/search/${collection}/bm25`,
      `{"query": "your words", "limit": ${WEAVIATE_GENERATED_LIMIT}}`,
    ].join("\n");
  }
  const target = chosen.name === "" ? "" : `"targetVector": ${JSON.stringify(chosen.name)}, `;
  const others = vectors
    .slice(1)
    .map((other) => `// Also in this collection: vector ${JSON.stringify(other.name)}, ${other.typeText}`);
  if (chosen.dimension === null) {
    // No length to write a probe of: a near-vector search sent with a guessed one is a server error, so the request
    // that runs is the keyword search, and the vector search waits in a comment for the user's numbers.
    return [
      `// A vector search needs a query vector of ${chosen.typeText}; no object has shown its length yet, so a keyword search runs instead:`,
      `// POST /v1/search/${collection}/near-vector {"vector": [your numbers], ${target}"limit": ${WEAVIATE_GENERATED_LIMIT}, "returnMetadata": ["distance"]}`,
      ...others,
      keyword[1],
      `POST /v1/search/${collection}/bm25`,
      `{"query": "your words", "limit": ${WEAVIATE_GENERATED_LIMIT}}`,
    ].join("\n");
  }
  return [
    `// Replace vector with your query vector: ${chosen.typeText}`,
    ...others,
    ...keyword,
    `POST /v1/search/${collection}/near-vector`,
    `{"vector": ${vectorText(chosen.dimension)}, ${target}"limit": ${WEAVIATE_GENERATED_LIMIT}, "returnMetadata": ["distance"]}`,
  ].join("\n");
}
