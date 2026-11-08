import type { DatabaseType } from "@/lib/types";

/**
 * What `run_read_query` tells a caller about one engine's SQL: the statements the
 * engine runs among those the MCP execution fence admits (a `SELECT` or `WITH`, `VALUES`, `TABLE`, and `EXPLAIN`
 * without `ANALYZE`), and how the engine's own SQL pages a result. The fence is one rule for every engine, so a
 * refusal that listed its whole set would offer `TABLE` on SQLite, which has no such statement; the refusal reads the
 * engine's row instead (`src/lib/mcp/tools/read-query-limits.ts`).
 *
 * Measured on 2026-10-27 by running each form: SQLite 3.53.4 refuses `TABLE`; DuckDB 1.5.5 runs all four; SQL Server
 * 2022 refuses a bare `VALUES` and `TABLE` and has no `EXPLAIN`; MySQL runs `VALUES ROW(...)` and `TABLE`, and MariaDB
 * 11.8 a bare `VALUES` list but no `TABLE`. Measured on 2026-11-01: ClickHouse 26.7.1.1315 refuses a bare `VALUES` and
 * `TABLE` and runs `EXPLAIN`; libSQL (sqld 0.24.33, through a read-only token) runs a bare `VALUES`, `EXPLAIN` and
 * `EXPLAIN QUERY PLAN`, and answers `TABLE` and `EXPLAIN ANALYZE` with a syntax error, as SQLite does; InfluxDB 3 Core
 * 3.12.0, through the agent read-only path, runs a bare `VALUES` and `EXPLAIN` (`VERBOSE` too), answers `TABLE` with a
 * parser error, and runs `EXPLAIN ANALYZE`, which the fence refuses; Elasticsearch 9.1.4, through the agent read-only
 * path, runs a `SELECT` that reads at most one index expression and an `EXPLAIN` of one, while the path's statement
 * check refuses a comment, a subquery, a `WITH` and a `JOIN` before they are sent, the grammar refuses `VALUES`,
 * `TABLE` and `EXPLAIN ANALYZE`, and there is no `OFFSET` at all, so it pages by key: a `WHERE` on a sort key past the
 * last value read answers the next rows. Measured on 2026-11-02: OpenSearch 3.8.0, through the agent read-only path,
 * runs a `SELECT` that reads at most one index expression, and pages it with `LIMIT n OFFSET m`, while the path's
 * statement check refuses a comment, a subquery, a `WITH`, a `JOIN` and a double-quoted name before they are sent, and
 * the plugin refuses `WITH`, `VALUES`, `TABLE` and `EXPLAIN`, each a statement that must start with SELECT, DELETE,
 * SHOW or DESCRIBE. Measured on 2026-11-02: Oracle AI Database 26ai Free 23.26.3, through the agent read-only path,
 * runs a `SELECT` and a `WITH`, answers a bare `VALUES` and `TABLE` with ORA-00900 and `EXPLAIN` with ORA-02000,
 * refuses `EXPLAIN PLAN`, which writes its rows into PLAN_TABLE, inside the read-only transaction (ORA-01456), and
 * pages with `OFFSET m ROWS FETCH NEXT n ROWS ONLY`; it has no `LIMIT` (ORA-03047), so its row refusals name its own
 * row limiting clause.
 * Measured on 2026-11-02: Apache Cassandra 5.0.9, as a role holding only SELECT
 * on its keyspace, runs a `SELECT` (`JSON` and `DISTINCT` too) and answers `WITH`, `VALUES`, `TABLE`, `EXPLAIN` and
 * `OFFSET` with a syntax error; the agent path sends a `SELECT` of one table of the connection's keyspace or of
 * `system_schema` only, and a `WHERE token(<partition key>) > token(<last key read>)` answers the next partitions.
 * Measured on 2026-11-02: Couchbase Server 8.0.2 Enterprise, through the agent read-only path, runs a `SELECT` (a
 * `WITH` before it too) and pages it with `LIMIT n OFFSET m`, while the path's statement check refuses `EXPLAIN` and
 * every other statement before it is sent, and SQL++ has no bare `VALUES` or `TABLE` statement.
 * Measured on 2026-11-02: Db2 12.1.0.0, through the agent read-only path, which sends the statement inside a derived
 * table, runs a `SELECT`, a `WITH` and a bare `VALUES`, answers `TABLE` and `EXPLAIN` with SQL0104N, and pages with
 * `OFFSET m ROWS FETCH NEXT n ROWS ONLY` inside that table.
 */
export interface ReadQueryForms {
  /** The statements, as the refusal names them after "runs one read-only statement:". */
  readonly statements: string;
  /** The engine's own paging clause, as the answer names it after "Page it in SQL:". */
  readonly paging: string;
  /**
   * Whether the engine's SQL has an `OFFSET` for `prepareQuery` to page with. Where it has none, `run_read_query` names
   * no next offset and refuses one before anything is sent, and `paging` says how to page without it.
   */
  readonly pagesWithOffset: boolean;
  /**
   * The engine's own row limiting clause, on an engine whose SQL has no `LIMIT`: `own` names every clause that makes a
   * query its own limit, as "This query has its own ..." reads, and `add` is the clause that reads at most n rows.
   * Absent, the refusals name `LIMIT`.
   */
  readonly rowLimit?: { readonly own: string; readonly add: string };
}

const LIMIT_OFFSET = "LIMIT n OFFSET m";

/**
 * An exhaustive Record, so a new type-id cannot join without someone answering. `null` is an engine whose statements
 * `run_read_query` does not run: an engine that opens there adds its row in the same change, and
 * `tests/unit/mcp/read-query-limits.test.ts` holds every served engine to having one.
 */
export const READ_QUERY_FORMS: Readonly<Record<DatabaseType, ReadQueryForms | null>> = Object.freeze({
  postgres: {
    statements: "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
    pagesWithOffset: true,
  },
  bigquery: null,
  snowflake: null,
  spark: null,
  // MariaDB has no TABLE statement; MySQL's VALUES is VALUES ROW(...), MariaDB's a bare VALUES list.
  mysql: {
    statements: "a SELECT (a WITH is fine), VALUES, TABLE (MySQL, not MariaDB), or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
    pagesWithOffset: true,
  },
  // No TABLE statement, and EXPLAIN takes no ANALYZE.
  sqlite: { statements: "a SELECT (a WITH is fine), VALUES, or EXPLAIN", paging: LIMIT_OFFSET, pagesWithOffset: true },
  // SQLite's grammar over Hrana: no TABLE statement, and EXPLAIN takes no ANALYZE.
  libsql: { statements: "a SELECT (a WITH is fine), VALUES, or EXPLAIN", paging: LIMIT_OFFSET, pagesWithOffset: true },
  duckdb: {
    statements: "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
    pagesWithOffset: true,
  },
  // A bare VALUES and TABLE are ORA-00900, and EXPLAIN PLAN writes into PLAN_TABLE, refused in the read-only
  // transaction. LIMIT is ORA-03047; ROWNUM counts as a query's own limit, as the query analyzer reads it.
  oracle: {
    statements: "a SELECT (a WITH is fine)",
    paging: "ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY",
    pagesWithOffset: true,
    rowLimit: { own: "FETCH FIRST, OFFSET ... FETCH or ROWNUM", add: "FETCH FIRST n ROWS ONLY" },
  },
  // Only a fullselect fits the derived table the agent path sends: TABLE and EXPLAIN are SQL0104N there. FETCH FIRST,
  // OFFSET ... FETCH and LIMIT each make a query its own limit, as the query analyzer reads it.
  db2: {
    statements: "a SELECT (a WITH is fine), or VALUES",
    paging: "ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY",
    pagesWithOffset: true,
    rowLimit: { own: "FETCH FIRST, OFFSET ... FETCH or LIMIT", add: "FETCH FIRST n ROWS ONLY" },
  },
  // No bare VALUES, no TABLE statement and no EXPLAIN.
  mssql: {
    statements: "a SELECT (a WITH is fine)",
    paging: "ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY",
    pagesWithOffset: true,
  },
  // A bare VALUES and TABLE are syntax errors (code 62); EXPLAIN runs.
  clickhouse: {
    statements: "a SELECT (a WITH is fine), or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
    pagesWithOffset: true,
  },
  druid: null,
  trino: null,
  // CQL: no WITH, VALUES, TABLE or EXPLAIN, and no OFFSET (each a syntax error), so the next page is asked for by token
  // across partitions and by clustering key within one; the agent path reads the connection's keyspace and
  // system_schema only.
  cassandra: {
    statements: "a SELECT of one table of the connection's keyspace or of system_schema",
    paging:
      "LIMIT n, and for the next page add WHERE token(the partition key) > token(the last one read), or, within one partition, WHERE the clustering column > the last value read",
    pagesWithOffset: false,
  },
  // The agent path's statement check refuses a comment, a subquery, a WITH and a JOIN before they are sent; VALUES,
  // TABLE and EXPLAIN ANALYZE are grammar refusals; and there is no OFFSET (a parsing_exception), so the next page is
  // asked for by key.
  elasticsearch: {
    statements:
      "a SELECT that reads at most one index expression, with no comment, subquery, WITH or JOIN, or an EXPLAIN of such a SELECT",
    paging: "ORDER BY a unique field, and for the next page add WHERE that field > the last value read",
    pagesWithOffset: false,
  },
  // The agent path's statement check refuses a comment, a subquery, a WITH, a JOIN and a double quote before they are
  // sent, and the plugin refuses WITH, VALUES, TABLE and EXPLAIN; OFFSET pages (measured on 3.8.0).
  opensearch: {
    statements:
      "a SELECT that reads at most one index expression, with no comment, subquery, WITH, JOIN or double quote (quote a name in backticks)",
    paging: LIMIT_OFFSET,
    pagesWithOffset: true,
  },
  mongodb: null,
  // The agent path's statement check sends one SELECT (a WITH before it too) and refuses EXPLAIN before it is sent;
  // SQL++ has no bare VALUES or TABLE statement.
  couchbase: { statements: "a SELECT (a WITH is fine)", paging: LIMIT_OFFSET, pagesWithOffset: true },
  redis: null,
  prometheus: null,
  kafka: null,
  etcd: null,
  neo4j: null,
  milvus: null,
  qdrant: null,
  weaviate: null,
  influxdb: null,
  // DataFusion: TABLE is a parser error, and EXPLAIN ANALYZE runs the statement.
  influxdb3: {
    statements: "a SELECT (a WITH is fine), VALUES, or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
    pagesWithOffset: true,
  },
  oxia: null,
  databend: null,
  s3: null,
  kubernetes: null,
  mqtt: null,
  firestore: null,
  rabbitmq: null,
  opcua: null,
  mtconnect: null,
  modbus: null,
  netconf: null,
  snmp: null,
  sparkplug: null,
  libredb: null,
});

/** The row of an engine `run_read_query` serves; an engine without one is a server fault, refused by name. */
export function readQueryFormsOf(type: DatabaseType): ReadQueryForms {
  const forms = READ_QUERY_FORMS[type];
  if (forms === null) throw new Error(`run_read_query has no accepted-forms row for ${type}`);
  return forms;
}
