/**
 * ClickHouse object surface (issue #789)
 *
 * One container level and five kinds, read out of `system.tables` and
 * `system.functions` through the same transport seam every other read here uses, so
 * this file names no header, no request parameter and no envelope field.
 *
 * Five measurements on ClickHouse 26.7.1.1315 shape everything below, and each one
 * produces a wrong tree if it is forgotten:
 *
 * 1. `system.tables.engine` is an OPEN set - 129 distinct values on a bare server,
 *    one per storage engine - so `table` is the DEFAULT arm and only three engine
 *    names are diverted off it. An inclusion list of engine names would make every
 *    engine this code has never heard of invisible, which is the absence standing
 *    ruling 5a exists for: a kind that falls out of the count AND the listing keeps
 *    the badge agreeing with the folder while the object cannot be reached at all.
 * 2. A DICTIONARY appears in `system.tables` too, with engine `Dictionary`. Counting
 *    everything in that catalog as a table counts each dictionary twice.
 * 3. A materialised view declared without a `TO` clause owns an IMPLICIT INNER TABLE,
 *    named `.inner_id.<the view's own uuid>` and carrying a real storage engine. It
 *    must appear in neither the count nor the listing: it is storage the server
 *    created, not an object a person named.
 * 4. The obvious exclusion for (3) - a name pattern - is REFUTED rather than
 *    unattractive. Measured: `CREATE TABLE probe.`.inner_id.fake`` SUCCEEDS, so
 *    `name LIKE '.inner%'` hides a table a user created. The rule used instead is
 *    structural and comes from the server's own columns: a table is an implicit inner
 *    table exactly when some MaterializedView's `(target_database, target_table)`
 *    names it AND that view's `target_table` is `concat('.inner_id.', toString(uuid))`.
 *    Measured against a fixture built to break it: `.inner_id.fake` survives, and so
 *    does `mv_target`, the explicit `TO` target of another view and an ordinary table.
 * 5. `system.functions.origin` is an `Enum8` and THE COLUMN TYPE IS THE VOCABULARY:
 *    `Enum8('System' = 0, 'SQLUserDefined' = 1, 'ExecutableUserDefined' = 2,
 *    'WasmUserDefined' = 3)`. So the filter is written as "not System" rather than as
 *    an inclusion list of the three user-defined origins: a fourth origin in a later
 *    build is then a function this tree shows, not one it loses.
 *
 * 6. A DICTIONARY is published in TWO catalogs and neither one holds all of them. A
 *    DDL dictionary (`CREATE DICTIONARY`) has a `system.tables` row with engine
 *    `Dictionary` AND a `system.dictionaries` row. A CONFIG-FILE dictionary, declared
 *    in `/etc/clickhouse-server/*_dictionary.xml`, has NO `system.tables` row and no
 *    `system.columns` row at all: it exists only in `system.dictionaries`, with an
 *    EMPTY `database`, the same way a user-defined function exists only in
 *    `system.functions`. So `system.dictionaries` is unioned into the same subquery -
 *    the count and the listing still read one text, so no 5f seam comes back with it -
 *    and it is also what `describeObject` reads for the kind, because it is the only
 *    catalog both flavours are in. The engine name is NOT what identifies a
 *    dictionary either: `CREATE TABLE d (...) ENGINE = Dictionary(other_dict)` is
 *    accepted and produces a `system.tables` row with engine `Dictionary` and no
 *    `system.dictionaries` row. That object is a TABLE that reads a dictionary, so the
 *    kind expression asks `system.dictionaries` for membership instead.
 *
 * Two absences are declarations rather than gaps. ClickHouse has no trigger and no
 * stored procedure, so neither kind is declared at all - a declared kind draws a
 * folder, and a folder for a concept the engine does not have is a lie its 0 badge
 * makes look like a fact (standing ruling 4). And no kind declares
 * `acceptsRowWrites`, because a row mutation here is spelled
 * `ALTER TABLE ... UPDATE`, which is the same measurement that made the provider
 * declare `supportsInlineRowEdit: false`.
 */

import { QueryError } from "@/lib/db/errors";
import {
  applySourceBound,
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
  requireSourceKind,
} from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import type {
  ColumnSchema,
  Container,
  ContainerLevelSpec,
  ContainerLevels,
  DatabaseObject,
  IndexSchema,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
  ProviderCapabilities,
} from "@/lib/db/types";
import {
  CLICKHOUSE_SYSTEM_DATABASES,
  isNullableType,
  readCount,
  readDefault,
  readIdentifier,
  readText,
  splitKeyExpression,
} from "./introspect";
import { type ClickHouseRow, type ClickHouseTransport, ClickHouseTransportError } from "./transport";

const PROVIDER = "clickhouse" as const;

// ============================================================================
// Declaration
// ============================================================================

/**
 * One level, and there is no second one to add.
 *
 * ClickHouse has no schema level below a database, and `CREATE SCHEMA` is not an
 * alias for anything: the grammar has no such statement. The level's structural `id`
 * is `schema` because that is what `ContainerLevelSpec` calls the innermost level on
 * every engine; the LABEL is the engine's own word, which is Database.
 */
export const CLICKHOUSE_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

/**
 * EVERY declared kind has a definition text, and `sql` is the right Monaco id for all five
 * (#789 Phase 2).
 *
 * The four table-backed kinds read `system.tables.create_table_query` and a function reads
 * `system.functions.create_query`. The function row is a MEASUREMENT and not a reading of the
 * documentation, which marks that column Obsolete: on 26.7.1.1315 it carries
 * `CREATE FUNCTION order_total_with_tax AS total -> (total * 1.2)` for the one
 * `SQLUserDefined` row while all 1858 `System` rows are empty, and the measurement wins over
 * the label (#789 probe 10). `docs/providers/clickhouse.md` records both, so a later reader
 * knows the column is deprecated rather than absent.
 *
 * `hasSource` answers for the KIND and the READ answers per object. Two of these kinds hold
 * objects with no text at all - a config-file dictionary and a function whose `origin` is
 * `ExecutableUserDefined` or `WasmUserDefined` - and each is a refusal PART beside readable
 * siblings of the same kind, never a dropped declaration.
 */
export const CLICKHOUSE_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasSource: true, sourceLanguage: "sql" },
  { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "sql" },
  {
    id: "materialized_view",
    role: "relation",
    label: "Materialized View",
    labelPlural: "Materialized Views",
    hasSource: true,
    sourceLanguage: "sql",
  },
  {
    id: "dictionary",
    role: "config",
    label: "Dictionary",
    labelPlural: "Dictionaries",
    hasSource: true,
    sourceLanguage: "sql",
  },
  {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: "sql",
  },
] as const);

/**
 * Which catalog answers for each declared kind, written once.
 *
 * The describe branch and the SQL both read this, so a kind added to
 * `CLICKHOUSE_OBJECT_KINDS` without an entry here fails loudly instead of drawing a
 * folder nothing can fill. It is keyed on the CATALOG rather than on
 * `role === "relation"` for the reason MySQL is: the two coincide on this engine
 * today - a dictionary is `config` and still resolves in `system.columns` - and a
 * later kind could break the coincidence without breaking this.
 */
type ObjectCatalog = "tables" | "dictionaries" | "functions";

const CLICKHOUSE_OBJECT_CATALOGS: Readonly<Record<string, ObjectCatalog>> = Object.freeze({
  table: "tables",
  view: "tables",
  materialized_view: "tables",
  dictionary: "dictionaries",
  function: "functions",
});

/**
 * The catalog a kind reads, or undefined for a kind that has none.
 *
 * `Object.hasOwn` and not a bare index, for the reason `applyKindCounts` uses it: a
 * plain object answers `CLICKHOUSE_OBJECT_CATALOGS["toString"]` with
 * `Function.prototype.toString`, so a declared kind of that name would pass a
 * `!== undefined` guard carrying a function where a catalog name belongs.
 */
function objectCatalog(kind: string): ObjectCatalog | undefined {
  return Object.hasOwn(CLICKHOUSE_OBJECT_CATALOGS, kind) ? CLICKHOUSE_OBJECT_CATALOGS[kind] : undefined;
}

// ============================================================================
// SQL
// ============================================================================

/**
 * A value as a ClickHouse string literal. The backslash escape has to be applied as
 * well as the doubled quote: ClickHouse honours both inside a literal
 * (live-verified), so escaping only the quote would leave `\'` as a way out.
 *
 * This is the ONLY way a caller-supplied name reaches a statement in this file. The
 * transport binds named `{name:Type}` parameters and nothing else, so there is no
 * positional bind to reach for.
 */
export function literal(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** Names are compile-time constants, so inlining them as literals is safe. */
const NON_SYSTEM_DATABASE_NAME = `name NOT IN (${CLICKHOUSE_SYSTEM_DATABASES.map((name) => `'${name}'`).join(", ")})`;

/**
 * The databases this connection can see.
 *
 * `name = currentDatabase()` is the SERVER's own answer for which container the
 * session is in, rather than the configured database string, which is what a person
 * typed into a form. Measured: the transport sends the connection's database on every
 * request, so `currentDatabase()` answers it.
 */
const CONTAINERS_SQL = [
  "SELECT name AS containerName, name = currentDatabase() AS isSessionDefault",
  "FROM system.databases",
  `WHERE ${NON_SYSTEM_DATABASE_NAME}`,
  "ORDER BY name ASC",
].join(" ");

/** Every dictionary on the server, by address. See point 6 of this file's docblock. */
const DICTIONARY_ADDRESSES_SQL = "SELECT dd.database, dd.name FROM system.dictionaries AS dd";

/**
 * The exceptions diverted off the `table` default, and nothing else.
 *
 * Read the docblock at the top of this file for why the arms are written as
 * exceptions rather than as an inclusion list, and why the dictionary arm asks
 * `system.dictionaries` for MEMBERSHIP instead of matching the engine name.
 */
const OBJECT_KIND_EXPR = [
  "multiIf(",
  "t.engine = 'View', 'view',",
  "t.engine = 'MaterializedView', 'materialized_view',",
  `(t.database, t.name) IN (${DICTIONARY_ADDRESSES_SQL}), 'dictionary',`,
  "'table')",
].join(" ");

/**
 * Every implicit inner table on the server, by address.
 *
 * The uuid equality is what separates an inner table from an explicit `TO` target:
 * both are named by some view's `target_table`, and only the implicit one is named
 * after the view's own uuid. Measured on 26.7.1.1315, and measured against the two
 * shapes that would otherwise be lost - see this file's docblock, point 4.
 */
const IMPLICIT_INNER_TABLES_SQL = [
  "SELECT mv.target_database, mv.target_table",
  "FROM system.tables AS mv",
  "WHERE mv.engine = 'MaterializedView'",
  "AND mv.target_table = concat('.inner_id.', toString(mv.uuid))",
].join(" ");

/**
 * Every object of every declared kind in one database, kind-tagged, as ONE subquery.
 *
 * The count GROUPs this and the listing FILTERs it, which is standing ruling 5f held
 * by construction rather than by two statements agreeing: there is no second WHERE
 * clause for the two to drift apart in. Oracle and MySQL both failed that rule on
 * their first pass, and both had a count and a listing reading different catalogs.
 *
 * The function arm casts its two counters explicitly. A bare `NULL` in a `UNION ALL`
 * takes `Nullable(Nothing)`, and a function has no rows and no bytes in any sense -
 * omitting the columns is not available, because the two arms must have one shape.
 */
function databaseObjectsSql(database: string): string {
  return [
    "SELECT t.name AS objectName,",
    `${OBJECT_KIND_EXPR} AS objectKind,`,
    "t.total_rows AS objectRows,",
    "t.total_bytes AS objectBytes",
    "FROM system.tables AS t",
    `WHERE t.database = ${literal(database)}`,
    `AND (t.database, t.name) NOT IN (${IMPLICIT_INNER_TABLES_SQL})`,
    "UNION ALL",
    "SELECT f.name AS objectName,",
    "'function' AS objectKind,",
    "CAST(NULL, 'Nullable(UInt64)') AS objectRows,",
    "CAST(NULL, 'Nullable(UInt64)') AS objectBytes",
    "FROM system.functions AS f",
    "WHERE f.origin != 'System'",
    "UNION ALL",
    "SELECT d.name AS objectName,",
    "'dictionary' AS objectKind,",
    "CAST(NULL, 'Nullable(UInt64)') AS objectRows,",
    "CAST(NULL, 'Nullable(UInt64)') AS objectBytes",
    "FROM system.dictionaries AS d",
    "WHERE d.database = ''",
  ].join(" ");
}

function countsSql(database: string): string {
  return `SELECT objectKind, count() AS objectCount FROM (${databaseObjectsSql(database)}) GROUP BY objectKind`;
}

function listingSql(database: string, kind: string): string {
  return [
    "SELECT objectName, objectRows, objectBytes",
    `FROM (${databaseObjectsSql(database)})`,
    `WHERE objectKind = ${literal(kind)}`,
    "ORDER BY objectName ASC",
  ].join(" ");
}

/** `position` orders the projection rather than appearing in it: it IS the declared order. */
function objectColumnsSql(database: string, name: string): string {
  return [
    "SELECT c.name AS columnName,",
    "c.type AS columnType,",
    "c.is_in_primary_key AS isPrimaryKey,",
    "c.default_kind AS defaultKind,",
    "c.default_expression AS defaultExpression",
    "FROM system.columns AS c",
    `WHERE c.database = ${literal(database)} AND c.table = ${literal(name)}`,
    "ORDER BY c.position",
  ].join(" ");
}

/**
 * One dictionary's columns, out of `system.dictionaries`.
 *
 * The catalog publishes them as four PARALLEL ARRAYS - `key.names`, `key.types`,
 * `attribute.names`, `attribute.types` - so they are zipped and flattened HERE rather
 * than in TypeScript: the transport reads scalar columns out of every other statement
 * in this file, and an array-valued column would be the only place it had to know
 * about ClickHouse's own array encoding.
 *
 * The empty database is accepted alongside the container's own, because a config-file
 * dictionary carries no database and is reached through whichever one the tree opened.
 * `ORDER BY database DESC LIMIT 1` then prefers the DDL dictionary if a config one
 * happens to share its name, so the answer is one object's columns and never two
 * objects' concatenated.
 */
function dictionaryColumnsSql(database: string, name: string): string {
  return [
    "SELECT c.1 AS columnName, c.2 AS columnType, c.3 AS isKeyColumn",
    "FROM (SELECT arrayJoin(arrayConcat(",
    "arrayMap((n, t) -> (n, t, 1), d.keyNames, d.keyTypes),",
    "arrayMap((n, t) -> (n, t, 0), d.attributeNames, d.attributeTypes))) AS c",
    "FROM (SELECT key.names AS keyNames, key.types AS keyTypes,",
    "attribute.names AS attributeNames, attribute.types AS attributeTypes",
    "FROM system.dictionaries",
    `WHERE (database = ${literal(database)} OR database = '') AND name = ${literal(name)}`,
    "ORDER BY database DESC LIMIT 1) AS d)",
  ].join(" ");
}

/**
 * The target set of one bulk read: every object of one kind in one database, in the
 * engine's own order, optionally cut (#789).
 *
 * The same kind-tagged subquery the count GROUPs and the listing FILTERs, so all three
 * cannot disagree about which rows are in scope - standing ruling 5f held by construction
 * rather than by three statements agreeing. What it adds to the listing is a `LIMIT`.
 *
 * `ORDER BY objectName ASC` is what makes a bounded cut deterministic, and it runs under
 * ClickHouse's own String comparison, which is the UTF-8 BYTE order and NOT the order
 * `comparePaths` produces. So the MEMBERSHIP of a bounded read is the server's and the
 * ORDER of the answer is ours.
 *
 * The limit is INTERPOLATED rather than bound, because this transport binds named
 * `{name:Type}` parameters and nothing else, and it is safe by construction: the caller's
 * value has already been refused unless it is a positive whole number, so nothing that
 * reaches this template can be anything but digits.
 */
function bulkTargetSql(database: string, kind: string, limit?: number): string {
  return [
    "SELECT objectName",
    `FROM (${databaseObjectsSql(database)})`,
    `WHERE objectKind = ${literal(kind)}`,
    "ORDER BY objectName ASC",
    ...(limit === undefined ? [] : [`LIMIT ${limit}`]),
  ].join(" ");
}

/**
 * Every target object's columns in ONE statement, which is `objectColumnsSql()` with the
 * name equality replaced by membership of the target set.
 *
 * `c.database` stays on the outer read as well as inside the target: `system.columns` spans
 * every database on the server, and two databases holding a table of the same name is the
 * ordinary case rather than a corner.
 */
function bulkColumnsSql(database: string, kind: string, limit?: number): string {
  return [
    "SELECT c.table AS objectName,",
    "c.name AS columnName,",
    "c.type AS columnType,",
    "c.is_in_primary_key AS isPrimaryKey,",
    "c.default_kind AS defaultKind,",
    "c.default_expression AS defaultExpression",
    "FROM system.columns AS c",
    `WHERE c.database = ${literal(database)}`,
    `AND c.table IN (${bulkTargetSql(database, kind, limit)})`,
    "ORDER BY c.table, c.position",
  ].join(" ");
}

/** The same reshaping of `objectIndexesSql()`. */
function bulkIndexesSql(database: string, kind: string, limit?: number): string {
  return [
    "SELECT i.table AS objectName, i.name AS indexName, i.expr AS indexExpression",
    "FROM system.data_skipping_indices AS i",
    `WHERE i.database = ${literal(database)}`,
    `AND i.table IN (${bulkTargetSql(database, kind, limit)})`,
    "ORDER BY i.table, i.name",
  ].join(" ");
}

/**
 * Every target dictionary's key and attribute columns in ONE statement.
 *
 * `dictionaryColumnsSql()`'s `ORDER BY database DESC LIMIT 1` picks the DDL dictionary over
 * a config one of the same name, and that is a PER NAME choice, so the bulk form cannot use
 * a `LIMIT` at all: it groups by name and takes each array with `argMax(..., database)`,
 * which is the same preference expressed for many names at once. Measured on
 * clickhouse-server 26.7.1.1315 against both fixture dictionaries, and the answer is
 * column-for-column what the single read gives for each of them.
 *
 * The four `key.*` and `attribute.*` names are backtick-quoted here and not in the single
 * read, because inside a function call a dotted name would otherwise parse as tuple access.
 */
function bulkDictionaryColumnsSql(database: string, kind: string, limit?: number): string {
  return [
    "SELECT d.objectName AS objectName, c.1 AS columnName, c.2 AS columnType, c.3 AS isKeyColumn",
    "FROM (SELECT objectName, arrayJoin(arrayConcat(",
    "arrayMap((n, t) -> (n, t, 1), keyNames, keyTypes),",
    "arrayMap((n, t) -> (n, t, 0), attributeNames, attributeTypes))) AS c",
    "FROM (SELECT name AS objectName,",
    "argMax(`key.names`, database) AS keyNames, argMax(`key.types`, database) AS keyTypes,",
    "argMax(`attribute.names`, database) AS attributeNames,",
    "argMax(`attribute.types`, database) AS attributeTypes",
    "FROM system.dictionaries",
    `WHERE (database = ${literal(database)} OR database = '')`,
    `AND name IN (${bulkTargetSql(database, kind, limit)})`,
    "GROUP BY name)) AS d",
  ].join(" ");
}

function objectIndexesSql(database: string, name: string): string {
  return [
    "SELECT i.name AS indexName, i.expr AS indexExpression",
    "FROM system.data_skipping_indices AS i",
    `WHERE i.database = ${literal(database)} AND i.table = ${literal(name)}`,
    "ORDER BY i.name",
  ].join(" ");
}

// ============================================================================
// Derivations over the declaration
// ============================================================================

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by
 * two different rules. `containerDepth()` is what decides, never
 * `containerLevels.length`: absent and empty are the same fact, and two callers
 * reading the field by different rules is how the tree and the API route came to
 * disagree about one engine.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, which is standing ruling 5g's general form: a container level's
 * POSITION is a property of the declaration and not a constant. ClickHouse declares
 * `[schema]`, so the database IS the first segment here, and on the five two-level
 * engines `path[0]` is the catalog - binding it as the database narrows every read to
 * something that does not exist. All three earlier spellings of this defect
 * (`container.length !== 1`, `path[1]` for the object name, `path[0]` for the schema)
 * are depth-identical on a one-level engine, which is exactly why each survived a
 * review round, and why the suite for THIS provider pins them with a two-level
 * declaration swapped in.
 *
 * Both failure modes raise through one guard: a declaration carrying no level of this
 * `id`, and a path too short to hold it. Neither may fall through to `undefined`,
 * which would reach `literal()` as the string "undefined" and quietly read a database
 * of that name.
 */
function containerSegment(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  id: ContainerLevelSpec["id"],
): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === id);
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A ClickHouse path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      PROVIDER,
    );
  }
  return segment;
}

/**
 * The one database a container path names.
 *
 * The expected depth is read through `containerDepth()` and the segment NAMES come
 * from the declared level labels, so the check and its message are the same array and
 * nothing here can inherit a hardcoded `1`. A path of another length is a caller that
 * built it from another engine's model, and it raises rather than reading a segment
 * and carrying on: an empty folder looks exactly like a database holding nothing,
 * which is the worst way to report a caller mistake.
 */
function containerDatabase(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A ClickHouse container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      PROVIDER,
    );
  }
  return containerSegment(capabilities, container, "schema");
}

/**
 * Refuses an object path of the wrong shape, naming the shape it does admit.
 *
 * ONE writer for two readers since #789 Phase 2: `describeObject` and `readObjectSource` ask
 * the same question about the same path, and two copies of this derivation are two chances
 * for the detail pane and the Source tab to disagree about what an object's address is.
 *
 * Derived, not counted. One segment per declared container level plus the name, and the
 * segment NAMES are the declared level labels sliced to the same depth, so the message and
 * the check cannot disagree. No kind here declares `attachedTo`, so there is a single shape
 * rather than the two MySQL accepts.
 */
function assertObjectPathShape(capabilities: ProviderCapabilities, kind: string, path: readonly string[]): void {
  const shape = [...declaredLevels(capabilities).map((level) => level.label.toLowerCase()), "name"];
  if (path.length === shape.length) return;
  throw new QueryError(
    `A ClickHouse "${kind}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
    PROVIDER,
  );
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "ClickHouse has this kind and this database holds none" render
 * as a 0 badge. Building the record from the GROUP BY rows alone would leave the kind
 * out entirely, and an absent kind already means something else and stronger: the
 * engine has no such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the GROUP BY actually answered.
 *
 * A kind that was never seeded is SKIPPED, so the DECLARATION decides which folders
 * exist and a catalog row cannot add one - which is what keeps
 * `tests/helpers/object-surface-conformance.ts`'s "never answers for an undeclared
 * kind" true from this side.
 *
 * `Object.hasOwn` and not `in`, which makes that guarantee absolute rather than nearly
 * so: `in` walks the prototype chain, so a row whose kind read `toString` or
 * `constructor` would pass the test and write a folder the provider never declared.
 */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly ClickHouseRow[]): void {
  for (const row of rows) {
    const kind = readIdentifier(row.objectKind);
    const n = readCount(row.objectCount);
    if (kind !== null && n !== undefined && Object.hasOwn(counts, kind)) counts[kind] = { count: n };
  }
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through the provider's error mapping: that gives a THROWN error a
 * type and this product's prefix, and nothing here throws. The sentence is rendered to
 * a person as the reason a folder has no number, so prefixing it would put our words
 * in front of ClickHouse's. A refused read is never 0 - "Not enough privileges" and
 * "this database holds no tables" are different facts, and `KindCount` is the type
 * that keeps them apart. Both are live cases here: `system.tables` filters by grant
 * while `system.functions` needs one, so a restricted user really does see this.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

// ============================================================================
// The four methods
// ============================================================================

/**
 * The databases this connection can see. One level, so `parent` can only ever name a
 * database, and nothing nests under one here - that answers `[]` rather than raising,
 * because "this level has no children" is a true statement about ClickHouse and not a
 * caller mistake.
 *
 * This is the one place a path is CONSTRUCTED rather than read, which is the single
 * exception standing ruling 5g allows to the no-positional-index rule.
 */
export async function listContainers(transport: ClickHouseTransport, parent?: readonly string[]): Promise<Container[]> {
  if (parent !== undefined && parent.length > 0) return [];

  const result = await transport.query(CONTAINERS_SQL);
  const containers: Container[] = [];
  for (const row of result.rows) {
    const name = readIdentifier(row.containerName);
    if (name === null) continue;
    containers.push({
      path: [name],
      name,
      level: 0,
      // A `UInt8` comparison, so 1 or 0 and never null.
      isSessionDefault: readCount(row.isSessionDefault) === 1,
    });
  }
  return containers;
}

/**
 * How many objects of each declared kind one database holds, in one statement.
 *
 * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
 * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
 * before the read. A kind whose read was refused carries the server's own sentence, so
 * the object browser can say why a folder has no number instead of showing a zero
 * nobody measured.
 *
 * The container path is checked BEFORE the read and raises, because a path of the
 * wrong shape is a caller mistake and not something the engine refused.
 */
export async function countObjects(
  transport: ClickHouseTransport,
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const database = containerDatabase(capabilities, container);
  const declared = declaredKinds(capabilities);
  const counts = seedZeroCounts(declared);

  try {
    const result = await transport.query(countsSql(database));
    applyKindCounts(counts, result.rows);
    return counts;
  } catch (error) {
    return unavailableCounts(
      declared.map((kind) => kind.id),
      error,
    );
  }
}

/**
 * The objects of one kind in one database, names only.
 *
 * Two questions, asked in order, and only the DECLARATION answers the first. Deciding
 * "is this kind declared" from whether a statement exists would make the two methods
 * disagree, and would report "declares no object kind" about a kind
 * `CLICKHOUSE_OBJECT_KINDS` does declare.
 *
 * A FUNCTION is listed under every database, and that is the engine rather than a
 * shortcut: `system.functions` has no database column, because a ClickHouse UDF is
 * server-global - `CREATE FUNCTION` takes no qualified name and the function resolves
 * from any database. So the container segment of a function's path records the
 * container it was REACHED through, not one that owns it. The alternative, showing
 * functions under one chosen database, would leave the folder empty everywhere else
 * while the functions are callable there.
 *
 * Ordering is done here rather than relying on the `ORDER BY` alone: the statement
 * sorts by NAME and the tree addresses by PATH, and a code-point sort over the
 * segments is one rule shared with every other provider in #789.
 */
export async function listObjects(
  transport: ClickHouseTransport,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`ClickHouse declares no object kind "${kind}"`, PROVIDER);
  }
  if (objectCatalog(kind) === undefined) {
    throw new QueryError(`ClickHouse declares the kind "${kind}" but has no statement that lists it`, PROVIDER);
  }
  const database = containerDatabase(capabilities, container);

  const sql = listingSql(database, kind);
  const result = await transport.query(sql);
  const objects: DatabaseObject[] = [];
  for (const row of result.rows) {
    const name = readIdentifier(row.objectName);
    if (name === null) continue;
    objects.push({
      path: [...container, name],
      name,
      kind,
      // Both are `Nullable(UInt64)` and really are null for a view, for a dictionary
      // and for a materialised view with a `TO` clause (measured). Null is UNKNOWN and
      // stays undefined: a view reported as 0 rows and 0 bytes is a measurement nobody
      // took.
      rowCount: readCount(row.objectRows),
      sizeBytes: readCount(row.objectBytes),
    });
  }
  return objects.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * One dictionary's key and attribute columns.
 *
 * `system.dictionaries` is the only catalog BOTH flavours of dictionary are in. The
 * first spelling read `system.columns`, which answers a DDL dictionary's columns
 * (measured) and cannot answer a config-file one's: that dictionary has no
 * `system.tables` row, so it has no `system.columns` row either (measured, count 0).
 *
 * A key column is reported `isPrimary`, which is the catalog's own split rather than a
 * guess. A dictionary has no index - its LAYOUT is not one and
 * `system.data_skipping_indices` holds nothing for it - and no foreign key, the same
 * fact as everywhere else here.
 */
async function describeDictionary(
  transport: ClickHouseTransport,
  path: readonly string[],
  database: string,
  name: string,
): Promise<ObjectDetail> {
  const sql = dictionaryColumnsSql(database, name);
  const rows = (await transport.query(sql)).rows;
  if (rows.length === 0) {
    // A dictionary always declares at least a key, so an empty answer means it is not
    // there under that name, the same reading as the zero-column refusal below.
    throw new QueryError(`No ClickHouse dictionary named ${name} in ${database}`, PROVIDER, sql);
  }

  return dictionaryDetailFromRows(path, rows);
}

/**
 * ONE dictionary's detail, from `system.dictionaries` rows, for BOTH reads (#789).
 *
 * One mapper and not two, because two are two chances for `describeObjects` to spell a
 * dictionary's key column differently from `describeObject` over the same dictionary.
 */
function dictionaryDetailFromRows(path: readonly string[], rows: readonly ClickHouseRow[]): ObjectDetail {
  const columns: ColumnSchema[] = [];
  for (const row of rows) {
    const columnName = readIdentifier(row.columnName);
    if (columnName === null) continue;
    const type = readText(row.columnType);
    columns.push({
      name: columnName,
      type,
      nullable: isNullableType(type),
      isPrimary: row.isKeyColumn === 1,
      defaultValue: undefined,
    });
  }
  // No index and no foreign key: a dictionary's LAYOUT is not an index and
  // `system.data_skipping_indices` holds nothing for it.
  return { path: [...path], columns, indexes: [], foreignKeys: [] };
}

/**
 * ONE table-backed object's detail, from rows, for BOTH reads (#789).
 *
 * The same reasoning as the dictionary mapper above, and the same shape: everything either
 * read needs is on the rows, so the two callers differ only in which statement produced
 * them.
 */
function objectDetailFromRows(
  path: readonly string[],
  columnRows: readonly ClickHouseRow[],
  indexRows: readonly ClickHouseRow[],
): ObjectDetail {
  const columns: ColumnSchema[] = [];
  for (const row of columnRows) {
    const columnName = readIdentifier(row.columnName);
    if (columnName === null) continue;
    // The declared type goes through VERBATIM: collapsing it onto a generic family throws
    // away the wrapper, and the wrapper is the part that says nullable, low-cardinality,
    // parameterised or enumerated.
    const type = readText(row.columnType);
    columns.push({
      name: columnName,
      type,
      nullable: isNullableType(type),
      // `is_in_primary_key` is the authority: the sorting key may extend past the primary
      // key, and those trailing columns are not primary.
      isPrimary: row.isPrimaryKey === 1,
      defaultValue: readDefault(readText(row.defaultKind), readText(row.defaultExpression)),
    });
  }

  const indexes: IndexSchema[] = [];
  for (const row of indexRows) {
    const indexName = readIdentifier(row.indexName);
    if (indexName === null) continue;
    indexes.push({
      name: indexName,
      // A skipping index is declared over an EXPRESSION that may carry commas of its own,
      // so the split is parenthesis-aware and shared with `getSchema()`.
      columns: splitKeyExpression(readText(row.indexExpression)),
      // A data-skipping index prunes granules and enforces nothing, so no index ClickHouse
      // reports is unique. Nor is the primary key: live-verified, three identical values
      // were accepted into a table declared PRIMARY KEY (a).
      unique: false,
    });
  }

  // `foreignKeys` is ALWAYS empty, and that is the engine: ClickHouse parses `REFERENCES`
  // in a column definition and enforces nothing by it, and `system.*` holds no constraint
  // catalog to read one back from.
  return { path: [...path], columns, indexes, foreignKeys: [] };
}

/**
 * Columns and indexes for one object of one KIND.
 *
 * The kind decides everything and nothing here reads the name to work out what it is
 * holding. Only the kinds a catalog answers for - the entries of
 * `CLICKHOUSE_OBJECT_CATALOGS` - have either, so a FUNCTION answers three empty arrays
 * without a round trip. That is a true fact about the kind rather than a failed read,
 * and `tests/helpers/object-surface-conformance.ts` states the same rule from the
 * caller's side.
 *
 * A DICTIONARY does describe, and measured rather than assumed, but out of
 * `system.dictionaries` and NOT `system.columns`: that is the only catalog both flavours
 * are in, because a config-file dictionary has no `system.tables` row and so no
 * `system.columns` row either (measured, count 0). `describeDictionary()` carries the
 * whole measurement. Keying this on the catalog rather than on `role === "relation"` is
 * what makes it come out right, since a dictionary is declared `config`.
 *
 * `foreignKeys` is ALWAYS empty, and that is the engine: ClickHouse parses
 * `REFERENCES` in a column definition and enforces nothing by it, and `system.*` holds
 * no constraint catalog to read one back from. The provider declares
 * `declaresForeignKeys: false` for the same measurement.
 *
 * The index read is NOT degraded to empty on a refusal, unlike `getSchema()`'s.
 * `system.data_skipping_indices` needs its own grant and answers code 497 without it,
 * and "this object has no skipping index" is a different fact from "you may not see
 * its indexes". A detail panel showing the first when the second is true is a claim
 * nobody measured.
 */
export async function describeObject(
  transport: ClickHouseTransport,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  const spec = findKind(capabilities, kind);
  if (spec === undefined) {
    throw new QueryError(`ClickHouse declares no object kind "${kind}"`, PROVIDER);
  }

  assertObjectPathShape(capabilities, kind, path);

  // The same two questions `listObjects` asks, in the same order: the DECLARATION
  // decides whether the kind exists, then the catalog map decides whether anything can
  // read it. A kind added to `CLICKHOUSE_OBJECT_KINDS` alone raised from `listObjects`
  // and answered three empty arrays here, so the tree drew a real-looking empty detail
  // panel for a kind nothing can read.
  const catalog = objectCatalog(kind);
  if (catalog === undefined) {
    throw new QueryError(`ClickHouse declares the kind "${kind}" but has no statement that describes it`, PROVIDER);
  }
  if (catalog === "functions") {
    return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
  }

  // Neither bind is positional. The database comes from the segment the DECLARATION
  // assigns to the `schema` level, and the object's own name is the LAST segment,
  // which is right at every depth.
  const database = containerSegment(capabilities, path, "schema");
  const name = path[path.length - 1];

  if (catalog === "dictionaries") {
    return describeDictionary(transport, path, database, name);
  }

  const columnsSql = objectColumnsSql(database, name);
  const columnRows = (await transport.query(columnsSql)).rows;
  if (columnRows.length === 0) {
    // `CREATE TABLE t ()` is a syntax error on this engine (measured, code 62), so
    // every object the four table-backed kinds cover has at least one column and an
    // empty answer means it is not there under that name in this database.
    throw new QueryError(`No ClickHouse ${kind} named ${name} in ${database}`, PROVIDER, columnsSql);
  }

  const indexRows = (await transport.query(objectIndexesSql(database, name))).rows;

  return objectDetailFromRows(path, columnRows, indexRows);
}

/**
 * Columns and indexes for EVERY object of one kind in one database (#789).
 *
 * THREE round trips for a table-backed folder and TWO for a dictionary folder, constant in
 * the number of objects: the target read plus the detail reads, each of which is the single
 * read's own statement with the name equality replaced by membership of the target set. The
 * caller's alternative was one `describeObject` per object, which is two statements each for
 * a table and one for a dictionary.
 *
 * The four guards are asked in the same order the reference implementation asks them, with
 * this engine's fifth in the place the single read puts it:
 *   1. a kind ClickHouse does not declare RAISES, naming the engine and the kind. An empty
 *      batch would be a claim about the database; an undeclared kind is a fact about the
 *      engine.
 *   2. the container path goes through `containerDatabase`, the same reader `listObjects`
 *      uses, so the depth and the segment-to-level mapping come from the declaration and
 *      never from a position (standing ruling 5g).
 *   3. a `limit` that is not a positive whole number raises rather than clamping. Here that
 *      guard also protects the STATEMENT: the value is interpolated into a `LIMIT` clause,
 *      because this transport binds named parameters only, so a fraction would reach the
 *      server as a syntax error rather than as a bound.
 *   4. a kind DECLARED with no catalog behind it raises differently, exactly as the single
 *      read does: a kind added to `CLICKHOUSE_OBJECT_KINDS` alone would otherwise answer an
 *      empty batch, which reads as a fact about the data.
 *   5. a kind with no columns answers `{ details: [] }` with NO round trip. On this engine
 *      that is `function` alone - a ClickHouse UDF is server-global and resolves in no
 *      column catalog - which is the same fact `describeObject` answers as three empty
 *      arrays. A DICTIONARY is NOT one of them, which is why the rule is keyed on the
 *      CATALOG and not on `role === "relation"`.
 *
 * The bound is the CALLER's. `limit + 1` reaches the target's `LIMIT`, the extra object is
 * dropped and `truncated` carries the caller's own limit; an unbounded call can never
 * report truncation, and nothing here caps the columns of an object.
 *
 * The index read is NOT degraded to empty on a refusal, for the reason the single read
 * gives: "these objects have no skipping index" is a different fact from "you may not see
 * their indexes".
 */
export async function describeObjects(
  transport: ClickHouseTransport,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`ClickHouse declares no object kind "${kind}"`, PROVIDER);
  }
  const database = containerDatabase(capabilities, container);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new QueryError(
      `A ClickHouse bulk column read limit must be a positive whole number, received ${limit}`,
      PROVIDER,
    );
  }
  const catalog = objectCatalog(kind);
  if (catalog === undefined) {
    throw new QueryError(`ClickHouse declares the kind "${kind}" but has no statement that describes it`, PROVIDER);
  }
  if (catalog === "functions") return { details: [] };

  // One row more than the bound, so the read itself says whether it stopped short.
  const bound = limit === undefined ? undefined : limit + 1;
  const targetRows = (await transport.query(bulkTargetSql(database, kind, bound))).rows;
  const targets: string[] = [];
  for (const row of targetRows) {
    const name = readIdentifier(row.objectName);
    if (name !== null) targets.push(name);
  }
  // From the READ and never from `targets`, which is what survived `readIdentifier`. A row
  // this provider cannot read back would otherwise both drop the object and suppress the
  // flag: the caller would get `limit` details and a claim of completeness while `limit + 1`
  // objects exist. Unreachable on today's row shapes and pinned anyway, because nine other
  // providers compute it this way and this is the shape a twelfth implementer copies.
  const truncated = limit !== undefined && targetRows.length > limit;
  // The extra object the `limit + 1` bound brought back is dropped here, so its rows in the
  // groupings below are simply never read.
  const named = truncated ? targets.slice(0, limit) : targets;

  const details =
    catalog === "dictionaries"
      ? await describeDictionaries(transport, container, database, kind, bound, named)
      : await describeRelations(transport, container, database, kind, bound, named);

  // Sorted by PATH, which is what every caller joins the two answers on, and not by the
  // name the statement ordered by: that order is the server's and decides only which
  // objects a bound keeps.
  const sorted = details.sort((left, right) => comparePaths(left.path, right.path));
  return truncated
    ? { details: sorted, truncated: { limit, reason: callerBoundTruncationReason(limit) } }
    : { details: sorted };
}

/** Every target dictionary described, in one statement. */
async function describeDictionaries(
  transport: ClickHouseTransport,
  container: readonly string[],
  database: string,
  kind: string,
  bound: number | undefined,
  named: readonly string[],
): Promise<ObjectDetail[]> {
  const rows = groupRows((await transport.query(bulkDictionaryColumnsSql(database, kind, bound))).rows);
  return named.map((name) => dictionaryDetailFromRows([...container, name], rows.get(name) ?? []));
}

/** Every target table-backed object described, in two statements. */
async function describeRelations(
  transport: ClickHouseTransport,
  container: readonly string[],
  database: string,
  kind: string,
  bound: number | undefined,
  named: readonly string[],
): Promise<ObjectDetail[]> {
  const columns = groupRows((await transport.query(bulkColumnsSql(database, kind, bound))).rows);
  const indexes = groupRows((await transport.query(bulkIndexesSql(database, kind, bound))).rows);
  return named.map((name) =>
    objectDetailFromRows([...container, name], columns.get(name) ?? [], indexes.get(name) ?? []),
  );
}

/** The rows of one bulk statement, grouped by the `objectName` each one carries. */
function groupRows(rows: readonly ClickHouseRow[]): Map<string, ClickHouseRow[]> {
  const grouped = new Map<string, ClickHouseRow[]>();
  for (const row of rows) {
    const name = readIdentifier(row.objectName);
    if (name === null) continue;
    const existing = grouped.get(name);
    if (existing === undefined) grouped.set(name, [row]);
    else existing.push(row);
  }
  return grouped;
}

// ============================================================================
// Object source reading (#789 Phase 2)
// ============================================================================

/**
 * ONE object's definition text, and the whole reason this read takes NO IDENTIFIER
 * POSITION anywhere.
 *
 * `SHOW CREATE TABLE|VIEW|DICTIONARY` is the statement a ClickHouse user knows, and it
 * takes an identifier where a bind would go. On this engine that position is a
 * statement-injection hazard rather than a quoting inconvenience: MEASURED on 26.7.1.1315
 * (#789 probe 11), a backslash inside a QUOTED IDENTIFIER is processed as an ESCAPE in both
 * the double-quote and the backtick form, so `SELECT 1 AS "a\"b"` and `SELECT 1 AS "a""b"`
 * produce the same identifier, and a table created as `"x\\"` stores exactly one trailing
 * backslash. A name ending in one therefore SWALLOWS the closing quote and the parser keeps
 * reading: the same statement with two more aliases fails ten characters later, at the
 * FORMAT clause. `SQLBaseProvider.escapeIdentifier` doubles ONLY the quote character and is
 * unsafe here, and `literal()` below is a STRING escaper whose single quotes are a parse
 * error in an identifier position.
 *
 * So the position is REMOVED rather than escaped. Every one of the three statements here is
 * a `WHERE x = <literal>` read of a system table, which is the same value position the other
 * nine `literal()` call sites in this file use and where the doubled quote plus the escaped
 * backslash are both measured to be correct. Live-verified against the committed fixture's
 * own `` demo.`bs_one\` ``: the escaped spelling reads the object back, and the naive one,
 * with the backslash left alone, answers code 62 `Single quoted string is not closed` having
 * run on into the trailing clause.
 *
 * NOTHING IS LOST BY AVOIDING `SHOW CREATE`, and that is a measurement too rather than an
 * assumption: `formatQuery(create_table_query)` is BYTE-IDENTICAL to what
 * `SHOW CREATE <kind>` answers, for a table, a view, a materialised view and a DDL
 * dictionary alike (measured on 26.7.1.1315 against the fixture: 323, 238 and 212 bytes, and
 * `mv_rollup` identical). The catalog column on its own is a single line, which is the same
 * statement and a much worse thing to hand a reader, so the engine's own formatter is asked
 * for the spelling and the engine's own catalog for the text.
 *
 * A `function` is the one kind NOT formatted, and that is forced rather than chosen:
 * `formatQuery('')` raises code 62 `Empty query`, `system.functions.create_query` really is
 * EMPTY for a non-SQL origin, and turning that per-object refusal into a hard error would
 * take the whole document away. Measured: the formatter leaves the one SQL function's text
 * byte-identical anyway, so the column is read raw.
 *
 * `system.tables.create_table_query` REDACTS a credential. A DDL dictionary comes back
 * carrying `PASSWORD '[HIDDEN]'`, which is the server's own substitution under
 * `format_display_secrets_in_show_and_select = 0`, the default, and `SHOW CREATE` does the
 * same. The text is still `complete`: it is the statement the server publishes for that
 * object, and section 6.2 of docs/providers/clickhouse.md says where the placeholder comes
 * from so a reader is not told a password was lost in transit.
 */
function objectSourceSql(database: string, name: string): string {
  return [
    "SELECT formatQuery(t.create_table_query) AS objectSource",
    "FROM system.tables AS t",
    `WHERE t.database = ${literal(database)} AND t.name = ${literal(name)}`,
  ].join(" ");
}

/**
 * One function's text, with the ORIGIN that says why there may be none.
 *
 * `create_query` carries the statement on 26.7.1.1315 despite the current documentation
 * marking the column Obsolete, and the measurement wins over the label (#789 probe 10). The
 * control that makes it a PER OBJECT fact rather than a server-wide one: all 1858 `System`
 * rows are empty beside the one `SQLUserDefined` row that is not.
 *
 * `origin` is projected because it is the only thing that can say WHICH absence an empty
 * text is. An `ExecutableUserDefined` or `WasmUserDefined` function has no SQL text at all -
 * its body is an external program or a WASM module - and a refusal that did not name the
 * origin would be a guess dressed as the engine's answer.
 */
function functionSourceSql(name: string): string {
  return [
    "SELECT f.origin AS objectOrigin, f.create_query AS objectSource",
    "FROM system.functions AS f",
    `WHERE f.name = ${literal(name)}`,
  ].join(" ");
}

/**
 * Whether a dictionary of this name is declared in a CONFIGURATION FILE, and which one.
 *
 * Asked only after `objectSourceSql()` has answered no row, and it is what separates the two
 * facts that read produces for this kind: a dictionary nobody declared, and a dictionary
 * declared where `system.tables` cannot see it. MEASURED: a config-file dictionary has NO
 * `system.tables` row at all and sits in `system.dictionaries` with an EMPTY `database` and
 * an `origin` naming the file, while a DDL dictionary carries its database and a uuid.
 *
 * `d.database = ''` is that flavour's whole address, because a database cannot be named the
 * empty string, so this question can never be answered by the DDL dictionary the first read
 * already covers.
 *
 * `SHOW CREATE DICTIONARY` is not what asks it. Measured: for the fixture's
 * `dict_regions_config` it answers code 390 CANNOT_GET_CREATE_TABLE_QUERY,
 * "Table `dict_regions_config` doesn't exist.", which is a FALSE claim about a dictionary
 * the server is serving - the same shape as Oracle's ORA-31603 "not found in schema" for an
 * object a caller simply may not read (#789 ruling C). A refusal has to say which absence it
 * is, so this read answers the fact and the sentence is composed from it.
 */
function configDictionarySql(name: string): string {
  return [
    "SELECT d.origin AS objectOrigin",
    "FROM system.dictionaries AS d",
    `WHERE d.name = ${literal(name)} AND d.database = ''`,
  ].join(" ");
}

/**
 * What one source statement produced: a text, a refusal, or a legal absence.
 *
 * Three arms and never one shape with an optional `text`, for the reason `ObjectSourcePart`
 * is a union: a refusal and an absent text are different facts, and one shape carrying both
 * makes them the same value at every call site below.
 */
type SourceRead =
  | { readonly outcome: "text"; readonly text: string }
  | { readonly outcome: "refused"; readonly unavailable: string }
  | { readonly outcome: "absent" };

/**
 * One source statement, with a PRIVILEGE DENIAL classified rather than thrown.
 *
 * MEASURED on 26.7.1.1315, and the two catalogs behave differently, which is why this is one
 * helper rather than an arm on one of them. `system.tables` FILTERS BY GRANT: a user holding
 * only `SELECT ON demo.orders` reads that table's `create_table_query` and gets ZERO ROWS for
 * `customers`, never a denial - so a caller who cannot see an object never lists it and never
 * reaches this read for it. `system.dictionaries` DENIES instead, code 497 as HTTP 500
 * (section 3.3), with the sentence "src_probe: Not enough privileges. To execute this query,
 * it's necessary to have the grant SELECT ON system.dictionaries."
 *
 * That sentence is carried VERBATIM and never through the provider's error mapping, which
 * would put this product's prefix in front of the server's words in a pane whose whole
 * purpose is to show the reader what the server said. Every OTHER failure propagates: a
 * timeout or a dropped socket is nobody answering at all, and rendering it as this object's
 * own refusal would present a symptom as a fact about the object.
 */
async function querySource(
  transport: ClickHouseTransport,
  sql: string,
): Promise<{ readonly rows: readonly ClickHouseRow[] } | { readonly unavailable: string }> {
  try {
    return { rows: (await transport.query(sql)).rows };
  } catch (error) {
    if (error instanceof ClickHouseTransportError && error.is("ACCESS_DENIED")) {
      return { unavailable: error.message };
    }
    throw error;
  }
}

/** One table-backed object's definition: a table, a view, a materialised view or a DDL dictionary. */
async function readTableBackedSource(
  transport: ClickHouseTransport,
  database: string,
  name: string,
): Promise<SourceRead> {
  const answer = await querySource(transport, objectSourceSql(database, name));
  if (!("rows" in answer)) return { outcome: "refused", unavailable: answer.unavailable };
  const row = answer.rows[0];
  if (row === undefined) return { outcome: "absent" };
  const text = readText(row.objectSource);
  if (text.trim() === "") {
    // An empty definition is not a definition. No live row produces one - 0 of 186
    // `system.tables` rows carry an empty `create_table_query`, and `formatQuery` raises
    // code 62 on one rather than answering a blank - so this is the arm that keeps a
    // wire-compatible fork or a future column change from reaching an editor buffer with
    // nothing in it.
    return {
      outcome: "refused",
      unavailable:
        "ClickHouse answered an empty create_table_query for this object, so there is no definition to show. " +
        "The object is in system.tables and the column that carries its CREATE statement is blank.",
    };
  }
  return { outcome: "text", text };
}

/**
 * One function's definition, or the reason its origin has none.
 *
 * The empty text is the LIVE case here rather than the defensive one, which is the exact
 * mirror of the table-backed read above.
 */
async function readFunctionSource(transport: ClickHouseTransport, name: string): Promise<SourceRead> {
  const answer = await querySource(transport, functionSourceSql(name));
  if (!("rows" in answer)) return { outcome: "refused", unavailable: answer.unavailable };
  const row = answer.rows[0];
  if (row === undefined) return { outcome: "absent" };
  const text = readText(row.objectSource);
  if (text.trim() === "") {
    const origin = readIdentifier(row.objectOrigin);
    return {
      outcome: "refused",
      unavailable:
        "ClickHouse publishes no SQL text for this function: system.functions.create_query is empty" +
        // The no-origin arm names the second absence rather than dropping the clause. It is
        // not a live shape - `origin` is an Enum8 and always carries one of its four names -
        // but an arm that produced the EMPTY string was DEAD while raw lcov reported this
        // line as hit, because the truthy arm is on the same physical line (standing ruling
        // 5b, #789). It is driven in the suite by a server answering a blank origin.
        (origin === null ? " and system.functions reports no origin for it" : ` and its origin is ${origin}`) +
        ". A function whose body is an external program or a WASM module has no SQL definition to read.",
    };
  }
  return { outcome: "text", text };
}

/**
 * One dictionary's definition, and the SECOND question a missing row makes it ask.
 *
 * A DDL dictionary is read exactly as a table is, out of `system.tables`. Nothing there means
 * one of two facts and they must not be reported as one: a CONFIG-FILE dictionary, which the
 * server is serving and publishes no CREATE statement for, and no dictionary of that name at
 * all. The second read answers which, and only the first of the two is a refusal - the second
 * raises, because an object the provider cannot find never answers a document (#789).
 */
async function readDictionarySource(
  transport: ClickHouseTransport,
  database: string,
  name: string,
): Promise<SourceRead> {
  const first = await readTableBackedSource(transport, database, name);
  if (first.outcome !== "absent") return first;

  const answer = await querySource(transport, configDictionarySql(name));
  if (!("rows" in answer)) return { outcome: "refused", unavailable: answer.unavailable };
  const row = answer.rows[0];
  if (row === undefined) return { outcome: "absent" };
  const origin = readIdentifier(row.objectOrigin);
  return {
    outcome: "refused",
    unavailable:
      "ClickHouse publishes no CREATE DICTIONARY statement for this dictionary: " +
      // Two WHOLE clauses rather than a name interpolated into one sentence. The earlier
      // spelling put the fallback inside the phrase "the configuration file X", so a server
      // reporting no origin produced "the configuration file system.dictionaries reports no
      // origin for, not in SQL", which is broken prose shown to a reader as the engine's own
      // fact. That arm was DEAD while raw lcov reported the line as hit (standing ruling 5b,
      // #789); both arms are driven in the suite now.
      (origin === null
        ? "it is declared outside SQL and system.dictionaries reports no origin for it"
        : `it is declared in the configuration file ${origin}, not in SQL`) +
      ", so it has no system.tables row to read one from. SHOW CREATE DICTIONARY answers that the table does " +
      "not exist for it, which is a false claim about a dictionary this server is serving.",
  };
}

/**
 * One read as the part a document carries.
 *
 * The two arms are built as WHOLE LITERALS and neither is spread from the other, which is the
 * point rather than a style. A part carrying BOTH `text` and `unavailable` COMPILES as an
 * `ObjectSourcePart`, because TypeScript's excess-property check on a union admits any
 * property declared on ANY member of it, and `isSourcePartUnavailable` then narrows such a
 * part to the refusal arm and drops a definition the engine really returned. This function
 * cannot build one: the refusal arm returns before the text arm is reached and neither
 * literal mentions the other's keys (#789).
 */
function sourcePart(
  read: SourceRead & { readonly outcome: "text" | "refused" },
  language: string,
  limit: number | undefined,
): ObjectSourcePart {
  if (read.outcome === "refused") {
    return { id: SOURCE_PART_ID, label: SOURCE_PART_LABEL, unavailable: read.unavailable };
  }
  const bounded = applySourceBound(read.text, limit);
  return {
    id: SOURCE_PART_ID,
    label: SOURCE_PART_LABEL,
    text: bounded.text,
    language,
    // The statement runs as given, so `complete`; the server REBUILT it from its own catalog
    // rather than storing what the author typed, so `regenerated`. Measured: a table created
    // as `total Decimal(12, 2) DEFAULT 0` comes back backquoted, with a `SETTINGS
    // index_granularity = 8192` clause nobody wrote, and a reader must never be shown a
    // reconstruction as an original.
    form: "complete",
    origin: "regenerated",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/** Every part this engine emits is the object's whole definition, so there is one id and one label. */
const SOURCE_PART_ID = "definition";
const SOURCE_PART_LABEL = "Definition";

/**
 * One object's definition text (#789 Phase 2).
 *
 * EVERY declared kind can answer, so there is no kind here that declares nothing. The
 * DECLARATION is what decides, read off `objectKinds` and never off a list of kind ids kept
 * beside it, and the catalog map decides which statement reads it - the same two questions,
 * in the same order, that `listObjects` and `describeObject` ask.
 *
 * ONE PART per document. No ClickHouse object is two texts: there is no package, no spec and
 * body split, and a materialised view's implicit inner table is storage the server created
 * rather than a second definition of the view (it is excluded from the tree for that reason,
 * see this file's docblock).
 *
 * The database is the container segment the DECLARATION names `schema` and the object's own
 * name is `path[path.length - 1]`, never a literal index (standing ruling 5g), pinned in this
 * provider's suite by a two-level declaration AND by one that swaps the two levels over.
 *
 * A FUNCTION is server-global and its path's container segment records where it was reached
 * from rather than something that owns it, exactly as the listing says, so that segment is
 * deliberately not part of the statement that reads it.
 */
export async function readObjectSource(
  transport: ClickHouseTransport,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const spec = requireSourceKind(capabilities, kind, { displayName: "ClickHouse", type: PROVIDER });
  assertObjectPathShape(capabilities, kind, path);
  const catalog = objectCatalog(kind);
  if (catalog === undefined) {
    throw new QueryError(
      `ClickHouse declares readable source for the kind "${kind}" but has no statement that reads it`,
      PROVIDER,
    );
  }

  const database = containerSegment(capabilities, path, "schema");
  const name = path[path.length - 1];
  const read =
    catalog === "functions"
      ? await readFunctionSource(transport, name)
      : catalog === "dictionaries"
        ? await readDictionarySource(transport, database, name)
        : await readTableBackedSource(transport, database, name);

  if (read.outcome === "absent") {
    // Absence RAISES and is never a refusal part: the document's `parts` tuple leaves no
    // empty value for an absence to be confused with, and a refusal sentence over an object
    // nobody found would be a claim about the wrong thing. The sentence names the object's
    // last segment, which is the identifier the caller asked under.
    throw new QueryError(
      catalog === "functions"
        ? `No ClickHouse function named ${name}`
        : `No ClickHouse ${kind} named ${name} in ${database}`,
      PROVIDER,
    );
  }

  // An array LITERAL, which is what satisfies the non-empty tuple. `rows.map(...)` does not,
  // and casting past it would defeat the invariant the tuple exists for.
  const parts: [ObjectSourcePart] = [sourcePart(read, spec.sourceLanguage, limit)];
  return { path: [...path], kind, parts };
}
