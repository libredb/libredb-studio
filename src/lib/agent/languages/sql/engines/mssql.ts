/**
 * SQL Server's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them
 * on SQL Server. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import { numeric, text } from "../../../catalog-rows";
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  type AgentPlanEstimate,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentStatisticsReading, AgentTableEstimate } from "../../../schema-stats";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** `LIKE` for both shapes, the digit run as a character class repeated (B26, `PROFILE_SHAPES`). */
const MSSQL_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // T-SQL has no regular expressions and no GLOB. Its `LIKE` DOES take a character
    // class, so the run is spelled as the class repeated: there is no quantifier, so
    // nine `[0-9]`s is the shortest faithful spelling of "nine or more digits".
    // The same run as a T-SQL `LIKE` pattern: the class repeated, between two `%`s.
    digitRun: (quoted: string, runLength: number) => `${quoted} LIKE '%${"[0-9]".repeat(runLength)}%'`,
  }),
  // PER DIALECT because the sets genuinely differ, and one shared regex would have to
  // be wrong about one of them.
  //
  // Every SQL Server entry was MEASURED on 2022 CU26, one `count(DISTINCT …)` per type,
  // rather than reasoned about: `xml`, `geography` and `geometry` each answer
  // "Operand data type <type> is invalid for count operator" (Msg 8117), while
  // `varbinary(max)` and `uniqueidentifier` both count without complaint. `hierarchyid`
  // was listed here and is NOT incomparable: the same probe counts it, and
  // `count(DISTINCT DocumentNode)` over `Production.Document` answers 13 for 13 rows.
  // Listing it cost that column its distinct count for nothing, so it is gone.
  //
  // `text`, `ntext` and `image` are absent for a different reason: SQL Server refuses
  // PLAIN `count` on them too, so they are excluded from the projection entirely by
  // `uncountableType` below and never reach this test. `text` is also why this cannot
  // be one shared list, since PostgreSQL's `text` is its ordinary string type.
  incomparableType: /\b(xml|geography|geometry)\b/i,
  uncountableType: /\b(text|ntext|image)\b/i,
});

/**
 * SQL Server's estimating plan is a SESSION MODE rather than a statement prefix, so it
 * composes no prefix at all.
 *
 * That is not an oversight of its dialect: T-SQL has no
 * `EXPLAIN` keyword. Its estimating plan is `SET SHOWPLAN_ALL ON`, which must be the
 * only statement in its batch and has to be turned off again on the SAME connection,
 * neither of which a prefix can say. So the statement travels unchanged and the MODE
 * says what to do with it (`ReadOnlyStatementMode`), which is a contract the provider
 * layer already has to honour rather than a marker hidden in the text.
 */
const MSSQL_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "session-mode", mode: "estimate-plan" });

/**
 * The schemas a SQL Server grounding read must not treat as user data, and why the
 * list is only two names long.
 *
 * `sys` and `INFORMATION_SCHEMA` can hold NOTHING a person wrote: `CREATE TABLE
 * sys.probe` answers Msg 2760 on SQL Server 2022 CU26, measured. So excluding them by
 * name excludes nothing a user could have created. The nine fixed-role schemas
 * (`db_owner`, `db_datareader`, …) are NOT excluded here, and that is deliberate rather
 * than an omission: the provider's schema listing drops them only when they are empty,
 * because `CREATE TABLE db_owner.t` succeeds, and every read below already filters on
 * `is_ms_shipped = 0`, which is the engine's own answer for "shipped with the product".
 * A name list would have had to be right about nine schemas; this is right by
 * construction.
 */
const MSSQL_SYSTEM_SCHEMAS = Object.freeze(["sys", "INFORMATION_SCHEMA"] as const);

const MSSQL_SCHEMA_EXCLUSION = `s.name NOT IN (${MSSQL_SYSTEM_SCHEMAS.map((schema) => `'${schema}'`).join(", ")})`;

/**
 * The column inventory, ONE ROW PER OBJECT, symmetric with the PostgreSQL arm (B52).
 *
 * The per-object column list is built by a correlated `FOR JSON PATH` subquery rather
 * than by `STRING_AGG`, because `FOR JSON` is the engine's own serialiser and quotes
 * a column name containing a quote, a bracket or a newline correctly without this
 * layer having to know how. Measured on AdventureWorks2022: 92 rows, and
 * `Person.Person`'s list arrives as one `nvarchar(max)` value rather than split across
 * rows: the 2033-character chunking `FOR JSON` does applies to a TOP-LEVEL `FOR JSON`
 * query, not to one used as a scalar subquery.
 *
 * `o.type` is `char(2)` and arrives padded (`'U '`), so it is trimmed: the value rides
 * along as this engine's own word for what the entry IS, the way `pg_class.relkind`
 * does on PostgreSQL, and a trailing space would make `'U '` and `'U'` two kinds.
 *
 * `system_type_id` and NOT `user_type_id`, which is the obvious spelling and the wrong
 * one. SQL Server ALIAS types are ordinary in a real schema and everywhere in this
 * fixture: measured, `Person.PersonPhone.PhoneNumber` answers `Phone` for the alias and
 * `nvarchar` for the base, and `Person.Person.FirstName` answers `Name` over `nvarchar`.
 * Nothing downstream knows an alias: `table-profile.ts` decides which columns get a text
 * SHAPE test and which are excluded from `count(DISTINCT …)` by matching this string
 * against base-type spellings, so with the alias name `profile_table` emitted no shape
 * test at all for `PhoneNumber` - the one column in that table the PII shapes exist to
 * find - and an alias over `text` would have failed the whole table's profile. The base
 * spelling is also the more useful of the two to a model writing SQL, which is what this
 * inventory is for; the object browser reads its own catalog and still shows the alias.
 *
 * COALESCE'd, because `system_type_id` alone is NULL for the system CLR types. They all
 * share id 240 and `TYPE_NAME(240)` answers NULL: measured, `Person.Address.SpatialLocation`
 * answers NULL for the base and `geography` for the alias, and `Production.Document.DocumentNode`
 * the same with `hierarchyid`. `FOR JSON PATH` omits a NULL property, so those columns would
 * have reached the snapshot with NO type at all, and a column with no type matches none of
 * `table-profile.ts`'s exclusions: `count(DISTINCT [SpatialLocation])` would then be composed
 * and the whole table's profile would fail with Msg 8117, "Operand data type geography is
 * invalid for count operator". So the base spelling where there is one, and the type's own
 * name where the base is NULL.
 *
 * `sys.objects` rather than `INFORMATION_SCHEMA.TABLES`, for the reason the provider
 * gives for its own reads: `INFORMATION_SCHEMA` is permission-filtered in a way that
 * silently drops rows, and `is_ms_shipped` has no counterpart there at all.
 */
function composeMssqlCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT s.name AS table_schema, o.name AS table_name, RTRIM(o.type) AS relkind, " +
    "(SELECT c.name AS [name], COALESCE(TYPE_NAME(c.system_type_id), TYPE_NAME(c.user_type_id)) AS [type], " +
    "CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS [nullable] " +
    "FROM sys.columns c WHERE c.object_id = o.object_id ORDER BY c.column_id FOR JSON PATH) AS columns " +
    "FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id " +
    `WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND ${MSSQL_SCHEMA_EXCLUSION}` +
    equalsClause("s.name", selector.schema, "schema", "mssql") +
    equalsClause("o.name", selector.table, "table", "mssql") +
    " ORDER BY s.name, o.name"
  );
}

/**
 * The foreign-key inventory, one row per KEY COLUMN PAIR.
 *
 * `sys.foreign_key_columns` and not `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS`, and
 * the reason is the same one that moved the PostgreSQL arm off `information_schema`:
 * a composite key has to pair position with position. That view exposes no ordinal and
 * the referencing and referenced column lists would come back as their cross-product;
 * `sys.foreign_key_columns` carries `constraint_column_id` on the row itself, so
 * position 1 of one side meets position 1 of the other and nothing else. It also
 * carries both object ids, so two constraints sharing a name in different schemas are
 * never matched to each other.
 *
 * Measured on AdventureWorks2022: 91 rows.
 */
function composeMssqlRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT s.name AS table_schema, o.name AS table_name, pc.name AS column_name, " +
    "rs.name AS referenced_schema, ro.name AS referenced_table, rc.name AS referenced_column " +
    "FROM sys.foreign_key_columns fkc " +
    "JOIN sys.objects o ON o.object_id = fkc.parent_object_id " +
    "JOIN sys.schemas s ON s.schema_id = o.schema_id " +
    "JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id " +
    "JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id " +
    "JOIN sys.schemas rs ON rs.schema_id = ro.schema_id " +
    "JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id " +
    `WHERE o.is_ms_shipped = 0 AND ${MSSQL_SCHEMA_EXCLUSION}` +
    equalsClause("s.name", selector.schema, "schema", "mssql") +
    equalsClause("o.name", selector.table, "table", "mssql") +
    " ORDER BY s.name, o.name, fkc.constraint_object_id, fkc.constraint_column_id"
  );
}

/**
 * The index inventory, one row per indexed KEY POSITION.
 *
 * `i.type <> 0` drops the heap, which is `sys.indexes`' row for a table that has no
 * clustered index and is not an index at all. `ic.is_included_column = 0` keeps a
 * covering index's INCLUDE columns out of its key list. The PostgreSQL arm cannot make
 * that distinction on older servers and documents the resulting imprecision; SQL Server
 * publishes it on every supported version, so this arm is exact.
 *
 * Measured on AdventureWorks2022, with no selector: 228 rows, one per (index, key column)
 * pair across the database's user tables and views. It is a count of KEY POSITIONS and not
 * of indexes: an index on two columns contributes two rows.
 */
function composeMssqlIndexes(selector: AgentCatalogSelector): string {
  return (
    "SELECT s.name AS table_schema, o.name AS table_name, i.name AS index_name, " +
    "i.is_unique AS is_unique, i.is_primary_key AS is_primary, c.name AS column_name " +
    "FROM sys.indexes i " +
    "JOIN sys.objects o ON o.object_id = i.object_id " +
    "JOIN sys.schemas s ON s.schema_id = o.schema_id " +
    "JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id " +
    "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id " +
    `WHERE i.type <> 0 AND ic.is_included_column = 0 AND o.is_ms_shipped = 0 AND ${MSSQL_SCHEMA_EXCLUSION}` +
    equalsClause("s.name", selector.schema, "schema", "mssql") +
    equalsClause("o.name", selector.table, "table", "mssql") +
    " ORDER BY s.name, o.name, i.name, ic.key_ordinal"
  );
}

/**
 * The statistics inventory: one row per table, carrying the engine's own row estimate.
 *
 * `sys.partitions.rows` for `index_id IN (0, 1)` is the heap's or the clustered index's
 * row count, which is what SQL Server itself reports as a table's size and what the
 * optimizer's estimates are built from. It is summed because a PARTITIONED table has
 * one such row per partition, and reporting the first would understate every partitioned
 * table by however many partitions it has.
 *
 * It carries the TABLE half and says nothing about columns, the same shape the SQLite
 * and DuckDB arms produce and the reason `AgentTableEstimate.columns` is allowed to be
 * empty. SQL Server does publish per-column distributions, but only through `DBCC
 * SHOW_STATISTICS`, which is a DBCC command rather than a read and would be refused by
 * the admission step and by the shared statement guard alike.
 *
 * Nothing here scans: it is a catalog read like every other statistics composition,
 * which is what lets a plan run be pointed at production. Measured on
 * AdventureWorks2022: 72 rows.
 */
function composeMssqlStatistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT s.name AS table_schema, o.name AS table_name, SUM(p.rows) AS estimated_rows " +
    "FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id " +
    "JOIN sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1) " +
    `WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND ${MSSQL_SCHEMA_EXCLUSION}` +
    equalsClause("s.name", selector.schema, "schema", "mssql") +
    equalsClause("o.name", selector.table, "table", "mssql") +
    " GROUP BY s.name, o.name ORDER BY s.name, o.name"
  );
}

/** SQL Server's catalog read: one composer per kind. */
const MSSQL_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeMssqlCatalog,
    relations: composeMssqlRelations,
    indexes: composeMssqlIndexes,
    statistics: composeMssqlStatistics,
  }),
  systemSchemas: MSSQL_SYSTEM_SCHEMAS,
});

/**
 * SQL Server's rows: one per USER TABLE, from `composeMssqlStatistics` - the sum of
 * `sys.partitions.rows` over the heap or clustered index (`index_id IN (0, 1)`).
 *
 * Keyed `schema.table`, the same shape `buildPostgresEstimates` produces, because the
 * inventory addresses a SQL Server object by the same qualified name and the packing
 * joins the two by that key alone.
 *
 * `columns` is empty, and that is this READ's limit rather than the engine's: SQL Server
 * does hold per-column distributions, but only behind `DBCC SHOW_STATISTICS`, which is a
 * DBCC command rather than a read and is refused by the admission step and by the shared
 * statement guard alike (`composeMssqlStatistics` records the same reasoning). The
 * table half is what a catalog read can honestly answer here, exactly as on SQLite and
 * DuckDB.
 *
 * There is no -1 case to unwind the way PostgreSQL's `reltuples` has one: `sys.partitions`
 * carries a maintained count and a table with no rows arrives as 0. An unreadable value
 * becomes absence through `numeric`, which is what keeps a driver that hands a `bigint`
 * back as text from printing as `NaN` rows. Measured on AdventureWorks2022: the composed
 * read answers 72 rows, one per user table.
 */
function buildMssqlEstimates(rows: readonly Record<string, unknown>[]): Map<string, AgentTableEstimate> {
  const byTable = new Map<string, AgentTableEstimate>();

  for (const row of rows) {
    byTable.set(`${text(row.table_schema)}.${text(row.table_name)}`, {
      estimatedRows: numeric(row.estimated_rows),
      columns: [],
    });
  }

  return byTable;
}

/** SQL Server's statistics reading: no probe, since `sys.partitions` is part of every database. */
const MSSQL_STATISTICS: AgentStatisticsReading = Object.freeze({ probe: null, build: buildMssqlEstimates });

export const MSSQL_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: MSSQL_CATALOG_READ,
    planEstimate: MSSQL_PLAN_ESTIMATE,
    profileComposition: MSSQL_PROFILE_COMPOSITION,
    statistics: MSSQL_STATISTICS,
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
