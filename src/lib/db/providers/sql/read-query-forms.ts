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
 * parser error, and runs `EXPLAIN ANALYZE`, which the fence refuses.
 */
export interface ReadQueryForms {
  /** The statements, as the refusal names them after "runs one read-only statement:". */
  readonly statements: string;
  /** The engine's own paging clause, as the answer names it after "Page it in SQL:". */
  readonly paging: string;
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
  },
  bigquery: null,
  snowflake: null,
  spark: null,
  // MariaDB has no TABLE statement; MySQL's VALUES is VALUES ROW(...), MariaDB's a bare VALUES list.
  mysql: {
    statements: "a SELECT (a WITH is fine), VALUES, TABLE (MySQL, not MariaDB), or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
  },
  // No TABLE statement, and EXPLAIN takes no ANALYZE.
  sqlite: { statements: "a SELECT (a WITH is fine), VALUES, or EXPLAIN", paging: LIMIT_OFFSET },
  // SQLite's grammar over Hrana: no TABLE statement, and EXPLAIN takes no ANALYZE.
  libsql: { statements: "a SELECT (a WITH is fine), VALUES, or EXPLAIN", paging: LIMIT_OFFSET },
  duckdb: {
    statements: "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE",
    paging: LIMIT_OFFSET,
  },
  oracle: null,
  db2: null,
  // No bare VALUES, no TABLE statement and no EXPLAIN.
  mssql: { statements: "a SELECT (a WITH is fine)", paging: "ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY" },
  // A bare VALUES and TABLE are syntax errors (code 62); EXPLAIN runs.
  clickhouse: { statements: "a SELECT (a WITH is fine), or EXPLAIN without ANALYZE", paging: LIMIT_OFFSET },
  druid: null,
  trino: null,
  cassandra: null,
  elasticsearch: null,
  opensearch: null,
  mongodb: null,
  couchbase: null,
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
  influxdb3: { statements: "a SELECT (a WITH is fine), VALUES, or EXPLAIN without ANALYZE", paging: LIMIT_OFFSET },
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
