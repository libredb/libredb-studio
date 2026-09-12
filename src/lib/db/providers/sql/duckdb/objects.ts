/**
 * The DuckDB object surface (issue #789)
 *
 * The statements, the row shapes and the pure derivations behind `listContainers`,
 * `countObjects`, `listObjects` and `describeObject`. The four methods themselves live on
 * the provider in `index.ts`; nothing here holds a client, so every function below is a
 * pure function of a declaration and a path.
 *
 * DuckDB is the SECOND two-level engine in #789 (SQL Server was the first), and the
 * second level is real rather than nominal: `ATTACH` puts another whole catalog in the
 * same connection, and a three-part name reaches into it, so a DuckDB session genuinely
 * holds databases holding schemas holding objects.
 *
 * Everything below was measured against DuckDB v1.5.5 through `@duckdb/node-api`
 * 1.5.5-r.4 on 2026-09-11. The engine is embedded, so those measurements are taken by
 * `tests/integration/db/duckdb-provider.test.ts` against a REAL engine on every run
 * rather than against a canned recordset.
 *
 * Four facts shape the statements here, each of which a reader would otherwise get wrong:
 *
 * - **`duckdb_schemas().internal` is TRUE for `main` in a USER database.** Filtering a
 *   schema listing on `NOT internal` therefore drops the default schema, which is where
 *   most objects live. The container list filters on the CATALOG instead, where `internal`
 *   means what a reader expects: `system` and `temp` carry it and no attached database
 *   does. Already recorded for `getSchema()` in `docs/providers/duckdb.md` section 3.3.
 * - **Every built-in function lives in the `system` catalog** (`system.main` and
 *   `system.pg_catalog`, 2949 rows on a bare instance), so a `database_name = $1` filter
 *   over a user catalog already excludes all of them and the macro read needs no
 *   `internal` predicate of its own.
 * - **There is no identifier interpolation anywhere in this file.** Every `duckdb_*` table
 *   function publishes its container as a COLUMN, so a catalog and a schema are bound
 *   STRINGS rather than parts of a three-part name. That removes the whole class of
 *   quoting defect SQL Server needs `escapeIdentifier` for here.
 * - **A DuckDB foreign key never crosses a schema**: `Binder Error: Creating foreign keys
 *   across different schemas or catalogs is not supported`, measured. So a referenced
 *   table is always in the reading object's own schema.
 */

import { QueryError } from "../../../errors";
import { containerDepth } from "../../../object-kinds";
import { displayName } from "./introspect";
import type {
  ContainerLevelSpec,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectKindSpec,
  ProviderCapabilities,
} from "../../../types";

// ============================================================================
// The macro vocabulary, derived from the ENGINE
// ============================================================================

/**
 * The `duckdb_functions().function_type` spellings that are a MACRO.
 *
 * DuckDB has exactly two macro forms and the documentation names both: `CREATE MACRO
 * f(x) AS <expression>` is a scalar macro and `CREATE MACRO f(x) AS TABLE <select>` is a
 * table macro. They are distinguished only by `function_type`; there is no
 * `duckdb_macros()` and `information_schema` has no `.routines` on this engine, so this
 * one column is the whole discriminator.
 *
 * **Derived from the ENGINE and pinned against it** (standing ruling 5a, #789). Task 10
 * took its vocabulary from a `SELECT DISTINCT` over its own fixture, and a spelling the
 * engine can produce that the fixture lacked fell out of the count AND the listing at
 * once - so ruling 5f still held while the object was invisible in the tree. The guard
 * against that here is `FUNCTION_TYPE_RULES` below, which every `function_type` the live
 * engine publishes has to be accounted for by; the fixture then holds one of each macro
 * form so the two arms cannot rot into one.
 */
const MACRO_FUNCTION_TYPES: readonly string[] = ["macro", "table_macro"];

/**
 * Every `function_type` this provider has a RULE for, and for the excluded ones the
 * reason.
 *
 * This exists because "the vocabulary enumerates the engine" is a claim that decays. A
 * future DuckDB can add a `function_type`, and the failure mode is silence: a spelling no
 * arm names is dropped from the count AND from the listing, so the two still agree, every
 * gate still passes, and the object is simply absent from the tree.
 *
 * The engine is embedded, so unlike MySQL's `CATALOG_TYPE_RULES` this needs no separate
 * live script: `tests/integration/db/duckdb-provider.test.ts` asks the running engine for
 * its own `SELECT DISTINCT function_type` - 2951 built-in rows plus the fixture's two
 * user macros - and fails NAMING anything outside this record. The excluded half is a map
 * rather than a list so an exclusion cannot be added without saying why.
 */
export const FUNCTION_TYPE_RULES: {
  readonly macros: readonly string[];
  readonly excluded: Readonly<Record<string, string>>;
} = {
  macros: MACRO_FUNCTION_TYPES,
  excluded: {
    scalar: "a built-in scalar function, compiled into the engine; nobody wrote it in this database",
    aggregate: "a built-in aggregate, same as scalar",
    table: "a built-in table function, `duckdb_tables()` and `read_csv` among them",
    pragma: "a PRAGMA, invoked as a statement rather than called, and not an object in any schema",
  },
};

// ============================================================================
// The catalog function behind each declared kind
// ============================================================================

interface DuckDBObjectSource {
  /** The `duckdb_*` table function this kind's rows come from. */
  readonly relation: string;
  /** The column in that function's output carrying the object's own name. */
  readonly nameColumn: string;
  /** An extra predicate ANDed onto the container filter, where the kind needs one. */
  readonly predicate?: string;
}

/** `'macro', 'table_macro'`: a vocabulary as a SQL literal list. */
function literalList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * One entry per declared kind, and the COUNT and the LISTING are both built from it.
 *
 * That is standing ruling 5f (#789) discharged structurally rather than by care: the
 * listing must contain exactly what the count counted, and both Oracle and MySQL failed
 * that on their first pass because a count statement and a listing statement were written
 * separately and drifted. Here `countsSql` and `listObjectsSql` call the same
 * `objectSource()` and the same `kindFilter()`, so the two cannot disagree about which
 * `duckdb_*` function answers for a kind or about which rows of it are in scope.
 *
 * DuckDB has no trigger and no stored procedure, so neither is declared and neither is
 * here. `information_schema` exists on this engine but is partial - it has no `.views`
 * and no `.routines` - so nothing below reaches for it.
 */
const DUCKDB_OBJECT_SOURCES: Record<string, DuckDBObjectSource> = {
  table: { relation: "duckdb_tables()", nameColumn: "table_name" },
  view: { relation: "duckdb_views()", nameColumn: "view_name" },
  macro: {
    relation: "duckdb_functions()",
    nameColumn: "function_name",
    predicate: `function_type IN (${literalList(MACRO_FUNCTION_TYPES)})`,
  },
  sequence: { relation: "duckdb_sequences()", nameColumn: "sequence_name" },
};

/**
 * Which catalog function answers for one kind, or a refusal naming it.
 *
 * The lookup is `Object.hasOwn` and not a bare index: a kind id is an OPEN string, so
 * `DUCKDB_OBJECT_SOURCES["toString"]` answers a function off the prototype chain rather
 * than `undefined`, and a kind called `toString` would then reach the statement builder
 * as a kind this engine has (standing ruling 5g, #789).
 */
function objectSource(kind: string): DuckDBObjectSource {
  if (!Object.hasOwn(DUCKDB_OBJECT_SOURCES, kind)) {
    throw new QueryError(
      `DuckDB declares the kind "${kind}" but has no catalog function that answers for it`,
      "duckdb",
    );
  }
  return DUCKDB_OBJECT_SOURCES[kind];
}

// ============================================================================
// Container statements
// ============================================================================

/**
 * The catalogs this connection can address: the one it opened plus everything `ATTACH`ed.
 *
 * `NOT internal` is the engine's own answer for `system` and `temp`, the two DuckDB
 * attaches to every session. `system` holds the `duckdb_*` and `pg_catalog` views and
 * nothing a person wrote; `temp` holds session-scoped objects, which is a real absence
 * recorded in `docs/providers/duckdb.md` rather than a silent one.
 *
 * `is_session_default` marks the catalog the session is already in, which on this engine
 * is the file the connection names - every other row is something a statement attached.
 */
export const CATALOGS_SQL = `SELECT database_name, database_name = current_database() AS is_session_default
      FROM duckdb_databases()
      WHERE NOT internal
      ORDER BY database_name`;

/**
 * One catalog's schemas, with the session's own schema marked.
 *
 * NO `internal` filter, and that is measured rather than an oversight: `duckdb_schemas()`
 * reports `internal = true` for `main` in a USER database, so `NOT internal` here would
 * drop the default schema and with it most of the objects in the tree. The catalog filter
 * is what keeps `system` and `temp` out, and it is bound rather than interpolated.
 *
 * `is_session_default` is marked HERE as well as on the catalog, and standing ruling 5a2
 * (#789) is why: first paint walks the container chain down to the session default at the
 * DEEPEST declared level, so a two-level engine that marked only its catalogs would leave
 * the tree opening a database and stopping, with no counts read at all.
 *
 * The predicate carries BOTH halves deliberately. `current_schema()` names a schema in
 * `current_database()`, so comparing the schema alone would mark `warehouse.main` as the
 * session default whenever the session sat in `memory.main` - measured: with
 * `USE warehouse.stock`, `current_database()` moves to `warehouse` and `current_schema()`
 * to `stock`, and the two always answer one real pair.
 */
export const SCHEMAS_SQL = `SELECT schema_name,
             database_name = current_database() AND schema_name = current_schema() AS is_session_default
      FROM duckdb_schemas()
      WHERE database_name = $1
      ORDER BY schema_name`;

// ============================================================================
// Count and listing statements
// ============================================================================

/**
 * The container filter both reads share, as a bound predicate.
 *
 * `$1` is the catalog and `$2` the schema, and the numbered form is deliberate: DuckDB
 * reuses a numbered parameter across a `UNION ALL`, so the counts statement binds one
 * catalog once no matter how many kinds are declared. A positional `?` would need one
 * copy per arm and the count would silently shift the moment a kind was added.
 */
function containerFilter(bySchema: boolean): string {
  return bySchema ? "database_name = $1 AND schema_name = $2" : "database_name = $1";
}

/** The container filter plus whatever extra predicate the kind's own catalog needs. */
function kindFilter(source: DuckDBObjectSource, bySchema: boolean): string {
  const filter = containerFilter(bySchema);
  return source.predicate === undefined ? filter : `${filter} AND ${source.predicate}`;
}

/**
 * Every declared kind counted in ONE round trip, one `UNION ALL` arm per kind.
 *
 * Built from the DECLARATION rather than from a constant, so a kind added to
 * `objectKinds` without an entry in `DUCKDB_OBJECT_SOURCES` fails loudly here instead of
 * drawing a folder nothing can fill. The kind id reaches the SQL as a literal, which is
 * safe by construction: `objectSource()` refuses anything outside the four keys above, so
 * no caller-supplied string is ever interpolated.
 */
export function countsSql(kinds: readonly ObjectKindSpec[], bySchema: boolean): string {
  return kinds
    .map((kind) => {
      const source = objectSource(kind.id);
      return `SELECT '${kind.id}' AS kind, COUNT(*) AS n FROM ${source.relation} WHERE ${kindFilter(source, bySchema)}`;
    })
    .join("\n      UNION ALL ");
}

/**
 * One kind's objects in one container.
 *
 * No `ORDER BY`: the ordering is done in `comparePaths` over the produced PATHS, which is
 * one rule for every kind rather than four `ORDER BY` clauses that can disagree.
 *
 * No row count column either, and that is a decision the engine forces. `estimated_size`
 * is the only cardinality DuckDB publishes per table and it is an ESTIMATE - measured in
 * #424, after deleting 19M of a table's 20M rows it answered 1,076,480 against a true
 * 1,000,000 and a `CHECKPOINT` did not move it - so publishing it as `rowCount` would put
 * a wrong number on a folder row. The honest alternative is a `count(*)` per object,
 * which is the N+1 the inventory route already had `includeColumns` removed for.
 */
export function listObjectsSql(kind: string, bySchema: boolean): string {
  const source = objectSource(kind);
  return `SELECT schema_name, ${source.nameColumn} AS name
      FROM ${source.relation}
      WHERE ${kindFilter(source, bySchema)}`;
}

// ============================================================================
// Detail statements
// ============================================================================

/**
 * The target set of one bulk read: every object of one kind in one container, in the
 * engine's own order, optionally cut (#789).
 *
 * The same `objectSource()` and the same `kindFilter()` the count and the listing use, so
 * the three cannot disagree about which rows are in scope. What it adds is an `ORDER BY`,
 * which the listing deliberately does not carry: a bound with no order keeps an arbitrary
 * subset, and two calls could keep different ones.
 *
 * `schema_name` leads the order because a CATALOG-level container spans every schema under
 * it, so `(schema_name, name)` is what is unique there; a schema-level read has one value
 * in the first column and is ordered by name alone in effect.
 *
 * The `LIMIT` placeholder takes the next free number after the container binds, which is
 * why it is derived from `bySchema` rather than written: the container filter is `$1`
 * alone at catalog level and `$1, $2` at schema level.
 */
export function bulkTargetSql(kind: string, bySchema: boolean, bounded: boolean): string {
  const source = objectSource(kind);
  const limit = bounded ? `\n      LIMIT $${bySchema ? 3 : 2}` : "";
  return `SELECT schema_name, ${source.nameColumn} AS name
      FROM ${source.relation}
      WHERE ${kindFilter(source, bySchema)}
      ORDER BY schema_name, name${limit}`;
}

/**
 * One detail read of a WHOLE FOLDER, as the single read's statement joined to the target.
 *
 * Each of the four detail statements below is its `describeObject()` counterpart with the
 * `schema_name = $2 AND table_name = $3` pair replaced by a join against `described`, and
 * nothing else changed: the same catalog function, the same predicates, the same casts. A
 * rewritten statement would be the one thing this file could get wrong that no fixture
 * shows, so they are built from one function rather than hand-copied four times.
 *
 * The join is on BOTH `schema_name` and the name, never on the name alone. A catalog-level
 * read spans every schema, and this fixture holds `customers` in two of them with different
 * columns: a join on the name would answer one table with the other's columns rather than
 * an error anybody would notice.
 *
 * `database_name = $1` stays on the OUTER read as well as inside the target, because
 * `duckdb_columns()` and the two constraint functions span every attached catalog and the
 * fixture holds `memory.main.customers` and `warehouse.main.customers` at once.
 */
function bulkDetailSql(
  kind: string,
  bySchema: boolean,
  bounded: boolean,
  relation: string,
  projection: string,
  extra: string,
  order: string,
): string {
  return `WITH described AS (${bulkTargetSql(kind, bySchema, bounded)})
      SELECT o.schema_name, o.table_name, ${projection}
      FROM ${relation} o
      JOIN described d ON d.schema_name = o.schema_name AND d.name = o.table_name
      WHERE o.database_name = $1${extra}${order}`;
}

export function bulkColumnsSql(kind: string, bySchema: boolean, bounded: boolean): string {
  return bulkDetailSql(
    kind,
    bySchema,
    bounded,
    "duckdb_columns()",
    "o.column_name, o.data_type, o.is_nullable, o.column_default",
    "",
    "\n      ORDER BY o.schema_name, o.table_name, o.column_index",
  );
}

export function bulkPrimaryKeySql(kind: string, bySchema: boolean, bounded: boolean): string {
  return bulkDetailSql(
    kind,
    bySchema,
    bounded,
    "duckdb_constraints()",
    "o.constraint_column_names",
    "\n        AND o.constraint_type = 'PRIMARY KEY'",
    "",
  );
}

export function bulkForeignKeysSql(kind: string, bySchema: boolean, bounded: boolean): string {
  return bulkDetailSql(
    kind,
    bySchema,
    bounded,
    "duckdb_constraints()",
    "o.constraint_column_names, o.referenced_table, o.referenced_column_names",
    "\n        AND o.constraint_type = 'FOREIGN KEY'",
    "",
  );
}

export function bulkIndexesSql(kind: string, bySchema: boolean, bounded: boolean): string {
  return bulkDetailSql(
    kind,
    bySchema,
    bounded,
    "duckdb_indexes()",
    "o.index_name, o.is_unique, o.expressions::VARCHAR[] AS index_columns",
    "",
    "\n      ORDER BY o.schema_name, o.table_name, o.index_name",
  );
}

/**
 * One relation's columns. `duckdb_columns()` carries a VIEW's columns as well as a
 * table's, so one statement answers for both declared relation kinds.
 */
export const OBJECT_COLUMNS_SQL = `SELECT column_name, data_type, is_nullable, column_default
      FROM duckdb_columns()
      WHERE database_name = $1 AND schema_name = $2 AND table_name = $3
      ORDER BY column_index`;

/**
 * One relation's primary key, as the column names it covers.
 *
 * The type filter is explicit rather than a `NOT internal`, because `duckdb_constraints()`
 * publishes every NOT NULL and UNIQUE constraint as a row of its own: `customers` with one
 * primary key and one NOT NULL column answers three rows there.
 */
export const OBJECT_PRIMARY_KEY_SQL = `SELECT constraint_column_names
      FROM duckdb_constraints()
      WHERE database_name = $1 AND schema_name = $2 AND table_name = $3
        AND constraint_type = 'PRIMARY KEY'`;

/**
 * One relation's foreign keys.
 *
 * Read SEPARATELY from the primary key rather than filtered out of one `IN` list, and the
 * reason is a type rather than a preference: `referenced_table` is NULL on a PRIMARY KEY
 * row and never on a FOREIGN KEY one, so one statement per type is what lets the row shape
 * below say `string` instead of `string | null` and carry no null arm that no test can
 * reach.
 */
export const OBJECT_FOREIGN_KEYS_SQL = `SELECT constraint_column_names, referenced_table, referenced_column_names
      FROM duckdb_constraints()
      WHERE database_name = $1 AND schema_name = $2 AND table_name = $3
        AND constraint_type = 'FOREIGN KEY'`;

/**
 * One relation's indexes.
 *
 * No primary-key exclusion is needed, unlike SQL Server: measured, a DuckDB PRIMARY KEY
 * writes NO `duckdb_indexes()` row at all, so the listing is already exactly the indexes
 * somebody created. `expressions` is declared VARCHAR and prints as `"[a, b]"`, so the
 * cast is what stops a caller parsing it by hand and getting an expression index with a
 * comma in it wrong.
 */
export const OBJECT_INDEXES_SQL = `SELECT index_name, is_unique, expressions::VARCHAR[] AS index_columns
      FROM duckdb_indexes()
      WHERE database_name = $1 AND schema_name = $2 AND table_name = $3
      ORDER BY index_name`;

// ============================================================================
// Row shapes
// ============================================================================

export interface CatalogRow {
  database_name: string;
  is_session_default: boolean;
}

export interface SchemaNameRow {
  schema_name: string;
  is_session_default: boolean;
}

export interface KindCountRow {
  kind: string;
  /** A DuckDB `COUNT(*)` is BIGINT, which arrives as a decimal STRING. */
  n: unknown;
}

export interface ObjectRow {
  schema_name: string;
  name: string;
}

export interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
}

export interface PrimaryKeyRow {
  constraint_column_names: string[];
}

/**
 * `referenced_table` is `string` and not `string | null` because the statement that
 * answers this row filters to FOREIGN KEY: measured, only a PRIMARY KEY row carries NULL
 * there. `referenced_column_names` is positionally aligned with `constraint_column_names`,
 * measured on a composite key: `FOREIGN KEY (x, y) REFERENCES parent(a, b)` answers
 * `["x","y"]` against `["a","b"]`.
 */
export interface ForeignKeyRow {
  constraint_column_names: string[];
  referenced_table: string;
  referenced_column_names: string[];
}

export interface IndexRow {
  index_name: string;
  is_unique: boolean;
  index_columns: string[] | null;
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
 * this engine rather than merely potentially wrong, because DuckDB declares two levels:
 * a hardcoded `container.length !== 1` refuses every valid schema path, `path[1]` is the
 * SCHEMA and not the object name, and `path[0]` is the CATALOG and not the schema.
 *
 * The shape is SQL Server's (`src/lib/db/providers/sql/mssql.ts`), which is where the
 * ruling settled it.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The container segments of a path, keyed by the LEVEL each one belongs to.
 *
 * This is what replaces `container[0]` and `path[1]`: a caller asks for `catalog` or
 * `schema` BY NAME, so a level added, removed or reordered moves every read with it.
 *
 * `Object.fromEntries` loses the key union, so the result is asserted back to it. The
 * assertion is sound by construction: the entries are exactly the declared level ids, and
 * `Partial` is what carries "a catalog-level container names no schema".
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
 * Every caller that binds a segment goes through this rather than through a non-null
 * assertion, because `undefined` reaching a bound parameter is not an error on this
 * driver - `Cannot create values of type ANY` is what the binding answers, which names
 * neither the level nor the path. The case is reachable without a bug in this file: a
 * provider that copied it and declared only a `catalog` level would have no schema
 * segment at all.
 */
function requiredSegment(
  segments: Partial<Record<ContainerLevelSpec["id"], string>>,
  level: ContainerLevelSpec["id"],
): string {
  const segment = segments[level];
  if (segment === undefined) {
    throw new QueryError(`DuckDB declares no ${level} level to read this path's segment from`, "duckdb");
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
 * `tests/helpers/object-surface-conformance.ts` reads counts at the OUTER one, so "how
 * many tables does this whole catalog hold" is a question with a true answer rather than
 * a caller mistake. SQL Server answered the same way for the same reason.
 *
 * The names in the message are the declared LABELS, the engine's own word for a person
 * reading a refusal; the code addresses the same segments by `ContainerLevelSpec.id`. The
 * depth behind both is `containerDepth()`, so the check and the sentence cannot disagree.
 */
function containerShapes(capabilities: ProviderCapabilities): readonly string[][] {
  const names = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  return names.map((_, index) => names.slice(0, index + 1));
}

/**
 * The shapes above, spelled for a message: `[database] or [database, schema]`.
 *
 * A declaration carrying no container level has no shape at all, and the empty join would
 * print "a DuckDB container path is , received []", which reads as a formatting bug rather
 * than as the fact it is. Reachable only through a declaration this engine does not have,
 * and pinned by the test that hands the provider one.
 */
function shapeList(shapes: readonly string[][]): string {
  if (shapes.length === 0) return "nothing: this declaration carries no container level";
  return shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ");
}

/**
 * The segments a container path addresses, keyed by level, or a refusal naming the shapes.
 *
 * It raises rather than reading what it can and carrying on. `undefined` bound as a
 * parameter is a driver-level failure here, and a container one segment too long would
 * otherwise bind the object's own name as a schema and answer an empty folder that looks
 * exactly like a schema holding nothing.
 */
function containerTarget(
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Partial<Record<ContainerLevelSpec["id"], string>> {
  const shapes = containerShapes(capabilities);
  if (!shapes.some((shape) => shape.length === container.length)) {
    throw new QueryError(
      `A DuckDB container path is ${shapeList(shapes)}, received ${JSON.stringify(container)}`,
      "duckdb",
    );
  }
  return containerSegments(capabilities, container);
}

/**
 * One container path resolved into everything the three reads need.
 *
 * ONE function rather than three, because `bySchema` decides both which statement is built
 * and which parameters are bound, and two derivations of the same fact are two chances to
 * disagree: a statement carrying `$2` with a one-element bind array is a driver-level
 * failure (`Values were not provided for the following prepared statement parameters`),
 * and the reverse silently counts the whole catalog under a schema's badge.
 *
 * Both fields are read BY LEVEL through `requiredSegment` and `target.schema`, never by
 * position: standing ruling 5g (#789) is that `container[0]` is the third spelling of the
 * same defect, and on a two-level engine it is wrong rather than merely fragile.
 */
export interface ContainerRead {
  readonly catalog: string;
  readonly bySchema: boolean;
  readonly binds: string[];
}

export function containerRead(capabilities: ProviderCapabilities, container: readonly string[]): ContainerRead {
  const target = containerTarget(capabilities, container);
  const catalog = requiredSegment(target, "catalog");
  const schema = target.schema;
  return {
    catalog,
    bySchema: schema !== undefined,
    binds: schema === undefined ? [catalog] : [catalog, schema],
  };
}

/**
 * The path shapes one KIND's objects are addressed by, derived from the declaration.
 *
 * ONE shape per kind, `[...levels, name]`. Every DuckDB object of every declared kind sits
 * in a schema - `CREATE TABLE t` with no schema resolves into the session's, never into no
 * schema - and nothing on this engine hangs off another object: there are no triggers at
 * all, which is the kind that gave SQL Server and Oracle a second shape, and an index is
 * not declared as a kind here.
 *
 * A kind declaring `attachedTo` is REFUSED rather than given the extra segment, because
 * the four statements above address a schema and a name and there is no read here that
 * could fill a base-object segment. Producing the shape anyway would draw a folder whose
 * every path resolves to nothing; saying so names what is missing.
 */
function objectShapes(capabilities: ProviderCapabilities, spec: ObjectKindSpec): readonly string[][] {
  if (spec.attachedTo !== undefined) {
    throw new QueryError(
      `DuckDB holds no object attached to another, so the kind "${spec.id}" cannot declare attachedTo "${spec.attachedTo}"`,
      "duckdb",
    );
  }
  return [[...declaredLevels(capabilities).map((level) => level.label.toLowerCase()), "name"]];
}

/**
 * One object path resolved into the three things its detail reads need, checked first.
 *
 * The name is `path[path.length - 1]` and NEVER `path[2]`, and the container segments come
 * from `containerSegments()` and never from `path[0]` and `path[1]`. Standing ruling 5g
 * (#789) asks every provider task to pin this; DuckDB can pin it harder than SQL Server
 * could, because a `spyOn` on `getCapabilities` can hand this provider the SAME two levels
 * in the OPPOSITE order and the test still reaches a bound value against a real engine -
 * the SQL Server task recorded that case as unreachable there (#789).
 *
 * The SCHEMA is carried as a named field as well as inside `binds`, because
 * `ForeignKeySchema.referencedTable` is spelled relative to it and reading it back out of
 * the bind array by position would reintroduce exactly the defect above.
 */
export interface ObjectRead {
  readonly schema: string;
  readonly name: string;
  readonly binds: [string, string, string];
}

export function objectRead(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  path: readonly string[],
): ObjectRead {
  const shapes = objectShapes(capabilities, spec);
  if (!shapes.some((shape) => shape.length === path.length)) {
    throw new QueryError(
      `A DuckDB "${spec.id}" path is ${shapeList(shapes)}, received ${JSON.stringify(path)}`,
      "duckdb",
    );
  }
  const segments = containerSegments(capabilities, path);
  const catalog = requiredSegment(segments, "catalog");
  const schema = requiredSegment(segments, "schema");
  const name = path[path.length - 1];
  return { schema, name, binds: [catalog, schema, name] };
}

// ============================================================================
// Count assembly
// ============================================================================

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this engine has this kind and this container holds none" render
 * as a 0 badge. Building the record from the answered rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the engine has
 * no such concept, so the tree draws no folder at all.
 */
export function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/** Overwrites the seeded zeros with what the UNION ALL actually answered. */
export function applyKindCounts(
  counts: Record<string, KindCount>,
  rows: readonly KindCountRow[],
  toNumber: (value: unknown) => number | undefined,
): void {
  for (const row of rows) {
    const measured = toNumber(row.n);
    // An unreadable count is left at whatever it was seeded with rather than coerced to
    // 0 through `Number(undefined)`, which is NaN and renders as a blank badge.
    if (measured !== undefined) counts[row.kind] = { count: measured };
  }
}

// ============================================================================
// Row mapping and ordering
// ============================================================================

/**
 * One catalog row as the object it addresses.
 *
 * The SCHEMA comes from the row rather than from the container, which is load-bearing at
 * the catalog level where one listing spans every schema in the database.
 *
 * The path is CONSTRUCTED here, which standing ruling 5g (#789) names as the one place a
 * position is legitimately written rather than derived - and it still has to be written in
 * the DECLARED order rather than in this engine's happens-to-be order, because
 * `objectRead()` reads the same path back by level. A listing that wrote
 * `[catalog, schema, name]` while the declaration said schema then catalog would hand the
 * conformance helper a path its own `describeObject` resolves backwards, so the two sides
 * of the round trip are driven from one array.
 */
export function listedObject(
  capabilities: ProviderCapabilities,
  catalog: string,
  kind: string,
  row: ObjectRow,
): DatabaseObject {
  const segments: Record<ContainerLevelSpec["id"], string> = { catalog, schema: row.schema_name };
  const path = [...declaredLevels(capabilities).map((level) => segments[level.id]), row.name];
  return { path, name: row.name, kind };
}

/**
 * The rows of one bulk read, grouped by the object they describe.
 *
 * The key is built by the CALLER rather than here, because a schema and a name joined by
 * any printable separator is a name collision waiting to happen: two objects really can be
 * called `a` and `b.c` in schemas `a.b` and `b`. The caller uses a NUL, which no DuckDB
 * identifier can contain.
 */
export function groupByObject<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const existing = grouped.get(id);
    if (existing === undefined) grouped.set(id, [row]);
    else existing.push(row);
  }
  return grouped;
}

/** One bulk detail row, tagged with the object it belongs to. */
export type OfObject<T> = T & { schema_name: string; table_name: string };

/** One object's four row sets, whichever read produced them. */
export interface ObjectDetailRows {
  readonly columns: readonly ColumnRow[];
  readonly primaryKey: readonly PrimaryKeyRow[];
  readonly foreignKeys: readonly ForeignKeyRow[];
  readonly indexes: readonly IndexRow[];
}

/**
 * ONE object's detail, from rows, for BOTH the single read and the bulk read (#789).
 *
 * One mapper and not two, because two are two chances for `describeObjects` to spell a
 * column, an index or a foreign key differently from `describeObject` over the same table,
 * and nothing downstream compares the two answers.
 *
 * `schema` is passed rather than read off the path, because the bulk read takes it from the
 * ROW: a catalog-level read spans every schema under the catalog, so the object's schema is
 * something the answer carries and not something the container said.
 */
export function objectDetailFromRows(path: readonly string[], schema: string, rows: ObjectDetailRows): ObjectDetail {
  const primaryKey = new Set(rows.primaryKey.flatMap((row) => row.constraint_column_names));

  return {
    path: [...path],
    columns: rows.columns.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable,
      isPrimary: primaryKey.has(row.column_name),
      // `?? undefined` rather than a conditional spread: `ColumnSchema.defaultValue` is
      // optional and an absent key and an undefined one are the same fact to every
      // consumer, so the explicit form keeps the object shape constant across rows.
      defaultValue: row.column_default ?? undefined,
    })),
    // A composite foreign key is ONE constraint over several columns and `ForeignKeySchema`
    // is per column, so the two aligned arrays are zipped out.
    foreignKeys: rows.foreignKeys.flatMap((row) =>
      row.constraint_column_names.map((columnName, index) => ({
        columnName,
        // Spelled the way `getSchema()` spells it on this engine, because
        // `ForeignKeySchema` carries one string and both surfaces are live through Phase 1:
        // bare in `main` and qualified anywhere else. DuckDB refuses a foreign key across
        // schemas outright, so the target is always in the reading object's own schema and
        // the catalog never needs naming.
        referencedTable: displayName(schema, row.referenced_table),
        referencedColumn: row.referenced_column_names[index],
      })),
    ),
    indexes: rows.indexes.map((row) => ({
      name: row.index_name,
      columns: row.index_columns ?? [],
      unique: row.is_unique,
    })),
  };
}

/**
 * Two paths ordered SEGMENT BY SEGMENT, shorter first where one is a prefix of the other.
 *
 * Never `JSON.stringify`, which standing ruling 5g (#789) rules out as a path key: JSON
 * escaping reorders exotic names by rewriting the very characters being compared, and at
 * mixed depth a serialised deeper path sorts before its own prefix because `,` is below
 * `]`. Neither is hypothetical on DuckDB - a double quote is legal in an identifier here
 * (`CREATE TABLE "a""b"` succeeds, measured) and JSON rewrites it as `\"`.
 */
export function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}
