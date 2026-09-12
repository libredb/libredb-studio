/**
 * The Couchbase object surface (issue #789)
 *
 * The statements, the row shapes and the pure derivations behind `listContainers`,
 * `countObjects`, `listObjects` and `describeObject`. The four methods themselves live on
 * the provider in `index.ts`; nothing here holds a transport, so every function below is a
 * pure function of a declaration and a path.
 *
 * Couchbase is the THIRD two-level engine in #789, after SQL Server and DuckDB, and its
 * two levels are the engine's own: a BUCKET holds SCOPES which hold collections, and a
 * SQL++ keyspace path is `bucket`.`scope`.`collection` in exactly that order. Both levels
 * are real, so every one of the three positional spellings standing ruling 5g names is
 * WRONG here rather than merely fragile.
 *
 * Everything below was measured against Couchbase Server 8.0.2 Community running
 * `docker/couchbase-init/01-object-fixture.sh`, on 2026-09-11.
 *
 * SIX measurements shape the statements here, each of which a reader would otherwise get
 * wrong:
 *
 * 1. **`system:scopes` does not list `_default`, and `COUNT(*)` over it disagrees with its
 *    own rows.** Measured on a bucket holding `_system`, `_default`, `inventory` and
 *    `tmpscope`: `SELECT s.name FROM system:scopes` answers two rows (`inventory`,
 *    `tmpscope`) while `SELECT COUNT(*) FROM system:scopes` answers 4, and wrapping the
 *    projection in a subquery and counting THAT answers 2 again. `_default` is the scope
 *    most of a bucket's collections live in, so reading `system:scopes` for the scope
 *    level would hide them. The scope list therefore comes from `system:all_scopes` with
 *    the `_system` scope excluded by name.
 * 2. **That same divergence is why nothing here counts with `COUNT(*)`.** A `system:`
 *    keyspace can count rows its own projection does not return, so a badge taken from a
 *    `COUNT(*)` would be a number the folder can never show. Every count in this provider
 *    is the LENGTH of the rows the listing itself produces, which is standing ruling 5f
 *    discharged structurally: see `SEAM` below.
 * 3. **The `all_` variants are wrong for the OBJECT reads for the opposite reason.**
 *    `system:all_keyspaces` answers every row `system:keyspaces` answers for the bucket,
 *    plus THREE the tree must not show: the `_system` scope's `_mobile` and `_query`, which
 *    are the server's own, and a scoped `_default`.`_default` row ALONGSIDE the pre-scopes
 *    bucket-level row that already IS that collection, so one collection would get two
 *    paths and the conformance helper's uniqueness invariant would fail a correct provider.
 *    The excess is stated as three rather than as a total because the total moves with the
 *    fixture and the difference does not: the fixture bucket holds one `system:keyspaces`
 *    row per collection plus the bucket-level one, so whatever that number is,
 *    `system:all_keyspaces` answers it plus three.
 *    `system:all_indexes` is worse, and its excess is not even a constant: it carries a
 *    `#sequentialscan` pseudo-index for EVERY keyspace it can see, in every namespace, plus
 *    the query service's own `#system` namespace indexes, so what it adds grows with the
 *    keyspace count while `system:indexes` answers only the indexes that were created.
 * 4. **The pre-scopes BUCKET-LEVEL row.** A bucket created before scopes existed, and the
 *    `_default`.`_default` collection of every bucket, appear in `system:keyspaces` as a
 *    row carrying NO `bucket` and NO `scope` field at all, whose `name` is the BUCKET's
 *    name. `system:indexes` uses the same shape: a bucket-level index row has no
 *    `bucket_id` and its `keyspace_id` is the bucket. Both resolve to `_default`.`_default`
 *    and dropping them would hide every document written before scopes existed.
 * 5. **An index NAME is unique per COLLECTION, not per scope.** Measured: `ix_name` is
 *    created on both `inventory`.`airline` and `inventory`.`hotel` and both succeed, while
 *    a second `ix_name` on ONE of them is refused with "The index ix_name already exists."
 *    Standing ruling 2 requires the last path segment to be unique within its parent, so
 *    the `index` kind declares `attachedTo: "collection"` and its path carries the
 *    collection segment.
 * 6. **A SQL++ user-defined function has no overloading.** Measured: with
 *    `discount(price, pct)` in place, `CREATE FUNCTION discount(price)` is refused with
 *    "Function 'discount' already exists" - refused on the NAME, arity and all. The same
 *    name in another scope succeeds. So the name is unique within its scope and the path's
 *    last segment is the bare name, unlike PostgreSQL, where standing ruling 2 needs an
 *    argument-type list because overloads share one name.
 *
 * THE 5f SEAM, AND WHERE IT IS ON THIS ENGINE. The rule is that the LISTING must contain
 * exactly what the COUNT counted. Four providers failed that on their first pass because a
 * count statement and a listing statement were written separately and drifted in a WHERE
 * clause. There is no second statement here: `countObjects` is the LENGTH of what
 * `listObjects` returns, for each declared kind, because measurement 2 rules out
 * `COUNT(*)` anyway. That costs one round trip per declared kind on a count, which is
 * three; the alternative was a `COUNT(*)` this engine has been measured to answer wrongly.
 *
 * THERE IS NO CLASSIFIER VOCABULARY TO ENUMERATE, which is this engine's answer to
 * standing ruling 5a. A row's KIND is decided by WHICH CATALOG it came from - a
 * `system:keyspaces` row is a collection, a `system:indexes` row is an index, a
 * `system:functions` row is a function - and never by a string inside the row. So there is
 * no `CASE` an unmodelled spelling can fall out of. The one place a vocabulary could have
 * crept in is `identity.type` on a function row, whose measured values are "global" and
 * "scope"; this file never reads it. A function is placed by whether its identity carries
 * a BUCKET and a SCOPE, so a future third identity type is placed by where it says it
 * lives rather than dropped for being unrecognised.
 *
 * TWO KINDS ARE DELIBERATELY ABSENT, both measured rather than assumed:
 *
 * - **No `view` kind.** SQL++ has no `CREATE VIEW` at all: `CREATE VIEW v AS SELECT 1` is
 *   error 3000, "syntax error - line 1, column 8, near 'CREATE ', at: VIEW (reserved
 *   word)". The legacy map-reduce Views, deprecated since 7.0 and still not removed, DO
 *   exist - the fixture creates `_design/dev_legacy` holding a `by_city` view over the CAPI
 *   port - and they are invisible to the query service: a `LIKE` over `ENCODE_JSON` of
 *   `system:all_keyspaces`, `system:all_indexes`, `system:functions`, `system:buckets` and
 *   `system:all_scopes` finds zero rows mentioning it, and it is not a document in
 *   `_default`.`_default` either. They are reachable only over ports 8091 and 8092, and the
 *   provider's transport speaks the management port for statistics and the query port for
 *   statements, so nothing here could list one.
 * - **No Eventing Function kind.** Eventing is a SEPARATE SERVICE with its own REST API on
 *   port 8096. Measured on the fixture node, which runs `data,index,query`: nothing listens
 *   on 8096 at all, and Eventing is an Enterprise Edition service in any case. It is not
 *   reachable through the query service this provider speaks, so Phase 1 excludes it.
 *
 * One more absence worth naming because it is a DECISION: a GLOBAL (namespace-level)
 * user-defined function is excluded. It belongs to `default:`, above every bucket, so it
 * has no container in a bucket/scope tree; listing it under a bucket would claim it lives
 * somewhere it does not. The fixture creates `celsius` so the exclusion is pinned by a
 * test that names it rather than being a silence.
 */

import { QueryError } from "@/lib/db/errors";
import { containerDepth } from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import type {
  ColumnSchema,
  ContainerLevelSpec,
  ContainerLevels,
  DatabaseObject,
  IndexSchema,
  ObjectDetail,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import { DOCUMENT_KEY_EXPRESSION, unquoteIndexKey } from "./introspect";
import { COUCHBASE_DEFAULT_SCOPE } from "./keyspace";
import type { CouchbaseRow, Keyspace } from "./transport";

// ============================================================================
// The declaration
// ============================================================================

/**
 * Bucket then scope, the engine's own two levels and its own two words.
 *
 * The structural ids are `catalog` and `schema` because that is what
 * `ContainerLevelSpec` calls the two levels on every engine; the LABELS are Couchbase's.
 * Nothing in this file reads a level by position, so the ids are what every derivation
 * addresses and the labels only ever reach a person.
 */
export const COUCHBASE_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "catalog", label: "Bucket", labelPlural: "Buckets" },
  { id: "schema", label: "Scope", labelPlural: "Scopes" },
] as const);

const COUCHBASE_KIND_COLLECTION = "collection";
export const COUCHBASE_KIND_FUNCTION = "function";
export const COUCHBASE_KIND_INDEX = "index";

export const COUCHBASE_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: COUCHBASE_KIND_COLLECTION,
    role: "relation",
    label: "Collection",
    labelPlural: "Collections",
    // A collection takes a document write, which is the per-KIND half and is deliberately
    // not conjoined with the engine-wide `supportsInlineRowEdit: false` this provider also
    // declares. That flag is about the results grid's `UPDATE ... SET`, which cannot
    // address a Couchbase document through the `__id` projection; an import into a
    // collection is an ordinary `UPSERT`. See `kindAcceptsRowWrites()` in object-kinds.ts.
    acceptsRowWrites: true,
  },
  { id: COUCHBASE_KIND_FUNCTION, role: "routine", label: "Function", labelPlural: "Functions" },
  {
    id: COUCHBASE_KIND_INDEX,
    role: "config",
    label: "Index",
    labelPlural: "Indexes",
    // Standing ruling 4 names couchbase as one of the three engines whose catalog models
    // an index as a first-class named object, and `system:indexes` does: a row per index,
    // with its own name, its keys and its `using`. But the NAME alone does not address one
    // - measurement 5 above - so the path carries the collection and standing ruling 2 is
    // satisfied by `attachedTo` rather than by hoping names do not collide.
    attachedTo: COUCHBASE_KIND_COLLECTION,
  },
] as const);

/** The scope the server owns. Its collections (`_mobile`, `_query`) are not a person's. */
const COUCHBASE_SYSTEM_SCOPE = "_system";

/** The collection a bucket-level catalog row means: `_default`.`_default`. */
export const COUCHBASE_DEFAULT_COLLECTION = "_default";

// ============================================================================
// Statements
// ============================================================================

/**
 * Every bucket this connection can address.
 *
 * The connection PINS one bucket, but SQL++ addresses any of them by a three-part name and
 * the query service is cluster-wide, so the top container level is the cluster's buckets
 * rather than the one the connection opened. Which one that is reaches the tree through
 * `isSessionDefault`, not through a filter.
 */
export const BUCKETS_SQL = "SELECT b.name AS bucket_name FROM system:buckets AS b";

/**
 * One bucket's scopes, `_system` excluded by exact NAME.
 *
 * `system:all_scopes` and not `system:scopes`: measurement 1. The exclusion is an exact
 * name and not a `_` prefix, and that is refuted rather than preferred: `_default` starts
 * with the same underscore and must stay, and the engine itself refuses any user scope
 * starting with `_` or `%` ("First character must not be _ or %", measured on `_systemx`),
 * so nothing a person creates can be hidden by it.
 *
 * `bucket` is a reserved word in SQL++ and is backtick-quoted; unquoted the projection is
 * error 3000 on 8.0.2.
 */
export const SCOPES_SQL = [
  "SELECT s.name AS scope_name FROM system:all_scopes AS s",
  `WHERE s.\`bucket\` = $1 AND s.name != "${COUCHBASE_SYSTEM_SCOPE}"`,
].join(" ");

/**
 * One bucket's collections.
 *
 * The second predicate is the pre-scopes bucket-level row of measurement 4, whose
 * `bucket` field is MISSING and whose name is the bucket's own.
 */
export const COLLECTIONS_SQL = [
  "SELECT k.`bucket` AS bucket_id, k.`scope` AS scope_id, k.name AS object_name",
  "FROM system:keyspaces AS k",
  "WHERE k.`bucket` = $1 OR (k.`bucket` IS MISSING AND k.name = $1)",
].join(" ");

/**
 * One bucket's indexes, with the same two shapes and the same bucket-level branch.
 *
 * `index_key` and `is_primary` ride along on the LISTING read rather than being fetched
 * again in `describeObject`, because the same rows answer both: a collection's detail is
 * the subset of these rows whose keyspace is that collection. One statement for both is
 * one fewer place for the two answers to disagree about which indexes exist.
 */
export const INDEXES_SQL = [
  "SELECT i.bucket_id AS bucket_id, i.scope_id AS scope_id,",
  "i.keyspace_id AS collection_id, i.name AS object_name,",
  "i.index_key AS index_key, i.is_primary AS is_primary",
  "FROM system:indexes AS i",
  "WHERE i.bucket_id = $1 OR (i.bucket_id IS MISSING AND i.keyspace_id = $1)",
].join(" ");

/**
 * Every user-defined function the query service holds, global ones included.
 *
 * NO bucket predicate, deliberately. The identity of a global function carries no bucket
 * at all, so a `WHERE f.identity.\`bucket\` = $1` would drop it server-side and the
 * exclusion this provider makes would become an accident of the statement rather than a
 * rule a test can drive. The catalog is namespace-wide and small - one row per
 * user-defined function on the whole cluster - so reading all of it and placing each row
 * in code costs nothing and keeps the placement rule in one visible place.
 */
export const FUNCTIONS_SQL = "SELECT f.identity AS identity FROM system:functions AS f";

// ============================================================================
// Row shapes
// ============================================================================

/**
 * One row of `COLLECTIONS_SQL` or `INDEXES_SQL`.
 *
 * Every field is optional and typed `unknown` because the catalog omits rather than nulls:
 * a bucket-level row carries no `bucket_id` KEY at all, and a collection row carries no
 * `collection_id`. Reading them through the guards below rather than through a cast is
 * what keeps one malformed row from taking a whole listing down.
 */
export interface CouchbaseObjectRow extends CouchbaseRow {
  bucket_id?: unknown;
  scope_id?: unknown;
  collection_id?: unknown;
  object_name?: unknown;
  index_key?: unknown;
  is_primary?: unknown;
}

/** One row of `FUNCTIONS_SQL`. `identity` is the only field this provider reads. */
export interface CouchbaseFunctionRow extends CouchbaseRow {
  identity?: unknown;
}

export interface ContainerNameRow extends CouchbaseRow {
  bucket_name?: unknown;
  scope_name?: unknown;
}

// ============================================================================
// Pure helpers
// ============================================================================

/** A string the cluster sent, or undefined for a field it omitted or sent as anything else. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The container levels this engine declares, cut to the depth `containerDepth()` answers.
 *
 * Every derivation below starts here rather than from a length or an index. Absent and
 * empty are the same fact and only `containerDepth()` decides it, so the tree and the API
 * route cannot read the same declaration by two different rules.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The container segments of a path, keyed by the LEVEL each one belongs to.
 *
 * This is what replaces `container[0]` and `path[1]`: a caller asks for `catalog` or
 * `schema` BY NAME, so a level added, removed or reordered moves every read with it.
 */
function containerSegments(
  capabilities: ProviderCapabilities,
  path: readonly string[],
): Partial<Record<ContainerLevelSpec["id"], string>> {
  const levels = declaredLevels(capabilities);
  return Object.fromEntries(
    path.slice(0, levels.length).map((segment, index) => [levels[index].id, segment]),
  ) as Partial<Record<ContainerLevelSpec["id"], string>>;
}

/**
 * The segment one declared level carries, or a refusal naming the level.
 *
 * Never a non-null assertion: `undefined` reaching `$1` is not an error the cluster reports
 * usefully - it binds a MISSING and answers an empty result set, which looks exactly like a
 * bucket holding nothing. The case is reachable without a bug in this file, through a
 * declaration carrying only one of the two levels.
 */
function requiredSegment(
  segments: Partial<Record<ContainerLevelSpec["id"], string>>,
  level: ContainerLevelSpec["id"],
): string {
  const segment = segments[level];
  if (segment === undefined) {
    throw new QueryError(`A Couchbase path needs a "${level}" container level and a segment for it`, "couchbase");
  }
  return segment;
}

/** Every prefix of the declared levels: a bucket alone, or a bucket and a scope. */
function containerShapes(capabilities: ProviderCapabilities): readonly string[][] {
  const names = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  return names.map((_, index) => names.slice(0, index + 1));
}

/**
 * The shapes above, spelled for a message: `[bucket] or [bucket, scope]`.
 *
 * A declaration carrying no container level has no shape at all, and the empty join would
 * print "a Couchbase container path is , received []", which reads as a formatting bug
 * rather than as the fact it is.
 */
function shapeList(shapes: readonly string[][]): string {
  if (shapes.length === 0) return "nothing: this declaration carries no container level";
  return shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ");
}

/**
 * What one container path addresses: the bucket to bind, and the scope to filter to.
 *
 * Both are read BY LEVEL, never by position. A bucket-level container has no scope, and
 * that is `undefined` rather than `_default`: `_default` is a real scope holding real
 * collections, so conflating the two would make a bucket-level count answer one scope's.
 */
export interface ContainerRead {
  readonly bucket: string;
  readonly scope: string | undefined;
}

export function containerRead(capabilities: ProviderCapabilities, container: readonly string[]): ContainerRead {
  const shapes = containerShapes(capabilities);
  if (!shapes.some((shape) => shape.length === container.length)) {
    throw new QueryError(
      `A Couchbase container path is ${shapeList(shapes)}, received ${JSON.stringify(container)}`,
      "couchbase",
    );
  }
  const segments = containerSegments(capabilities, container);
  return { bucket: requiredSegment(segments, "catalog"), scope: segments.schema };
}

/**
 * The path shape one KIND's objects are addressed by, derived from the declaration.
 *
 * `attachedTo` inserts the base object's segment between the container and the name, which
 * is standing ruling 2's rule and is what gives an index its collection segment. The
 * container part comes from the declared LEVELS, so reversing or shortening the
 * declaration moves the shape with it.
 */
function objectShape(capabilities: ProviderCapabilities, spec: ObjectKindSpec): string[] {
  const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  return spec.attachedTo === undefined ? [...levels, "name"] : [...levels, spec.attachedTo, "name"];
}

/**
 * One object path checked against the shape its KIND is addressed by, or a refusal.
 *
 * Separate from `relationKeyspace()` below on purpose: every kind's path is checked, and
 * only a relation's path is then resolved into a keyspace. Returning a keyspace for an
 * index path would mean inventing one - an index's last segment is the index's name, not a
 * collection - and a value nothing reads is a value nothing can keep honest.
 */
export function checkObjectPath(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  path: readonly string[],
): void {
  const shape = objectShape(capabilities, spec);
  if (path.length !== shape.length) {
    throw new QueryError(
      `A Couchbase "${spec.id}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
      "couchbase",
    );
  }
}

/**
 * The keyspace one RELATION's path names.
 *
 * The collection is `path[path.length - 1]` and NEVER `path[2]`. The two are
 * behaviour-identical while a relation sits at exactly three segments, which is every
 * relation this engine has, so the suite varies the DECLARATION instead: a `collection`
 * kind handed an `attachedTo` through `getCapabilities` is addressed at four segments, and
 * `path[2]` then names the base object while the last segment names the relation itself.
 * That is standing ruling 5g's instruction taken literally - a derivation you declared
 * unmutatable is usually a fixture you did not vary.
 *
 * The bucket and the scope come from `containerSegments()` and never from `path[0]` and
 * `path[1]`, which is the third spelling of the same ruling and the one that keeps
 * surviving, because it is depth-identical on every one-level engine and wrong here.
 */
export function relationKeyspace(capabilities: ProviderCapabilities, path: readonly string[]): Keyspace {
  const segments = containerSegments(capabilities, path);
  return {
    bucket: requiredSegment(segments, "catalog"),
    scope: requiredSegment(segments, "schema"),
    collection: path[path.length - 1],
  };
}

// ============================================================================
// Placement: which container a catalog row belongs to
// ============================================================================

/**
 * The scope and collection a `system:keyspaces` or `system:indexes` row is about.
 *
 * ONE function for both catalogs, because their projections are aliased onto the same
 * field names and both carry the same two row shapes:
 *
 * - a row with no `bucket_id` is the PRE-SCOPES bucket-level row (measurement 4). It is
 *   `_default`.`_default`, whatever its `name` says, and its name says the bucket's name.
 * - anything else names its scope; a row that somehow carries none is placed in `_default`,
 *   which is where an unqualified SQL++ keyspace resolves.
 *
 * `keyspaceName` is the field carrying the COLLECTION: `object_name` on a collection row,
 * `collection_id` on an index row. The caller supplies it, so this function never has to
 * know which catalog it is reading. A row that names NO keyspace is placed in `_default`
 * too, by the same rule and for the same reason as the scope: `_default`.`_default` is
 * where an unqualified SQL++ keyspace resolves, and the alternative to placing such a row
 * is dropping it out of the COUNT and the LISTING at once, which leaves an object invisible
 * in the tree while standing ruling 5f still holds. Neither shape was observed on 8.0.2,
 * and neither is claimed to be unreachable: a shape that is merely unobserved is what
 * standing ruling 5a says to place rather than to reason away. So this function is TOTAL,
 * and a row that addresses nothing is dropped by its caller on the NAME, which is the one
 * field a tree row cannot do without.
 */
export function resolveKeyspaceOf(bucket: string, row: CouchbaseObjectRow, keyspaceName: string | undefined): Keyspace {
  if (text(row.bucket_id) === undefined) {
    return { bucket, scope: COUCHBASE_DEFAULT_SCOPE, collection: COUCHBASE_DEFAULT_COLLECTION };
  }
  return {
    bucket,
    scope: text(row.scope_id) ?? COUCHBASE_DEFAULT_SCOPE,
    collection: keyspaceName ?? COUCHBASE_DEFAULT_COLLECTION,
  };
}

/**
 * The bucket, scope and name a `system:functions` row addresses, or undefined for one that
 * belongs to no scope.
 *
 * The test is STRUCTURAL and not a match on `identity.type`. A row carrying a bucket and a
 * scope lives in that scope; a row carrying neither is a GLOBAL function, which belongs to
 * the `default:` namespace above every bucket and has no container in this tree. Written
 * this way, a future third identity type is placed by where it says it lives instead of
 * disappearing for being an unrecognised spelling - which is standing ruling 5a's
 * requirement discharged without a vocabulary to keep current.
 */
export interface FunctionIdentity {
  readonly bucket: string;
  readonly scope: string;
  readonly name: string;
}

export function resolveFunctionIdentity(row: CouchbaseFunctionRow): FunctionIdentity | undefined {
  const identity = asRecord(row.identity);
  if (identity === undefined) return undefined;
  const bucket = text(identity.bucket);
  const scope = text(identity.scope);
  const name = text(identity.name);
  if (bucket === undefined || scope === undefined || name === undefined) return undefined;
  return { bucket, scope, name };
}

// ============================================================================
// Path construction and ordering
// ============================================================================

/**
 * A path built from the DECLARED level order, plus whatever segments follow.
 *
 * This is the one place a position is legitimately WRITTEN rather than read, which
 * standing ruling 5g names as the single exception to the no-positional-index rule. It
 * still has to be written in the declared order, because `objectRead()` reads the same
 * path back by level: a listing that wrote `[bucket, scope, ...]` while the declaration
 * said scope then bucket would hand the conformance helper a path its own `describeObject`
 * resolves backwards.
 */
export function objectPath(capabilities: ProviderCapabilities, keyspace: Keyspace, tail: readonly string[]): string[] {
  const segments: Record<ContainerLevelSpec["id"], string> = {
    catalog: keyspace.bucket,
    schema: keyspace.scope,
  };
  return [...declaredLevels(capabilities).map((level) => segments[level.id]), ...tail];
}

/**
 * Whether a produced path sits inside a container path.
 *
 * The container is a PREFIX of the object's path, at whatever depth the declaration puts
 * it, so the same predicate serves a bucket-level and a scope-level read and there is no
 * second filtering rule for the two to disagree in.
 */
export function isInsideContainer(path: readonly string[], container: readonly string[]): boolean {
  return container.every((segment, index) => path[index] === segment);
}

// ============================================================================
// Count assembly
//
// THERE IS NO `seedZeroCounts` HERE, and its absence is a consequence of the one-read
// design rather than an oversight. Every other provider in #789 seeds each declared kind
// at `{ count: 0 }` before overwriting it from catalog rows, because a kind the statement
// answers nothing for would otherwise be missing from the record and its folder would
// disappear. Here the count for each declared kind is produced BY ITERATING THE
// DECLARATION - one `kindObjects()` call per declared kind, each answering a length - so
// every declared kind is in the record by construction and a seed would be a line no
// mutation could kill. The invariant it protects is still pinned, by the test that empties
// every catalog and expects three zeroes rather than an empty record.
// ============================================================================

/** One listed object, as the tree addresses it. */
export function listedObject(path: string[], name: string, kind: string): DatabaseObject {
  return { path, name, kind };
}

/**
 * One `system:indexes` row as the shape `ObjectDetail.indexes` carries.
 *
 * Spelled exactly as `getSchema()` spells it (`introspect.ts`), because both surfaces are
 * live through Phase 1 and an index that reads one way in the tree and another in the flat
 * explorer is the same index described twice. A PRIMARY index carries no `index_key` at
 * all - it keys the document key itself - and it is the only unique index Couchbase has:
 * no secondary GSI enforces uniqueness.
 *
 * Module-private: `relationDetail` below is the only caller, and it is what both the single
 * and the bulk read go through, so an index cannot be spelled two ways.
 */
function indexSchemaOf(row: CouchbaseObjectRow, name: string): IndexSchema {
  const isPrimary = row.is_primary === true;
  const keys = Array.isArray(row.index_key)
    ? row.index_key.filter((key): key is string => typeof key === "string").map(unquoteIndexKey)
    : [];
  return {
    name,
    columns: isPrimary && keys.length === 0 ? [DOCUMENT_KEY_EXPRESSION] : keys,
    unique: isPrimary,
  };
}

/**
 * One relation's `ObjectDetail`, from its columns and the bucket's whole index catalog.
 *
 * ONE mapper for the single read and the bulk read (#789). Two copies would be two chances
 * for a batch to spell an index differently from `describeObject` on the same collection,
 * and every caller joins the two answers on path.
 *
 * The index rows are the BUCKET's, so the filter is what selects this collection's own -
 * and it compares BOTH the scope and the collection, because one collection NAME can live
 * in two scopes. The fixture puts `airline` in `_default` and in `inventory`, each with its
 * own `ix_name` over a different key, so a name-only filter reports the wrong keys rather
 * than merely the wrong count.
 *
 * `foreignKeys` is ALWAYS empty, the measurement behind `declaresForeignKeys: false`: SQL++
 * has no referential constraint at all.
 */
export function relationDetail(
  path: readonly string[],
  keyspace: Keyspace,
  columns: readonly ColumnSchema[],
  indexRows: readonly CouchbaseObjectRow[],
): ObjectDetail {
  const indexes: IndexSchema[] = [];
  for (const row of indexRows) {
    const name = typeof row.object_name === "string" ? row.object_name : undefined;
    const keyspaceName = typeof row.collection_id === "string" ? row.collection_id : undefined;
    const rowKeyspace = resolveKeyspaceOf(keyspace.bucket, row, keyspaceName);
    if (name === undefined) continue;
    if (rowKeyspace.scope !== keyspace.scope || rowKeyspace.collection !== keyspace.collection) continue;
    indexes.push(indexSchemaOf(row, name));
  }
  indexes.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  return { path: [...path], columns: [...columns], indexes, foreignKeys: [] };
}
