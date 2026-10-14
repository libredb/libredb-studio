/**
 * What agent mode knows about each engine's STATEMENT LANGUAGE, and what each workflow is on each language, as data a
 * browser bundle may hold.
 *
 * Client-safe on purpose, like `engine-support.ts`: it imports types and nothing else, because the rail, the safety
 * strip and the posture read it, and a provider module or `node:crypto` here would reach a browser bundle. What a
 * language DOES (its fingerprint, its advice, its admission) is server code and lives in `statement-languages.ts`.
 *
 * `AGENT_STATEMENT_LANGUAGE` is the list of engines agent mode reads statements on, keyed by type-id so no dialect
 * comparison is written anywhere. `tests/unit/lib/agent/agent-manifest.test.ts` holds it to every provider: an engine
 * has a language exactly when its provider has `queryReadOnly`.
 */
import type { DatabaseType } from "@/lib/types";

/** The statement languages agent mode can send. A later engine reuses one or registers a new id here. */
export type AgentStatementLanguageId = "sql" | "kubectl";

export const AGENT_STATEMENT_LANGUAGE: Readonly<Record<DatabaseType, AgentStatementLanguageId | null>> = Object.freeze({
  postgres: "sql",
  bigquery: null,
  snowflake: null,
  mysql: "sql",
  sqlite: "sql",
  libsql: null,
  duckdb: "sql",
  oracle: null,
  db2: null,
  mssql: "sql",
  clickhouse: null,
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
  influxdb: null,
  influxdb3: null,
  oxia: null,
  databend: null,
  s3: null,
  // The provider has no queryReadOnly until its machine context and redaction land; flipped with it.
  kubernetes: null,
  mqtt: null,
  firestore: null,
  rabbitmq: null,
  opcua: null,
  libredb: null,
} satisfies Record<DatabaseType, AgentStatementLanguageId | null>);

/**
 * The words a language contributes to the sentences a run reads. The SQL entry is the wording the agent rules have
 * always used, and the D6 golden file holds it there.
 */
export interface AgentLanguageCopy {
  /** What one unit the model sends is called. */
  readonly noun: string;
  /** The name of the model argument that carries it. Persisted event fields keep `sql` whatever this says. */
  readonly argument: "sql" | "statement";
  /** What the boundary refuses, as the rules name it. */
  readonly writes: string;
  /** What a refused statement never reaches. */
  readonly reached: string;
  /** What a policy refusal is not a defect in. */
  readonly defect: string;
  /** The commands that have row-cap advice of their own; the server registry answers each one. */
  readonly adviceKeys: readonly string[];
}

export const AGENT_LANGUAGE_COPY: Readonly<Record<AgentStatementLanguageId, AgentLanguageCopy>> = Object.freeze({
  sql: Object.freeze({
    noun: "statement",
    argument: "sql",
    writes: "writes and DDL",
    reached: "the database",
    defect: "your SQL",
    adviceKeys: Object.freeze([]),
  }),
  kubectl: Object.freeze({
    noun: "statement",
    argument: "statement",
    writes: "writes, exec, port-forward, proxy and watches",
    reached: "the cluster",
    defect: "your kubectl statement",
    adviceKeys: Object.freeze(["get", "top", "logs", "events"]),
  }),
} satisfies Record<AgentStatementLanguageId, AgentLanguageCopy>);

/**
 * What a workflow variant needs of an engine beyond its language, evaluated over the engine TYPE so a client can
 * answer it with no provider in hand.
 */
export type AgentVariantRequirement = "sql-composers" | "cluster-usage-reading" | "cluster-workload-reading";

/**
 * The engines each requirement holds on. Mirrored rather than computed, for the reason `posture.ts` mirrors
 * `CATALOG_PLANS`: the registries it mirrors reach server code. `agent-manifest.test.ts` holds `sql-composers` to the
 * composer registries in `composed-sql.ts` and each cluster reading to the providers declaring `agentReadings`.
 */
export const AGENT_REQUIREMENT_ENGINES: Readonly<Record<AgentVariantRequirement, readonly DatabaseType[]>> =
  Object.freeze({
    "sql-composers": Object.freeze<DatabaseType[]>(["postgres", "sqlite", "duckdb", "mssql", "mysql"]),
    "cluster-usage-reading": Object.freeze<DatabaseType[]>([]),
    "cluster-workload-reading": Object.freeze<DatabaseType[]>([]),
  } satisfies Record<AgentVariantRequirement, readonly DatabaseType[]>);
