/**
 * InfluxDB 3's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * InfluxDB 3 (SQL). Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * The statements are DataFusion's, as InfluxDB 3.12.0 Core runs them on `/api/v3/query_sql`, and each was run there
 * with the read policy and the agent path's `system` schema fence in front: the catalog reads off
 * `information_schema`, whose `iox` schema holds the session database's tables, and `EXPLAIN` plans a statement
 * without running it. The engine keeps no foreign key, no index and no row estimate a read outside the `system` schema
 * can reach, so those three kinds answer no rows. The table profile would scan every row of a table, which on a
 * time-series table meets the server's file limit, and the statistics reading and grounding capture have nothing to
 * read, so all three stay unsupported.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  type AgentPlanEstimate,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** DataFusion's `EXPLAIN` answers the logical and the physical plan, one row each, and runs nothing. */
const INFLUXDB3_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN" });

/** The schema the session database's tables live in; `system` and `information_schema` are the engine's own. */
const INFLUXDB3_TABLE_SCHEMA = "table_schema = 'iox'";

/** The selector's narrowing, the same on every kind. */
function narrowing(selector: AgentCatalogSelector): string {
  return (
    equalsClause("table_schema", selector.schema, "schema", "influxdb3") +
    equalsClause("table_name", selector.table, "table", "influxdb3")
  );
}

/**
 * The column inventory, one row per column in each table's own order. DataFusion numbers columns from 0, so the
 * position is moved to the 1-based count the other engines answer. `is_nullable` is `YES` or `NO`; the `time` column
 * is the one that is never null.
 */
function composeInfluxdb3Columns(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position + 1 AS ordinal_position " +
    `FROM information_schema.columns WHERE ${INFLUXDB3_TABLE_SCHEMA}${narrowing(selector)}` +
    " ORDER BY table_schema, table_name, ordinal_position"
  );
}

/** The foreign-key inventory, always empty: the engine has no constraint of any kind. Told, not refused. */
function composeInfluxdb3Relations(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, column_name, " +
    "'' AS referenced_schema, '' AS referenced_table, '' AS referenced_column " +
    `FROM information_schema.columns WHERE false AND ${INFLUXDB3_TABLE_SCHEMA}${narrowing(selector)}` +
    " ORDER BY table_schema, table_name"
  );
}

/** The index inventory, always empty: a table is sorted by its tags and time, and has no index object to name. */
function composeInfluxdb3Indexes(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, '' AS index_name, false AS is_unique, false AS is_primary " +
    `FROM information_schema.tables WHERE false AND ${INFLUXDB3_TABLE_SCHEMA}${narrowing(selector)}` +
    " ORDER BY table_schema, table_name"
  );
}

/** The statistics inventory, always empty: no row estimate is kept outside the `system` schema the agent may not read. */
function composeInfluxdb3Statistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, 0 AS estimated_rows " +
    `FROM information_schema.tables WHERE false AND ${INFLUXDB3_TABLE_SCHEMA}${narrowing(selector)}` +
    " ORDER BY table_schema, table_name"
  );
}

/** InfluxDB 3's catalog read: one composer per kind. */
const INFLUXDB3_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeInfluxdb3Columns,
    relations: composeInfluxdb3Relations,
    indexes: composeInfluxdb3Indexes,
    statistics: composeInfluxdb3Statistics,
  }),
});

export const INFLUXDB3_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: INFLUXDB3_CATALOG_READ,
    planEstimate: INFLUXDB3_PLAN_ESTIMATE,
    // No verified profile composition, so `profile_table` refuses with `UNSUPPORTED_DIALECT`.
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
