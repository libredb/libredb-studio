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
