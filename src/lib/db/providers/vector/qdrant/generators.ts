/**
 * What a tree click and Generate Command write for a Qdrant collection (vector-family spec 6.7), read through
 * `DIALECT_GENERATORS.qdrant` in `src/lib/query-generators.ts`.
 *
 * The click runs at once: a scroll of the collection's first 100 points with their payloads and without vectors,
 * an explicit limit, so the absent-limit rule does not apply. Generate Command opens without running: a query over
 * the collection's first dense vector with the shared probe vector, a comment naming the vector and its type, and
 * one comment line for every other vector; with no dense vector, the first multivector gets a one-row matrix and
 * the first sparse vector `{"indices": [0], "values": [1.0]}`.
 *
 * A name reaches the text only where it cannot leave its place: a collection name through `encodeURIComponent` in
 * the request line, which the console decodes back, and a vector name through `JSON.stringify` in a comment or a
 * string, so a line break in a name stays an escape. Every probe number is written by `toJsonText`, so a float
 * element is a double and an index an integer. Pure and browser-safe.
 */
import { taggedNumber, toJsonText } from "@/lib/db/console/tagged-json";
import type { VectorTarget } from "@/lib/db/vector/dense";
import { type ProbeVector, probeVector } from "@/lib/db/vector/probe";
import type { ColumnSchema } from "@/lib/types";
import { vectorNameOfColumn, vectorTargetOfType } from "./type-spelling";

/** The rows the tree click reads, the first page of the approved design. */
const QDRANT_CLICK_LIMIT = 100;
/** The hits Generate Command asks for, Qdrant's documented default written out. */
const QDRANT_GENERATED_QUERY_LIMIT = 10;

function collectionOf(path: readonly string[]): string {
  return path[path.length - 1];
}

function collectionRoute(path: readonly string[], route: string): string {
  return `POST /collections/${encodeURIComponent(collectionOf(path))}/${route}`;
}

/** The tree click: a scroll of the first 100 points, payloads and no vectors. */
export function qdrantTableQuery(path: readonly string[]): string {
  return `${collectionRoute(path, "points/scroll")}\n{"limit": ${QDRANT_CLICK_LIMIT}, "with_payload": true, "with_vector": false}`;
}

interface DeclaredVector {
  readonly target: VectorTarget;
  readonly typeText: string;
}

function declaredVectors(columns: readonly ColumnSchema[]): readonly DeclaredVector[] {
  return columns.flatMap((column) => {
    const name = vectorNameOfColumn(column.name);
    const target = name === null ? null : vectorTargetOfType(name, column.type);
    return target === null ? [] : [{ target, typeText: column.type }];
  });
}

function vectorLabel({ target, typeText }: DeclaredVector): string {
  return `${target.name === "" ? "the unnamed vector" : `vector ${JSON.stringify(target.name)}`}, ${typeText}`;
}

/**
 * The probe as query JSON: floats through toJsonText, sparse indices as integers. type-spelling.ts admits a size
 * from 1 to 65,536 only, so the shared probe always has one for a Qdrant vector and never answers null here.
 */
function queryText(target: VectorTarget): string {
  const probe = probeVector(target) as ProbeVector;
  const row = (values: readonly number[]) => `[${values.map(toJsonText).join(", ")}]`;
  if (probe.kind === "dense") return row(probe.values);
  if (probe.kind === "multi") return `[${probe.rows.map(row).join(", ")}]`;
  const indices = probe.vector.indices.map((index) => toJsonText(taggedNumber(String(index))));
  return `{"indices": [${indices.join(", ")}], "values": ${row(probe.vector.values)}}`;
}

/** Generate Command: a query over the collection's first dense vector, or the first multivector, or the first sparse one. */
export function qdrantSelectQuery(path: readonly string[], columns: readonly ColumnSchema[]): string {
  const vectors = declaredVectors(columns);
  const chosen =
    vectors.find((vector) => vector.target.kind === "dense") ??
    vectors.find((vector) => vector.target.kind === "multi") ??
    vectors.find((vector) => vector.target.kind === "sparse");
  if (chosen === undefined) {
    return `// Collection ${JSON.stringify(collectionOf(path))} declares no vector to search.`;
  }
  const others = vectors
    .filter((vector) => vector !== chosen)
    .map((vector) => `// Also in this collection: ${vectorLabel(vector)}`);
  const query = queryText(chosen.target);
  const using = chosen.target.name === "" ? "" : `"using": ${JSON.stringify(chosen.target.name)}, `;
  return [
    `// Replace query with your vector: ${vectorLabel(chosen)}`,
    ...others,
    collectionRoute(path, "points/query"),
    `{"query": ${query}, ${using}"limit": ${QDRANT_GENERATED_QUERY_LIMIT}, "with_payload": true}`,
  ].join("\n");
}
