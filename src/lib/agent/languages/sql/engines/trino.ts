/**
 * Trino's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on Trino.
 * Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * Trino reads its catalog with a SELECT on `information_schema.columns`, which resolves against the connection's pinned
 * catalog (a connection that pins none is answered the server's own refusal) and which the server filters to the tables
 * the access control lets the user see. The `information_schema` schema itself is left out of the read. Trino declares
 * no key and no index on any connector, so the relation read is the projection the other engines answer, with no rows,
 * and the index and statistics kinds are refused: the row counts Trino has come from `SHOW STATS`, which is not a
 * SELECT. The provider sends only a SELECT to the server, so no estimating plan (`EXPLAIN`) is composed, and a table
 * profile, the statistics reading and the grounding capture have no composition measured here.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** The schema Trino keeps for its own catalog views, excluded from the column read. */
const TRINO_SCHEMA_EXCLUSION = "table_schema <> 'information_schema'";

/** The selector's schema and table as conditions on `information_schema`'s own columns. */
function narrowing(selector: AgentCatalogSelector): string {
  return (
    equalsClause("table_schema", selector.schema, "schema", "trino") +
    equalsClause("table_name", selector.table, "table", "trino")
  );
}

/** The column inventory, one row per column, in each table's own column order. */
function composeTrinoColumns(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position " +
    `FROM information_schema.columns WHERE ${TRINO_SCHEMA_EXCLUSION}${narrowing(selector)} ` +
    "ORDER BY table_schema, table_name, ordinal_position"
  );
}

/**
 * The foreign-key inventory, which on Trino is always empty: no connector declares a key (`declaresForeignKeys: false`
 * on the provider). The read is still the projection the other engines answer, with no rows, so a run that asks is told
 * there are none rather than refused.
 */
function composeTrinoRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, column_name, " +
    "'' AS referenced_schema, '' AS referenced_table, '' AS referenced_column " +
    `FROM information_schema.columns WHERE 1 = 0${narrowing(selector)}`
  );
}

/** A kind the catalog has nothing to answer: refused, naming what it lacks. */
function refusing(lacks: string): (selector: AgentCatalogSelector) => string {
  return () => {
    throw new AgentComposedSqlError(
      `Trino keeps no ${lacks}, so there is no such inventory to read`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  };
}

/** Trino's catalog read: the column and relation kinds composed. */
const TRINO_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeTrinoColumns,
    relations: composeTrinoRelations,
    indexes: refusing("index object on any connector"),
    statistics: refusing("row count a SELECT can read, only the SHOW STATS answer, which is not read here"),
  }),
});

export const TRINO_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: TRINO_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
