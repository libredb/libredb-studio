/**
 * Studio's record of the `sqlText.redaction` claim (docs/providers/CONTRACT.md, clauses M-53, M-54 and M-78): per
 * engine, how a statement is redacted before the query event log keeps it. An engine declaration requests its
 * redaction at `sqlText.redaction`, and each shipped engine's request is its row here, written into its declaration by
 * scripts/generate-engine-declarations.ts. No reader of Studio's reads this record: the query event log reads the
 * engine record's grant, from the engine's register row, which equals this row for every legacy engine
 * (tests/unit/db/grant-register-legacy-rows.test.ts).
 *
 * Written by hand as one frozen literal, a row per engine in id order, so no projection of the declarations can feed it
 * (tests/unit/db/engine-declaration-readers.test.ts). A command redaction's reader is held by the name the declaration
 * gives it, so this record holds no imported binding. Its restrictive value is `none`, under which the query event log
 * keeps nothing of a statement's text (M-53).
 *
 * A leaf with type imports only.
 */
import type { StatementRedaction } from "@libredb/provider-sdk/manifest";
import type { DatabaseType } from "@/lib/types";

/** Each engine's redaction, the row of Studio's record of its `sqlText.redaction` claim. */
export const SQL_TEXT_REDACTION: Readonly<Record<DatabaseType, StatementRedaction>> = Object.freeze({
  bigquery: Object.freeze({ kind: "sql", nameQuote: null }),
  cassandra: Object.freeze({ kind: "sql", nameQuote: null }),
  clickhouse: Object.freeze({ kind: "sql", nameQuote: null }),
  couchbase: Object.freeze({ kind: "none" }),
  databend: Object.freeze({ kind: "sql", nameQuote: null }),
  db2: Object.freeze({ kind: "sql", nameQuote: null }),
  druid: Object.freeze({ kind: "none" }),
  duckdb: Object.freeze({ kind: "sql", nameQuote: null }),
  elasticsearch: Object.freeze({ kind: "sql", nameQuote: null }),
  etcd: Object.freeze({ kind: "none" }),
  firestore: Object.freeze({ kind: "none" }),
  influxdb: Object.freeze({ kind: "none" }),
  influxdb3: Object.freeze({ kind: "sql", nameQuote: null }),
  kafka: Object.freeze({ kind: "none" }),
  kubernetes: Object.freeze({ kind: "none" }),
  libredb: Object.freeze({ kind: "none" }),
  libsql: Object.freeze({ kind: "sql", nameQuote: null }),
  milvus: Object.freeze({ kind: "none" }),
  modbus: Object.freeze({ kind: "none" }),
  // The JSON document the provider parses: its keys and the names it runs on are kept.
  mongodb: Object.freeze({ kind: "command", reader: "redactionReader" }),
  mqtt: Object.freeze({ kind: "none" }),
  // `[` is a name under every session setting. A double quote is a string while `QUOTED_IDENTIFIER` is off, so it is
  // masked like any literal.
  mssql: Object.freeze({ kind: "sql", nameQuote: "[" }),
  mtconnect: Object.freeze({ kind: "none" }),
  // A backtick is a name under every session setting. A double quote is a string unless `ANSI_QUOTES` is set, so it is
  // masked like any literal.
  mysql: Object.freeze({ kind: "sql", nameQuote: "`" }),
  neo4j: Object.freeze({ kind: "none" }),
  netconf: Object.freeze({ kind: "none" }),
  opcua: Object.freeze({ kind: "none" }),
  opensearch: Object.freeze({ kind: "sql", nameQuote: null }),
  // A double quote is a name under every session setting, the one quoted run a redacted statement keeps.
  oracle: Object.freeze({ kind: "sql", nameQuote: '"' }),
  oxia: Object.freeze({ kind: "none" }),
  // A double quote is a name under every session setting, the one quoted run a redacted statement keeps.
  postgres: Object.freeze({ kind: "sql", nameQuote: '"' }),
  prometheus: Object.freeze({ kind: "none" }),
  qdrant: Object.freeze({ kind: "none" }),
  rabbitmq: Object.freeze({ kind: "none" }),
  // The one command `readRedisCommandText()` reads for the provider: its name is kept.
  redis: Object.freeze({ kind: "command", reader: "redactionReader" }),
  s3: Object.freeze({ kind: "none" }),
  snmp: Object.freeze({ kind: "none" }),
  snowflake: Object.freeze({ kind: "sql", nameQuote: null }),
  spark: Object.freeze({ kind: "sql", nameQuote: null }),
  sparkplug: Object.freeze({ kind: "none" }),
  sqlite: Object.freeze({ kind: "sql", nameQuote: null }),
  trino: Object.freeze({ kind: "sql", nameQuote: null }),
  weaviate: Object.freeze({ kind: "none" }),
});
