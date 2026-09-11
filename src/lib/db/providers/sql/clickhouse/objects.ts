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
import { containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import type {
  ColumnSchema,
  Container,
  ContainerLevelSpec,
  DatabaseObject,
  IndexSchema,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
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
import type { ClickHouseRow, ClickHouseTransport } from "./transport";

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
export const CLICKHOUSE_CONTAINER_LEVELS: readonly ContainerLevelSpec[] = Object.freeze([
  { id: "schema", label: "Database", labelPlural: "Databases" },
] as const);

export const CLICKHOUSE_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  {
    id: "materialized_view",
    role: "relation",
    label: "Materialized View",
    labelPlural: "Materialized Views",
  },
  { id: "dictionary", role: "config", label: "Dictionary", labelPlural: "Dictionaries" },
  { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
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

/**
 * Two paths compared SEGMENT BY SEGMENT, so a sort is over the address and never over
 * one joined string.
 *
 * `JSON.stringify(path)` is the obvious spelling and it is wrong twice. At MIXED DEPTH
 * the deeper path sorts first, because the separator `,` (0x2C) is below the
 * terminator `]` (0x5D). And JSON ESCAPES, so a name holding a quote, a backslash or a
 * control character sorts by its escape sequence rather than by its own code points -
 * and ClickHouse accepts all three in a backquoted identifier, measured.
 *
 * This is the fifth copy of this function in the repo. Standing ruling 5h: Task 28
 * hoists it beside `containerDepth` in `src/lib/db/object-kinds.ts` once, rather than
 * each provider task hoisting it and colliding with the others.
 */
export function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
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
  return { path: [...path], columns, indexes: [], foreignKeys: [] };
}

/**
 * Columns and indexes for one object of one KIND.
 *
 * The kind decides everything and nothing here reads the name to work out what it is
 * holding. Only the kinds `system.columns` resolves - the `tables` entries of
 * `CLICKHOUSE_OBJECT_CATALOGS` - have either, so a FUNCTION answers three empty arrays
 * without a round trip. That is a true fact about the kind rather than a failed read,
 * and `tests/helpers/object-surface-conformance.ts` states the same rule from the
 * caller's side.
 *
 * A DICTIONARY does describe, and measured rather than assumed: `system.columns`
 * answers its key and attribute columns, because a dictionary is a table underneath
 * (engine `Dictionary`). Keying this on the catalog rather than on
 * `role === "relation"` is what makes that come out right.
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

  // Derived, not counted. One segment per declared container level plus the name, and
  // the segment NAMES are the declared level labels sliced to the same depth, so the
  // message and the check cannot disagree. No kind here declares `attachedTo`, so
  // there is a single shape rather than the two MySQL accepts.
  const shape = [...declaredLevels(capabilities).map((level) => level.label.toLowerCase()), "name"];
  if (path.length !== shape.length) {
    throw new QueryError(
      `A ClickHouse "${kind}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
      PROVIDER,
    );
  }

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

  const columns: ColumnSchema[] = [];
  for (const row of columnRows) {
    const columnName = readIdentifier(row.columnName);
    if (columnName === null) continue;
    // The declared type goes through VERBATIM: collapsing it onto a generic family
    // throws away the wrapper, and the wrapper is the part that says nullable,
    // low-cardinality, parameterised or enumerated.
    const type = readText(row.columnType);
    columns.push({
      name: columnName,
      type,
      nullable: isNullableType(type),
      // `is_in_primary_key` is the authority: the sorting key may extend past the
      // primary key, and those trailing columns are not primary.
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
      // A skipping index is declared over an EXPRESSION that may carry commas of its
      // own, so the split is parenthesis-aware and shared with `getSchema()`.
      columns: splitKeyExpression(readText(row.indexExpression)),
      // A data-skipping index prunes granules and enforces nothing, so no index
      // ClickHouse reports is unique. Nor is the primary key: live-verified, three
      // identical values were accepted into a table declared PRIMARY KEY (a).
      unique: false,
    });
  }

  return { path: [...path], columns, indexes, foreignKeys: [] };
}
