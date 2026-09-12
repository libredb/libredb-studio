/**
 * Couchbase schema introspection (issue #262, decision 10)
 *
 * Three catalog reads, all through the transport seam so this file stays free
 * of any wire vocabulary:
 *
 * - `system:keyspaces` (joined with `system:scopes`) lists the collections of
 *   the pinned bucket.
 * - `INFER` samples documents per collection to produce columns. Couchbase is
 *   schemaless, so the column list is statistical: it describes the sample, not
 *   a declared shape.
 * - `system:indexes` supplies the index list. Foreign keys are always empty -
 *   Couchbase has none and none are invented.
 *
 * Two rules the live cluster forced, both load-bearing:
 *
 * 1. `bucket` and `scope` are reserved words in SQL++. Unquoted, a projection
 *    over `system:keyspaces` fails with error 3000 (verified on Server 8.0.2),
 *    so every occurrence is backtick-quoted.
 * 2. INFER fails on a collection the user cannot read AND on an empty one
 *    (error 7014, "No documents found, unable to infer schema"). Both are
 *    ordinary states, so a failed INFER yields empty columns and never fails
 *    the tree. The concurrency bound - not truncation of the collection list -
 *    is what keeps the cost of schema loading in hand.
 */

import type { ColumnSchema } from "@/lib/types";
import { keyspacePath } from "./keyspace";
import type { CouchbaseRow, CouchbaseTransport, Keyspace } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/** Documents INFER samples per collection. Mirrors the MongoDB provider. */
const INFER_SAMPLE_SIZE = 100;

/** Property name INFER uses for document metadata rather than a real field. */
const META_PROPERTY = "~meta";

/** Type reported for a property whose INFER entry names none. */
const UNKNOWN_TYPE = "unknown";

/** How SQL++ addresses the document key a primary index is built on. */
export const DOCUMENT_KEY_EXPRESSION = "META().id";

/**
 * Column carrying the document key. It matches the alias the generated
 * `SELECT META(h).id AS __id, h.*` projection uses (decision 5), so the schema
 * tree and the result grid name the key the same way.
 */
export const COUCHBASE_DOCUMENT_KEY_COLUMN = "__id";

/** Concurrent INFER statements. Bounds schema-load cost without truncating. */
export const INFER_CONCURRENCY = 4;

/** Per-INFER server-side timeout: one unreadable collection cannot stall the tree. */
export const INFER_TIMEOUT_MS = 5000;

/** Server-side timeout for the `system:*` catalog reads. */
export const CATALOG_TIMEOUT_MS = 15000;

/** A single backtick-quoted identifier, with embedded backticks doubled. */
const QUOTED_IDENTIFIER = /^`((?:[^`]|``)*)`$/;

// ============================================================================
// Types
// ============================================================================

/** What the sampled documents say about one field. */
interface FieldStats {
  types: Set<string>;
  nullable: boolean;
  flavourCount: number;
}

// ============================================================================
// Pure helpers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Type names an INFER property carries: one string, or a JSON-schema array. */
function propertyTypes(property: Record<string, unknown>): string[] {
  if (typeof property.type === "string") return [property.type];
  if (Array.isArray(property.type)) {
    const names = property.type.filter((entry): entry is string => typeof entry === "string");
    if (names.length > 0) return names;
  }
  return [UNKNOWN_TYPE];
}

/** Render a union of observed types the way the MongoDB provider does. */
function formatType(types: Set<string>): string {
  const names = [...types].sort((a, b) => a.localeCompare(b));
  return names.length === 1 ? names[0] : `mixed(${names.join("|")})`;
}

/** True when the field is missing from part of the flavour it belongs to. */
function isPartial(property: Record<string, unknown>): boolean {
  return typeof property["%docs"] === "number" && property["%docs"] < 100;
}

/** Document key type from the `~meta` pseudo-property. */
function documentKeyType(meta: Record<string, unknown>): string {
  const id = asRecord(asRecord(meta.properties)?.id);
  return id ? formatType(new Set(propertyTypes(id))) : "string";
}

/**
 * Flatten INFER flavours into columns.
 *
 * Every flavour is unioned: a collection holding two document shapes reports
 * two flavours, and taking only the first would drop every field the other one
 * carries. A field missing from some flavour is nullable for the same reason a
 * field with %docs below 100 is - part of the collection does not have it.
 */
function columnsFromFlavours(flavours: unknown[]): ColumnSchema[] {
  const fields = new Map<string, FieldStats>();
  let keyType: string | null = null;
  let flavourCount = 0;

  for (const entry of flavours) {
    const properties = asRecord(asRecord(entry)?.properties);
    if (!properties) continue;
    flavourCount += 1;

    for (const [name, rawProperty] of Object.entries(properties)) {
      const property = asRecord(rawProperty);
      if (!property) continue;

      if (name === META_PROPERTY) {
        keyType = documentKeyType(property);
        continue;
      }

      const stats = fields.get(name) ?? { types: new Set<string>(), nullable: false, flavourCount: 0 };
      for (const type of propertyTypes(property)) stats.types.add(type);
      stats.nullable = stats.nullable || isPartial(property) || stats.types.has("null");
      stats.flavourCount += 1;
      fields.set(name, stats);
    }
  }

  const columns: ColumnSchema[] = [...fields.entries()]
    .map(([name, stats]) => ({
      name,
      type: formatType(stats.types),
      nullable: stats.nullable || stats.flavourCount < flavourCount,
      isPrimary: false,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (keyType !== null) {
    columns.unshift({ name: COUCHBASE_DOCUMENT_KEY_COLUMN, type: keyType, nullable: false, isPrimary: true });
  }
  return columns;
}

/** Strip the quoting Couchbase applies to a plain index key identifier. */
export function unquoteIndexKey(key: string): string {
  const match = QUOTED_IDENTIFIER.exec(key);
  return match ? match[1].replaceAll("``", "`") : key;
}

/**
 * Run `worker` over `items`, at most `limit` at a time, preserving order.
 * Results are written by index, so no item is dropped and none is reordered.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const mapped = new Array<R>(items.length);
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      mapped[index] = await worker(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return mapped;
}

// ============================================================================
// Introspection
// ============================================================================

/** The INFER statement for one collection. The path is quoted, never inlined raw. */
function inferStatement(keyspace: Keyspace): string {
  return `INFER ${keyspacePath(keyspace)} WITH {"sample_size": ${INFER_SAMPLE_SIZE}}`;
}

/**
 * Statistical columns for one collection.
 *
 * A rejected INFER yields no columns rather than an error: the two common
 * causes - the user lacks SELECT on the collection, and the collection is empty
 * (error 7014) - are both states the explorer should render, not fail on.
 */
export async function inferColumns(transport: CouchbaseTransport, keyspace: Keyspace): Promise<ColumnSchema[]> {
  let flavours: unknown;
  try {
    const result = await transport.query(inferStatement(keyspace), { timeoutMs: INFER_TIMEOUT_MS });
    flavours = result.rows[0];
  } catch {
    return [];
  }
  return Array.isArray(flavours) ? columnsFromFlavours(flavours) : [];
}

/**
 * Columns for MANY keyspaces, at most `INFER_CONCURRENCY` statements in flight (#789).
 *
 * One INFER per keyspace and not one statement for all of them, and that is a measurement
 * on Server 8.0.2 rather than a preference. `INFER a, b` is a syntax error and `INFER`
 * against a scope is refused ("only 2 or 4 parts are valid"), so the only combined form is
 * a `WITH`/`UNION ALL` over INFER subqueries - which the parser does accept - and that
 * form fails ENTIRELY on the first empty keyspace with error 7014. An empty collection is
 * an ordinary state here, so a combined statement would cost a whole folder its columns
 * whenever one collection held no documents.
 *
 * Answers are written by index, so a keyspace whose INFER was refused carries `[]` in its
 * own slot rather than shifting another keyspace's columns onto it.
 */
export async function inferColumnsEach(
  transport: CouchbaseTransport,
  keyspaces: readonly Keyspace[],
): Promise<ColumnSchema[][]> {
  return await mapWithConcurrency([...keyspaces], INFER_CONCURRENCY, (keyspace) => inferColumns(transport, keyspace));
}
