/**
 * Apache Druid's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * Druid. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * Druid reads its catalog with a SELECT on INFORMATION_SCHEMA, which the server filters to the datasources the user
 * may read, so a user holding READ on one datasource reads that datasource's columns and no other's (measured on
 * 37.0.0, `tests/fixtures/druid/37.0.0/agent-boundary/` capture 06). The `sys` schema, INFORMATION_SCHEMA itself and
 * the `lookup` and `view` schemas, which an agent statement may not read, are left out of the read; only the
 * datasources (`druid`) stay in. Druid has no foreign key, so the relation
 * read is the projection the other engines answer, with no rows. It keeps no index object, since every dimension is
 * indexed inside its segments, and no row count in its catalog, so those two kinds are refused. The agent's statements
 * are only a SELECT, so no estimating plan (`EXPLAIN PLAN FOR`) is composed; the provider's own EXPLAIN before each
 * statement is a check the agent never sees. A table profile, the statistics reading and the grounding capture have no
 * composition measured here.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/**
 * The schemas Druid keeps for itself, and the lookup and view schemas, excluded from the column read: an agent
 * statement may not read them (`druidAgentStatementRefusal`), so the read offers no table the agent cannot read.
 */
const DRUID_SCHEMA_EXCLUSION = "TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA', 'lookup', 'view')";

/** The selector's schema and table as conditions on INFORMATION_SCHEMA's own columns. */
function narrowing(selector: AgentCatalogSelector): string {
  return (
    equalsClause("TABLE_SCHEMA", selector.schema, "schema", "druid") +
    equalsClause("TABLE_NAME", selector.table, "table", "druid")
  );
}

/** The column inventory, one row per column, in each table's own column order. */
function composeDruidColumns(selector: AgentCatalogSelector): string {
  return (
    "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, " +
    "DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, ORDINAL_POSITION AS ordinal_position " +
    `FROM INFORMATION_SCHEMA.COLUMNS WHERE ${DRUID_SCHEMA_EXCLUSION}${narrowing(selector)} ` +
    "ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
  );
}

/**
 * The foreign-key inventory, which on Druid is always empty: a datasource cannot reference another
 * (`declaresForeignKeys: false` on the provider). The read is still the projection the other engines answer, with no
 * rows, so a run that asks is told there are none rather than refused.
 */
function composeDruidRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, " +
    "'' AS referenced_schema, '' AS referenced_table, '' AS referenced_column " +
    `FROM INFORMATION_SCHEMA.COLUMNS WHERE 1 = 0${narrowing(selector)}`
  );
}

/** A kind the catalog has nothing to answer: refused, naming what it lacks. */
function refusing(lacks: string): (selector: AgentCatalogSelector) => string {
  return () => {
    throw new AgentComposedSqlError(
      `Druid keeps no ${lacks}, so there is no such inventory to read`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  };
}

/** Druid's catalog read: the column and relation kinds composed. */
const DRUID_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeDruidColumns,
    relations: composeDruidRelations,
    indexes: refusing("index object, since every dimension is indexed inside its segments"),
    statistics: refusing("row count in its catalog, only in the segment list, which is not read here"),
  }),
});

export const DRUID_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: DRUID_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
