/**
 * The Trino object surface (issue #789)
 *
 * The statements, the row shapes and the pure derivations behind `listContainers`,
 * `countObjects`, `listObjects` and `describeObject`. The four methods themselves live on
 * the provider in `index.ts`; nothing here holds a transport, so every function below is a
 * pure function of a declaration and a path.
 *
 * Trino is the THIRD two-level engine in #789, after SQL Server and DuckDB, and the two
 * levels are as real as a two-level engine gets: a CATALOG is a named connector
 * configuration rather than a database, so one Trino session addresses an Iceberg lake, a
 * PostgreSQL server and a generated `tpch` dataset side by side, each holding schemas
 * holding objects. Nothing in the model below is per catalog except the statements' own
 * catalog segment, which is the point: `information_schema` is PER CATALOG here, so a
 * query against one catalog's copy says nothing whatsoever about another's.
 *
 * Everything below was measured against a live Trino 476 on 2026-09-11, with the `memory`
 * and `tpch` catalogs the repo's `database-compose.yml` configures plus an `iceberg`
 * catalog on an Apache Hive 4.0.1 standalone metastore, which is the only catalog type
 * this release will create a materialized view on: the Iceberg JDBC catalog answers
 * `createMaterializedView is not supported for Iceberg JDBC catalogs` and the REST catalog
 * answers the same for REST.
 *
 * Five measured facts shape every statement here, and four of them produce a wrong answer
 * rather than a failure if forgotten:
 *
 * - **A MATERIALIZED VIEW IS `table_type = 'BASE TABLE'`.** Measured: with
 *   `iceberg.warehouse.order_totals` a materialized view,
 *   `iceberg.information_schema.tables` reports it as an ordinary BASE TABLE beside
 *   `orders`. A table count taken from `table_type` alone therefore counts it twice over
 *   the two kinds and draws the same object under Tables AND under Materialized Views. The
 *   anti-join in {@link relationScopeSql} is what removes it, and the materialized views
 *   are read from their own catalog rather than from `information_schema`, so neither
 *   source can lose a row the other holds.
 * - **AN UNFILTERED `system.metadata.materialized_views` READ FAILS IF ANY CATALOG ON THE
 *   CLUSTER CANNOT LIST ITS OWN.** Measured against a deliberately broken Iceberg catalog:
 *   `SELECT * FROM system.metadata.materialized_views` answers
 *   `Error listing materialized views for catalog brokenice: Failed to connect: ...` while
 *   the same read filtered to one healthy catalog answers its row. So `catalog_name = ...`
 *   here is isolation and not an optimisation: without it one misconfigured catalog
 *   anywhere on a shared cluster empties the Materialized Views folder of every catalog.
 * - **`table_type` IS `BASE TABLE` OR `VIEW`, AND AN UNKNOWN SPELLING IS MADE LOUD.**
 *   Standing ruling 5a (#789): Task 10 derived a vocabulary from its own fixture and a
 *   spelling the engine can produce fell out of the count AND the listing at once, so
 *   ruling 5f still held while the object was invisible. The `CASE` in
 *   {@link objectCountsSql} has an ELSE arm that labels anything else `unknown:<type>`,
 *   which is a kind id no provider declares, so {@link applyKindCounts} raises naming the
 *   spelling instead of dropping it.
 * - **A FUNCTION IS ADDRESSED BY NAME AND ARGUMENT TYPES.** Measured: `plus_one(bigint)`
 *   and `plus_one(double)` coexist in one schema, so a bare name gives two objects one
 *   address. Standing ruling 2 (#789) calls for the engine's own disambiguated form, which
 *   here is the `Argument Types` column of `SHOW FUNCTIONS`.
 * - **THERE IS NO CATALOG-WIDE FUNCTION LISTING.** `SHOW FUNCTIONS FROM <catalog>.<schema>`
 *   is the whole surface: it takes a schema, it cannot be aliased (its columns are
 *   `Function` and `Argument Types`, with spaces), and it cannot be wrapped in a subquery -
 *   measured, `SELECT * FROM (SHOW FUNCTIONS FROM memory.app)` is a syntax error. So a
 *   catalog-level function count is answered `{ unavailable }` with that sentence rather
 *   than by fanning `SHOW FUNCTIONS` out over every schema in the catalog, which on a Hive
 *   or Iceberg catalog is an unbounded number of full HTTP exchanges.
 *
 * There is NO identifier interpolation risk left open here: every catalog and schema
 * segment reaches a statement through {@link quoteIdentifier} or {@link quoteLiteral}, both
 * of which double the quote character they protect.
 */

import { QueryError } from "@/lib/db/errors";
import { containerDepth } from "@/lib/db/object-kinds";
import type {
  ContainerLevelSpec,
  DatabaseObject,
  KindCount,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import { TRINO_METADATA_SCHEMA } from "./introspect";

/** The canonical type-id, for the errors raised here. */
const TYPE_ID = "trino";

// ============================================================================
// Quoting
// ============================================================================

/** One identifier, quoted the way Trino quotes them, with embedded quotes doubled. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** One string literal, with embedded apostrophes doubled. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ============================================================================
// The kind vocabulary, derived from the ENGINE
// ============================================================================

/** The kind id a function is declared and addressed under. */
export const TRINO_FUNCTION_KIND = "function";

/** The kind id a materialized view is declared and addressed under. */
export const TRINO_MATERIALIZED_VIEW_KIND = "materialized_view";

/**
 * Every `information_schema.tables.table_type` this provider has a kind for.
 *
 * Derived from the ENGINE and not from a fixture (standing ruling 5a, #789). Trino's
 * `information_schema` is generated by the coordinator rather than by a connector, and it
 * emits exactly these two spellings for every catalog of every connector: measured across
 * `tpch` (72 rows, all BASE TABLE), `memory` (a table and a view) and `iceberg` (a table, a
 * materialized view and the connector's own `system.iceberg_tables`, all BASE TABLE).
 *
 * The guard against this record going stale is not a live probe - the provider's tests
 * replay captured pages rather than reaching a cluster - but the ELSE arm of
 * {@link objectCountsSql}, which labels an unmodelled spelling `unknown:<type>` so
 * {@link applyKindCounts} raises naming it. A spelling this record does not hold is
 * therefore reported, not dropped.
 */
export const TRINO_TABLE_TYPE_KINDS: Readonly<Record<string, string>> = {
  "BASE TABLE": "table",
  VIEW: "view",
};

/** The `table_type` spellings one relation kind is read from, or a refusal naming the kind. */
function tableTypesFor(kind: string): readonly string[] {
  const types = Object.keys(TRINO_TABLE_TYPE_KINDS).filter((type) => TRINO_TABLE_TYPE_KINDS[type] === kind);
  if (types.length === 0) {
    throw new QueryError(
      `Trino declares the kind "${kind}" but no information_schema table_type answers for it`,
      TYPE_ID,
    );
  }
  return types;
}

// ============================================================================
// Container statements
// ============================================================================

/**
 * One catalog's schemas.
 *
 * `information_schema` itself is excluded, the same exclusion `getSchema()` already makes
 * through {@link TRINO_METADATA_SCHEMA}: every catalog carries one, it holds only the eight
 * generated metadata relations, and a schema folder for it would open onto the tree's own
 * plumbing in every catalog on the cluster.
 *
 * NOTHING ELSE is excluded, and that is deliberate. A connector may publish a schema of its
 * own - measured, an Iceberg catalog carries `system` holding `iceberg_tables` - and a name
 * denylist is exactly the boundary #424 found cannot be maintained (`docs/providers/duckdb.md`
 * records the same conclusion for a read-only denylist). Those schemas are real and
 * queryable, so they are listed.
 */
export function trinoSchemaListSql(catalog: string): string {
  return [
    'SELECT schema_name AS "schemaName"',
    `FROM ${quoteIdentifier(catalog)}.information_schema.schemata`,
    `WHERE schema_name <> ${quoteLiteral(TRINO_METADATA_SCHEMA)}`,
    "ORDER BY schema_name",
  ].join(" ");
}

// ============================================================================
// Count and listing statements
// ============================================================================

/**
 * One container as the two statements below address it: a catalog, and a schema when the
 * caller named one.
 *
 * Both fields are read BY LEVEL and never by position - standing ruling 5g (#789) - and the
 * type carries `schema?` rather than a depth number so a statement builder cannot ask the
 * wrong question of it.
 */
export interface TrinoContainer {
  readonly catalog: string;
  readonly schema?: string;
}

/** The materialized-view catalog, filtered to one catalog and optionally to one schema. */
function materializedViewFilter(container: TrinoContainer): string {
  const schema = container.schema === undefined ? "" : ` AND schema_name = ${quoteLiteral(container.schema)}`;
  return `catalog_name = ${quoteLiteral(container.catalog)}${schema}`;
}

/**
 * The `information_schema.tables` rows in scope, with every materialized view removed.
 *
 * The anti-join is the whole point. A materialized view is reported here as
 * `table_type = 'BASE TABLE'` (measured), so without it `order_totals` is counted as a
 * table AND as a materialized view, and the tree draws it in both folders. Removing it here
 * rather than by name in the caller is what makes the count and the listing agree by
 * construction, which is standing ruling 5f (#789) discharged structurally: both statements
 * below are built from this one scope.
 */
function relationScopeSql(container: TrinoContainer): string {
  const schema = container.schema === undefined ? "" : ` AND t.table_schema = ${quoteLiteral(container.schema)}`;
  return [
    `FROM ${quoteIdentifier(container.catalog)}.information_schema.tables t`,
    `WHERE t.table_schema <> ${quoteLiteral(TRINO_METADATA_SCHEMA)}${schema}`,
    "AND NOT EXISTS (SELECT 1 FROM system.metadata.materialized_views mv",
    `WHERE mv.catalog_name = ${quoteLiteral(container.catalog)}`,
    "AND mv.schema_name = t.table_schema AND mv.name = t.table_name)",
  ].join(" ");
}

/**
 * The `CASE` that turns a `table_type` into a declared kind id.
 *
 * The ELSE arm is the guard standing ruling 5a (#789) asks for: an unmodelled spelling
 * becomes `unknown:<type>`, which is a kind id no declaration holds, so
 * {@link applyKindCounts} raises NAMING it. The silent alternative - a `WHERE table_type IN
 * (...)` that simply drops the row - would take the object out of the count and out of the
 * listing together, leaving ruling 5f satisfied while the object is invisible in the tree.
 */
function kindCaseSql(): string {
  const arms = Object.entries(TRINO_TABLE_TYPE_KINDS).map(
    ([type, kind]) => `WHEN ${quoteLiteral(type)} THEN ${quoteLiteral(kind)}`,
  );
  return `CASE t.table_type ${arms.join(" ")} ELSE ${quoteLiteral("unknown:")} || t.table_type END`;
}

/**
 * Every relation kind counted in ONE round trip, materialized views included.
 *
 * Two arms rather than one, because the two sources are genuinely different catalogs and
 * either can hold a row the other does not: `system.metadata.materialized_views` is the
 * coordinator asking each connector for its materialized views, while
 * `information_schema.tables` is the coordinator asking for its tables. Reading the
 * materialized views out of `information_schema` by anti-joining the OTHER way round would
 * lose every materialized view on a connector that does not publish them as tables.
 *
 * The `function` kind is deliberately NOT here: `SHOW FUNCTIONS` is a statement rather than
 * a relation and cannot be part of a `UNION ALL` - measured,
 * `SELECT * FROM (SHOW FUNCTIONS FROM memory.app)` is a syntax error.
 */
export function trinoObjectCountsSql(container: TrinoContainer, withMaterializedViews: boolean): string {
  const arms = [`SELECT ${kindCaseSql()} AS kind ${relationScopeSql(container)}`];
  if (withMaterializedViews) {
    arms.unshift(
      `SELECT ${quoteLiteral(TRINO_MATERIALIZED_VIEW_KIND)} AS kind FROM system.metadata.materialized_views WHERE ${materializedViewFilter(container)}`,
    );
  }
  return `SELECT kind AS "kind", count(*) AS "n" FROM ( ${arms.join(" UNION ALL ")} ) GROUP BY kind`;
}

/** One relation kind's objects in one container: the schema that holds each, and its name. */
export function trinoRelationListSql(container: TrinoContainer, kind: string): string {
  const types = tableTypesFor(kind).map(quoteLiteral).join(", ");
  return [
    'SELECT t.table_schema AS "schemaName", t.table_name AS "objectName"',
    relationScopeSql(container),
    `AND t.table_type IN (${types})`,
  ].join(" ");
}

/** Every materialized view in one container, from the one catalog that publishes them. */
export function trinoMaterializedViewListSql(container: TrinoContainer): string {
  return [
    'SELECT schema_name AS "schemaName", name AS "objectName"',
    "FROM system.metadata.materialized_views",
    `WHERE ${materializedViewFilter(container)}`,
  ].join(" ");
}

/**
 * Every catalog-stored function in ONE schema.
 *
 * A `SHOW` statement and not a projection, because there is no relation to project:
 * `information_schema` holds eight views on this engine and none of them is a routine
 * catalog, and `system.jdbc.procedures` answers zero rows for a schema holding three
 * functions (measured). The column names below therefore cannot be aliased, which is why
 * {@link TRINO_FUNCTION_COLUMNS} spells them with their spaces.
 */
export function trinoFunctionListSql(catalog: string, schema: string): string {
  return `SHOW FUNCTIONS FROM ${quoteIdentifier(catalog)}.${quoteIdentifier(schema)}`;
}

/** One relation's columns, in declared order. A materialized view answers here too (measured). */
export function trinoObjectColumnsSql(catalog: string, schema: string, name: string): string {
  return [
    'SELECT column_name AS "columnName", data_type AS "dataType", is_nullable AS "isNullable"',
    `FROM ${quoteIdentifier(catalog)}.information_schema.columns`,
    `WHERE table_schema = ${quoteLiteral(schema)} AND table_name = ${quoteLiteral(name)}`,
    "ORDER BY ordinal_position",
  ].join(" ");
}

// ============================================================================
// Row shapes
// ============================================================================

/** The `SHOW FUNCTIONS` column names, which carry spaces and cannot be aliased. */
export const TRINO_FUNCTION_COLUMNS = { name: "Function", argumentTypes: "Argument Types" } as const;

export interface KindCountRow {
  kind: unknown;
  n: unknown;
}

export interface ObjectNameRow {
  schemaName: unknown;
  objectName: unknown;
}

export interface ColumnNameRow {
  columnName: unknown;
  dataType: unknown;
  isNullable: unknown;
}

/** One identifier as text, or null for a row that cannot be placed and must be skipped. */
export function readIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A `count(*)`, which is BIGINT and arrives as a JSON NUMBER on this protocol.
 *
 * No string arm, deliberately: the client protocol renders a bigint as a JSON number and
 * never as text, so an arm for a decimal string would be a branch no payload can reach, and
 * standing ruling 5b (#789) measured that raw lcov will happily report such an arm as
 * covered while it is dead. Anything that is not a finite number is `undefined`, which
 * leaves the kind at whatever it was seeded with rather than turning it into the NaN that
 * `Number(null)` and friends produce.
 */
export function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ============================================================================
// Derivations over the declaration
// ============================================================================

/**
 * The container levels this engine declares, cut to the depth `containerDepth()` answers.
 *
 * Every derivation below starts here rather than from a length or an index, which is
 * standing ruling 5g (#789) in its general form: NEVER index `path` or `container`
 * positionally, anywhere, for anything. All three spellings the ruling names are wrong on
 * this engine rather than merely potentially wrong, because Trino declares two levels: a
 * hardcoded `container.length !== 1` refuses every valid schema path, `path[1]` is the
 * SCHEMA and not the object name, and `path[0]` is the CATALOG and not the schema.
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
 * Every caller that needs a segment goes through this rather than through a non-null
 * assertion, because an `undefined` reaching a statement builder does not fail here: it
 * interpolates as the four characters `undefined` and asks the cluster about a catalog
 * called `undefined`, which answers `Catalog 'undefined' not found` - a sentence about
 * neither the level nor the path. The case is reachable without a bug in this file: a
 * provider that copied it and declared only a `catalog` level would have no schema segment
 * at all.
 */
function requiredSegment(
  segments: Partial<Record<ContainerLevelSpec["id"], string>>,
  level: ContainerLevelSpec["id"],
): string {
  const segment = segments[level];
  if (segment === undefined) {
    throw new QueryError(`Trino declares no ${level} level to read this path's segment from`, TYPE_ID);
  }
  return segment;
}

/**
 * The container paths this engine accepts, outermost first, as segment NAMES.
 *
 * Every prefix of the declared levels, which at two levels means a catalog alone or a
 * catalog and a schema. Both are real containers: the tree only draws folders at the
 * deepest level (`src/components/object-tree/flatten.ts`), but `assertContainerDepth` in
 * `src/lib/api/object-route.ts` admits any path down to the declared depth and
 * `tests/helpers/object-surface-conformance.ts` reads counts at the OUTER one, so "how many
 * tables does this whole catalog hold" is a question with a true answer rather than a
 * caller mistake. SQL Server and DuckDB answered the same way for the same reason.
 */
function containerShapes(capabilities: ProviderCapabilities): readonly string[][] {
  // `level.id` and NOT `level.label.toLowerCase()`: `id` is the field every read binds by
  // (`containerSegments()` keys the record with it), so spelling the shape from `label`
  // would describe a path shape no read accepts the moment a declaration's label is prose
  // rather than its id capitalised. The two are the same word on Trino's own declaration,
  // which is exactly why the divergence was invisible until a test varied the labels.
  const names = declaredLevels(capabilities).map((level) => level.id);
  return names.map((_, index) => names.slice(0, index + 1));
}

/**
 * The shapes above, spelled for a message: `[catalog] or [catalog, schema]`.
 *
 * A declaration carrying no container level has no shape at all, and the empty join would
 * print "a Trino container path is , received []", which reads as a formatting bug rather
 * than as the fact it is.
 */
function shapeList(shapes: readonly string[][]): string {
  if (shapes.length === 0) return "nothing: this declaration carries no container level";
  return shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ");
}

/**
 * One container path resolved into the catalog and, when the caller named one, the schema.
 *
 * It raises rather than reading what it can and carrying on: a container one segment too
 * long would otherwise bind the object's own name as a schema and answer an empty folder
 * that looks exactly like a schema holding nothing.
 */
export function containerRead(capabilities: ProviderCapabilities, container: readonly string[]): TrinoContainer {
  const shapes = containerShapes(capabilities);
  if (!shapes.some((shape) => shape.length === container.length)) {
    throw new QueryError(
      `A Trino container path is ${shapeList(shapes)}, received ${JSON.stringify(container)}`,
      TYPE_ID,
    );
  }
  const segments = containerSegments(capabilities, container);
  const catalog = requiredSegment(segments, "catalog");
  const schema = segments.schema;
  return schema === undefined ? { catalog } : { catalog, schema };
}

/**
 * One object path resolved into the three things a detail read needs, checked first.
 *
 * The name is `path[path.length - 1]` and NEVER `path[2]`, and the container segments come
 * from `containerSegments()` and never from `path[0]` and `path[1]` (standing ruling 5g,
 * #789).
 *
 * A kind declaring `attachedTo` is REFUSED rather than given a fourth segment. Trino holds
 * no object that hangs off another - it has no triggers, no indexes and no constraints of
 * any kind - so producing the shape would draw a folder whose every path resolves to
 * nothing.
 */
export interface TrinoObjectRead {
  readonly catalog: string;
  readonly schema: string;
  readonly name: string;
}

export function objectRead(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  path: readonly string[],
): TrinoObjectRead {
  if (spec.attachedTo !== undefined) {
    throw new QueryError(
      `Trino holds no object attached to another, so the kind "${spec.id}" cannot declare attachedTo "${spec.attachedTo}"`,
      TYPE_ID,
    );
  }
  // `level.id`, the field the segments below are resolved by. See {@link containerShapes}.
  const shape = [...declaredLevels(capabilities).map((level) => level.id), "name"];
  if (path.length !== shape.length) {
    throw new QueryError(
      `A Trino "${spec.id}" path is ${shapeList([shape])}, received ${JSON.stringify(path)}`,
      TYPE_ID,
    );
  }
  const segments = containerSegments(capabilities, path);
  return {
    catalog: requiredSegment(segments, "catalog"),
    schema: requiredSegment(segments, "schema"),
    name: path[path.length - 1],
  };
}

// ============================================================================
// Count assembly
// ============================================================================

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this engine has this kind and this container holds none" render as
 * a 0 badge. Building the record from the answered rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the engine has no
 * such concept, so the tree draws no folder at all.
 */
export function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the `UNION ALL` actually answered, and RAISES on a
 * kind the declaration does not hold.
 *
 * That raise is the whole guard behind {@link TRINO_TABLE_TYPE_KINDS}. It fires on two
 * different defects with one sentence: an `information_schema` `table_type` this provider
 * has no kind for, which arrives labelled `unknown:<type>` from the `CASE`'s ELSE arm, and a
 * kind the statement can produce that `objectKinds` stopped declaring. Both would otherwise
 * be dropped silently, which standing ruling 5a (#789) names as the worst shape of defect
 * this epic has: the count and the listing lose the same rows together, so ruling 5f still
 * holds while the object is missing from the tree.
 *
 * `Object.hasOwn` and not `in`: a kind id is an OPEN string, so `counts["toString"]` answers
 * a function off the prototype chain and a catalog row spelled `toString` would be accepted
 * as declared (standing ruling 5g, #789).
 */
export function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    const kind = readIdentifier(row.kind);
    if (kind === null) continue;
    if (!Object.hasOwn(counts, kind)) {
      throw new QueryError(
        `Trino counted objects under "${kind}", which this provider does not declare as an object kind (#789)`,
        TYPE_ID,
      );
    }
    const measured = readCount(row.n);
    // An unreadable count is left at whatever it was seeded with rather than coerced through
    // `Number(undefined)`, which is NaN and renders as a blank badge.
    if (measured !== undefined) counts[kind] = { count: measured };
  }
}

// ============================================================================
// Row mapping and ordering
// ============================================================================

/**
 * One catalog row as the object it addresses.
 *
 * The SCHEMA comes from the row rather than from the container, which is load-bearing at
 * the catalog level where one listing spans every schema in the catalog.
 *
 * The path is CONSTRUCTED here, which standing ruling 5g (#789) names as the one place a
 * position is legitimately written rather than derived - and it still has to be written in
 * the DECLARED order, because `objectRead()` reads the same path back by level.
 */
export function listedObject(
  capabilities: ProviderCapabilities,
  catalog: string,
  kind: string,
  schema: string,
  segment: string,
  name: string,
): DatabaseObject {
  const segments: Record<ContainerLevelSpec["id"], string> = { catalog, schema };
  const path = [...declaredLevels(capabilities).map((level) => segments[level.id]), segment];
  return { path, name, kind };
}

/**
 * A function's own path segment: the name with its argument types, `plus_one(bigint)`.
 *
 * Standing ruling 2 (#789) asks for the engine's own identifier WITHIN its container, and
 * on Trino a name alone is not one: measured on 476, `plus_one(bigint)` and
 * `plus_one(double)` coexist in `memory.app`, so a bare `plus_one` gives two objects one
 * address. `SHOW FUNCTIONS` publishes the argument types as a rendered list and nothing
 * else identifies an overload, so the segment is built from it.
 *
 * The types and never the parameter names, which is the same rule PostgreSQL's segment
 * follows: overload resolution never depends on a parameter name, so carrying one would
 * make the identity change when somebody renames an argument. `SHOW FUNCTIONS` publishes no
 * parameter names at all, so on this engine the honest form is also the only available one.
 */
export function functionSegment(name: string, argumentTypes: string): string {
  return `${name}(${argumentTypes})`;
}

/**
 * Two paths ordered SEGMENT BY SEGMENT, shorter first where one is a prefix of the other.
 *
 * Never `JSON.stringify`, which standing ruling 5g (#789) rules out as a path key: JSON
 * escaping reorders exotic names by rewriting the very characters being compared, and at
 * mixed depth a serialised deeper path sorts before its own prefix because `,` is below
 * `]`. Neither is hypothetical on Trino - a double quote is legal inside a quoted
 * identifier here, doubled - and JSON rewrites it as `\"`.
 *
 * This is the fifth copy in the fleet (#789). Task 28's sweep hoists it beside
 * `containerDepth` in `src/lib/db/object-kinds.ts`; hoisting it here would collide with the
 * other implementers holding this checkout.
 */
export function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}
