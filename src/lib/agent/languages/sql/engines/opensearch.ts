/**
 * OpenSearch's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * OpenSearch. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * OpenSearch SQL reads its catalog only through commands (`SHOW TABLES` and `DESCRIBE TABLES`), never through a
 * SELECT (it has no `information_schema`), so the catalog read is declared a command: the column inventory is
 * `DESCRIBE TABLES LIKE ...`, and its JDBC-shaped answer is mapped into the column rows the other engines answer.
 * Every statement and answer here was measured on 3.8.0 (`tests/fixtures/opensearch/3.8.0/catalog-read/`). The two
 * forms are answered by two engines inside the plugin: an unquoted `%` by the new one, which lists each table's
 * columns under the table's own name, and a quoted name by the older one, which takes the name as written (an unquoted
 * name is a LIKE pattern there, so `probe_orders` also matches `probeXorders`). The engine has no foreign key, no
 * index object apart from the table itself, and no row estimate a catalog command reads, so those three kinds are
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
 * The column inventory: `DESCRIBE TABLES LIKE %`, every table's columns, or one table's with its name. A table is an
 * index or an alias, each in the engine's own listing order.
 */
function composeOpenSearchColumns(selector: AgentCatalogSelector): string {
  if (selector.schema !== undefined) {
    throw new AgentComposedSqlError(
      "OpenSearch SQL has no schema to narrow by, so name a table instead",
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  return `DESCRIBE TABLES LIKE ${selector.table === undefined ? "%" : quotedTable(selector.table)}`;
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
 * meets. The values are the engine's own: `IS_NULLABLE` is an empty string, and the position counts from 1 in the
 * every-table answer and from 0 in the one-table answer, which the two engines inside the plugin each answer their
 * own way.
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
