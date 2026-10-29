/**
 * Elasticsearch's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * Elasticsearch. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * Elasticsearch SQL reads its catalog only through commands (`SHOW`, `DESCRIBE`, `SYS`), never through a SELECT, so
 * the catalog read is declared a command: the column inventory is `SYS COLUMNS`, and its JDBC-shaped answer is mapped
 * into the column rows the other engines answer. Every statement and answer here was measured on 9.1.4
 * (`tests/fixtures/elasticsearch/9.1.4/catalog-read/`). The engine has no foreign key, no index object apart from the
 * table itself, and no row estimate a catalog command reads, so those three kinds are refused rather than answered
 * with invented rows. Its `EXPLAIN` answers the engine's own plan text, which no explain strategy reads (the provider
 * declares `supportsExplain: false`), so no estimating plan is composed. A table profile would be an aggregate over a
 * whole index, never measured here, and the statistics reading and grounding capture have nothing to read.
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
 * What makes a quoted name an index expression rather than one name, each measured on 9.1.4 with `SYS COLUMNS`: `*`
 * and `,` widen it to every match (`"probe_*"`, `"a,b"`), `<...>` is date math, `:` names a remote cluster, and a
 * leading `-`, `+` or `_` is an exclusion, an inclusion or `_all`. No index, alias or data stream can be named with
 * any of them, so refusing them refuses no table.
 */
const INDEX_EXPRESSION = /[*,:<>]|^[-+_]/;

/** The selector's table as one quoted name, its double quotes doubled, the escape the engine reads inside one. */
function quotedTable(selector: AgentCatalogSelector): string {
  if (selector.table === undefined) return "";
  const table = assertSelector(selector.table, "table");
  if (INDEX_EXPRESSION.test(table)) {
    throw new AgentComposedSqlError(
      `catalog selector "table" (${table}) is an Elasticsearch index expression, not one table name`,
      "INVALID_SELECTOR",
    );
  }
  return ` "${table.replaceAll('"', '""')}"`;
}

/**
 * The column inventory: `SYS COLUMNS`, every table's columns, or one table's with its name. A table is an index, an
 * alias or a data stream's backing index, each in the engine's own listing order.
 */
function composeElasticsearchColumns(selector: AgentCatalogSelector): string {
  if (selector.schema !== undefined) {
    throw new AgentComposedSqlError(
      "Elasticsearch SQL has no schema to narrow by, so name a table instead",
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  return `SYS COLUMNS${quotedTable(selector)}`;
}

/** A kind the engine has nothing to answer: refused, naming what it lacks. */
function refusing(lacks: string): (selector: AgentCatalogSelector) => string {
  return () => {
    throw new AgentComposedSqlError(
      `Elasticsearch keeps no ${lacks}, so there is no such inventory to read`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  };
}

/** The column rows the inventory reads as, in this order. */
const COLUMN_FIELDS = Object.freeze(["table_name", "column_name", "data_type", "is_nullable", "ordinal_position"]);

/**
 * `SYS COLUMNS`'s answer as the column inventory: each row's `TABLE_NAME`, `COLUMN_NAME`, `TYPE_NAME` (the engine's own
 * type name, such as `KEYWORD` or `TEXT`), `IS_NULLABLE` and `ORDINAL_POSITION`, one row per engine row, with a cell the
 * engine did not answer read as null. Only the column kind composes a statement, so it is the only answer this meets.
 * An object field's own position is skipped by the engine, which lists its leaves (`address.city`) instead.
 */
function mapElasticsearchRows(_kind: AgentCatalogKind, rows: readonly Record<string, unknown>[]): AgentCatalogRows {
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

/** Elasticsearch's catalog read: a command, with the column kind alone composed. */
const ELASTICSEARCH_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeElasticsearchColumns,
    relations: refusing("foreign key"),
    indexes: refusing("index object apart from the table itself"),
    statistics: refusing("row estimate a catalog command reads"),
  }),
  commandShaped: true,
  mapRows: mapElasticsearchRows,
});

export const ELASTICSEARCH_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: ELASTICSEARCH_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
