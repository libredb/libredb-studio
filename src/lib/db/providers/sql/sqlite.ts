/**
 * SQLite Database Provider
 * File-based SQLite support - runs under both Bun and Node.
 *
 * The underlying driver is selected at runtime by the sqlite-driver adapter:
 * bun:sqlite under Bun, node:sqlite under Node (override with
 * LIBREDB_SQLITE_DRIVER=bun|node).
 *
 * Note: SQLite is primarily for local development. Cloud deployments
 * typically use PostgreSQL or MySQL instead.
 */

import { SQLBaseProvider } from "./sql-base";
import {
  type Container,
  type ContainerLevelSpec,
  type DatabaseObject,
  type DatabaseConnection,
  type ForeignKeySchema,
  type IndexSchema,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectKindSpec,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderExecutionContext,
  type ReadOnlyStatementBudget,
  type ProviderCapabilities,
  type ProviderLabels,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from "../../types";
import {
  DatabaseConfigError,
  ConnectionError,
  ExecutionProfileError,
  QueryError,
  mapDatabaseError,
} from "../../errors";
import { assertReadOnlyBudget, measureResultBytes } from "./read-only-budget";
import { formatBytes } from "../../utils/pool-manager";
import { loadSQLiteDriver, type SQLiteDatabase } from "./sqlite-driver";
import { callerBoundTruncationReason, containerDepth, declaredKinds, findKind } from "../../object-kinds";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Type Definitions
// ============================================================================

// Row shapes returned by the PRAGMA introspection statements below.
interface SQLiteColumnInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SQLiteForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

interface SQLiteIndexListRow {
  seq: number;
  name: string;
  unique: number;
}

// ============================================================================
// Introspection SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope (not inlined in the methods) on purpose. bun's
// coverage instruments the interior lines of a *multi-line template literal in
// a function body* as 0-hit in any test process that imports this file but
// does not exercise the method — and the merged lcov then reports those SQL
// lines as uncovered even though the method is tested. Evaluated once at
// module load, these consts are reported as covered everywhere, so coverage
// stays accurate (same pattern as postgres.ts).
// ============================================================================

const SCHEMA_TABLES_SQL = `
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `;

const DB_PAGE_SIZE_SQL = `
          SELECT (SELECT page_count FROM pragma_page_count()) *
                 (SELECT page_size FROM pragma_page_size()) as size
        `;

// Size of a :memory: database (no file to stat).
const MEMORY_DB_SIZE_SQL = `
          SELECT (page_count * page_size) as size
          FROM pragma_page_count(), pragma_page_size()
        `;

const TABLE_COUNT_SQL = `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `;

const INDEX_COUNT_SQL = `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `;

const STATS_TABLES_SQL = `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

// Per-object page bytes. `dbstat` is a virtual table behind the compile-time
// SQLITE_ENABLE_DBSTAT_VTAB option, so whether it answers is a property of the BUILD
// behind the driver rather than of the driver's name: node:sqlite has carried it
// throughout, bun:sqlite raised "no such table: dbstat" through Bun 1.3.14 (measured
// 2026-08-24 on SQLite 3.53.0 against a working row from node:sqlite 3.51.2 /
// Node 24.14.0) and answers from 1.4.0 / 3.53.2 on the Linux and Windows builds
// (re-measured 2026-08-31 on Linux x86_64). Both arms stay live - see readDbstatSizes.
// It is the only
// per-table size SQLite publishes at all - there is no catalog column for it - and
// reading it costs a scan of the whole database file, which is acceptable on the
// monitoring tab and is why nothing else calls it.
const DBSTAT_SIZES_SQL = `
      SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name
    `;

// Every index and which table it belongs to. Deliberately NOT filtered by
// `name NOT LIKE 'sqlite_%'` the way STATS_INDEXES_SQL is: an implicit
// `sqlite_autoindex_*` occupies real pages and belongs in its table's index bytes,
// even though it is not an index a user declared and so is not listed on its own.
const DBSTAT_INDEX_OWNERS_SQL = `
      SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'
    `;

const STATS_INDEXES_SQL = `
      SELECT name, tbl_name FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY tbl_name, name
    `;

// ============================================================================
// Object surface (#789)
// ============================================================================

/**
 * The one schema this provider's object surface reads, and the reason it is a constant
 * rather than a path segment.
 *
 * SQLite declares ZERO container levels, so no container path carries a schema and
 * nothing here derives one. `main` is SQLite's own name for the database file the
 * connection opened; `temp` and any `ATTACH`ed database are SESSION state on this handle,
 * which a declaration read off an UNCONNECTED provider (`POST /api/db/provider-meta`,
 * #457) cannot describe. Out of scope for Phase 1 and recorded as such in
 * `docs/providers/sqlite.md`.
 *
 * It is not cosmetic, and it is not a filter that could be dropped. Measured on SQLite
 * 3.53.2: with `CREATE TEMP TABLE main_only(ttt)` live, the one-argument
 * `pragma_table_info('main_only')` answers the TEMP table's columns and the two-argument
 * `pragma_table_info('main_only', 'main')` answers the file's. A read that leaves the
 * schema out describes a different object under the same name. The same measurement on
 * the listing side: `PRAGMA table_list` spans every attached schema AND `temp`, so
 * without `t.schema = ?` a temp table shadowing a real one gives two objects ONE path,
 * which is the uniqueness the tree addresses rows by.
 */
const MAIN_SCHEMA = "main";

// ----------------------------------------------------------------------------
// `name NOT LIKE 'sqlite\_%' ESCAPE '\'`, in all six statements below
//
// Names SQLite reserves for itself, excluded from every count and every listing. This
// can never hide a user's object, and that is measured rather than assumed: the engine
// refuses the name outright, `CREATE TABLE sqlite_foo` answering "object name reserved
// for internal use: sqlite_foo". What it does remove is real and appears without being
// asked for - `sqlite_schema` and `sqlite_temp_schema` are rows in `PRAGMA table_list`,
// `sqlite_sequence` appears the moment a table declares AUTOINCREMENT, `sqlite_stat1`
// the moment ANALYZE runs, and `sqlite_autoindex_<table>_<n>` the moment a column
// declares UNIQUE or a PRIMARY KEY needs an index.
//
// `ESCAPE` is load-bearing: `_` is LIKE's single-character wildcard, so the unescaped
// `'sqlite_%'` also matches `sqliteXanything`, which is a name a user CAN create.
//
// The same predicate is applied to all four populations, in the counts and in the
// listings, so the badge and its folder can never disagree about what an object is
// (standing ruling 5f).
// ----------------------------------------------------------------------------

/**
 * How many objects of each kind the file holds, in one statement.
 *
 * Two arms because two catalogs answer: `PRAGMA table_list` separates a real table from
 * the shadow tables an FTS5 or R-Tree module owns, and `sqlite_schema` is the only place
 * an index or a trigger appears at all. The `CASE` maps the three relation-shaped
 * `table_list` types onto the two declared kinds, and the `IN` list is the vocabulary:
 * `PRAGMA table_list.type` is documented to carry exactly `table`, `view`, `shadow` and
 * `virtual`, so the arm that is dropped is `shadow` and nothing else. That is SQLite's
 * documentation rather than a `SELECT DISTINCT` over a fixture (standing ruling 5a), and
 * the fixture in `tests/integration/db/sqlite-provider.test.ts` holds all four values so
 * the claim is exercised rather than asserted.
 */
const COUNTS_SQL = `
      SELECT kind, COUNT(*) AS n
        FROM (
               SELECT CASE t.type WHEN 'view' THEN 'view' ELSE 'table' END AS kind
                 FROM pragma_table_list AS t
                WHERE t.schema = ?
                  AND t.type IN ('table', 'view', 'virtual')
                  AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
               UNION ALL
               SELECT s.type AS kind
                 FROM sqlite_schema AS s
                WHERE s.type IN ('index', 'trigger')
                  AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             )
       GROUP BY kind
    `;

// `virtual` belongs with `table` and `shadow` does not, which is the whole reason
// `PRAGMA table_list` is read here instead of `sqlite_schema`. An FTS5 table is one
// `virtual` row plus five `shadow` rows and an R-Tree is one plus three, and
// `sqlite_schema` types every one of them `table`: measured on the fixture in
// `tests/integration/db/sqlite-provider.test.ts`, which holds six tables and one FTS5
// table, a naive scan answers 12. A user SELECTs from the `virtual` row and never from a
// `shadow` one, so the shadow tables are not objects this tree has any business drawing.
const LIST_TABLES_SQL = `
      SELECT t.name AS name
        FROM pragma_table_list AS t
       WHERE t.schema = ?
         AND t.type IN ('table', 'virtual')
         AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

const LIST_VIEWS_SQL = `
      SELECT t.name AS name
        FROM pragma_table_list AS t
       WHERE t.schema = ?
         AND t.type = 'view'
         AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

// Indexes and triggers are not in `PRAGMA table_list` at all, so these two read
// `sqlite_schema`, which needs no schema bind: measured with a database ATTACHed, the
// unqualified name always resolves to `main.sqlite_schema`, and `temp` objects live in
// the separate `sqlite_temp_schema`. So these two are already scoped to the same one
// schema the two statements above bind.
const LIST_INDEXES_SQL = `
      SELECT s.name AS name
        FROM sqlite_schema AS s
       WHERE s.type = 'index'
         AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

// `tbl_name` is the object the trigger fires on, which is the `attachedTo` nesting.
const LIST_TRIGGERS_SQL = `
      SELECT s.name AS name, s.tbl_name AS parent
        FROM sqlite_schema AS s
       WHERE s.type = 'trigger'
         AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    `;

// `table_xinfo` and not `table_info`, which is the same read minus the hidden column.
// Measured: `table_info` DROPS a generated column in both spellings, VIRTUAL (hidden 2)
// and STORED (hidden 3), so a table declaring one reports a column list the engine does
// not have. `hidden = 1` is the other direction - a virtual table module's own interface
// columns, its own name and `rank` on an FTS5 table - and those are not columns the table
// declares, so only that value is excluded. `getSchema()` still reads `table_info` and
// still loses generated columns; that is the flat surface's defect, recorded in
// docs/BACKLOG.md.
const OBJECT_COLUMNS_SQL = `
      SELECT name, type, "notnull", dflt_value, pk
        FROM pragma_table_xinfo(?, ?)
       WHERE hidden <> 1
       ORDER BY cid
    `;

// `ORDER BY name`, which `pragma_index_list` does NOT do on its own: measured, it answers
// in reverse creation order, so `idx_orders_doubled` comes back before
// `idx_orders_customer`. The bulk read has to order by the object to group its rows, and
// an order that then differs from this one would make the two surfaces describe the same
// table's indexes in two different sequences. Creation order is not a fact anybody reads,
// so both are ordered by name.
const OBJECT_INDEXES_SQL = `
      SELECT name, "unique"
        FROM pragma_index_list(?, ?)
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name
    `;

const OBJECT_INDEX_COLUMNS_SQL = `
      SELECT name
        FROM pragma_index_info(?, ?)
       ORDER BY seqno
    `;

// The parent's PRIMARY KEY column for a foreign key that names no column, resolved in
// the same statement. Measured: `REFERENCES customers` (no column list) answers
// `to = NULL`, which means the parent's primary key, and
// `ForeignKeySchema.referencedColumn` is a string - so the alternative to resolving it is
// putting a null in a typed string field.
//
// `pk` is a 1-BASED RANK over the parent's key columns and `seq` is the 0-based position
// of this column inside the constraint, so `p.pk = f.seq + 1` is the parent key column
// this one references. A correlated subquery rather than a second read per parent,
// because the same shape then serves the bulk read, where the parents of a whole folder
// would otherwise be a second N+1 inside the read that exists to remove one. A parent
// that is not there at all answers NULL, which is the same absence the per-parent read
// spelled as an out-of-range index (measured against `REFERENCES ghost`).
//
// The first placeholder is the SUBQUERY's schema, because SQLite numbers placeholders by
// the order they APPEAR in the statement text and the select list is written before the
// FROM clause.
const OBJECT_FOREIGN_KEYS_SQL = `
      SELECT f.id AS id, f.seq AS seq, f."table" AS "table", f."from" AS "from", f."to" AS "to",
             (SELECT p.name FROM pragma_table_info(f."table", ?) AS p WHERE p.pk = f.seq + 1) AS parent_key
        FROM pragma_foreign_key_list(?, ?) AS f
       ORDER BY f.id, f.seq
    `;

/**
 * Every object kind SQLite has, and nothing else.
 *
 * `sqlite_schema.type` carries exactly four values - `table`, `index`, `view` and
 * `trigger` - and this is the whole inventory. There is no stored procedure and no stored
 * function to declare: an application-defined SQLite function is registered against a
 * connection by the HOST PROCESS through `sqlite3_create_function()` and is never written
 * to the database file, so nothing survives the connection to be listed and a `routine`
 * folder would be a claim about this product rather than about the file.
 *
 * `index` IS declared here, unlike on postgres, mysql, mssql and oracle. The test is
 * whether the engine's own catalog models an index as a first-class named object at
 * container level, and SQLite's does: an index is a row in `sqlite_schema` beside the
 * tables, addressed by a bare name that shares one namespace with tables and views
 * (measured: `CREATE INDEX t ON u(id)` against an existing table `t` answers
 * "there is already a table named t").
 *
 * Module scope rather than a literal inside `getCapabilities()`, so the array is one
 * object rather than a fresh one per call: `getCapabilities()` is called several times
 * per request by the object routes and the tree.
 */
const SQLITE_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
  // No `acceptsRowWrites`. SQLite refuses a write to a view outright unless an INSTEAD OF
  // trigger carries it, which is a per-OBJECT fact a per-kind declaration cannot state.
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "index", role: "config", label: "Index", labelPlural: "Indexes" },
  { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
];

/** One row of `COUNTS_SQL`: a declared kind id and how many the file holds. */
interface KindCountRow {
  kind: string;
  n: number;
}

/**
 * One listed object, from whichever of the four listing statements answered.
 *
 * `parent` is selected by the trigger listing alone, which is what lets one mapper serve
 * all four.
 */
interface ObjectRow {
  name: string;
  parent?: string | null;
}

/** One column of an object, as `pragma_table_xinfo` publishes it. */
interface ObjectColumnRow {
  name: string;
  type: string | null;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** One index on an object, as `pragma_index_list` publishes it. */
interface ObjectIndexRow {
  name: string;
  unique: number;
}

/**
 * One key column of one index, as `pragma_index_info` publishes it.
 *
 * `index_name` is carried on the row rather than held by the caller, so the single read
 * and the bulk read hand the shared mapper the same shape: the single read reads one
 * index at a time and tags each row, the bulk read selects the name in SQL.
 */
interface ObjectIndexColumnRow {
  index_name: string;
  name: string | null;
}

/**
 * One foreign key constraint column, as `pragma_foreign_key_list` publishes it, plus the
 * parent key column `OBJECT_FOREIGN_KEYS_SQL`'s correlated subquery resolved.
 */
interface ObjectForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  parent_key: string | null;
}

/** One object's four row sets, whichever read produced them. */
interface ObjectDetailRows {
  readonly columns: readonly ObjectColumnRow[];
  readonly indexes: readonly ObjectIndexRow[];
  readonly indexColumns: readonly ObjectIndexColumnRow[];
  readonly foreignKeys: readonly ObjectForeignKeyRow[];
}

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by
 * two different rules. `containerDepth()` is what decides, never `containerLevels.length`:
 * absent and empty are the same fact and two callers reading the field by different rules
 * is how the tree and the API route came to disagree about one engine.
 *
 * On SQLite this answers the empty array, which is the point of the task and not a
 * degenerate case.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * Refuses a container path that is not the shape the DECLARATION describes.
 *
 * On SQLite the only valid container path is the empty one, and `container.length !== 0`
 * is NOT how that is written. The depth comes from `containerDepth()` and the segment
 * names from the declared level labels, so the check and its message are the same array:
 * a provider copying this file onto a one- or two-level engine inherits a derivation
 * rather than a literal that would refuse every valid path there (standing ruling 5g).
 *
 * This raises rather than answering an empty folder, because a path of another shape is a
 * caller that built it from another engine's model, and an empty folder that looks exactly
 * like a database holding nothing is the worst way to report that.
 */
function assertContainerPath(capabilities: ProviderCapabilities, container: readonly string[]): void {
  const levels = declaredLevels(capabilities);
  if (container.length === levels.length) return;
  const shape = levels.length === 0 ? "empty" : `[${levels.map((level) => level.label.toLowerCase()).join(", ")}]`;
  throw new QueryError(`A SQLite container path is ${shape}, received ${JSON.stringify(container)}`, "sqlite");
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "SQLite has this kind and this file holds none" render as a 0
 * badge. Building the record from the GROUP BY rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the engine has
 * no such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the GROUP BY actually answered.
 *
 * A kind that was never seeded is SKIPPED, so the DECLARATION decides which folders exist
 * and a catalog row cannot add one - which is what keeps
 * `tests/helpers/object-surface-conformance.ts`'s "never answers for an undeclared kind"
 * true from this side.
 *
 * `Object.hasOwn` and not `in`, which is what makes that guarantee absolute rather than
 * nearly so: `in` walks the prototype chain, so a row whose kind read `toString` or
 * `constructor` would pass the test and write a folder the provider never declared.
 */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    if (Object.hasOwn(counts, row.kind)) counts[row.kind] = { count: Number(row.n) };
  }
}

/**
 * The engine's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through `mapDatabaseError`: that mapper gives a THROWN error a type and
 * this product's prefix, and nothing here throws. The sentence is rendered to a person as
 * the reason a folder has no number, so prefixing it would put our words in front of
 * SQLite's. A refused read is never 0 - on a build older than 3.37 the sentence is
 * "no such table: pragma_table_list", which is a different fact from "this file holds no
 * tables", and `KindCount` is the type that keeps them apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/**
 * The `PRAGMA table_list` types one declared kind covers, and the whole set of kinds the
 * bulk column read answers for (#789).
 *
 * The two `relation` kinds and nothing else. Measured: `pragma_table_xinfo` answers ZERO
 * rows for an index name and for a trigger name, so those two kinds have no columns at
 * all on this engine and `describeObjects` answers `{ details: [] }` for them without a
 * round trip - the same fact `describeObject` answers as three empty arrays.
 *
 * The `IN` list is the same vocabulary `LIST_TABLES_SQL` and `LIST_VIEWS_SQL` carry, taken
 * from SQLite's documentation of `PRAGMA table_list.type` rather than from a fixture
 * (standing ruling 5a), so the bulk read's target can never be a different population from
 * the folder's listing.
 */
const BULK_RELATION_TYPES: Readonly<Record<string, readonly string[]>> = {
  table: ["table", "virtual"],
  view: ["view"],
};

/**
 * The target set of one bulk read: every object of one kind in `main`, in the engine's
 * own order, optionally cut.
 *
 * `ORDER BY t.name` is not decoration. Measured: `pragma_table_list` answers in no useful
 * order of its own, so without it a bounded read would keep an arbitrary subset and two
 * calls could keep different ones. The sort runs under BINARY, which is the UTF-8 BYTE
 * order, and that is NOT the same order `comparePaths` produces: measured, a database
 * holding the two names U+E000 and U+1F600 comes back from SQLite in that order and from
 * a JavaScript sort in the other, because JavaScript compares UTF-16 code units. So the
 * MEMBERSHIP of a bounded cut is the engine's and the ORDER of the answer is ours, and the
 * two are separated deliberately rather than assumed to agree.
 *
 * `LIMIT ?` carries `limit + 1`, so a saturated read is distinguishable from an exact one
 * without a second count. The bound is bound rather than interpolated, measured accepted
 * inside a CTE by both drivers.
 */
function describedCte(types: readonly string[], bounded: boolean): string {
  return `WITH described AS (
        SELECT t.name AS object_name
          FROM pragma_table_list AS t
         WHERE t.schema = ?
           AND t.type IN (${types.map((type) => `'${type}'`).join(", ")})
           AND t.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY t.name${bounded ? "\n         LIMIT ?" : ""}
      )`;
}

/**
 * The five statements of one bulk read, which is FIVE round trips for a whole folder
 * rather than one per object plus one per index.
 *
 * Every one of them joins a pragma table-valued function against the SAME `described`
 * target, which is what makes the count constant: SQLite accepts a TVF argument that
 * references a column of the row being joined, so `pragma_table_xinfo(d.object_name, ?)`
 * runs once per target object inside one statement.
 *
 * The target read is separate and is what decides MEMBERSHIP. Taking it from the column
 * read instead would drop an object whose every column is hidden, and the folder's listing
 * would then name an object the batch does not carry.
 */
interface BulkDetailStatements {
  readonly target: string;
  readonly columns: string;
  readonly indexes: string;
  readonly indexColumns: string;
  readonly foreignKeys: string;
  /** How many trailing `MAIN_SCHEMA` binds each statement above takes, in that order. */
  readonly schemaBinds: readonly [number, number, number, number, number];
}

function bulkDetailStatements(types: readonly string[], bounded: boolean): BulkDetailStatements {
  const described = describedCte(types, bounded);
  return {
    target: `${described}
      SELECT d.object_name AS object_name FROM described AS d`,
    columns: `${described}
      SELECT d.object_name AS object_name, x.name AS name, x.type AS type,
             x."notnull" AS "notnull", x.dflt_value AS dflt_value, x.pk AS pk
        FROM described AS d
        JOIN pragma_table_xinfo(d.object_name, ?) AS x
       WHERE x.hidden <> 1
       ORDER BY d.object_name, x.cid`,
    indexes: `${described}
      SELECT d.object_name AS object_name, i.name AS name, i."unique" AS "unique"
        FROM described AS d
        JOIN pragma_index_list(d.object_name, ?) AS i
       WHERE i.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY d.object_name, i.name`,
    indexColumns: `${described}, listed AS (
        SELECT d.object_name AS object_name, i.name AS index_name
          FROM described AS d
          JOIN pragma_index_list(d.object_name, ?) AS i
         WHERE i.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      )
      SELECT l.object_name AS object_name, l.index_name AS index_name, c.name AS name
        FROM listed AS l
        JOIN pragma_index_info(l.index_name, ?) AS c
       ORDER BY l.object_name, l.index_name, c.seqno`,
    foreignKeys: `${described}
      SELECT d.object_name AS object_name, f.id AS id, f.seq AS seq, f."table" AS "table",
             f."from" AS "from", f."to" AS "to",
             (SELECT p.name FROM pragma_table_info(f."table", ?) AS p WHERE p.pk = f.seq + 1) AS parent_key
        FROM described AS d
        JOIN pragma_foreign_key_list(d.object_name, ?) AS f
       ORDER BY d.object_name, f.id, f.seq`,
    schemaBinds: [0, 1, 1, 2, 2],
  };
}

/**
 * Both forms of all five statements, per kind, built once at module load rather than per
 * call: the object routes ask for a folder at a time and the text never varies.
 */
const BULK_DETAIL_SQL: Readonly<Record<string, BulkDetailStatements>> = Object.fromEntries(
  Object.entries(BULK_RELATION_TYPES).map(([kind, types]) => [kind, bulkDetailStatements(types, false)]),
);

const BULK_DETAIL_SQL_BOUNDED: Readonly<Record<string, BulkDetailStatements>> = Object.fromEntries(
  Object.entries(BULK_RELATION_TYPES).map(([kind, types]) => [kind, bulkDetailStatements(types, true)]),
);

/** One bulk row, tagged with the object it belongs to. */
type OfObject<T> = T & { object_name: string };

/** The rows of one bulk read, grouped by the object they describe. */
function groupByObject<T extends { object_name: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.object_name);
    if (existing === undefined) grouped.set(row.object_name, [row]);
    else existing.push(row);
  }
  return grouped;
}

/** Which statement lists one kind, and what it binds. */
const OBJECT_LISTINGS: Readonly<Record<string, { readonly sql: string; readonly params: readonly unknown[] }>> = {
  table: { sql: LIST_TABLES_SQL, params: [MAIN_SCHEMA] },
  view: { sql: LIST_VIEWS_SQL, params: [MAIN_SCHEMA] },
  index: { sql: LIST_INDEXES_SQL, params: [] },
  trigger: { sql: LIST_TRIGGERS_SQL, params: [] },
};

/**
 * Where one listed object is addressed.
 *
 * Built from the CONTAINER and the ROW rather than from the kind id, so the four listing
 * statements share one rule: a `parent` column adds a nesting segment and nothing else
 * does, which is what the `attachedTo: "table"` declaration states. The container path is
 * prefixed rather than assumed empty, so every path starts with its container even though
 * SQLite's container path is always `[]` - the conformance helper asserts exactly that,
 * and writing `[row.name]` here would be a second place that knows this engine's depth.
 *
 * A trigger's parent is `sqlite_schema.tbl_name`, which is never null for a trigger, so
 * there is no parentless shape to collapse. It is not always a TABLE: SQLite allows an
 * INSTEAD OF trigger on a VIEW and `tbl_name` then names the view. `attachedTo` names the
 * kind a trigger usually hangs off, and the count and the listing both carry the view case
 * rather than one of them dropping it (standing ruling 5f).
 */
function objectPath(container: readonly string[], row: ObjectRow): string[] {
  const parent = row.parent;
  if (parent === undefined || parent === null) return [...container, row.name];
  return [...container, parent, row.name];
}

/**
 * Two paths compared SEGMENT BY SEGMENT, so a sort is over the address and never over one
 * joined string.
 *
 * Exported for the same reason `readDbstatSizes` is: the two cases that separate this
 * from `JSON.stringify` cannot arise inside ONE kind on this engine, where every path of a
 * kind is the same length, so a test driven through `listObjects` could not tell the two
 * spellings apart. The rule is shared with every other provider in #789.
 *
 * `JSON.stringify(path)` is the obvious spelling and it is wrong twice. At MIXED DEPTH the
 * deeper path sorts first, because the separator `,` (0x2C) is below the terminator `]`
 * (0x5D), which would put a trigger above the object it hangs off. And JSON ESCAPES, so a
 * name holding a quote, a backslash or a control character sorts by its escape sequence
 * rather than by its own code points.
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
 * ONE object's detail, from rows, for BOTH the single read and the bulk read (#789).
 *
 * One mapper and not two, because two are two chances for `describeObjects` to spell a
 * column, an index or a foreign key differently from `describeObject` over the same
 * table, and nothing downstream compares the two answers. Everything this function needs
 * is on the rows, so the two callers differ only in which statement produced them: the
 * single read binds one object name, the bulk read joins the same pragmas against a
 * target set.
 */
function objectDetailFromRows(path: readonly string[], rows: ObjectDetailRows): ObjectDetail {
  const keyColumns = new Map<string, string[]>();
  for (const row of rows.indexColumns) {
    // An index on an EXPRESSION publishes a null column name (`cid = -2`), and so does one
    // that keys the rowid. Those are not columns of this object, so they are left out
    // rather than rendered as a fabricated label; the index itself still appears, with an
    // empty column list.
    if (row.name === null) continue;
    const existing = keyColumns.get(row.index_name);
    if (existing === undefined) keyColumns.set(row.index_name, [row.name]);
    else existing.push(row.name);
  }

  return {
    path: [...path],
    columns: rows.columns.map((row) => ({
      name: row.name,
      // `type` is the empty string on a virtual table's columns and on a column declared
      // with no type at all, which SQLite allows. `getSchema()` spells that absence
      // "TEXT", which is a guess about affinity; the empty string is what the engine said.
      type: row.type ?? "",
      nullable: row.notnull === 0,
      // `pk` is a 1-BASED RANK and not a flag: a composite primary key answers 1 and 2,
      // so `=== 1` reports the second key column as ordinary. Measured on
      // `PRIMARY KEY (region, year)`.
      isPrimary: row.pk > 0,
      defaultValue: row.dflt_value ?? undefined,
    })),
    indexes: rows.indexes.map((row) => ({
      name: row.name,
      columns: keyColumns.get(row.name) ?? [],
      unique: row.unique === 1,
    })),
    foreignKeys: rows.foreignKeys.map((row) => ({
      columnName: row.from,
      // A bare name, never qualified: SQLite resolves a foreign key's parent inside the
      // same database, so there is no cross-schema case to spell.
      referencedTable: row.table,
      referencedColumn: row.to ?? row.parent_key ?? "",
    })),
  };
}

// ============================================================================
// Agent read-only execution profile (#328)
// ============================================================================

const QUERY_ONLY_PRAGMA_SQL = "PRAGMA query_only = true";
const QUERY_ONLY_READBACK_SQL = "PRAGMA query_only";

/**
 * Refuses a read-only handle whose `query_only` pragma does not read back
 * enabled.
 *
 * A read-only OPEN does not imply `query_only` on either adapter (it reads
 * back 0 until explicitly set), so the profile sets it and verifies it — at
 * open AND before every statement.
 *
 * The two controls cover different things and neither is redundant. The
 * read-only open governs the TARGET database file: writes to it are refused
 * and a missing file is not created. It does NOT govern writes to OTHER
 * files — `VACUUM INTO '<path>'` copies the whole database to an arbitrary
 * server path from a read-only handle on both adapters. That is what
 * `query_only` refuses, and why it is re-asserted per statement rather than
 * only at open: a statement can turn it off, but `prepare()` compiles exactly
 * one statement, so the disable and the write can never ride in the same call.
 */
export function assertQueryOnlyEnabled(readback: unknown[]): void {
  const value = (readback[0] as { query_only?: unknown } | undefined)?.query_only;
  if (value !== 1) {
    throw new ConnectionError(
      `SQLite read-only profile could not enable query_only (read back ${JSON.stringify(value ?? null)})`,
      "sqlite",
    );
  }
}

// ============================================================================
// Per-table sizes (dbstat)
// ============================================================================

/** One table's measured page bytes, split between its own b-tree and its indexes. */
export interface SQLiteTableSizeBytes {
  tableSizeBytes: number;
  indexSizeBytes: number;
}

/**
 * Read per-object page bytes out of `dbstat`, or answer `null` when the driver has
 * no such table.
 *
 * `null` is the whole point: the two SQLite drivers disagree about dbstat (see
 * DBSTAT_SIZES_SQL), and `LIBREDB_SQLITE_DRIVER` lets a user switch between them, so
 * both answers have to be right. What used to fill the gap was `rowCount * 100`
 * ("Assume 100 bytes average per row") which the Storage tab summed into the Data
 * figure it drew beside the measured database size.
 *
 * Takes the database handle as a parameter, and is exported, so that BOTH answers are
 * testable in-process under Bun with a stand-in handle, whichever one the running build
 * happens to give. `dbstat` sits behind SQLITE_ENABLE_DBSTAT_VTAB, a COMPILE-TIME option,
 * so its presence is a property of the BUILD and not of the driver's name: this was
 * written believing bun:sqlite could only ever answer `null`, and a Bun whose SQLite
 * carries dbstat answers the other one. Nothing here changes - both answers were already
 * right - but a test that reads the driver's name to predict which arm it is on is
 * reading the wrong thing.
 */
export function readDbstatSizes(db: SQLiteDatabase): Map<string, SQLiteTableSizeBytes> | null {
  let pages: { name: string; bytes: number }[];
  try {
    pages = db.prepare(DBSTAT_SIZES_SQL).all() as { name: string; bytes: number }[];
  } catch {
    return null;
  }

  const owners = db.prepare(DBSTAT_INDEX_OWNERS_SQL).all() as { name: string; tbl_name: string }[];
  const bytesByObject = new Map(pages.map((page) => [page.name, Number(page.bytes) || 0]));
  const indexNames = new Set(owners.map((owner) => owner.name));
  const sizes = new Map<string, SQLiteTableSizeBytes>();

  const entryFor = (tableName: string): SQLiteTableSizeBytes => {
    const existing = sizes.get(tableName);
    if (existing) return existing;
    const created = { tableSizeBytes: 0, indexSizeBytes: 0 };
    sizes.set(tableName, created);
    return created;
  };

  // Indexes first, so an index's pages land on its table rather than on a name of
  // their own - the Storage tab's index total is the per-TABLE figure.
  for (const owner of owners) {
    entryFor(owner.tbl_name).indexSizeBytes += bytesByObject.get(owner.name) ?? 0;
  }
  for (const [name, bytes] of bytesByObject) {
    if (!indexNames.has(name)) entryFor(name).tableSizeBytes += bytes;
  }

  return sizes;
}

/**
 * Build one table's stats row. `size` is `null` when this driver publishes no page
 * bytes, and then the byte fields are OMITTED rather than zeroed: a 0 reads as an
 * empty table on the Storage tab, which is the same fabrication the `rowCount * 100`
 * estimate was. `totalSize`/`totalSizeBytes` are still required by `TableStats`, so
 * they carry the "N/A" / 0 placeholder that `getIndexStats()` already uses for
 * `indexSize` (#469) - the tab keys off the absent `tableSizeBytes` and draws neither.
 *
 * Exported for the same reason as readDbstatSizes: the populated branch is only ever
 * reached under node:sqlite, and it is tested under Bun by being handed the sizes.
 */
export function buildTableStats(tableName: string, rowCount: number, size: SQLiteTableSizeBytes | null): TableStats {
  if (!size) {
    return { schemaName: "main", tableName, rowCount, totalSize: "N/A", totalSizeBytes: 0 };
  }

  const totalSizeBytes = size.tableSizeBytes + size.indexSizeBytes;

  return {
    schemaName: "main",
    tableName,
    rowCount,
    tableSize: formatBytes(size.tableSizeBytes),
    tableSizeBytes: size.tableSizeBytes,
    indexSize: formatBytes(size.indexSizeBytes),
    indexSizeBytes: size.indexSizeBytes,
    totalSize: formatBytes(totalSizeBytes),
    totalSizeBytes,
  };
}

// ============================================================================
// SQLite Provider
// ============================================================================

export class SQLiteProvider extends SQLBaseProvider {
  private db: SQLiteDatabase | null = null;
  /** True when this instance was opened under the agent read-only profile. */
  private readonly readOnlyProfile: boolean;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    super(config, options);
    // Server-injected only (see ProviderExecutionContext): the shared editor
    // path builds providers from caller-supplied ProviderOptions, which has no
    // route to this flag in either direction.
    this.readOnlyProfile = execution.readOnly === true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: null,
      supportsExplain: true,
      explainFormat: "sqlite-queryplan",
      supportsConnectionString: false,
      supportsInlineRowEdit: true,
      // SQLite HAS transactions; this provider holds no session for one, so
      // POST /api/db/transaction refuses the call and the controls stay hidden.
      supportsTransactions: false,
      maintenanceOperations: ["vacuum", "analyze", "reindex", "check"],
      // `VACUUM` rewrites the whole database file and takes no object at all, and
      // `PRAGMA integrity_check` reads the whole file the same way - `runMaintenance`
      // ignores the target for both, so a per-table control there named one table and
      // acted on the database (#496). `ANALYZE` and `REINDEX` do take a bare name and
      // also run over everything without one.
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Database", perEntity: false, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        check: { label: "Integrity Check", perEntity: false, global: true },
      },
      containerLevels: [],
      objectKinds: SQLITE_OBJECT_KINDS,
    };
  }

  /**
   * The slow-query empty state and the global reindex wording; every other label is
   * the SQL default and right.
   *
   * `getSlowQueries()` answers `[]` unconditionally, so the monitoring Queries panel
   * is ALWAYS empty here - and it used to tell the reader to install a PostgreSQL
   * extension (#463).
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      slowQueriesEmptyState: "SQLite keeps no statistics about finished statements, so there is nothing to enable.",
      reindexGlobalLabel: "Run Reindex",
      reindexGlobalTitle: "Rebuild Indexes",
      reindexGlobalDesc: "Runs bare REINDEX, rebuilding every index in the database file.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.database && !this.config.connectionString) {
      throw new DatabaseConfigError(
        'Database file path is required for SQLite (use "database" field or ":memory:" for in-memory)',
        "sqlite",
      );
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      // Dynamically load the runtime-appropriate SQLite driver
      const SQLiteDB = await loadSQLiteDriver();

      const dbPath = this.getDatabasePath();

      if (this.readOnlyProfile) {
        this.connectReadOnly(SQLiteDB, dbPath);
        return;
      }

      if (dbPath !== ":memory:") {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new SQLiteDB(dbPath, {
        create: true,
        readwrite: true,
      });

      // Enable WAL mode and foreign keys
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));

      // Typed refusals keep their own identity: wrapping them would strip the
      // config diagnosis / the profile's deny reason code.
      if (error instanceof DatabaseConfigError || error instanceof ExecutionProfileError) {
        throw error;
      }

      throw new ConnectionError(
        `Failed to open SQLite database: ${error instanceof Error ? error.message : error}`,
        "sqlite",
      );
    }
  }

  /**
   * Open the agent read-only handle (#328). Deliberately NOT the shared
   * sequence above:
   *
   * - no directory is created and no `create` flag is passed, so a missing
   *   target leaves the filesystem untouched (the read-only open itself
   *   refuses to create the file on both adapters);
   * - `PRAGMA journal_mode = WAL` is a write and fails outright on a read-only
   *   handle, so the shared pragma trio is skipped — none of it applies to a
   *   connection that cannot write;
   * - `query_only` is set and verified (a read-only open does not imply it).
   *
   * An in-memory target is refused: a read-only open of an anonymous database
   * can only ever yield an empty one (node:sqlite) or fail (bun:sqlite), so
   * vending it would hand the agent a silently useless target.
   */
  private connectReadOnly(SQLiteDB: Awaited<ReturnType<typeof loadSQLiteDriver>>, dbPath: string): void {
    if (dbPath === ":memory:") {
      throw new ExecutionProfileError(
        "The agent read-only execution profile cannot target an in-memory SQLite database",
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }

    this.db = new SQLiteDB(dbPath, { readonly: true });
    try {
      this.enforceQueryOnly();
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }

    this.setConnected(true);
  }

  /** Set `query_only` and refuse to continue unless it reads back enabled. */
  private enforceQueryOnly(): void {
    this.db!.exec(QUERY_ONLY_PRAGMA_SQL);
    assertQueryOnlyEnabled(this.db!.prepare(QUERY_ONLY_READBACK_SQL).all());
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.setConnected(false);
    }
  }

  private getDatabasePath(): string {
    let dbPath: string;
    if (this.config.connectionString) {
      dbPath = this.config.connectionString.startsWith("file:")
        ? this.config.connectionString.replace("file:", "")
        : this.config.connectionString;
    } else {
      dbPath = this.config.database || ":memory:";
    }

    // Allow :memory: without path validation
    if (dbPath === ":memory:") return dbPath;

    // Reject NUL bytes (never valid in a filesystem path), then resolve to an
    // absolute path. ".." segments are accepted by design: sqlite paths are
    // trusted server-side paths (docs/providers/sqlite.md).
    if (dbPath.includes("\0")) {
      throw new DatabaseConfigError("Invalid database path: NUL bytes are not allowed", "sqlite");
    }

    return path.resolve(dbPath);
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const isSelect = this.isReadOnlyQuery(sql);

          if (isSelect) {
            const stmt = this.db!.prepare(sql);
            const rows = params ? stmt.all(...params) : stmt.all();
            const fields = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            return {
              rows: (rows as unknown[]).map((row) => row as Record<string, unknown>) as Record<string, unknown>[],
              fields,
              changes: 0,
            };
          } else {
            const stmt = this.db!.prepare(sql);
            const info = params ? stmt.run(...params) : stmt.run();
            return {
              rows: [],
              fields: [],
              changes: info.changes,
            };
          }
        } catch (error) {
          throw mapDatabaseError(error, "sqlite", sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rows.length || result.changes,
        executionTime,
      };
    });
  }

  /**
   * Execute exactly one statement under SQLite's own read-only enforcement
   * (#328).
   *
   * The boundary is the database's own enforcement, not any inspection of
   * `sql`: a write reaching this method is executed and rejected by the
   * engine (see `assertQueryOnlyEnabled` for which control covers what). It is
   * therefore refused outright on a provider that was not opened under the
   * profile — a writable handle has no boundary to enforce, and silently
   * running the statement there would be exactly the fail-open this layer
   * exists to prevent.
   *
   * Statements are compiled with `prepare()`, never `exec()`: `exec()` runs
   * every statement of a multi-statement string, while `prepare()` compiles
   * only the first. Rejecting multi-statement input is the policy pipeline's
   * job — this method only guarantees the tail is never executed.
   */
  public async queryReadOnly(sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult> {
    this.ensureConnected();
    assertReadOnlyBudget(budget, "sqlite");
    if (!this.readOnlyProfile) {
      throw new QueryError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "sqlite",
        sql,
      );
    }
    // Per statement, not just at open: the profiled provider is pooled and
    // reused, so a previous statement's `PRAGMA query_only = false` would
    // otherwise persist for every later call on this connection.
    this.enforceQueryOnly();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return this.db!.prepare(sql).all() as Record<string, unknown>[];
        } catch (error) {
          throw mapDatabaseError(error, "sqlite", sql);
        }
      });

      if (result.length > budget.maxResultRows) {
        throw new QueryError(
          `Read-only execution exceeded the row budget: ${result.length} rows > ${budget.maxResultRows} allowed`,
          "sqlite",
          sql,
        );
      }
      const resultBytes = measureResultBytes(result);
      if (resultBytes > budget.maxResultBytes) {
        throw new QueryError(
          `Read-only execution exceeded the byte budget: ${resultBytes} bytes > ${budget.maxResultBytes} allowed`,
          "sqlite",
          sql,
        );
      }
      // SQLite has no transaction-local statement timeout, and neither adapter
      // exposes sqlite3_interrupt or a progress handler, so the budget's
      // timeout is a post-execution deadline: an overrunning statement is not
      // preempted, but its result is refused rather than returned as if it had
      // been within budget. Recorded as such in docs/providers/sqlite.md.
      if (executionTime > budget.statementTimeoutMs) {
        throw new QueryError(
          `Read-only execution exceeded the time budget: ${executionTime}ms > ${budget.statementTimeoutMs}ms allowed`,
          "sqlite",
          sql,
        );
      }

      return {
        rows: result,
        fields: result.length > 0 ? Object.keys(result[0]) : [],
        rowCount: result.length,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(SCHEMA_TABLES_SQL);
    const tables = tablesStmt.all() as { name: string }[];

    const schemas: TableSchema[] = [];

    for (const { name: tableName } of tables) {
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      const columnsStmt = this.db!.prepare(`PRAGMA table_info("${tableName}")`);
      const columns = columnsStmt.all() as SQLiteColumnInfoRow[];

      const fkStmt = this.db!.prepare(`PRAGMA foreign_key_list("${tableName}")`);
      const foreignKeys = fkStmt.all() as SQLiteForeignKeyRow[];

      const indexStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexStmt.all() as SQLiteIndexListRow[];

      const indexes = [];
      for (const idx of indexList) {
        if (idx.name.startsWith("sqlite_")) continue;

        const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${idx.name}")`);
        const indexCols = indexInfoStmt.all() as Array<{ seqno: number; cid: number; name: string }>;

        indexes.push({
          name: idx.name,
          columns: indexCols.map((c) => c.name),
          unique: idx.unique === 1,
        });
      }

      let sizeBytes = 0;
      try {
        const pageCountStmt = this.db!.prepare(DB_PAGE_SIZE_SQL);
        const sizeResult = pageCountStmt.get() as { size: number };
        sizeBytes = sizeResult?.size || 0;
      } catch {
        // Ignore size calculation errors
      }

      schemas.push({
        name: tableName,
        rowCount,
        size: formatBytes(sizeBytes),
        columns: columns.map((col) => ({
          name: col.name,
          type: col.type || "TEXT",
          nullable: col.notnull === 0,
          isPrimary: col.pk === 1,
          defaultValue: col.dflt_value ?? undefined,
        })),
        indexes,
        foreignKeys: foreignKeys.map((fk) => ({
          columnName: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to,
        })),
      });
    }

    return schemas;
  }

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /**
   * No containers, because SQLite has no container level.
   *
   * `[]` is the ENGINE answering, not a refusal and not a gap: a SQLite connection opens
   * one database file and every object in it is addressed by a bare name. The tree reads
   * `containerDepth()` off the same declaration, sees 0, and draws the kind folders at the
   * root under the empty container path; `enumerateContainers()` in
   * `src/lib/api/object-route.ts` answers `[[]]` for the same engines. Inventing a
   * synthetic `main` container to make the shape match the other sixteen engines would put
   * a row in the tree that names nothing a user can act on.
   *
   * Takes no `parent`, which the optional interface parameter allows: there is no level
   * for one to name, so accepting and ignoring it would be the same answer written twice.
   */
  public async listContainers(): Promise<Container[]> {
    this.ensureConnected();
    return [];
  }

  /**
   * How many objects of each declared kind the file holds, in one statement.
   *
   * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
   * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
   * before the read. A kind whose read was refused carries SQLite's own sentence, so the
   * object browser can say why a folder has no number instead of showing a zero nobody
   * measured. The refusal is a real case rather than a defensive arm: `PRAGMA table_list`
   * arrived in SQLite 3.37, and a build below it answers "no such table:
   * pragma_table_list" for every kind at once, which is why one failure covers all four.
   *
   * The container path is checked BEFORE the read and raises, because a path of the wrong
   * shape is a caller mistake and not something the engine refused.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    assertContainerPath(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);

    try {
      applyKindCounts(counts, this.db!.prepare(COUNTS_SQL).all(MAIN_SCHEMA) as KindCountRow[]);
      return counts;
    } catch (error) {
      return unavailableCounts(
        declared.map((kind) => kind.id),
        error,
      );
    }
  }

  /** One object-surface read, mapped against THE STATEMENT SQLITE RECEIVED. */
  private runObjectQuery<T>(sql: string, params: readonly unknown[]): T[] {
    try {
      return this.db!.prepare(sql).all(...params) as T[];
    } catch (error) {
      throw mapDatabaseError(error, "sqlite", sql);
    }
  }

  /**
   * The objects of one kind, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Four
   * statements answer these listings, so four `ORDER BY` clauses would be four chances to
   * disagree; and a SQL sort runs under the column's own collation, which is `BINARY` on
   * `sqlite_schema.name` but is whatever a `COLLATE` clause said on a user's own catalog
   * view. A code-point sort here is one rule and the same rule everywhere.
   *
   * By PATH and not by name, because it is the address that has to be stable: sorting by
   * the address groups an object's triggers under it.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    assertContainerPath(capabilities, container);
    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a listing statement exists would make the two
    // methods disagree, and would report "declares no object kind" about a kind
    // `objectKinds` does declare but nothing here can list.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`SQLite declares no object kind "${kind}"`, "sqlite");
    }
    const statement = OBJECT_LISTINGS[kind];
    if (statement === undefined) {
      throw new QueryError(`SQLite declares the kind "${kind}" but has no statement that lists it`, "sqlite");
    }

    return this.runObjectQuery<ObjectRow>(statement.sql, statement.params)
      .map((row) => ({ path: objectPath(container, row), name: row.name, kind }))
      .sort((left, right) => comparePaths(left.path, right.path));
    // No `rowCount` and no `sizeBytes`, and both absences are facts about SQLite rather
    // than unfinished work. There is no catalog row estimate at all here: `sqlite_stat1`
    // exists only after someone ran ANALYZE, so a `COUNT(*)` per object would be a full
    // table scan per row of this listing. Per-object bytes come only from `dbstat`, which
    // scans the whole database file (see DBSTAT_SIZES_SQL) and is not on a build without
    // SQLITE_ENABLE_DBSTAT_VTAB. A fabricated 0 in either field would read as an empty
    // object, which is the estimate #469 removed from the Storage tab.
  }

  /**
   * Columns, indexes and foreign keys for one object of one KIND.
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. Only the two `relation` kinds have any of the three: measured,
   * `pragma_table_xinfo` answers zero rows for an index name and for a trigger name, so an
   * index and a trigger answer three empty arrays without a round trip. That is a true
   * fact about those kinds rather than a failed read, and
   * `tests/helpers/object-surface-conformance.ts` states the same rule from the caller's
   * side. An index's own key list is NOT published here and that is deliberate:
   * `IndexSchema.columns` is a list of column names and an index on an expression has
   * none, measured as `index_info.name = NULL, cid = -2`, so half the indexes on an engine
   * would describe themselves and the other half would silently describe themselves
   * wrongly. A trigger's body is source text, which is Phase 2's Source tab.
   *
   * Keying on `role === "relation"` is safe HERE and is not the general rule: MySQL keys
   * the same decision on the catalog, because a MariaDB sequence is declared `config` and
   * still has real columns. On SQLite the two coincide exactly.
   *
   * Path depth is derived from the declaration: one segment per declared container level,
   * plus the attached parent where the kind declares one, plus the name. Every SQLite
   * trigger has a parent - `sqlite_schema.tbl_name` is never null for one - so there is a
   * single shape rather than the two MySQL accepts.
   *
   * Zero columns IS a failed read and raises: SQLite refuses `CREATE TABLE t()`, so every
   * table and every view has at least one column, and an empty answer means the object is
   * not there under that name in `main`.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`SQLite declares no object kind "${kind}"`, "sqlite");
    }

    const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
    const shape = spec.attachedTo === undefined ? [...levels, "name"] : [...levels, spec.attachedTo, "name"];
    if (path.length !== shape.length) {
      throw new QueryError(
        `A SQLite "${kind}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
        "sqlite",
      );
    }

    if (spec.role !== "relation") {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    // Neither bind is positional. The object's own name is the LAST segment, which is
    // right at every depth, where `path[0]` is right only at depth 1 and would name a
    // container segment on the five two-level engines that copy this shape. The schema is
    // the constant `main` rather than a segment, because this engine declares no container
    // level to take one from - see MAIN_SCHEMA for what leaving it out actually does.
    const binds = [path[path.length - 1], MAIN_SCHEMA];

    const columnRows = this.runObjectQuery<ObjectColumnRow>(OBJECT_COLUMNS_SQL, binds);
    if (columnRows.length === 0) {
      throw new QueryError(`No SQLite ${kind} named ${binds[0]} in ${MAIN_SCHEMA}`, "sqlite", OBJECT_COLUMNS_SQL);
    }

    return objectDetailFromRows(path, {
      columns: columnRows,
      indexes: this.readObjectIndexes(binds),
      indexColumns: this.readObjectIndexColumns(binds),
      foreignKeys: this.readObjectForeignKeys(binds),
    });
  }

  /**
   * One entry per index on this object, its columns in `seqno` order.
   *
   * The `sqlite_` exclusion is the same predicate the Indexes folder lists by, so the two
   * surfaces cannot disagree about what an index is: an implicit `sqlite_autoindex_*`
   * serves a UNIQUE or PRIMARY KEY constraint, cannot be dropped, and is not an object a
   * user declared.
   */
  private readObjectIndexes(binds: readonly unknown[]): ObjectIndexRow[] {
    return this.runObjectQuery<ObjectIndexRow>(OBJECT_INDEXES_SQL, binds);
  }

  /**
   * The key columns of every index on this object, tagged with the index they belong to.
   *
   * One read per index, which is what `pragma_index_info` takes; the tag is added here so
   * the rows reach `objectDetailFromRows` in the same shape the bulk read's single
   * statement produces. Null names are kept rather than filtered, because the MAPPER is
   * the one place that decides what an expression key means.
   */
  private readObjectIndexColumns(binds: readonly unknown[]): ObjectIndexColumnRow[] {
    const [, schema] = binds;
    return this.readObjectIndexes(binds).flatMap((index) =>
      this.runObjectQuery<{ name: string | null }>(OBJECT_INDEX_COLUMNS_SQL, [index.name, schema]).map((column) => ({
        index_name: index.name,
        name: column.name,
      })),
    );
  }

  /**
   * This object's foreign keys, one entry per constrained column.
   *
   * `to` is NULL when the reference names no column - `REFERENCES customers` rather than
   * `REFERENCES customers(id)` - and SQLite reads that as the parent's PRIMARY KEY.
   * `ForeignKeySchema.referencedColumn` is a string, so the choice is to resolve it or to
   * put a null in a typed string field. The parent's key columns are read at most once per
   * parent and only when some constraint needs them.
   */
  private readObjectForeignKeys(binds: readonly unknown[]): ObjectForeignKeyRow[] {
    const [name, schema] = binds;
    // The schema first, because it is the SUBQUERY's placeholder and SQLite numbers
    // placeholders by where they appear in the statement text.
    return this.runObjectQuery<ObjectForeignKeyRow>(OBJECT_FOREIGN_KEYS_SQL, [schema, name, schema]);
  }

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in the file (#789).
   *
   * FIVE round trips for a whole folder, constant in the number of objects, which is the
   * entire reason this method exists: the caller's alternative was one `describeObject`
   * per object, and each of those is itself a column read, an index list, one read per
   * index and a foreign key list. The five are the target read plus the four detail reads,
   * each joining a pragma table-valued function against the same target set.
   *
   * The four guards are asked in the same order PostgreSQL asks them, and each one is a
   * different fact:
   *   1. a kind this engine does not declare RAISES, naming the engine and the kind. An
   *      empty batch would be a claim about the file; an undeclared kind is a fact about
   *      SQLite.
   *   2. the container path is checked through `assertContainerPath`, the same reader
   *      `listObjects` uses, so the depth comes from the declaration and never from a
   *      literal (standing ruling 5g).
   *   3. a `limit` that is not a positive whole number raises rather than clamping: a 0
   *      would answer nothing while reporting a truncation nobody asked for, and a
   *      fraction reaches the driver as a bind it cannot use.
   *   4. a kind with no columns answers `{ details: [] }` with NO round trip. On SQLite
   *      that is `index` and `trigger`, measured: `pragma_table_xinfo` answers zero rows
   *      for either name.
   *
   * The bound is the CALLER's and is never invented here. `limit + 1` reaches the target's
   * `LIMIT`, the extra object is dropped, and `truncated` carries the caller's own limit;
   * an unbounded call can never report truncation. `getSchema()`'s column list is capped
   * nowhere in this file and nothing here adds a cap of its own.
   *
   * Paths are built by `objectPath`, the rule `listObjects` builds its paths with, and
   * sorted by `comparePaths`, so the two answers join on path. Membership comes from the
   * TARGET read and not from the column read: an object whose every column is hidden would
   * otherwise be listed by the folder and missing from the batch. That is also why this
   * method does not repeat `describeObject`'s zero-column throw - there the empty answer
   * means the object is not there under that name, here the catalog has just said it is.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`SQLite declares no object kind "${kind}"`, "sqlite");
    }
    assertContainerPath(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new QueryError(
        `A SQLite bulk column read limit must be a positive whole number, received ${limit}`,
        "sqlite",
      );
    }
    if (BULK_RELATION_TYPES[kind] === undefined) return { details: [] };

    const bounded = limit !== undefined;
    const statements = bounded ? BULK_DETAIL_SQL_BOUNDED[kind]! : BULK_DETAIL_SQL[kind]!;
    const head = [MAIN_SCHEMA, ...(bounded ? [limit + 1] : [])];
    const params = (schemaBinds: number): unknown[] => [...head, ...Array<string>(schemaBinds).fill(MAIN_SCHEMA)];

    const targets = this.runObjectQuery<{ object_name: string }>(statements.target, params(statements.schemaBinds[0]));
    const truncated = bounded && targets.length > limit;
    // The extra object the `limit + 1` bound brought back is dropped here, so its rows in
    // the four maps below are simply never read.
    const names = (truncated ? targets.slice(0, limit) : targets).map((row) => row.object_name);

    const columns = groupByObject(
      this.runObjectQuery<OfObject<ObjectColumnRow>>(statements.columns, params(statements.schemaBinds[1])),
    );
    const indexes = groupByObject(
      this.runObjectQuery<OfObject<ObjectIndexRow>>(statements.indexes, params(statements.schemaBinds[2])),
    );
    const indexColumns = groupByObject(
      this.runObjectQuery<OfObject<ObjectIndexColumnRow>>(statements.indexColumns, params(statements.schemaBinds[3])),
    );
    const foreignKeys = groupByObject(
      this.runObjectQuery<OfObject<ObjectForeignKeyRow>>(statements.foreignKeys, params(statements.schemaBinds[4])),
    );

    const details = names
      .map((name) =>
        objectDetailFromRows(objectPath(container, { name }), {
          columns: columns.get(name) ?? [],
          indexes: indexes.get(name) ?? [],
          indexColumns: indexColumns.get(name) ?? [],
          foreignKeys: foreignKeys.get(name) ?? [],
        }),
      )
      .sort((left, right) => comparePaths(left.path, right.path));

    return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    let databaseSize = "N/A";
    if (dbPath !== ":memory:") {
      try {
        const stats = fs.statSync(dbPath);
        databaseSize = formatBytes(stats.size);
      } catch {
        databaseSize = "Unknown";
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(MEMORY_DB_SIZE_SQL);
        const result = sizeStmt.get() as { size: number };
        databaseSize = formatBytes(result?.size || 0);
      } catch {
        databaseSize = "N/A";
      }
    }

    let isHealthy = true;
    try {
      const integrityStmt = this.db!.prepare("PRAGMA integrity_check");
      const integrityResult = integrityStmt.get() as { integrity_check: string };
      isHealthy = integrityResult?.integrity_check === "ok";
    } catch {
      isHealthy = false;
    }

    let journalMode = "unknown";
    try {
      const journalStmt = this.db!.prepare("PRAGMA journal_mode");
      const journalResult = journalStmt.get() as { journal_mode: string };
      journalMode = journalResult?.journal_mode || "unknown";
    } catch {
      // Ignore
    }

    return {
      activeConnections: 1,
      databaseSize,
      // Same word as the performance panel's absent ratio, and now the same
      // constant, so the two cannot drift apart.
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [
        {
          query: `Integrity: ${isHealthy ? "OK" : "FAILED"}`,
          calls: 0,
          avgTime: "N/A",
        },
        {
          query: `Journal Mode: ${journalMode}`,
          calls: 0,
          avgTime: "N/A",
        },
      ],
      activeSessions: [
        {
          pid: process.pid,
          user: "sqlite",
          database: path.basename(dbPath),
          state: "active",
          query: "",
          duration: "N/A",
        },
      ],
    };
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      let sql = "";

      switch (type) {
        case "vacuum":
          sql = "VACUUM";
          break;
        case "analyze":
          sql = target ? `ANALYZE ${this.escapeIdentifier(target)}` : "ANALYZE";
          break;
        case "reindex":
          sql = target ? `REINDEX ${this.escapeIdentifier(target)}` : "REINDEX";
          break;
        case "check":
          const checkStmt = this.db!.prepare("PRAGMA integrity_check");
          const checkResult = checkStmt.get() as { integrity_check: string };
          return {
            success: checkResult?.integrity_check === "ok",
            message: checkResult?.integrity_check || "Unknown",
          };
      }

      // Unsupported types fall through the switch with sql left empty. A
      // `default:` label is deliberately avoided here: bun's coverage emits a
      // 0-hit line record for `default:` that no runtime execution ever
      // credits, which permanently poisons the merged lcov report.
      if (!sql) {
        throw new QueryError(`Unsupported maintenance type for SQLite: ${type}`, "sqlite");
      }

      this.db!.exec(sql);
      return { success: true, message: `${type.toUpperCase()} completed successfully` };
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    // Get SQLite version
    const versionStmt = this.db!.prepare("SELECT sqlite_version() as version");
    const versionResult = versionStmt.get() as { version: string };
    const version = `SQLite ${versionResult?.version || "Unknown"}`;

    // Get database size
    const dbPath = this.getDatabasePath();
    let databaseSizeBytes = 0;

    if (dbPath !== ":memory:") {
      try {
        const stats = fs.statSync(dbPath);
        databaseSizeBytes = stats.size;
      } catch {
        // File might not exist yet
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(MEMORY_DB_SIZE_SQL);
        const result = sizeStmt.get() as { size: number };
        databaseSizeBytes = result?.size || 0;
      } catch {
        // Ignore
      }
    }

    // Get table count
    const tableCountStmt = this.db!.prepare(TABLE_COUNT_SQL);
    const tableCountResult = tableCountStmt.get() as { count: number };
    const tableCount = tableCountResult?.count || 0;

    // Get index count
    const indexCountStmt = this.db!.prepare(INDEX_COUNT_SQL);
    const indexCountResult = indexCountStmt.get() as { count: number };
    const indexCount = indexCountResult?.count || 0;

    return {
      version,
      uptime: "N/A",
      activeConnections: 1,
      maxConnections: 1,
      databaseSize: formatBytes(databaseSizeBytes),
      databaseSizeBytes,
      tableCount,
      indexCount,
    };
  }

  /**
   * Only what SQLite can actually be asked, which is no cache hit ratio at all.
   *
   * SQLite's hit and miss counters live behind the C API
   * (`sqlite3_db_status()` with `SQLITE_DBSTATUS_CACHE_HIT` / `CACHE_MISS`), and
   * neither driver this provider can load surfaces them. Measured 2026-08-23 by
   * walking the prototype chain of a live handle: `bun:sqlite` 1.3.14 offers
   * `clearQueryCache, close, exec, fileControl, filename, handle, inTransaction,
   * loadExtension, prepare, query, run, serialize, transaction`, and
   * `node:sqlite` on Node 24.14.0 offers `aggregate, applyChangeset, close,
   * createSession, createTagStore, enableDefensive, enableLoadExtension, exec,
   * function, isOpen, isTransaction, loadExtension, location, open, prepare,
   * setAuthorizer`. No status call on either, and nothing SQL-reachable stands
   * in: `PRAGMA cache_hit` and `PRAGMA cache_miss` are not pragmas (SQLite
   * answers an unknown pragma with zero rows rather than an error, so they
   * *look* like empty readings), `PRAGMA stats` returned `[]` on both drivers,
   * and `PRAGMA cache_size` is the configured page budget - `-2000`, the 2 MiB
   * default, on both.
   *
   * That budget is what the old code turned into a ratio: it reported 95%
   * whenever `PRAGMA cache_size` came back truthy, which it always does, and 99%
   * otherwise. Both numbers were this provider's invention, and the panel rated
   * them "Excellent". A missing panel is honest; a populated wrong one is not
   * (#424), so the field is omitted - permanently, not pending a better query.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    return {
      // `cacheHitRatio`, `queriesPerSecond` and `bufferPoolUsage` are all absent:
      // SQLite keeps no statement counter and no server-side buffer pool whose
      // usage could be read, so the monitoring tabs show "Not measured" for each.
      //
      // `deadlocks` is different, and stays. It is a statement about the engine
      // rather than a reading that failed: SQLite serializes writers behind a
      // single write lock and has no lock-wait graph to deadlock in - a second
      // writer is refused with SQLITE_BUSY instead - so there are no deadlocks to
      // count and 0 is the true count.
      deadlocks: 0,
    };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    // SQLite doesn't have built-in query statistics
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    // SQLite is single-connection, return current session
    return [
      {
        pid: process.pid,
        user: "sqlite",
        database: path.basename(dbPath),
        state: "active",
        query: "",
        duration: "N/A",
        durationMs: 0,
      },
    ];
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(STATS_TABLES_SQL);
    const tables = tablesStmt.all() as { name: string }[];

    // One dbstat scan per call, not per table: it reads the whole database file.
    const sizes = readDbstatSizes(this.db!);
    const stats: TableStats[] = [];

    for (const { name: tableName } of tables) {
      // Get row count
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      stats.push(buildTableStats(tableName, rowCount, sizes?.get(tableName) ?? null));
    }

    return stats;
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    const indexesStmt = this.db!.prepare(STATS_INDEXES_SQL);
    const indexes = indexesStmt.all() as { name: string; tbl_name: string }[];

    const stats: IndexStats[] = [];

    for (const { name: indexName, tbl_name: tableName } of indexes) {
      // Get index info
      const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${indexName}")`);
      const indexCols = indexInfoStmt.all() as { seqno: number; cid: number; name: string }[];

      // Get index uniqueness
      const indexListStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexListStmt.all() as { name: string; unique: number }[];
      const indexMeta = indexList.find((i) => i.name === indexName);

      stats.push({
        schemaName: "main",
        tableName,
        indexName,
        columns: indexCols.map((c) => c.name),
        isUnique: indexMeta?.unique === 1,
        isPrimary: false, // SQLite auto-creates rowid, explicit PKs are shown differently
        // SQLite publishes no per-index size: `dbstat` would give page counts but it
        // is a compile-time option (ENABLE_DBSTAT_VTAB) the build decides - always there
        // on node:sqlite, absent on bun:sqlite through Bun 1.3.14 ("no such table:
        // dbstat", measured 2026-08-23) - so it cannot be relied on for every install.
        // The size string already said so; the companion byte
        // count said 0, and the Storage tab summed those zeroes into an index total
        // that read as "every index is empty". The field is optional for this case.
        indexSize: "N/A",
        scans: 0, // SQLite doesn't track index usage
      });
    }

    return stats;
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const stats: StorageStats[] = [];
    const dbPath = this.getDatabasePath();

    // Main database file
    let mainSizeBytes = 0;
    if (dbPath !== ":memory:") {
      try {
        const fileStats = fs.statSync(dbPath);
        mainSizeBytes = fileStats.size;
      } catch {
        // File might not exist
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(MEMORY_DB_SIZE_SQL);
        const result = sizeStmt.get() as { size: number };
        mainSizeBytes = result?.size || 0;
      } catch {
        // Ignore
      }
    }

    stats.push({
      name: "Main Database",
      location: dbPath === ":memory:" ? ":memory:" : path.basename(dbPath),
      size: formatBytes(mainSizeBytes),
      sizeBytes: mainSizeBytes,
    });

    // WAL file (if exists)
    if (dbPath !== ":memory:") {
      const walPath = `${dbPath}-wal`;
      try {
        const walStats = fs.statSync(walPath);
        stats.push({
          name: "WAL",
          location: path.basename(walPath),
          size: formatBytes(walStats.size),
          sizeBytes: walStats.size,
          walSize: formatBytes(walStats.size),
          walSizeBytes: walStats.size,
        });
      } catch {
        // WAL might not exist
      }

      // SHM file (if exists)
      const shmPath = `${dbPath}-shm`;
      try {
        const shmStats = fs.statSync(shmPath);
        stats.push({
          name: "Shared Memory",
          location: path.basename(shmPath),
          size: formatBytes(shmStats.size),
          sizeBytes: shmStats.size,
        });
      } catch {
        // SHM might not exist
      }
    }

    return stats;
  }
}
