/**
 * libSQL's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on libSQL.
 * Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 *
 * libSQL embeds SQLite, so every statement here is SQLite's, and each was run on sqld 0.24.33 (SQLite 3.45.1) with a
 * read-only token: the catalog reads off `sqlite_master`, the statistics probe, `EXPLAIN QUERY PLAN` and the table
 * profile's `LIKE` and `GLOB` counts all answered. The server refuses `ANALYZE` for every token, so `sqlite_stat1`
 * exists only in a database that brought one with it, and the probe reads its absence as statistics absent. The
 * grounding capture stays unsupported: it would read through the agent's read-only path, which only a read-only token
 * opens, and plan mode grounds on a connection whose token may write.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  type AgentPlanEstimate,
  assertSelector,
  equalsClause,
} from "../../../composed-sql-primitives";
import { numeric, text } from "../../../catalog-rows";
import type { AgentStatisticsReading, AgentTableEstimate } from "../../../schema-stats";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay, SqlServerDialect } from "../../pack";

/** `LIKE` for the email shape and `GLOB` for the digit run, as on SQLite: the engine is SQLite. */
const LIBSQL_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // SQLite has no quantifier, so the run is spelled out one class at a time.
    digitRun: (quoted: string, runLength: number) => `${quoted} GLOB '*${"[0-9]".repeat(runLength)}*'`,
  }),
  incomparableType: /\b(jsonb?|xml|point|line|lseg|box|path|polygon|circle)\b/i,
});

/** `EXPLAIN QUERY PLAN` reports the plan the compiler produced, without running it. */
const LIBSQL_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN QUERY PLAN" });

/** libSQL's only schema: the server refuses `ATTACH` for every token, so `main` is the whole set. */
const LIBSQL_ONLY_SCHEMA = "main";

/** libSQL serves one schema, and a selector naming another is refused rather than quietly read as `main`. */
function assertLibsqlSchema(selector: AgentCatalogSelector): void {
  if (selector.schema === undefined) return;
  const schema = assertSelector(selector.schema, "schema");
  if (schema.toLowerCase() !== LIBSQL_ONLY_SCHEMA) {
    throw new AgentComposedSqlError(
      `libSQL serves one schema on the agent path ("${LIBSQL_ONLY_SCHEMA}"), so "${schema}" cannot be selected`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
}

/**
 * The tables and views with their DDL, which serves the relation read too: a foreign key is declared inside its
 * table's `CREATE TABLE`. The escape character is `@` rather than a backslash, for the reason `assertSelector` states.
 */
function composeLibsqlCatalog(selector: AgentCatalogSelector): string {
  assertLibsqlSchema(selector);
  return (
    "SELECT name, type, sql FROM sqlite_master " +
    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("name", selector.table, "table", "libsql") +
    " ORDER BY type, name"
  );
}

/**
 * The index inventory with its DDL. `sql IS NOT NULL` leaves out the indexes a `UNIQUE` or `PRIMARY KEY` constraint
 * creates, which carry no DDL; their columns are in the table's own DDL. The selector narrows on the indexed table.
 */
function composeLibsqlIndexes(selector: AgentCatalogSelector): string {
  assertLibsqlSchema(selector);
  return (
    "SELECT name, tbl_name, sql FROM sqlite_master " +
    "WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("tbl_name", selector.table, "table", "libsql") +
    " ORDER BY tbl_name, name"
  );
}

/**
 * The statistics inventory from `sqlite_stat1`, every table kept by the LEFT JOIN, since a table with no analysed index
 * has no row there. The table must exist when the statement is prepared, so the availability probe runs first.
 */
function composeLibsqlStatistics(selector: AgentCatalogSelector): string {
  assertLibsqlSchema(selector);
  return (
    "SELECT m.name AS table_name, s.idx AS index_name, s.stat AS stat " +
    "FROM sqlite_master m LEFT JOIN sqlite_stat1 s ON s.tbl = m.name " +
    "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("m.name", selector.table, "table", "libsql") +
    " ORDER BY m.name, s.idx"
  );
}

/** libSQL's catalog read. Its relation read is its object read, as on SQLite. */
const LIBSQL_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeLibsqlCatalog,
    relations: composeLibsqlCatalog,
    indexes: composeLibsqlIndexes,
    statistics: composeLibsqlStatistics,
  }),
  /** `main` is matched without case, so the canonical spelling is the one a scope allowlist is written against. */
  declaredSchema: (schema: string) => schema.toLowerCase(),
});

/**
 * One estimate per table from `sqlite_stat1`: the first field of `stat` is the row count at the last `ANALYZE`. The
 * fields after it describe an index prefix, not a column, so no per-column figure is read from them.
 */
function buildLibsqlEstimates(rows: readonly Record<string, unknown>[]): Map<string, AgentTableEstimate> {
  const byTable = new Map<string, AgentTableEstimate>();
  for (const row of rows) {
    const name = text(row.table_name);
    const estimatedRows = numeric(text(row.stat).split(" ")[0]);
    const held = byTable.get(name);
    // The first index that carries an estimate wins; a later NULL `stat` never overwrites a reading with an absence.
    if (held !== undefined && held.estimatedRows !== null) continue;
    byTable.set(name, { estimatedRows, columns: [] });
  }
  return byTable;
}

/** libSQL's statistics reading: the probe runs first, since the server cannot run `ANALYZE` to create the table. */
const LIBSQL_STATISTICS: AgentStatisticsReading = Object.freeze({
  probe: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
  build: buildLibsqlEstimates,
  limitNote:
    "This engine records no per-column distinct count or null fraction at all, so none is shown for any column here, and none can be obtained without reading the data.",
});

export const LIBSQL_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: LIBSQL_CATALOG_READ,
    planEstimate: LIBSQL_PLAN_ESTIMATE,
    profileComposition: LIBSQL_PROFILE_COMPOSITION,
    statistics: LIBSQL_STATISTICS,
    // No grounding capture: it reads through the read-only path, which a token that writes cannot open (module doc).
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
} as const satisfies AgentEngineServerOverlay<"sql">;
