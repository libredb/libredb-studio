/**
 * OpenSearch's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * OpenSearch. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * OpenSearch SQL reads its catalog only through commands (`SHOW TABLES` and `DESCRIBE TABLES`), never through a
 * SELECT (it has no `information_schema`), so the catalog read is declared a command: the column inventory is one
 * table's `DESCRIBE TABLES LIKE '<table>'`, and its JDBC-shaped answer is mapped into the column rows the other engines
 * answer. Every statement and answer here was measured on 3.8.0 (`tests/fixtures/opensearch/3.8.0/catalog-read/`). The
 * quoted name is answered by the older of the two engines inside the plugin, which takes the name as written (an
 * unquoted name is a LIKE pattern there, so `probe_orders` also matches `probeXorders`). Every table's read, an
 * unquoted `%`, resolves `*`, which reaches the indices whose names start with a dot on every 3.8.0 node, so it is
 * refused when composed rather than sent for the provider's statement check to refuse. The engine has no foreign key,
 * no index object apart from the table itself, and no row estimate a catalog command reads, so those three kinds are
 * refused rather than answered with invented rows. It answers no `EXPLAIN` the provider reads (`supportsExplain` is
 * false), so no estimating plan is composed, and a table profile, the statistics reading and the grounding capture
 * were never measured here.
 */
import {
  type AgentCatalogKind,
  type AgentCatalogRead,
  type AgentCatalogRows,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  assertSelector,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/**
 * What makes a quoted name an index expression rather than one name, each measured on 3.8.0 with
 * `DESCRIBE TABLES LIKE '<name>'`: `*` and `,` widen it to every match, `%` is read as `*`, `<...>` is date math
 * (`'<probe_orders>'` answered `probe_orders`), `:` names a remote cluster (`'remote:probe_orders'` answered
 * `probe_orders`), and a leading `_` reads `_all` as every index; a leading `-` or `+` is an exclusion or an
 * inclusion elsewhere in the engine. No index, alias or data stream can be named with any of them, so refusing them
 * refuses no table.
 */
const INDEX_EXPRESSION = /[*,%:<>]|^[-+_]/;

/** The selector's table as one string, its single quotes doubled, the escape 3.8.0 reads inside one. */
function quotedTable(table: string): string {
  const name = assertSelector(table, "table");
  if (INDEX_EXPRESSION.test(name)) {
    throw new AgentComposedSqlError(
      `catalog selector "table" (${name}) is an OpenSearch index expression, not one table name`,
      "INVALID_SELECTOR",
    );
  }
  return `'${name.replaceAll("'", "''")}'`;
}

/**
 * The column inventory: one table's columns, read by its name. A table is an index or an alias. With no table named it
 * is refused: every table's read, `DESCRIBE TABLES LIKE %`, names every index, `*`, which reaches the indices whose
 * names start with a dot on every 3.8.0 node, and the provider's statement check refuses it on the agent read-only path
 * anyway, so the agent is told to name a table here instead.
 */
function composeOpenSearchColumns(selector: AgentCatalogSelector): string {
  if (selector.schema !== undefined) {
    throw new AgentComposedSqlError(
      "OpenSearch SQL has no schema to narrow by, so name a table instead",
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  if (selector.table === undefined) {
    throw new AgentComposedSqlError(
      "OpenSearch's every-table catalog read reaches the indices whose names start with a dot, so name a table instead",
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  return `DESCRIBE TABLES LIKE ${quotedTable(selector.table)}`;
}

/** A kind the engine has nothing to answer: refused, naming what it lacks. */
function refusing(lacks: string): (selector: AgentCatalogSelector) => string {
  return () => {
    throw new AgentComposedSqlError(
      `OpenSearch keeps no ${lacks}, so there is no such inventory to read`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  };
}

/** The column rows the inventory reads as, in this order. */
const COLUMN_FIELDS = Object.freeze(["table_name", "column_name", "data_type", "is_nullable", "ordinal_position"]);

/**
 * `DESCRIBE TABLES`'s answer as the column inventory: each row's `TABLE_NAME`, `COLUMN_NAME`, `TYPE_NAME` (the
 * mapping type, such as `keyword` or `text`), `IS_NULLABLE` and `ORDINAL_POSITION`, one row per engine row, with a cell
 * the engine did not answer read as null. Only the column kind composes a statement, so it is the only answer this
 * meets. The values are the engine's own: `IS_NULLABLE` is an empty string, and the position counts from 0, as the
 * older engine inside the plugin answers it.
 */
function mapOpenSearchRows(_kind: AgentCatalogKind, rows: readonly Record<string, unknown>[]): AgentCatalogRows {
  return {
    fields: COLUMN_FIELDS,
    rows: rows.map((row) => ({
      table_name: row.TABLE_NAME ?? null,
      column_name: row.COLUMN_NAME ?? null,
      data_type: row.TYPE_NAME ?? null,
      is_nullable: row.IS_NULLABLE ?? null,
      ordinal_position: row.ORDINAL_POSITION ?? null,
    })),
  };
}

/** OpenSearch's catalog read: a command, with the column kind alone composed. */
const OPENSEARCH_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeOpenSearchColumns,
    relations: refusing("foreign key"),
    indexes: refusing("index object apart from the table itself"),
    statistics: refusing("row estimate a catalog command reads"),
  }),
  commandShaped: true,
  mapRows: mapOpenSearchRows,
});

export const OPENSEARCH_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: OPENSEARCH_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
