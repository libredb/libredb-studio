/**
 * Druid object surface (issue #789)
 *
 * One container level and three kinds, all of them read out of `INFORMATION_SCHEMA`
 * through the same transport seam every other read in this provider uses, so this
 * file names no header, no request field and no endpoint.
 *
 * This is the engine of honest absence, and that is the point of it. Druid has no
 * view, no materialized view, no user-defined function, no stored procedure and no
 * trigger, so none of them is declared and the tree draws no folder for any of them.
 * Measured on 37.0.0 rather than read: `CREATE` in ANY form is a syntax error, and the
 * parser answers by listing every statement it expected - INSERT, UPSERT, EXPLAIN,
 * SET, RESET, ALTER, WITH, SELECT, VALUES ... - with no form of CREATE among them. A
 * declared kind draws a folder, and a folder for a concept the engine cannot have is a
 * lie its 0 badge makes look like a fact.
 *
 * Five measurements against Apache Druid 37.0.0 shape everything below. The fixture
 * they were taken against is `docker/druid-init/`, mounted into the Router by
 * `database-compose.yml`, so every one of them can be re-run rather than believed.
 *
 * 1. A LOOKUP IS IN SQL, and the plan behind this work said it was not. A lookup that
 *    the Broker has LOADED has a row in `INFORMATION_SCHEMA.TABLES` with
 *    `TABLE_SCHEMA = 'lookup'` and `TABLE_TYPE = 'TABLE'`, its `k` and `v` columns are
 *    in `INFORMATION_SCHEMA.COLUMNS`, and `SELECT * FROM lookup.<name>` returns its
 *    pairs. So the kind needs no second transport: the Coordinator's REST API is how a
 *    lookup is REGISTERED, not how it is read. The one caveat, measured: a lookup that
 *    is registered and not yet loaded has no row anywhere in SQL, so this surface shows
 *    what is queryable and nothing else, which is the honest half of the pair.
 * 2. `INFORMATION_SCHEMA.SCHEMATA` reports FIVE schemas on a bare cluster -
 *    `INFORMATION_SCHEMA`, `druid`, `lookup`, `sys` and `view` - so the container list
 *    is READ rather than hardcoded to the three a person would name. `view` is there
 *    even though this build can hold no view; it is the engine's own answer, and a
 *    container that holds nothing is a true statement while a container we withheld is
 *    not.
 * 3. `sys` and `INFORMATION_SCHEMA` hold ten system tables between them, and they are
 *    ordinary queryable objects. `TABLE_TYPE = 'SYSTEM_TABLE'` is the engine's own word
 *    for them, so `system_table` is a declared kind: without it both of those
 *    containers would open onto nothing at all while `sys.segments` is right there to
 *    be selected from.
 * 4. `INFORMATION_SCHEMA.ROUTINES` holds 228 rows and every one of them is BUILT IN -
 *    `ROUTINE_TYPE` is `FUNCTION` for all 228 and `CREATE FUNCTION` does not parse. A
 *    `function` kind here would therefore be a folder holding the engine's operator
 *    reference manual rather than anything a person made, which is why the routine
 *    catalog is deliberately not read.
 * 5. A BACKSLASH IS NOT AN ESCAPE inside a Druid string literal: measured,
 *    `SELECT LENGTH('a\b')` is 3 and `SELECT LENGTH('a\\b')` is 4. Doubling the quote
 *    is therefore the whole escape, unlike ClickHouse where both apply. The fixture
 *    carries a datasource called `libredb_o'brien` so that claim is exercised rather
 *    than asserted.
 *
 * No kind declares `acceptsRowWrites`. Druid SQL has no row-level DML at all - `UPDATE`
 * answers `Unsupported SQL statement [UPDATE]` - which is the same measurement behind
 * the provider's `supportsInlineRowEdit: false`.
 *
 * Nothing here reads `sys` and that is deliberate, for the reason `introspect.ts`
 * states about the schema tree: a cluster running `druid-basic-security` grants the
 * `sys` schema separately from the catalogs, so a row count taken from `sys.segments`
 * would make the whole object tree fail on a cluster that merely declines to describe
 * its segments. A datasource's rows and bytes stay out of `DatabaseObject` for that
 * price, and they are already on the Tables panel, which is allowed to lose one panel.
 */

import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason, containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import type {
  Container,
  ContainerLevelSpec,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import { DRUID_CLIENT_DEADLINE_GRACE_MS, type DruidRow, type DruidTransport } from "./transport";
import { DRUID_SCHEMA_NAME, DRUID_SYSTEM_READ_TIMEOUT_MS, readColumn, readIdentifier } from "./introspect";

const PROVIDER = "druid" as const;

/** Narrower than the whole transport: this module never opens or closes anything. */
type DruidQueryRunner = Pick<DruidTransport, "query">;

// ============================================================================
// Declaration
// ============================================================================

/**
 * One level, and there is no second one to add.
 *
 * `INFORMATION_SCHEMA.SCHEMATA` reports exactly one catalog, always `druid`, so a
 * catalog level would be a folder with one child forever. The level's structural `id`
 * is `schema` because that is what `ContainerLevelSpec` calls the innermost level on
 * every engine, and here the engine's own word is Schema as well.
 */
export const DRUID_CONTAINER_LEVELS: readonly ContainerLevelSpec[] = Object.freeze([
  { id: "schema", label: "Schema", labelPlural: "Schemas" },
] as const);

/**
 * The three kinds Druid has. Read the docblock at the top of this file for the five
 * this engine does NOT have and why each one is absent rather than declared empty.
 *
 * `lookup` is `config` because that is what it is: a lookup is defined by the JSON map
 * posted to the Coordinator, not by DDL, and `ObjectRole` names a Druid lookup as the
 * example of that role. It is nonetheless queryable, which is why it is in this list at
 * all rather than only in a settings panel somewhere.
 */
export const DRUID_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  { id: "datasource", role: "relation", label: "Datasource", labelPlural: "Datasources" },
  { id: "lookup", role: "config", label: "Lookup", labelPlural: "Lookups" },
  { id: "system_table", role: "relation", label: "System Table", labelPlural: "System Tables" },
] as const);

// ============================================================================
// SQL
// ============================================================================

/**
 * A value as a Druid string literal.
 *
 * Doubling the quote is the COMPLETE escape here, and that is measured rather than
 * assumed: a backslash is an ordinary character inside a Druid literal
 * (`SELECT LENGTH('a\b')` is 3), unlike ClickHouse where it escapes and both rules have
 * to be applied. Adding a backslash rule anyway would be worse than useless - it would
 * corrupt every name that legitimately holds one.
 *
 * This is the only way a caller-supplied name reaches a statement in this file. The
 * transport does bind positional parameters, and they are deliberately not used for a
 * catalog read: these statements are built once per call and the literal keeps the
 * exported statement text complete, which is what the tests pin.
 */
function druidLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Every schema the cluster publishes, in the server's own order.
 *
 * Not hardcoded to `druid`, `sys` and `lookup`: `INFORMATION_SCHEMA` and `view` are
 * both real schemas on a bare 37.0.0 cluster, the first holding four system tables and
 * the second holding nothing. Listing what the server answers is what keeps this right
 * on a cluster whose extensions publish a schema this code has never heard of.
 */
const DRUID_CONTAINER_LIST_SQL = [
  'SELECT SCHEMA_NAME AS "containerName"',
  "FROM INFORMATION_SCHEMA.SCHEMATA",
  "ORDER BY SCHEMA_NAME",
].join(" ");

/**
 * The schema a LOOKUP lives in, which is the only thing that tells a lookup and a
 * datasource apart: both carry `TABLE_TYPE = 'TABLE'` (measured), so the type alone
 * cannot distinguish them.
 */
const DRUID_LOOKUP_SCHEMA_NAME = "lookup";

/**
 * The kind expression, and it is TOTAL by construction.
 *
 * Every row of `INFORMATION_SCHEMA.TABLES` maps to exactly one declared kind, because
 * the last arm has no predicate. That is standing ruling 5a's requirement stated as
 * code: a `TABLE_TYPE` this build has never seen still reaches the tree as a
 * datasource, whereas an inclusion list of known types would drop it out of the count
 * AND the listing at once, which keeps the badge agreeing with the folder while the
 * object cannot be reached at all.
 *
 * The order of the arms is load-bearing and comes from the measurement: a lookup and a
 * datasource BOTH carry `TABLE_TYPE = 'TABLE'`, so the type alone cannot tell them
 * apart and the schema is what does. The system-table arm is first because
 * `TABLE_TYPE` answers it exactly, in both `sys` and `INFORMATION_SCHEMA`.
 */
const OBJECT_KIND_EXPR = [
  "CASE WHEN TABLE_TYPE = 'SYSTEM_TABLE' THEN 'system_table'",
  `WHEN TABLE_SCHEMA = ${druidLiteral(DRUID_LOOKUP_SCHEMA_NAME)} THEN 'lookup'`,
  "ELSE 'datasource' END",
].join(" ");

/**
 * Every object of every declared kind in one schema, kind-tagged, as ONE subquery.
 *
 * The count GROUPs this text and the listing FILTERs it, so standing ruling 5f holds by
 * construction rather than by two statements agreeing: there is no second WHERE clause
 * for the two to drift apart in.
 *
 * Every alias is double-quoted, which is not decoration on this engine: Calcite's
 * reserved-word list is large enough that `SELECT 1 AS one` is a syntax error.
 */
function schemaObjectsSql(schema: string): string {
  return [
    'SELECT TABLE_NAME AS "objectName",',
    `${OBJECT_KIND_EXPR} AS "objectKind"`,
    "FROM INFORMATION_SCHEMA.TABLES",
    `WHERE TABLE_SCHEMA = ${druidLiteral(schema)}`,
  ].join(" ");
}

function druidCountsSql(schema: string): string {
  return [
    'SELECT "objectKind", COUNT(*) AS "objectCount"',
    `FROM (${schemaObjectsSql(schema)})`,
    'GROUP BY "objectKind"',
  ].join(" ");
}

/**
 * The objects of one kind in one schema, optionally bounded.
 *
 * ONE builder for the listing and for the bulk read's target, so the two answers are
 * joined on an address both of them derived the same way rather than on two spellings
 * that happen to agree today.
 *
 * `limit` is INTERPOLATED rather than bound, because this transport sends a statement as
 * text and the catalog reads in this file use no parameter channel at all. That is safe
 * by construction rather than by inspection: `describeObjects` refuses a limit that is
 * not a positive whole number BEFORE it reaches here, so nothing but digits can arrive.
 * Measured on 37.0.0: `ORDER BY` and `LIMIT` are both accepted inside a subquery, and the
 * `LIMIT` belongs in the TARGET rather than on the joined rows - on the outer statement it
 * would cut columns instead of objects.
 */
function druidListingSql(schema: string, kind: string, limit?: number): string {
  return [
    'SELECT "objectName"',
    `FROM (${schemaObjectsSql(schema)})`,
    `WHERE "objectKind" = ${druidLiteral(kind)}`,
    'ORDER BY "objectName"',
    ...(limit === undefined ? [] : [`LIMIT ${limit}`]),
  ].join(" ");
}

/**
 * Every object of one kind in one schema with its columns, in ONE round trip.
 *
 * A LEFT JOIN and not an inner one, and that is the membership rule rather than a style
 * choice: the set of objects is what the TARGET read answered, so an object whose column
 * read returns nothing is still in the batch. Druid says that cannot happen - a datasource
 * always has `__time`, a lookup always has `k` and `v` - but a bulk read whose membership
 * came from the COLUMN catalog would lose an object the folder lists the moment one did,
 * which is the invisible absence standing ruling 5a exists for.
 *
 * Measured on Apache Druid 37.0.0: `INFORMATION_SCHEMA` really does join. Calcite answers
 * this locally rather than planning a Druid query, so none of the engine's broadcast-side
 * join restrictions applies, and the same statement with an inner join, an `IN` subquery
 * and a plain two-statement form were all run against the cluster before this one was
 * chosen.
 *
 * `ORDINAL_POSITION` orders the columns and never appears in the projection: it IS the
 * declared order, the same rule the single read uses.
 */
function druidBulkColumnsSql(schema: string, kind: string, limit?: number): string {
  return [
    'SELECT t."objectName" AS "tableName", c.COLUMN_NAME AS "columnName",',
    'c.DATA_TYPE AS "dataType", c.IS_NULLABLE AS "isNullable"',
    `FROM (${druidListingSql(schema, kind, limit)}) t`,
    `LEFT JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = ${druidLiteral(schema)}`,
    'AND c.TABLE_NAME = t."objectName"',
    'ORDER BY t."objectName", c.ORDINAL_POSITION',
  ].join(" ");
}

/**
 * One object's columns, in declared order.
 *
 * `ORDINAL_POSITION` orders the read rather than appearing in it: it IS the declared
 * order. `tableName` is projected although the statement already names one table, so
 * the rows can go through `readColumn()`, the same mapper `getSchema()` uses - which is
 * what keeps the object detail and the sidebar from ever describing one datasource's
 * columns two different ways.
 *
 * One statement serves all three kinds, and that is the engine rather than a shortcut:
 * `INFORMATION_SCHEMA.COLUMNS` answers for a datasource, for a lookup's `k` and `v`,
 * and for a `sys` table alike (measured: 11, 4 and 66 rows for the fixture's schemas).
 */
function druidObjectColumnsSql(schema: string, name: string): string {
  return [
    'SELECT TABLE_NAME AS "tableName", COLUMN_NAME AS "columnName",',
    'DATA_TYPE AS "dataType", IS_NULLABLE AS "isNullable"',
    "FROM INFORMATION_SCHEMA.COLUMNS",
    `WHERE TABLE_SCHEMA = ${druidLiteral(schema)} AND TABLE_NAME = ${druidLiteral(name)}`,
    "ORDER BY ORDINAL_POSITION",
  ].join(" ");
}

// ============================================================================
// Derivations over the declaration
// ============================================================================

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports. One reader for the whole file, so the depth and the level list can never be
 * taken by two different rules, and `containerLevels.length` is never the authority:
 * absent and empty are the same fact.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, which is standing ruling 5g's general form: a container level's
 * POSITION is a property of the declaration and not a constant. Druid declares
 * `[schema]`, so the schema IS the first segment here, and on a two-level engine
 * `path[0]` is the catalog - binding it as the schema narrows every read to something
 * that does not exist. All three earlier spellings of this defect are depth-identical
 * on a one-level engine, which is exactly why each survived a review round, and why
 * this provider's suite pins them with a two-level declaration swapped in.
 *
 * Both failure modes raise through one guard: a declaration carrying no level of this
 * `id`, and a path too short to hold it. Neither may fall through to `undefined`, which
 * would reach `druidLiteral()` as the string "undefined" and quietly read a schema of
 * that name.
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
      `A Druid path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      PROVIDER,
    );
  }
  return segment;
}

/**
 * The one schema a container path names.
 *
 * The expected depth is read through `containerDepth()` and the level NAMES come from
 * the declaration, so the check and its message are the same array and nothing here can
 * inherit a hardcoded 1. A path of another length is a caller that built it from
 * another engine's model, and it raises rather than reading a segment and carrying on:
 * an empty folder looks exactly like a schema holding nothing, which is the worst way
 * to report a caller mistake.
 */
function containerSchema(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A Druid container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      PROVIDER,
    );
  }
  return containerSegment(capabilities, container, "schema");
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "Druid has this kind and this schema holds none" render as a 0
 * badge, and on this engine that is the ordinary case rather than the exception: the
 * `druid` schema holds no lookup and no system table, and the `lookup` schema holds
 * nothing else. Building the record from the GROUP BY rows alone would leave those
 * kinds out entirely, and an absent kind already means something else and stronger: the
 * engine has no such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the GROUP BY actually answered.
 *
 * A kind that was never seeded is SKIPPED, so the DECLARATION decides which folders
 * exist and a catalog row cannot add one. `Object.hasOwn` and not `in`, which makes
 * that absolute rather than nearly so: `in` walks the prototype chain, so a row whose
 * kind read `toString` would pass the test and write a folder nobody declared.
 */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly DruidRow[]): void {
  for (const row of rows) {
    const kind = readIdentifier(row.objectKind);
    const count = row.objectCount;
    if (kind === null || !Object.hasOwn(counts, kind)) continue;
    // A COUNT arrives as a JSON number, and as a decimal STRING once the transport has
    // quoted it out of the unsafe integer range. Both encodings reach here.
    const parsed = typeof count === "number" ? count : Number(count);
    if (Number.isFinite(parsed)) counts[kind] = { count: parsed };
  }
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through the provider's error mapping: that gives a THROWN error a
 * type and this product's prefix, and nothing here throws. The sentence is rendered to
 * a person as the reason a folder has no number, so prefixing it would put our words in
 * front of Druid's. A refused read is never 0: a `druid-basic-security` cluster answers
 * FORBIDDEN for a schema a role may not see, and "you may not read this" and "this
 * schema holds nothing" are different facts that `KindCount` is the type for.
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
 * the deeper path sorts first, because the separator `,` (0x2C) is below the terminator
 * `]` (0x5D). And JSON ESCAPES, so a name holding a quote or a backslash sorts by its
 * escape sequence rather than by its own code points, and a Druid datasource name may
 * hold both: `libredb_o'brien` is in the fixture.
 *
 * This is the sixth copy of this function in the repo. Standing ruling 5h: Task 28
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

/**
 * One catalog read, with both deadlines armed the way every other read here arms them.
 *
 * The client half is deliberately LATER than the server half: equal deadlines are a
 * race the client wins, and winning it throws away Druid's classified TIMEOUT envelope
 * in favour of a bare abort.
 *
 * Unlike `introspect.ts`'s `readRows`, a refusal is NOT degraded to an empty array
 * here. An empty answer means "this schema holds none", and the object tree has
 * `KindCount.unavailable` to say "you may not see them" instead, so flattening the two
 * would report a permission failure as a measurement.
 */
async function readRows(runner: DruidQueryRunner, sql: string): Promise<DruidRow[]> {
  const result = await runner.query(sql, {
    timeoutMs: DRUID_SYSTEM_READ_TIMEOUT_MS,
    clientDeadlineMs: DRUID_SYSTEM_READ_TIMEOUT_MS + DRUID_CLIENT_DEADLINE_GRACE_MS,
  });
  return result.rows;
}

/**
 * Where one object of any declared kind is addressed.
 *
 * ONE builder for the listing, the single read and the bulk read, because every caller
 * joins those answers on path: two spellings that agree today are two chances for them to
 * stop agreeing. No kind here declares `attachedTo`, so there is a single shape.
 */
function objectPath(container: readonly string[], name: string): string[] {
  return [...container, name];
}

/**
 * One object's rows as an `ObjectDetail`.
 *
 * The SHARED mapper, used by the single read and the bulk read alike. Two copies are two
 * chances for the bulk read to spell a column's type differently from the single read of
 * the same datasource.
 *
 * `indexes` and `foreignKeys` are empty BY CONSTRUCTION rather than by omission: Druid has
 * no user-defined index and no foreign key anywhere, which is the same measurement behind
 * the provider's `declaresForeignKeys: false`.
 */
function objectDetail(path: readonly string[], rows: readonly DruidRow[]): ObjectDetail {
  const columns = rows
    .map((row) => readColumn(row))
    .filter((owned) => owned !== null)
    .map((owned) => owned.column);
  return { path: [...path], columns, indexes: [], foreignKeys: [] };
}

// ============================================================================
// The four methods
// ============================================================================

/**
 * The schemas this cluster publishes. One level, so `parent` can only ever name a
 * schema, and nothing nests under one - that answers `[]` rather than raising, because
 * "this level has no children" is a true statement about Druid and not a caller
 * mistake.
 *
 * This is the one place a path is CONSTRUCTED rather than read, which is the single
 * exception standing ruling 5g allows to the no-positional-index rule.
 *
 * `isSessionDefault` is `druid` and it is a fact rather than a guess: a Druid
 * connection carries no schema to choose, `SELECT * FROM "libredb_demo"` resolves
 * unqualified, and `INFORMATION_SCHEMA.SCHEMATA` reports one catalog. There is no
 * `CURRENT_SCHEMA` to ask instead - measured, it is "Column 'CURRENT_SCHEMA' not found
 * in any table" - so the constant the whole provider already shares is the answer.
 */
export async function listContainers(runner: DruidQueryRunner, parent?: readonly string[]): Promise<Container[]> {
  if (parent !== undefined && parent.length > 0) return [];

  const rows = await readRows(runner, DRUID_CONTAINER_LIST_SQL);
  const containers: Container[] = [];
  for (const row of rows) {
    const name = readIdentifier(row.containerName);
    if (name === null) continue;
    containers.push({ path: [name], name, level: 0, isSessionDefault: name === DRUID_SCHEMA_NAME });
  }
  return containers;
}

/**
 * How many objects of each declared kind one schema holds, in one statement.
 *
 * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
 * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
 * before the read. A kind whose read was refused carries the server's own sentence.
 *
 * The container path is checked BEFORE the read and raises, because a path of the wrong
 * shape is a caller mistake and not something the engine refused.
 */
export async function countObjects(
  runner: DruidQueryRunner,
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const schema = containerSchema(capabilities, container);
  const declared = declaredKinds(capabilities);
  const counts = seedZeroCounts(declared);

  try {
    applyKindCounts(counts, await readRows(runner, druidCountsSql(schema)));
    return counts;
  } catch (error) {
    return unavailableCounts(
      declared.map((kind) => kind.id),
      error,
    );
  }
}

/**
 * The objects of one kind in one schema, names only.
 *
 * Whether the kind exists is answered by the DECLARATION and by nothing else. Deciding
 * it from whether a statement exists would make the two methods disagree, and would
 * report "declares no object kind" about a kind `DRUID_OBJECT_KINDS` does declare.
 *
 * No `rowCount` and no `sizeBytes`: both would have to come from `sys.segments`, which
 * this surface deliberately never reads (see this file's docblock), and a datasource
 * reported as 0 rows because a grant was missing is a measurement nobody took.
 *
 * Ordering happens here rather than relying on the `ORDER BY` alone: the statement
 * sorts by NAME and the tree addresses by PATH, and a code-point sort over the segments
 * is one rule shared with every other provider in #789.
 */
export async function listObjects(
  runner: DruidQueryRunner,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`Druid declares no object kind "${kind}"`, PROVIDER);
  }
  const schema = containerSchema(capabilities, container);

  const rows = await readRows(runner, druidListingSql(schema, kind));
  const objects: DatabaseObject[] = [];
  for (const row of rows) {
    const name = readIdentifier(row.objectName);
    if (name === null) continue;
    objects.push({ path: objectPath(container, name), name, kind });
  }
  return objects.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * One object's columns, whatever its kind.
 *
 * Every declared kind has columns and all three come out of the same catalog, which is
 * measured rather than assumed: a lookup answers `k` and `v`, a `sys` table answers its
 * own, and a datasource answers its dimensions and metrics. So there is no per-kind
 * branch here and no kind that answers three empty arrays.
 *
 * `indexes` and `foreignKeys` are empty BY CONSTRUCTION rather than by omission. Druid
 * has no user-defined index - every dimension is indexed inside the segment, and there
 * is no DDL that could declare one - and no foreign key anywhere, which is the same
 * measurement behind the provider's `declaresForeignKeys: false`. `isPrimary` is false
 * for every column including `__time`, which `readColumn()` owns and states in full:
 * `__time` is mandatory and sorted and is NOT unique, and `isPrimary` means PRIMARY KEY
 * to every consumer of it.
 */
export async function describeObject(
  runner: DruidQueryRunner,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`Druid declares no object kind "${kind}"`, PROVIDER);
  }

  // Derived, not counted: one segment per declared container level plus the name, and
  // the segment NAMES are the declared level labels sliced to the same depth, so the
  // message and the check cannot disagree. No kind here declares `attachedTo`, so there
  // is a single shape rather than the two MySQL accepts.
  const shape = [...declaredLevels(capabilities).map((level) => level.label.toLowerCase()), "name"];
  if (path.length !== shape.length) {
    throw new QueryError(`A Druid "${kind}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`, PROVIDER);
  }

  // Neither bind is positional. The schema comes from the segment the DECLARATION
  // assigns to the `schema` level, and the object's own name is the LAST segment, which
  // is right at every depth.
  const schema = containerSegment(capabilities, path, "schema");
  const name = path[path.length - 1];

  const sql = druidObjectColumnsSql(schema, name);
  const rows = await readRows(runner, sql);
  if (rows.length === 0) {
    // Every object of every declared kind has at least one column: a datasource always
    // has `__time`, a lookup always has `k` and `v`, and a system table is a fixed
    // projection. So an empty answer means it is not there under that name in this
    // schema, and saying so beats rendering an object with no columns as if that were
    // a measurement.
    throw new QueryError(`No Druid ${kind} named ${name} in ${schema}`, PROVIDER, sql);
  }

  return objectDetail(path, rows);
}

/**
 * Columns for EVERY object of one kind in one schema, in ONE round trip (#789).
 *
 * The fifth method, and Druid is one of the two type-ids that fell out of the four
 * implementation waves that landed it elsewhere. Nothing went red, because the shared
 * conformance helper skipped a provider that did not declare the method at all, which is
 * the second half of that finding.
 *
 * ONE round trip for the folder, never one per object: the target subquery is the LISTING's
 * own statement and the column catalog is joined onto it. Measured on Apache Druid 37.0.0,
 * where `INFORMATION_SCHEMA` joins locally in Calcite.
 *
 * The four guards, in the order the reference implementation writes them:
 *
 * 1. A kind this engine does not declare THROWS, naming the engine and the kind. An
 *    undeclared kind is a fact about the ENGINE and an empty answer is a claim about the
 *    DATA, so answering `{ details: [] }` here would say something nobody measured.
 * 2. The container path is resolved through `containerSchema()`, the same reader
 *    `listObjects` uses, so neither the depth nor the position of the schema segment is
 *    written out as a constant (standing ruling 5g).
 * 3. A `limit` that is not a positive whole number THROWS rather than being clamped or
 *    ignored: 0 would answer nothing while reporting a truncation the caller never asked
 *    for. On this engine that guard also protects the STATEMENT and not only the answer,
 *    because the transport has no parameter channel and the bound is interpolated.
 * 4. A kind with no columns would answer `{ details: [] }` with no round trip - and Druid
 *    HAS NO SUCH KIND, measured: `INFORMATION_SCHEMA.COLUMNS` answers for a datasource,
 *    for a lookup's `k` and `v` and for a `sys` table alike. So the guard the other
 *    sixteen providers write is absent here rather than written as an unreachable branch,
 *    and this sentence is where that decision is recorded.
 *
 * `limit + 1` reaches the target, the extra object is dropped here, and `truncated`
 * carries the CALLER's limit with `callerBoundTruncationReason()`'s shared sentence: this
 * file never spells that sentence itself, because the same bound reading three ways
 * depending on which engine is open is what that helper exists to stop. Nothing here
 * applies a second bound of its own, so there is nothing to join onto it. What the cut takes is decided by the target's
 * `ORDER BY "objectName"`, which runs under the cluster's own String comparison - measured
 * to be the UTF-8 byte order, `U&'\+00e000' < U&'\+01f600'` being true on 37.0.0 - while
 * the batch is re-sorted here by `comparePaths`, which compares UTF-16 code units and
 * reverses exactly that pair. So a bounded read's MEMBERSHIP is the cluster's and the
 * ORDER of the answer is ours, the same split three other engines in #789 measured.
 */
export async function describeObjects(
  runner: DruidQueryRunner,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`Druid declares no object kind "${kind}"`, PROVIDER);
  }
  const schema = containerSchema(capabilities, container);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new QueryError(`A Druid bulk column read limit must be a positive whole number, received ${limit}`, PROVIDER);
  }

  const rows = await readRows(runner, druidBulkColumnsSql(schema, kind, limit === undefined ? undefined : limit + 1));

  // Grouped in the order the objects arrived, which is the target's order and therefore
  // the order the cut was taken in. A `Map` keeps that; an object literal would reorder
  // anything that looks like an array index.
  const grouped = new Map<string, DruidRow[]>();
  for (const row of rows) {
    // MEMBERSHIP comes from the target read carried on every joined row, never from the
    // column read: the join is a LEFT one, so an object with no column row still opens a
    // group here and is described with an empty column list.
    const owner = readIdentifier(row.tableName);
    if (owner === null) continue;
    const owned = grouped.get(owner);
    if (owned === undefined) grouped.set(owner, [row]);
    else owned.push(row);
  }

  const names = [...grouped.keys()];
  const truncated = limit !== undefined && names.length > limit;
  const details = (truncated ? names.slice(0, limit) : names)
    .map((name) => objectDetail(objectPath(container, name), grouped.get(name)!))
    .sort((left, right) => comparePaths(left.path, right.path));

  return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
}
