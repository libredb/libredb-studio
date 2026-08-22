/**
 * Elasticsearch / OpenSearch schema introspection (issue #424, Phase 1)
 *
 * Turns a search cluster into the table/column shape the rest of the product
 * expects, and does it entirely through the `SearchTransport` seam: this file names
 * no endpoint, no envelope key and no product fault name, so a second transport
 * (the official client library, a test double) drives it unchanged.
 *
 * The load-bearing decision is WHERE the schema comes from. It is the MAPPING, not
 * SQL. `SELECT *` describes the statement rather than the index - measured on
 * Elasticsearch 9.1.4, an index mapping `blob` as `flattened` and `items` as
 * `nested` answers `SELECT *` with `{"columns":[],"rows":[[]]}`, i.e. a table with
 * no columns at all - and `DESCRIBE` is a SQL surface whose availability is the
 * very thing the tree must not depend on. The mapping is the index's own
 * declaration, is readable on a CLOSED index (measured), and is the same document
 * the user edits, so it is the only honest source.
 *
 * Everything below was measured on 2026-08-19 against Elasticsearch 9.1.4 (basic
 * licence, security disabled) and OpenSearch 3.8.0, on stock single nodes. The four
 * measurements that shaped the code:
 *
 * 1. **A container field breaks the WHOLE statement, not one column.** On
 *    Elasticsearch, `SELECT address FROM probe_shapes` where `address` is an object
 *    is HTTP 400, `verification_exception`, "Cannot use field [address] type
 *    [object] only its subfields"; `nested` is refused with the same wording. Since
 *    `query-generators.ts` builds its starter query by enumerating EVERY declared
 *    column, listing a container would hand the user a query that cannot run at
 *    all. Containers are therefore not columns here - see
 *    {@link SEARCH_CONTAINER_TYPES}.
 * 2. **A multi-field parent is NOT a container, and its child is not portable.**
 *    `note` mapped as `text` with a `keyword` sub-field answers `SELECT note` with
 *    the text on both products, so "has sub-fields" is the wrong test for dropping
 *    a column - the field's own TYPE is. The CHILD is a different matter: measured,
 *    Elasticsearch selects `note.keyword` fine while OpenSearch 3.8.0 refuses it in
 *    every spelling (`SemanticCheckException`, "can't resolve
 *    Symbol(namespace=FIELD_NAME, name=note.keyword) in type env"), and dynamic
 *    mapping creates one of these for EVERY text field. So multi-fields are dropped
 *    on both products by the same rule as containers, and the Elasticsearch-only
 *    loss is recorded rather than papered over: `note.keyword` is selectable there
 *    and the tree does not offer it. An OBJECT sub-field (`address.city`) selects on
 *    both and is kept.
 * 3. **Every field is nullable, and no field is a key.** A document indexed without
 *    `note` answers `SELECT note` with `null` for that row (measured), so absence is
 *    a value the surface really returns. And nothing in a mapping is unique: the only
 *    unique thing in an index is the document `_id`, which is metadata rather than a
 *    mapped field - and which Elasticsearch's SQL does not even expose ("Unknown
 *    column [_id]", measured, while OpenSearch's does).
 * 4. **A stock OpenSearch node is mostly not the user's data.** Three indices on an
 *    empty cluster, of which `.plugins-ml-config` and `top_queries-2026.08.18-74305`
 *    are the engine's own bookkeeping. Hiding them is the default; see
 *    {@link isSystemIndex}.
 *
 * Recorded limitation: a type the engine maps but its SQL surface cannot read is
 * still listed as a column, because the mapping does not say which types SQL
 * supports. Measured case: `flattened` on Elasticsearch is refused with "Cannot use
 * field [blob] with unsupported type [flattened]" while the mapping declares it like
 * any other field. Enumerating the unsupported types would be a per-version list
 * this file cannot verify, and inventing one would hide fields that a future version
 * reads perfectly well.
 */

import type { ColumnSchema, TableSchema } from "@/lib/types";
import { formatBytes } from "../../../utils/pool-manager";
import {
  type SearchErrorCategory,
  type SearchIndexInfo,
  type SearchMappingField,
  type SearchTransport,
  SearchTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * Mapping types whose value lives in the sub-fields rather than in the field.
 *
 * These are the two the engines refuse to project by name. Measured on
 * Elasticsearch: "Cannot use field [address] type [object] only its subfields" and
 * "Cannot use field [items] type [nested] only its subfields", both HTTP 400. The
 * OpenSearch SQL plugin is more permissive - it answers `SELECT address` with the
 * whole sub-document and `SELECT items` with the array (measured, HTTP 200) - and
 * that difference is deliberately NOT branched on: the seam's `dialect` may pick a
 * word, never a behaviour, and a starter query that works on one product and fails
 * on the other is worse than one that works on both. Projecting the leaves works
 * on both.
 *
 * These strings are mapping TYPE VALUES, which cross the seam as
 * `SearchMappingField.type` data - `transport.ts` names `object` in its own doc
 * comment for exactly that reason. They are not wire vocabulary: no endpoint,
 * envelope key, fault name or status code is named in this file.
 *
 * Exported because the decision is a fact about the provider that its tests and its
 * completion/labelling surfaces have to agree with, and one definition is the point.
 */
export const SEARCH_CONTAINER_TYPES: readonly string[] = Object.freeze(["object", "nested"]);

/**
 * How many mappings to read at once.
 *
 * One request per index is unavoidable - a mapping is per-index - so a cluster with
 * hundreds of indices decides between a serial crawl and a burst that the cluster
 * itself has to queue. Four is the number Couchbase's per-collection inference
 * settled on for the same trade-off (`INFER_CONCURRENCY`), and `_mapping` is a
 * cluster-state read rather than a search, so it is cheap per call and not worth
 * tuning past "not serial, not a flood".
 */
export const SEARCH_MAPPING_CONCURRENCY = 4;

/**
 * The two per-index failures that cost one index's columns instead of the tree.
 *
 * `auth` because a security plugin grants index privileges PER INDEX, so a role
 * that lists twenty indices and may describe nineteen is an ordinary
 * configuration - and failing the whole sidebar over the twentieth would punish a
 * perfectly usable connection. `unknown-object` because the listing is a snapshot:
 * an index deleted between the listing and its mapping read is a race that happens
 * on a live cluster, not a fault.
 *
 * Everything else propagates on purpose. An unreachable cluster or an expired
 * deadline would otherwise render every index with zero columns, which reads as
 * "these indices have no fields" - a fabricated schema, and the failure mode that
 * hides the real error forever.
 */
const DEGRADABLE_MAPPING_FAILURES: readonly SearchErrorCategory[] = Object.freeze(["auth", "unknown-object"]);

// ============================================================================
// Options
// ============================================================================

/** What a caller may ask introspection to include. */
export interface SearchSchemaOptions {
  /**
   * Include the indices the engine keeps for itself. Default false.
   *
   * It is an option rather than a constant because both answers are legitimate and
   * the caller knows which: an operator debugging why ML inference is failing wants
   * `.plugins-ml-config` in the tree, and a developer writing a query does not want
   * two thirds of the sidebar to be indices they have never heard of.
   */
  includeSystemIndices?: boolean;
}

// ============================================================================
// System indices
// ============================================================================

/**
 * Whether an index is the engine's own bookkeeping rather than a user's data.
 *
 * The transport flags it - dot-prefixed by both products' convention, plus
 * OpenSearch's date-suffixed query-insights indices, which break the convention -
 * and the decision of what to DO about the flag is this file's, which is why the
 * seam exposes a boolean instead of filtering the list itself.
 *
 * This function exists so that the decision has one name and one place. The rule is
 * deliberately the flag and nothing more: adding a second opinion here (a name
 * pattern of our own, a size threshold) would mean two definitions of "system",
 * and the one on the wire side is the one that can be measured against a real
 * cluster.
 */
export function isSystemIndex(index: SearchIndexInfo): boolean {
  return index.isSystem;
}

/**
 * The indices to describe.
 *
 * Closed indices are KEPT. Measured: a closed index still answers `_mapping` in
 * full, and its `_cat` row reports a null document count and a null size - so it
 * can be described completely and honestly, with the counts absent rather than
 * zero. Dropping it would tell the user their index is gone when it is merely
 * closed, and a query against it gets the engine's own refusal, which says exactly
 * what happened.
 */
function selectIndices(indices: SearchIndexInfo[], options: SearchSchemaOptions): SearchIndexInfo[] {
  if (options.includeSystemIndices === true) return indices;
  return indices.filter((index) => !isSystemIndex(index));
}

// ============================================================================
// Columns
// ============================================================================

/** Whether the value of this field is only reachable through its sub-fields. */
function isContainer(field: SearchMappingField): boolean {
  return SEARCH_CONTAINER_TYPES.includes(field.type);
}

/**
 * One mapping field as a column.
 *
 * `type` is the engine's OWN mapping type - `keyword`, `text`, `long`, `date` - and
 * not a translation into SQL type names. Two reasons, both from `transport.ts`: the
 * result grid labels its columns with what the SQL endpoint declared, which is the
 * mapping vocabulary (`SELECT customer, total` declares `keyword` and `double`,
 * measured), so translating here would make the tree and the grid disagree about
 * the same column; and the mapping type is the word the user wrote in their own
 * index definition, so it is the one they can look up.
 */
function toColumn(field: SearchMappingField): ColumnSchema {
  return {
    // The dotted path, because that is the name the SQL surface accepts:
    // `SELECT note.keyword, address.city` returns both columns (measured), so the
    // path is an identifier here and not a display convenience.
    name: field.path,
    type: field.type,
    // ALWAYS nullable, and this is a measurement rather than a hedge. A mapping
    // declares how a field is indexed IF a document carries it; it cannot require
    // one, there is no NOT NULL in the model, and a document indexed without the
    // field really does come back as `null` from the SQL surface (measured). So
    // every column here accepts absence, and `false` would be the fabricated value.
    nullable: true,
    // NEVER primary. Nothing a mapping declares is unique - the engine enforces no
    // uniqueness on any field, and indexing the same document body twice yields two
    // documents. The only unique thing in an index is the document `_id`, which is
    // metadata rather than a mapped field, and which is not even a shared column:
    // measured, Elasticsearch's SQL answers `SELECT _id` with "Unknown column
    // [_id]" while OpenSearch's returns it.
    //
    // Claiming otherwise is not cosmetic, because `isPrimary` is stated as FACT
    // wherever it is read - `sql-completions.ts` appends "(PK)", the agent's schema
    // context puts " PK" into what a model reasons from, and `schema-diff` reports
    // "Primary key changed" - so a key we invented here becomes a key the product
    // asserts. `ColumnSchema` has no "document identity" field, and inventing one
    // out of `isPrimary` would be a different concept wearing its name.
    isPrimary: false,
    // `defaultValue` is left undefined, which `ColumnSchema` allows. A mapping's
    // `null_value` is the closest thing and is NOT a default: it is the term
    // substituted into the INDEX for an explicit null so the value becomes
    // searchable, and it changes no value any document carries. Reporting it as a
    // default would tell the user a value they never wrote is stored in their
    // documents.
  };
}

/**
 * Mapping fields as columns, containers removed and order made deterministic.
 *
 * Sorting is by path and by code unit, not by the server's order and not by locale.
 * Measured, Elasticsearch normalizes mapping properties alphabetically even for a
 * dynamically mapped index (`{"zeta":1,"alpha":"x","mid":true}` comes back
 * `alpha`, `mid`, `zeta`, and its own `DESCRIBE` agrees) - but that is the engine's
 * normalization and not a promise, the transport emits multi-fields AFTER a level's
 * own children, and a mapping has no declaration order to preserve in the first
 * place: documents are unordered JSON, so there is no "column 3" to be faithful to.
 * Sorting by path also keeps `address.city` next to the other `address.*` fields,
 * which is the grouping a container leaves behind once it is dropped as a column.
 */
function toColumns(fields: SearchMappingField[]): ColumnSchema[] {
  return (
    fields
      .filter((field) => !isContainer(field))
      // Multi-fields are dropped on BOTH products, by the same rule that drops
      // containers above: a column that works on one product and fails on the other
      // is worse than one that works on both.
      //
      // Measured 2026-08-19. Elasticsearch 9.1.4 selects `note.keyword` happily - its
      // own `DESCRIBE` lists the path as a column - while OpenSearch 3.8.0 refuses it
      // in every spelling (bare, backticked, and split) with `SemanticCheckException`,
      // "can't resolve Symbol(namespace=FIELD_NAME, name=note.keyword) in type env".
      // An OBJECT subfield (`addr.city`) selects on both, which is why only the
      // multi-field kind is dropped and the container's leaves are kept.
      //
      // Why this is not a dialect branch: dynamic mapping gives EVERY text field a
      // `keyword` multi-field automatically, so keeping them would put an
      // unselectable column in the tree and in the generated starter query for
      // essentially every dynamically-mapped OpenSearch index. Keeping them only on
      // Elasticsearch would make `dialect` decide a behaviour, which this file
      // forbids. The cost is recorded honestly instead: `note.keyword` is real and
      // selectable on Elasticsearch, and the schema tree does not offer it. A user
      // who wants an exact-match subfield types it, and it works.
      .filter((field) => !field.isMultiField)
      .map(toColumn)
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  );
}

// ============================================================================
// Reads
// ============================================================================

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

/**
 * The columns of one index, degrading only for the failures that are about THAT
 * index (see {@link DEGRADABLE_MAPPING_FAILURES}).
 *
 * An index with no mapping yet answers an empty list from the seam, which is a fact
 * about the index rather than an error - a brand-new index really has no fields -
 * so an empty column list is a statement this function is allowed to make.
 */
async function readColumns(
  transport: SearchTransport,
  index: SearchIndexInfo,
  signal?: AbortSignal,
): Promise<ColumnSchema[]> {
  try {
    return toColumns(await transport.mapping(index.name, signal));
  } catch (error) {
    if (error instanceof SearchTransportError && DEGRADABLE_MAPPING_FAILURES.includes(error.category)) return [];
    throw error;
  }
}

// ============================================================================
// Assembly
// ============================================================================

/**
 * One index as a table.
 *
 * `indexes` is empty BY CONSTRUCTION, not by omission, and the collision of words
 * is worth stating plainly: an Elasticsearch index is the TABLE here, not an
 * `IndexSchema`. There is no secondary-index object to report - every mapped field
 * is inverted-indexed by the engine as a property of being mapped, so there is
 * nothing a user declared, nothing to name, and no DDL that could create one.
 * Synthesizing an entry per field would report the same fact twice, once as a
 * column and once as an index.
 *
 * `foreignKeys` is empty for the same kind of reason: the engine has no such
 * constraint in its model - denormalization is the modelling advice, and `nested` /
 * `join` are containment rather than reference - so no reading of any kind could
 * ever return one. That distinction is invisible in an empty array, which is why
 * the provider must also declare `declaresForeignKeys: false` in its capabilities:
 * a consumer that hedges "either this schema declares none, or the role cannot see
 * them" is wrong in both branches here.
 *
 * `rowCount` is the document count, which is what a row IS on this surface, and
 * stays UNDEFINED when the cluster did not report one - measured on a closed index,
 * where the count and the size both arrive null. Undefined is "unknown"; zero would
 * claim an empty index.
 */
function toTableSchema(index: SearchIndexInfo, columns: ColumnSchema[]): TableSchema {
  return {
    // The index name verbatim. It may be a name SQL needs quoted - measured,
    // OpenSearch's own `top_queries-2026.08.18-74305` carries hyphens and dots -
    // and quoting belongs to whoever builds a statement, not to the inventory.
    name: index.name,
    columns,
    indexes: [],
    foreignKeys: [],
    ...(index.docCount === null ? {} : { rowCount: index.docCount }),
    ...(index.sizeBytes === null ? {} : { size: formatBytes(index.sizeBytes) }),
  };
}

// ============================================================================
// Introspection
// ============================================================================

/**
 * Every index the credentials can see, with its mapped fields as columns.
 *
 * One listing plus one mapping read per index. There is deliberately no
 * `getSchemaList`/`getSchemaRelations` split: that pair exists so a slow index or
 * relationship read cannot block the table list, and here both are empty by
 * construction, so there is nothing to defer and a second pass would re-read every
 * mapping to return the same empty arrays.
 *
 * Aliases and data streams are absent, which the seam records as a limitation
 * rather than an oversight: they come from other endpoints, so a queryable alias
 * does not appear in the tree even though SQL accepts it.
 */
export async function getSchema(
  transport: SearchTransport,
  options: SearchSchemaOptions = {},
  signal?: AbortSignal,
): Promise<TableSchema[]> {
  const indices = selectIndices(await transport.indices(signal), options);
  const columns = await mapWithConcurrency(indices, SEARCH_MAPPING_CONCURRENCY, (index) =>
    readColumns(transport, index, signal),
  );

  return indices.map((index, position) => toTableSchema(index, columns[position]));
}
