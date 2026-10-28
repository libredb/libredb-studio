/**
 * Cypher generators (spec 6.5, E11, SR5).
 *
 * Pure, and shipped to the browser. A tree click on a node label or a relationship type writes a
 * bounded sample read; every name goes through `quoteCypherName` and the limit is a literal
 * integer, so the output lexes as one statement and passes the read policy as allowed. Indexes and
 * constraints have no generator in v1.
 */
import { parseGraphObjectSegment } from "../objects";
import { quoteCypherName } from "./quote";
import { objectSegment } from "@/lib/db/query-generators/shared";
import type { LanguageGenerators } from "@/lib/db/query-generators/types";

export const GRAPH_SAMPLE_LIMIT = 100;

function limitOf(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`A Cypher sample limit must be a positive safe integer; received ${limit}`);
  }
  return limit;
}

/** `MATCH (n:\`Label\`) RETURN n LIMIT 100` */
export function cypherSelectLabel(label: string, limit: number = GRAPH_SAMPLE_LIMIT): string {
  return `MATCH (n:${quoteCypherName(label)}) RETURN n LIMIT ${limitOf(limit)}`;
}

/** `MATCH (a)-[r:\`TYPE\`]->(b) RETURN a, r, b LIMIT 100` */
export function cypherSelectRelationship(type: string, limit: number = GRAPH_SAMPLE_LIMIT): string {
  return `MATCH (a)-[r:${quoteCypherName(type)}]->(b) RETURN a, r, b LIMIT ${limitOf(limit)}`;
}

/** From a kind-qualified path segment; undefined for an index, a constraint or an unknown segment (SR5). */
export function cypherForSegment(segment: string, limit?: number): string | undefined {
  const parsed = parseGraphObjectSegment(segment);
  if (parsed?.kind === "label") return cypherSelectLabel(parsed.name, limit);
  if (parsed?.kind === "relationship_type") return cypherSelectRelationship(parsed.name, limit);
  return undefined;
}

/**
 * The Cypher language's generators (Neo4j spec 6.5, SR5), collected as its row by `LANGUAGE_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. A label or a relationship type is addressed by its kind-qualified segment, so
 * the two of one name never read each other's rows: a label reads a bounded sample of its nodes and a relationship
 * type its relationships with their ends, each name backticked. Without this row a tree click would auto-execute
 * `SELECT * FROM ...`. An index or a constraint has no generator in v1 and no click action (role `config`), so its
 * segment writes no statement. Generate Query writes the click's read, which keeps its own `LIMIT 100`; the columns
 * are not spelled, because a node is returned whole, its properties in one cell. Every name is backticked, a backtick
 * doubled, as the generators do.
 */
export const CYPHER_GENERATORS: LanguageGenerators = Object.freeze<LanguageGenerators>({
  table: (path: readonly string[]) => cypherForSegment(objectSegment(path)) ?? "",
  select: (path: readonly string[]) => cypherForSegment(objectSegment(path)) ?? "",
  quote: (name: string) => quoteCypherName(name),
});
