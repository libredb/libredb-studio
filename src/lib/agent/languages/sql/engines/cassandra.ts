/**
 * Apache Cassandra's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * Cassandra, and the grounding a plan run on it is told. Server tier, read only through `engineServerDialect` and
 * `runServerPack` in `languages/engines/server.ts`.
 *
 * CQL reads its catalog with a SELECT on `system_schema`, which every role may read, so the column inventory is
 * `system_schema.columns` with its columns renamed to the ones the other engines answer (measured on 5.0.9,
 * `tests/fixtures/cassandra/5.0.9/agent-boundary/` capture 04). Its partition key is `keyspace_name`, and CQL has no
 * `NOT IN` to leave the system keyspaces out of a read of every keyspace, so the read names one keyspace and a
 * selector without one is refused. `kind` says which columns make the primary key (`partition_key`, `clustering`,
 * `regular`, `static`); `position` orders the key columns and reads -1 for every other one. CQL has no foreign key,
 * its index catalog names no column a key read could use, and it records no honest row count, so those three kinds
 * are refused. It has no `EXPLAIN`, so no estimating plan is composed, and a table profile, the statistics reading and
 * the grounding capture have no composition measured here.
 */
import { quoteLiteral } from "@/lib/sql/values";
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  assertSelector,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, AgentLanguageGrounding, SqlServerDialect } from "../../pack";

/** The column inventory of one keyspace, or of one of its tables, in the server's own key order. */
function composeCassandraColumns(selector: AgentCatalogSelector): string {
  if (selector.schema === undefined) {
    throw new AgentComposedSqlError(
      "Cassandra's catalog is read one keyspace at a time, so name the keyspace as the schema",
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  return (
    "SELECT keyspace_name AS table_schema, table_name, column_name, type AS data_type, kind AS column_kind, " +
    "position AS ordinal_position FROM system_schema.columns " +
    `WHERE keyspace_name = ${quoteLiteral(assertSelector(selector.schema, "schema"), "cassandra")}` +
    equalsClause("table_name", selector.table, "table", "cassandra")
  );
}

/** A kind the engine has nothing to answer: refused, naming what it lacks. */
function refusing(lacks: string): (selector: AgentCatalogSelector) => string {
  return () => {
    throw new AgentComposedSqlError(
      `Cassandra keeps no ${lacks}, so there is no such inventory to read`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  };
}

/** Cassandra's catalog read: the column kind alone composed. */
const CASSANDRA_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeCassandraColumns,
    relations: refusing("foreign key"),
    indexes: refusing(
      "index a key read uses apart from the primary key, which the column inventory's column_kind names",
    ),
    statistics: refusing("row count it can vouch for"),
  }),
});

/**
 * What a plan run on Cassandra is told on top of the SQL contract: the limits of CQL a statement written from SQL
 * habits breaks, each measured on 5.0.9 as a syntax error or a refusal.
 */
const CQL_PLANNING_RULES: readonly string[] = Object.freeze([
  "CQL reads one table per statement: there is no JOIN, no subquery, no UNION and no OFFSET, and GROUP BY and ORDER BY take only primary key columns in key order.",
  "Restrict the partition key with = or IN, then clustering columns in key order; a predicate on any other column needs ALLOW FILTERING, which scans the table, and ALLOW FILTERING goes last, after LIMIT.",
  "Name each table with its keyspace, as keyspace.table.",
]);

/** The SQL grounding with CQL's limits added, and no relation inventory, since CQL has no foreign key. */
const cassandraGrounding = (base: AgentLanguageGrounding): AgentLanguageGrounding =>
  Object.freeze({ ...base, relations: false, planningRules: CQL_PLANNING_RULES });

export const CASSANDRA_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: CASSANDRA_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
  grounding: cassandraGrounding,
} as const satisfies AgentEngineServerOverlay<"sql">;
