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

import type { ColumnSchema, IndexSchema, TableRelations, TableSchema } from "@/lib/types";
import { COUCHBASE_DEFAULT_SCOPE, keyspaceDisplayName, keyspacePath } from "./keyspace";
import type { CouchbaseRow, CouchbaseTransport, Keyspace } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/** Collection every bucket has, and the one a bucket-level catalog row means. */
const DEFAULT_COLLECTION = "_default";

/** Documents INFER samples per collection. Mirrors the MongoDB provider. */
const INFER_SAMPLE_SIZE = 100;

/** Property name INFER uses for document metadata rather than a real field. */
const META_PROPERTY = "~meta";

/** Type reported for a property whose INFER entry names none. */
const UNKNOWN_TYPE = "unknown";

/** Name for an index row that carries none, mirroring the MongoDB provider. */
const UNKNOWN_INDEX_NAME = "unknown";

/** How SQL++ addresses the document key a primary index is built on. */
const DOCUMENT_KEY_EXPRESSION = "META().id";

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

/**
 * Collections of the pinned bucket.
 *
 * The LEFT JOIN is deliberate. `system:scopes` does not list `_default` on
 * Server 8.0.2, so an inner join silently drops every collection in the default
 * scope. The second predicate is equally deliberate: the bucket-level row
 * (name = bucket, no `bucket`/`scope` fields) IS the pre-collections default
 * collection, and dropping it would hide every document written before scopes
 * existed.
 */
const COLLECTION_LIST_SQL = [
  "SELECT k.`bucket` AS bucket_name, k.`scope` AS scope_name, k.name AS collection_name",
  "FROM system:keyspaces AS k",
  "LEFT JOIN system:scopes AS s ON k.`bucket` = s.`bucket` AND k.`scope` = s.name",
  "WHERE k.`bucket` = $1 OR (k.`bucket` IS MISSING AND k.name = $1)",
  "ORDER BY scope_name, collection_name",
].join(" ");

/** Indexes of the pinned bucket, aliased onto the same row shape as above. */
const INDEX_LIST_SQL = [
  "SELECT i.name AS index_name, i.bucket_id AS bucket_name, i.scope_id AS scope_name,",
  "i.keyspace_id AS collection_name, i.index_key AS index_key, i.is_primary AS is_primary",
  "FROM system:indexes AS i",
  "WHERE i.bucket_id = $1 OR (i.bucket_id IS MISSING AND i.keyspace_id = $1)",
  "ORDER BY scope_name, collection_name, index_name",
].join(" ");

/** A single backtick-quoted identifier, with embedded backticks doubled. */
const QUOTED_IDENTIFIER = /^`((?:[^`]|``)*)`$/;

// ============================================================================
// Types
// ============================================================================

/** A collection and the name the flat schema explorer shows for it. */
export interface CouchbaseCollection {
  keyspace: Keyspace;
  displayName: string;
}

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

/**
 * Catalog row -> keyspace, shared by both catalogs because their projections
 * are aliased onto the same field names. Returns null for a row that cannot be
 * placed, so one malformed row cannot take the whole listing down.
 */
function resolveKeyspace(bucket: string, row: CouchbaseRow): Keyspace | null {
  if (typeof row.bucket_name !== "string") {
    return { bucket, scope: COUCHBASE_DEFAULT_SCOPE, collection: DEFAULT_COLLECTION };
  }
  if (typeof row.collection_name !== "string") return null;
  return {
    bucket,
    scope: typeof row.scope_name === "string" ? row.scope_name : COUCHBASE_DEFAULT_SCOPE,
    collection: row.collection_name,
  };
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
function unquoteIndexKey(key: string): string {
  const match = QUOTED_IDENTIFIER.exec(key);
  return match ? match[1].replaceAll("``", "`") : key;
}

function toIndexSchema(row: CouchbaseRow): IndexSchema {
  const isPrimary = row.is_primary === true;
  const keys = Array.isArray(row.index_key)
    ? row.index_key.filter((key): key is string => typeof key === "string").map(unquoteIndexKey)
    : [];

  return {
    name: typeof row.index_name === "string" ? row.index_name : UNKNOWN_INDEX_NAME,
    // A primary index carries no index_key: it keys the document key itself.
    columns: isPrimary && keys.length === 0 ? [DOCUMENT_KEY_EXPRESSION] : keys,
    // No secondary GSI enforces uniqueness; only the document key is unique.
    unique: isPrimary,
  };
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

/** Collections of the pinned bucket, with their flat display names. */
export async function listCollections(transport: CouchbaseTransport, bucket: string): Promise<CouchbaseCollection[]> {
  const result = await transport.query(COLLECTION_LIST_SQL, { args: [bucket], timeoutMs: CATALOG_TIMEOUT_MS });

  const collections: CouchbaseCollection[] = [];
  for (const row of result.rows) {
    const keyspace = resolveKeyspace(bucket, row);
    if (!keyspace) continue;
    collections.push({ keyspace, displayName: keyspaceDisplayName(keyspace.scope, keyspace.collection) });
  }
  return collections;
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
 * Fast structural schema: every collection of the bucket, with inferred
 * columns. Indexes are left to getSchemaRelations() so their cost never blocks
 * the tree, exactly as in the SQL providers.
 */
export async function getSchemaList(transport: CouchbaseTransport, bucket: string): Promise<TableSchema[]> {
  const collections = await listCollections(transport, bucket);
  const columns = await mapWithConcurrency(collections, INFER_CONCURRENCY, (collection) =>
    inferColumns(transport, collection.keyspace),
  );

  return collections.map((collection, index) => ({
    name: collection.displayName,
    columns: columns[index],
    indexes: [],
    foreignKeys: [],
  }));
}

/**
 * Index lists keyed by display name.
 *
 * Failure propagates on purpose. An empty index list is the signal that a
 * collection has no usable index (decision 6), so degrading a failed catalog
 * read to empty would fabricate that signal for the whole bucket.
 */
export async function getSchemaRelations(transport: CouchbaseTransport, bucket: string): Promise<TableRelations[]> {
  const result = await transport.query(INDEX_LIST_SQL, { args: [bucket], timeoutMs: CATALOG_TIMEOUT_MS });

  const byCollection = new Map<string, IndexSchema[]>();
  for (const row of result.rows) {
    const keyspace = resolveKeyspace(bucket, row);
    if (!keyspace) continue;
    const displayName = keyspaceDisplayName(keyspace.scope, keyspace.collection);
    const indexes = byCollection.get(displayName) ?? [];
    indexes.push(toIndexSchema(row));
    byCollection.set(displayName, indexes);
  }

  return [...byCollection.entries()].map(([name, indexes]) => ({ name, foreignKeys: [], indexes }));
}
