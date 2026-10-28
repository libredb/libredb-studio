/**
 * ClickHouse's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * ClickHouse. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * The catalog is read from `system.columns` and `system.tables`, which ClickHouse filters to what the user may see,
 * so the least-privilege agent user reads them with no grant of its own; `system.data_skipping_indices`, the one
 * catalog table the index read could add, answers that user 497 without a grant on it (all measured on 26.7.1.1315
 * as the least-privilege user under `readonly = 1`). The profile composition, the statistics reading and the
 * grounding capture have no composition measured on this engine, and stay unsupported.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  type AgentPlanEstimate,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/**
 * The estimating plan, the one the editor's EXPLAIN asks for (`clickhouse-json.ts`): ClickHouse's EXPLAIN describes a
 * statement without running it, and `indexes = 1` names the primary-key and skipping-index ranges it would select.
 * Measured as the least-privilege user under `readonly = 1`: one row whose `explain` cell is the plan as JSON text.
 */
const CLICKHOUSE_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({
  kind: "prefix",
  prefix: "EXPLAIN json = 1, indexes = 1",
});

/** The schemas ClickHouse keeps for itself, excluded from every catalog read below. */
const CLICKHOUSE_SCHEMA_EXCLUSION = "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

/**
 * The column inventory, one row per column, in each table's own column order. `data_type` is the type verbatim, its
 * `Nullable` and `LowCardinality` wrappers included, and `is_nullable` reads the wrapper, since ClickHouse has no
 * separate nullability flag.
 */
function composeClickhouseColumns(selector: AgentCatalogSelector): string {
  return (
    "SELECT database AS table_schema, table AS table_name, name AS column_name, type AS data_type, " +
    "type LIKE 'Nullable(%' OR type LIKE 'LowCardinality(Nullable(%' AS is_nullable, position AS ordinal_position " +
    `FROM system.columns WHERE ${CLICKHOUSE_SCHEMA_EXCLUSION}` +
    equalsClause("database", selector.schema, "schema", "clickhouse") +
    equalsClause("table", selector.table, "table", "clickhouse") +
    " ORDER BY database, table, position"
  );
}

/**
 * The foreign-key inventory, which on ClickHouse is always empty: the engine parses REFERENCES in a column definition
 * and keeps nothing of it (`declaresForeignKeys: false` on the provider). The read is still the projection the other
 * engines answer, with no rows, so a run that asks is told there are none rather than refused.
 */
function composeClickhouseRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT database AS table_schema, table AS table_name, name AS column_name, " +
    "'' AS referenced_schema, '' AS referenced_table, '' AS referenced_column " +
    `FROM system.columns WHERE 0 AND ${CLICKHOUSE_SCHEMA_EXCLUSION}` +
    equalsClause("database", selector.schema, "schema", "clickhouse") +
    equalsClause("table", selector.table, "table", "clickhouse") +
    " ORDER BY database, table"
  );
}

/**
 * The key inventory: each table's primary key and, where it differs, its sorting key, as the expressions
 * `system.tables` holds. A ClickHouse primary key is a sparse index over the sorting order, not a uniqueness
 * constraint, so neither is unique. The expression is kept whole rather than split into columns, because a key may be
 * any expression (`toDate(ts), id`) and a split at its commas would cut a function's arguments apart.
 */
function composeClickhouseIndexes(selector: AgentCatalogSelector): string {
  const narrowing =
    equalsClause("database", selector.schema, "schema", "clickhouse") +
    equalsClause("name", selector.table, "table", "clickhouse");
  const primary =
    "SELECT database AS table_schema, name AS table_name, 'PRIMARY KEY' AS index_name, false AS is_unique, " +
    "true AS is_primary, primary_key AS key_expression " +
    `FROM system.tables WHERE primary_key != '' AND ${CLICKHOUSE_SCHEMA_EXCLUSION}${narrowing}`;
  const sorting =
    "SELECT database AS table_schema, name AS table_name, 'ORDER BY' AS index_name, false AS is_unique, " +
    "false AS is_primary, sorting_key AS key_expression " +
    `FROM system.tables WHERE sorting_key != '' AND sorting_key != primary_key AND ${CLICKHOUSE_SCHEMA_EXCLUSION}${narrowing}`;
  return `${primary} UNION ALL ${sorting} ORDER BY 1, 2, 3`;
}

/**
 * The statistics inventory: one row per table with the row count `system.tables` keeps, which a MergeTree table
 * maintains from its parts and a view or a table of another engine leaves NULL. Nothing here scans a table.
 */
function composeClickhouseStatistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT database AS table_schema, name AS table_name, total_rows AS estimated_rows " +
    `FROM system.tables WHERE ${CLICKHOUSE_SCHEMA_EXCLUSION}` +
    equalsClause("database", selector.schema, "schema", "clickhouse") +
    equalsClause("name", selector.table, "table", "clickhouse") +
    " ORDER BY database, name"
  );
}

/** ClickHouse's catalog read: one composer per kind. */
const CLICKHOUSE_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeClickhouseColumns,
    relations: composeClickhouseRelations,
    indexes: composeClickhouseIndexes,
    statistics: composeClickhouseStatistics,
  }),
});

export const CLICKHOUSE_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: CLICKHOUSE_CATALOG_READ,
    planEstimate: CLICKHOUSE_PLAN_ESTIMATE,
    // No verified profile composition, so `profile_table` refuses with `UNSUPPORTED_DIALECT`.
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
