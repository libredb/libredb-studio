/**
 * Db2 LUW's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on Db2.
 * Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * The catalog is read from the `SYSCAT` views, which every user may read on a fresh database and which list every
 * object, not only those the user may read, and the columns from `SYSIBM.COLUMNS`, which keeps no stored value. Each
 * is named by its schema, so an object in the user's schema or a public alias cannot stand in for it. The system's own tables (`SYSCAT.TABLES.OWNERTYPE` S) are left out of every
 * read, by that catalog fact rather than by a schema name: a schema created implicitly, by a CREATE in a schema that
 * does not exist, is itself owned by SYSIBM, while its tables are owned by their creator (measured). Names are trimmed,
 * since db2-node hands a padded CHAR
 * name back padded, and each name a selector carries is a string literal compared exactly, as the catalog spells it:
 * an undelimited Db2 name is stored in upper case. Each kind was run as the least-privilege agent user on 12.1.0.0.
 *
 * The estimating plan stays unsupported: Db2's EXPLAIN writes its rows into the explain tables, a write the agent
 * user is refused. The profile composition, the statistics reading and the grounding capture have no composition
 * measured on this engine, and stay unsupported too.
 */
import { type AgentCatalogRead, type AgentCatalogSelector, equalsClause } from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** The table `schema`.`table` is not the system's own, the condition every catalog read below holds its rows to. */
function db2UserTable(schema: string, table: string): string {
  return `EXISTS (SELECT 1 FROM SYSCAT.TABLES o WHERE o.TABSCHEMA = ${schema} AND o.TABNAME = ${table} AND o.OWNERTYPE <> 'S')`;
}

/** The selector's schema and table, compared with the catalog's own columns. */
function narrowing(selector: AgentCatalogSelector, schema: string, table: string): string {
  return equalsClause(schema, selector.schema, "schema", "db2") + equalsClause(table, selector.table, "table", "db2");
}

/** The ISO type names `SYSIBM.COLUMNS` answers, spelled as the catalog's own type names (measured on 12.1.0.0). */
const ISO_TYPE_NAMES: readonly (readonly [string, string])[] = [
  ["CHARACTER VARYING", "VARCHAR"],
  ["GRAPHIC VARYING", "VARGRAPHIC"],
  ["CHARACTER LARGE OBJECT", "CLOB"],
  ["DOUBLE-BYTE CHARACTER LARGE OBJECT", "DBCLOB"],
  ["BINARY LARGE OBJECT", "BLOB"],
  ["DOUBLE PRECISION", "DOUBLE"],
];

/**
 * The column inventory, one row per column, in each table's own column order, views included. It reads
 * `SYSIBM.COLUMNS`, which keeps no stored value, rather than `SYSCAT.COLUMNS`, whose `HIGH2KEY` and `LOW2KEY` hold
 * the second highest and lowest value of every column and which the agent user's seed revokes from PUBLIC.
 * `data_type` is the type name as the catalog spells it, a distinct type's by its own name, and `is_nullable` Y or N.
 */
function composeDb2Columns(selector: AgentCatalogSelector): string {
  const typeName =
    "CASE c.DATA_TYPE " +
    ISO_TYPE_NAMES.map(([iso, name]) => `WHEN '${iso}' THEN '${name}' `).join("") +
    "WHEN 'USER-DEFINED' THEN c.UDT_NAME ELSE c.DATA_TYPE END";
  return (
    'SELECT RTRIM(c.TABLE_SCHEMA) AS "table_schema", c.TABLE_NAME AS "table_name", c.COLUMN_NAME AS "column_name", ' +
    `${typeName} AS "data_type", CASE c.IS_NULLABLE WHEN 'YES' THEN 'Y' ELSE 'N' END AS "is_nullable", ` +
    'c.ORDINAL_POSITION AS "ordinal_position" ' +
    `FROM SYSIBM.COLUMNS c WHERE ${db2UserTable("c.TABLE_SCHEMA", "c.TABLE_NAME")}` +
    narrowing(selector, "c.TABLE_SCHEMA", "c.TABLE_NAME") +
    " ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION"
  );
}

/** The foreign-key inventory: each referencing column beside the column it references, by position in the key. */
function composeDb2Relations(selector: AgentCatalogSelector): string {
  return (
    'SELECT RTRIM(r.TABSCHEMA) AS "table_schema", r.TABNAME AS "table_name", k.COLNAME AS "column_name", ' +
    'RTRIM(r.REFTABSCHEMA) AS "referenced_schema", r.REFTABNAME AS "referenced_table", ' +
    'p.COLNAME AS "referenced_column" ' +
    "FROM SYSCAT.REFERENCES r " +
    "JOIN SYSCAT.KEYCOLUSE k ON k.TABSCHEMA = r.TABSCHEMA AND k.TABNAME = r.TABNAME AND k.CONSTNAME = r.CONSTNAME " +
    "JOIN SYSCAT.KEYCOLUSE p ON p.TABSCHEMA = r.REFTABSCHEMA AND p.TABNAME = r.REFTABNAME " +
    "AND p.CONSTNAME = r.REFKEYNAME AND p.COLSEQ = k.COLSEQ " +
    `WHERE ${db2UserTable("r.TABSCHEMA", "r.TABNAME")}` +
    narrowing(selector, "r.TABSCHEMA", "r.TABNAME") +
    " ORDER BY r.TABSCHEMA, r.TABNAME, r.CONSTNAME, k.COLSEQ"
  );
}

/**
 * The index inventory, one row per indexed column in key order. `UNIQUERULE` reads P for the primary key's index, U
 * for a unique one and D for one that admits duplicates.
 */
function composeDb2Indexes(selector: AgentCatalogSelector): string {
  return (
    'SELECT RTRIM(i.TABSCHEMA) AS "table_schema", i.TABNAME AS "table_name", i.INDNAME AS "index_name", ' +
    "CASE WHEN i.UNIQUERULE IN ('P', 'U') THEN 'YES' ELSE 'NO' END AS \"is_unique\", " +
    "CASE WHEN i.UNIQUERULE = 'P' THEN 'YES' ELSE 'NO' END AS \"is_primary\", " +
    'u.COLNAME AS "column_name" ' +
    "FROM SYSCAT.INDEXES i JOIN SYSCAT.INDEXCOLUSE u ON u.INDSCHEMA = i.INDSCHEMA AND u.INDNAME = i.INDNAME " +
    `WHERE ${db2UserTable("i.TABSCHEMA", "i.TABNAME")}` +
    narrowing(selector, "i.TABSCHEMA", "i.TABNAME") +
    " ORDER BY i.TABSCHEMA, i.TABNAME, i.INDNAME, u.COLSEQ"
  );
}

/**
 * The statistics inventory: one row per table and materialized query table with the row count its last RUNSTATS
 * recorded, NULL for one never measured (`CARD` -1). Nothing here scans a table.
 */
function composeDb2Statistics(selector: AgentCatalogSelector): string {
  return (
    'SELECT RTRIM(t.TABSCHEMA) AS "table_schema", t.TABNAME AS "table_name", NULLIF(t.CARD, -1) AS "estimated_rows" ' +
    "FROM SYSCAT.TABLES t WHERE t.TYPE IN ('T', 'S') AND t.OWNERTYPE <> 'S'" +
    narrowing(selector, "t.TABSCHEMA", "t.TABNAME") +
    " ORDER BY t.TABSCHEMA, t.TABNAME"
  );
}

/** Db2's catalog read: one composer per kind. */
const DB2_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeDb2Columns,
    relations: composeDb2Relations,
    indexes: composeDb2Indexes,
    statistics: composeDb2Statistics,
  }),
});

export const DB2_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: DB2_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
