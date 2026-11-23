/**
 * Each engine's connect budget: how long the host waits for an open of the engine, and for its Test connection, from
 * the open's start (docs/providers/CONTRACT.md, clause M-51). Each engine declaration states its row as
 * `connection.connectBudgetMs` (scripts/generate-engine-declarations.ts), and the census reads each declaration back
 * to this table (tests/unit/db/engine-declarations.test.ts).
 *
 * A budget is the engine's own connect bound at Studio's default statement timeout, plus 10 s for the provider's own
 * answer to arrive after it, so a provider that bounds its connect answers in its own words before the host does. An
 * engine whose own bound fits in the host's default, `DEFAULT_CONNECT_BUDGET_MS` (70 s, the pools' 60 s acquire bound
 * plus 10 s), states null. Two do not fit:
 * - `bigquery`, 140 s: its connect lists the datasets and then runs a probe job, each cut at the statement timeout plus
 *   the provider's 5 s client grace, so 2 x (60 s + 5 s) + 10 s;
 * - `snowflake`, 80 s: its connect sends two Studio statements, the connect statement and the role check, each cut at
 *   Snowflake's 30 s surface timeout plus its 5 s grace, so 2 x (30 s + 5 s) + 10 s.
 * A test beside each provider holds its row to that provider's own constants (tests/unit/db/bigquery/connect-budget.test.ts
 * and tests/unit/db/snowflake/connect-budget.test.ts).
 *
 * The table is central, as `CONNECTION_FIELDS` is, rather than a row beside each provider: a registry index collecting
 * a row from each provider directory is an import from core into those directories, which docs/PROVIDER_IMPORTS.md
 * refuses. Pure and UI-free: it imports types, the SDK's constant and the type-id reader only.
 */
import { DEFAULT_CONNECT_BUDGET_MS } from "@libredb/provider-sdk/calls";
import type { ConnectBudget } from "@libredb/provider-sdk/manifest";
import { waitedSeconds } from "@/lib/db/errors";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";

/** Each engine's connect budget in milliseconds, or null for the host's default, `DEFAULT_CONNECT_BUDGET_MS`. */
export const CONNECT_BUDGET: Readonly<Record<DatabaseType, ConnectBudget>> = Object.freeze({
  bigquery: 140_000,
  cassandra: null,
  clickhouse: null,
  couchbase: null,
  databend: null,
  db2: null,
  druid: null,
  duckdb: null,
  elasticsearch: null,
  etcd: null,
  firestore: null,
  influxdb: null,
  influxdb3: null,
  kafka: null,
  kubernetes: null,
  libredb: null,
  libsql: null,
  milvus: null,
  modbus: null,
  mongodb: null,
  mqtt: null,
  mssql: null,
  mtconnect: null,
  mysql: null,
  neo4j: null,
  netconf: null,
  opcua: null,
  opensearch: null,
  oracle: null,
  oxia: null,
  postgres: null,
  prometheus: null,
  qdrant: null,
  rabbitmq: null,
  redis: null,
  s3: null,
  snmp: null,
  snowflake: 80_000,
  spark: null,
  sparkplug: null,
  sqlite: null,
  trino: null,
  weaviate: null,
});

/**
 * How long the host waits for an open of `type` and for its Test connection, in milliseconds: its row, or the host's
 * default where the row is null.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function connectBudgetFor(type: DatabaseType): number {
  return typeIdRow(CONNECT_BUDGET, type) ?? DEFAULT_CONNECT_BUDGET_MS;
}

/** Studio's sentence for an open its connect budget of `budgetMs` ended: nothing was sent. */
export function openDeadlineSentence(budgetMs: number): string {
  return `The connection did not open within ${waitedSeconds(budgetMs)}, so Studio stopped waiting for it and sent nothing.`;
}
