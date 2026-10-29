/**
 * Oracle's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on Oracle.
 * Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * The catalog is read from the `ALL_*` dictionary views, which Oracle filters to the objects the user may see, so the
 * read-only agent user reads them with no grant beyond its SELECT on the tables themselves. The schemas Oracle
 * maintains (`ALL_USERS.ORACLE_MAINTAINED`) are left out of every read. Each name a selector carries is a string
 * literal compared exactly, as the dictionary spells it: an unquoted Oracle name is stored in upper case.
 *
 * The estimating plan stays unsupported: `EXPLAIN PLAN` writes its rows into `PLAN_TABLE`, a write the read-only user
 * is refused. The profile composition, the statistics reading and the grounding capture have no composition measured
 * on this engine, and stay unsupported too.
 */
import { type AgentCatalogRead, type AgentCatalogSelector, equalsClause } from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** The owners Oracle maintains, excluded from every catalog read below. */
function oracleSchemaExclusion(column: string): string {
  return `${column} NOT IN (SELECT u.USERNAME FROM ALL_USERS u WHERE u.ORACLE_MAINTAINED = 'Y')`;
}

/**
 * The column inventory, one row per column, in each table's own column order, views included. `data_type` is the
 * dictionary's type name, and `is_nullable` its Y or N.
 */
function composeOracleColumns(selector: AgentCatalogSelector): string {
  return (
    'SELECT c.OWNER AS "table_schema", c.TABLE_NAME AS "table_name", c.COLUMN_NAME AS "column_name", ' +
    'c.DATA_TYPE AS "data_type", c.NULLABLE AS "is_nullable", c.COLUMN_ID AS "ordinal_position" ' +
    `FROM ALL_TAB_COLUMNS c WHERE ${oracleSchemaExclusion("c.OWNER")}` +
    equalsClause("c.OWNER", selector.schema, "schema", "oracle") +
    equalsClause("c.TABLE_NAME", selector.table, "table", "oracle") +
    " ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID"
  );
}

/** The foreign-key inventory: each referencing column beside the column it references, by position in the key. */
function composeOracleRelations(selector: AgentCatalogSelector): string {
  return (
    'SELECT c.OWNER AS "table_schema", c.TABLE_NAME AS "table_name", cc.COLUMN_NAME AS "column_name", ' +
    'r.OWNER AS "referenced_schema", r.TABLE_NAME AS "referenced_table", rc.COLUMN_NAME AS "referenced_column" ' +
    "FROM ALL_CONSTRAINTS c " +
    "JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME " +
    "JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME " +
    "JOIN ALL_CONS_COLUMNS rc ON rc.OWNER = r.OWNER AND rc.CONSTRAINT_NAME = r.CONSTRAINT_NAME " +
    "AND rc.POSITION = cc.POSITION " +
    `WHERE c.CONSTRAINT_TYPE = 'R' AND ${oracleSchemaExclusion("c.OWNER")}` +
    equalsClause("c.OWNER", selector.schema, "schema", "oracle") +
    equalsClause("c.TABLE_NAME", selector.table, "table", "oracle") +
    " ORDER BY c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION"
  );
}

/**
 * The index inventory, one row per indexed column in key order. `is_primary` reads the primary-key constraint the
 * index enforces; a function-based index names the hidden column Oracle made for its expression.
 */
function composeOracleIndexes(selector: AgentCatalogSelector): string {
  return (
    'SELECT i.TABLE_OWNER AS "table_schema", i.TABLE_NAME AS "table_name", i.INDEX_NAME AS "index_name", ' +
    "CASE WHEN i.UNIQUENESS = 'UNIQUE' THEN 'YES' ELSE 'NO' END AS \"is_unique\", " +
    "CASE WHEN EXISTS (SELECT 1 FROM ALL_CONSTRAINTS k WHERE k.CONSTRAINT_TYPE = 'P' AND k.OWNER = i.TABLE_OWNER " +
    "AND k.TABLE_NAME = i.TABLE_NAME AND k.INDEX_NAME = i.INDEX_NAME) THEN 'YES' ELSE 'NO' END AS \"is_primary\", " +
    'ic.COLUMN_NAME AS "column_name" ' +
    "FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME " +
    `WHERE ${oracleSchemaExclusion("i.TABLE_OWNER")}` +
    equalsClause("i.TABLE_OWNER", selector.schema, "schema", "oracle") +
    equalsClause("i.TABLE_NAME", selector.table, "table", "oracle") +
    " ORDER BY i.TABLE_OWNER, i.TABLE_NAME, i.INDEX_NAME, ic.COLUMN_POSITION"
  );
}

/**
 * The statistics inventory: one row per table with the row count its last statistics gathering recorded, NULL for a
 * table never analysed. Nothing here scans a table.
 */
function composeOracleStatistics(selector: AgentCatalogSelector): string {
  return (
    'SELECT t.OWNER AS "table_schema", t.TABLE_NAME AS "table_name", t.NUM_ROWS AS "estimated_rows" ' +
    `FROM ALL_TABLES t WHERE ${oracleSchemaExclusion("t.OWNER")}` +
    equalsClause("t.OWNER", selector.schema, "schema", "oracle") +
    equalsClause("t.TABLE_NAME", selector.table, "table", "oracle") +
    " ORDER BY t.OWNER, t.TABLE_NAME"
  );
}

/** Oracle's catalog read: one composer per kind. */
const ORACLE_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeOracleColumns,
    relations: composeOracleRelations,
    indexes: composeOracleIndexes,
    statistics: composeOracleStatistics,
  }),
});

export const ORACLE_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: ORACLE_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
