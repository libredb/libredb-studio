/**
 * MySQL's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * MySQL and MariaDB. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  type AgentPlanEstimate,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** `LIKE` for the email shape and `REGEXP` for the digit run (B26, `PROFILE_SHAPES`). */
const MYSQL_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    // LIKE is spelled the same way on MySQL and MariaDB, `_` meaning "any character"
    // included, measured on both engines as the least-privilege account.
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // Both engines of this family take the SQL:1999 REGEXP operator with a POSIX-ish
    // pattern, measured on MySQL 26.7.0 and MariaDB 13.0.2 as the least-privilege
    // account: the nine-digit run counted 1, the eight-digit one 0.
    digitRun: (quoted: string, runLength: number) => `${quoted} REGEXP '[0-9]{${runLength},}'`,
  }),
  // PER DIALECT, and this arm matches NOTHING - measured, not assumed. On MySQL
  // 26.7.0 and MariaDB 13.0.2, as the least-privilege account, one
  // `count(DISTINCT …)` per column of a probe table holding `json`, `blob`,
  // `geometry`, `bigint` past 2^53, `varchar` and `text`: every one of them counted
  // (the two engines compare by the value's own form, so each answered 1 for the one
  // row). Neither engine of this family refuses a DISTINCT the way PostgreSQL
  // refuses `json`, so listing any type here would cost a column its distinct count
  // for nothing. `\b\B` cannot match ANY text, by construction: no position is both
  // a word boundary and not one (`$^`, the first spelling of this, matches the empty
  // string, which would have ruled out a column whose declared type read back empty).
  //
  // The engines DO refuse `ORDER BY` and comparison on some of these types - that is
  // a different operation than the COUNT this test guards, and nothing this module
  // composes orders by a column value.
  incomparableType: /\b\B/,
});

/**
 * One spelling for MySQL and MariaDB: both accept `EXPLAIN FORMAT=JSON` with no
 * privilege beyond SELECT (measured as the least-privilege account on 26.7.0 and
 * 13.0.2), and the JSON shapes differ (`query_plan` on MySQL, `query_block` on
 * MariaDB) without either refusing the prefix. `EXPLAIN ANALYZE` is deliberately
 * not composed: it EXECUTES, see `withoutEstimatingPrefix` in `composed-sql.ts`.
 */
const MYSQL_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({
  kind: "prefix",
  prefix: "EXPLAIN FORMAT=JSON",
});

/**
 * The schemas MySQL and MariaDB reserve, excluded from every catalog read below.
 *
 * Four names, both engines: `information_schema` and `performance_schema` exist on
 * both, `mysql` is the grant catalogue on both, and `sys` exists on MySQL and is
 * harmlessly absent on MariaDB. Every other schema a server of this family owns is
 * one an operator chose the name of (`probe` in the fixtures, `reporting` in them
 * too), and a name list would have had to be right about all of them.
 *
 * A function of the column it filters, because the column inventory joins two views
 * that both carry `table_schema`, and an unqualified name there is refused with 1052
 * on both engines.
 *
 * Every arm below also ALIASES the columns it reads to lower case: MySQL answers an
 * unaliased `information_schema` column in upper case (`TABLE_SCHEMA`), MariaDB in
 * lower case, and the alias is what makes the two hand back the same keys.
 */
function mysqlSchemaExclusion(column: string): string {
  return `${column} NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')`;
}

/**
 * The column inventory, ONE ROW PER OBJECT, symmetric with the PostgreSQL and SQL
 * Server arms (B52).
 *
 * The per-object column list is built by `GROUP_CONCAT` over `JSON_OBJECT`, not by
 * `JSON_ARRAYAGG`, because the two engines disagree about ORDER: MariaDB accepts
 * `JSON_ARRAYAGG(… ORDER BY …)` (measured, 13.0.2: the list arrived in ordinal
 * order) and MySQL answers 1064 for the same text (measured, 26.7.0), while
 * `GROUP_CONCAT(… ORDER BY …)` is the one aggregate-with-order BOTH spell. The
 * brackets are concatenated rather than cast, because MariaDB answers 1064 for
 * `CAST(… AS JSON)` (measured) - the text is a JSON array either way, and the
 * consumer parses the cell.
 *
 * `GROUP_CONCAT` has a length ceiling (`group_concat_max_len`), 1024 by default on
 * MySQL and 1048576 on MariaDB, measured, and a ceiling hit is a SILENT truncation.
 * The read-only path raises it to 4 MB for the session (`MySQLProvider`
 * `queryReadOnly`), which a column list of realistic size does not approach, and the
 * connection is closed when the call ends, so the raised ceiling never outlives it.
 *
 * `relkind` is `information_schema.tables.table_type` - `BASE TABLE` and `VIEW`,
 * this family's own words for what an entry is, the role `pg_class.relkind` plays
 * on PostgreSQL and `o.type` on SQL Server. It is joined rather than read from the
 * columns view alone because that view does not carry it.
 *
 * Measured on MySQL 26.7.0 and MariaDB 12.3.2 (2026-10-13) as the least-privilege
 * account `libredb_agent` through `queryReadOnly`: every table of the `app` fixture,
 * one row per object, columns in ordinal position order. The first spelling of this
 * statement left the schema filter unqualified and both engines refused it with 1052,
 * which no text-pinned unit test could see; `tests/live/mysql-agent-profile.ts` runs
 * every kind against both engines.
 */
function composeMysqlCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT c.table_schema AS table_schema, c.table_name AS table_name, t.table_type AS relkind, " +
    "CONCAT('[', GROUP_CONCAT(JSON_OBJECT('name', c.column_name, 'type', c.data_type, " +
    "'nullable', c.is_nullable) ORDER BY c.ordinal_position SEPARATOR ','), ']') AS columns " +
    "FROM information_schema.columns c " +
    "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
    `WHERE ${mysqlSchemaExclusion("c.table_schema")}` +
    equalsClause("c.table_schema", selector.schema, "schema", "mysql") +
    equalsClause("c.table_name", selector.table, "table", "mysql") +
    " GROUP BY c.table_schema, c.table_name, t.table_type ORDER BY c.table_schema, c.table_name"
  );
}

/**
 * The foreign-key inventory, one row per KEY COLUMN PAIR.
 *
 * `information_schema.key_column_usage`, which carries one row per column of each
 * constraint with its own ordinal and the referenced pair on the same row, so a
 * composite key pairs position with position by construction - the same reason the
 * PostgreSQL arm reads `pg_constraint` rather than the constraint views. Measured on
 * both engines as `libredb_agent`: the `app` fixture's two foreign keys, two rows.
 */
function composeMysqlRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT kcu.table_schema AS table_schema, kcu.table_name AS table_name, kcu.column_name AS column_name, " +
    "kcu.referenced_table_schema AS referenced_table_schema, kcu.referenced_table_name AS referenced_table_name, " +
    "kcu.referenced_column_name AS referenced_column_name " +
    "FROM information_schema.key_column_usage kcu " +
    "WHERE kcu.referenced_table_name IS NOT NULL " +
    `AND ${mysqlSchemaExclusion("kcu.table_schema")}` +
    equalsClause("kcu.table_schema", selector.schema, "schema", "mysql") +
    equalsClause("kcu.table_name", selector.table, "table", "mysql") +
    " ORDER BY kcu.table_schema, kcu.table_name, kcu.constraint_name, kcu.ordinal_position"
  );
}

/**
 * The index inventory, one row per indexed KEY POSITION.
 *
 * `information_schema.statistics` is one row per column position of each index:
 * `seq_in_index` is the position, `non_unique` inverted is `is_unique`, and the
 * PRIMARY KEY of this family is an index NAMED `PRIMARY` - which is how `is_primary`
 * is answered, the engine's own convention rather than a flag it does not publish.
 * `sub_part` rows (an index on a prefix of a long column) still name the column, and
 * prefix length is not something this inventory has ever carried.
 *
 * Measured on both engines as `libredb_agent`: `PRIMARY` unique and primary, the
 * constraint-backed `orders_customer_fk` neither, in position order.
 */
function composeMysqlIndexes(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema AS table_schema, table_name AS table_name, index_name AS index_name, " +
    "NOT non_unique AS is_unique, index_name = 'PRIMARY' AS is_primary, column_name AS column_name " +
    "FROM information_schema.statistics " +
    `WHERE ${mysqlSchemaExclusion("table_schema")}` +
    equalsClause("table_schema", selector.schema, "schema", "mysql") +
    equalsClause("table_name", selector.table, "table", "mysql") +
    " ORDER BY table_schema, table_name, index_name, seq_in_index"
  );
}

/**
 * The statistics inventory: one row per table, carrying the engine's own row
 * estimate.
 *
 * `information_schema.tables.table_rows` is the estimate MySQL and MariaDB both
 * keep for the optimizer - an ESTIMATE, exact for MyISAM and approximate for InnoDB,
 * which is precisely what the other engines' arms answer too (`pg_class.reltuples`,
 * `sys.partitions.rows`). It carries the TABLE half and says nothing about columns,
 * the same shape the SQL Server, SQLite and DuckDB arms produce and the reason
 * `AgentTableEstimate.columns` is allowed to be empty.
 *
 * Nothing here scans: it is a catalog read like every other statistics composition,
 * which is what lets a plan run be pointed at production. Measured on both engines
 * as `libredb_agent`.
 */
function composeMysqlStatistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema AS table_schema, table_name AS table_name, table_rows AS estimated_rows " +
    "FROM information_schema.tables " +
    `WHERE table_type = 'BASE TABLE' AND ${mysqlSchemaExclusion("table_schema")}` +
    equalsClause("table_schema", selector.schema, "schema", "mysql") +
    equalsClause("table_name", selector.table, "table", "mysql") +
    " ORDER BY table_schema, table_name"
  );
}

/** MySQL and MariaDB's catalog read: one composer per kind. */
const MYSQL_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeMysqlCatalog,
    relations: composeMysqlRelations,
    indexes: composeMysqlIndexes,
    statistics: composeMysqlStatistics,
  }),
});

export const MYSQL_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: MYSQL_CATALOG_READ,
    planEstimate: MYSQL_PLAN_ESTIMATE,
    profileComposition: MYSQL_PROFILE_COMPOSITION,
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
