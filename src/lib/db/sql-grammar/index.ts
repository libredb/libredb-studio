import { BIGQUERY_SQL_GRAMMAR } from "@/lib/db/providers/sql/bigquery/sql-grammar";
import { CASSANDRA_SQL_GRAMMAR } from "@/lib/db/providers/sql/cassandra/sql-grammar";
import { CLICKHOUSE_SQL_GRAMMAR } from "@/lib/db/providers/sql/clickhouse/sql-grammar";
import { COUCHBASE_SQL_GRAMMAR } from "@/lib/db/providers/document/couchbase/sql-grammar";
import { DATABEND_SQL_GRAMMAR } from "@/lib/db/providers/sql/databend/sql-grammar";
import { DB2_SQL_GRAMMAR } from "@/lib/db/providers/sql/db2/sql-grammar";
import { DRUID_SQL_GRAMMAR } from "@/lib/db/providers/sql/druid/sql-grammar";
import { DUCKDB_SQL_GRAMMAR } from "@/lib/db/providers/sql/duckdb/sql-grammar";
import { ELASTICSEARCH_SQL_GRAMMAR } from "@/lib/db/providers/sql/search/elasticsearch-sql-grammar";
import { ETCD_SQL_GRAMMAR } from "@/lib/db/providers/keyvalue/etcd/sql-grammar";
import { FIRESTORE_SQL_GRAMMAR } from "@/lib/db/providers/document/firestore/sql-grammar";
import { INFLUXDB3_SQL_GRAMMAR } from "@/lib/db/providers/timeseries/influxdb/influxdb3-sql-grammar";
import { INFLUXDB_SQL_GRAMMAR } from "@/lib/db/providers/timeseries/influxdb/influxdb-sql-grammar";
import { KAFKA_SQL_GRAMMAR } from "@/lib/db/providers/stream/kafka/sql-grammar";
import { KUBERNETES_SQL_GRAMMAR } from "@/lib/db/providers/platform/kubernetes/sql-grammar";
import { LIBREDB_SQL_GRAMMAR } from "@/lib/db/providers/embedded/libredb-sql-grammar";
import { LIBSQL_SQL_GRAMMAR } from "@/lib/db/providers/sql/libsql/sql-grammar";
import { MILVUS_SQL_GRAMMAR } from "@/lib/db/providers/vector/milvus/sql-grammar";
import { MODBUS_SQL_GRAMMAR } from "@/lib/db/providers/industrial/modbus/sql-grammar";
import { MONGODB_SQL_GRAMMAR } from "@/lib/db/providers/document/mongodb/sql-grammar";
import { MQTT_SQL_GRAMMAR } from "@/lib/db/providers/keyvalue/mqtt/sql-grammar";
import { MSSQL_SQL_GRAMMAR } from "@/lib/db/providers/sql/mssql-sql-grammar";
import { MTCONNECT_SQL_GRAMMAR } from "@/lib/db/providers/industrial/mtconnect/sql-grammar";
import { MYSQL_SQL_GRAMMAR } from "@/lib/db/providers/sql/mysql-sql-grammar";
import { NEO4J_SQL_GRAMMAR } from "@/lib/db/providers/graph/neo4j/sql-grammar";
import { NETCONF_SQL_GRAMMAR } from "@/lib/db/providers/network/netconf/sql-grammar";
import { OPCUA_SQL_GRAMMAR } from "@/lib/db/providers/industrial/opcua/sql-grammar";
import { OPENSEARCH_SQL_GRAMMAR } from "@/lib/db/providers/sql/search/opensearch-sql-grammar";
import { ORACLE_SQL_GRAMMAR } from "@/lib/db/providers/sql/oracle-sql-grammar";
import { OXIA_SQL_GRAMMAR } from "@/lib/db/providers/keyvalue/oxia/sql-grammar";
import { POSTGRES_SQL_GRAMMAR } from "@/lib/db/providers/sql/postgres-sql-grammar";
import { PROMETHEUS_SQL_GRAMMAR } from "@/lib/db/providers/timeseries/prometheus/sql-grammar";
import { QDRANT_SQL_GRAMMAR } from "@/lib/db/providers/vector/qdrant/sql-grammar";
import { WEAVIATE_SQL_GRAMMAR } from "@/lib/db/providers/vector/weaviate/sql-grammar";
import { RABBITMQ_SQL_GRAMMAR } from "@/lib/db/providers/stream/rabbitmq/sql-grammar";
import { REDIS_SQL_GRAMMAR } from "@/lib/db/providers/keyvalue/redis-sql-grammar";
import { S3_SQL_GRAMMAR } from "@/lib/db/providers/objectstore/s3/sql-grammar";
import { SNMP_SQL_GRAMMAR } from "@/lib/db/providers/network/snmp/sql-grammar";
import { SNOWFLAKE_SQL_GRAMMAR } from "@/lib/db/providers/sql/snowflake/sql-grammar";
import { SPARKPLUG_SQL_GRAMMAR } from "@/lib/db/providers/industrial/sparkplug/sql-grammar";
import { SPARK_SQL_GRAMMAR } from "@/lib/db/providers/sql/spark/sql-grammar";
import { SQLITE_SQL_GRAMMAR } from "@/lib/db/providers/sql/sqlite-sql-grammar";
import { TRINO_SQL_GRAMMAR } from "@/lib/db/providers/sql/trino/sql-grammar";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_SQL_GRAMMAR } from "./no-connection";
import type { SqlGrammarSpec } from "./types";
import { UNKNOWN_TYPE_SQL_GRAMMAR } from "./unknown-type";

/**
 * Every engine's SQL grammar facts, one row per type id, each declared in a module beside its provider (spec 5.3).
 * Being total over `DatabaseType` is what makes a new type id without a module a compile error here.
 */
export const SQL_GRAMMAR: Readonly<Record<DatabaseType, SqlGrammarSpec>> = Object.freeze({
  bigquery: BIGQUERY_SQL_GRAMMAR,
  cassandra: CASSANDRA_SQL_GRAMMAR,
  clickhouse: CLICKHOUSE_SQL_GRAMMAR,
  couchbase: COUCHBASE_SQL_GRAMMAR,
  databend: DATABEND_SQL_GRAMMAR,
  db2: DB2_SQL_GRAMMAR,
  druid: DRUID_SQL_GRAMMAR,
  duckdb: DUCKDB_SQL_GRAMMAR,
  elasticsearch: ELASTICSEARCH_SQL_GRAMMAR,
  etcd: ETCD_SQL_GRAMMAR,
  firestore: FIRESTORE_SQL_GRAMMAR,
  influxdb: INFLUXDB_SQL_GRAMMAR,
  influxdb3: INFLUXDB3_SQL_GRAMMAR,
  kafka: KAFKA_SQL_GRAMMAR,
  kubernetes: KUBERNETES_SQL_GRAMMAR,
  libredb: LIBREDB_SQL_GRAMMAR,
  libsql: LIBSQL_SQL_GRAMMAR,
  milvus: MILVUS_SQL_GRAMMAR,
  modbus: MODBUS_SQL_GRAMMAR,
  mongodb: MONGODB_SQL_GRAMMAR,
  mqtt: MQTT_SQL_GRAMMAR,
  mssql: MSSQL_SQL_GRAMMAR,
  mtconnect: MTCONNECT_SQL_GRAMMAR,
  mysql: MYSQL_SQL_GRAMMAR,
  neo4j: NEO4J_SQL_GRAMMAR,
  netconf: NETCONF_SQL_GRAMMAR,
  opcua: OPCUA_SQL_GRAMMAR,
  opensearch: OPENSEARCH_SQL_GRAMMAR,
  oracle: ORACLE_SQL_GRAMMAR,
  oxia: OXIA_SQL_GRAMMAR,
  postgres: POSTGRES_SQL_GRAMMAR,
  prometheus: PROMETHEUS_SQL_GRAMMAR,
  qdrant: QDRANT_SQL_GRAMMAR,
  rabbitmq: RABBITMQ_SQL_GRAMMAR,
  redis: REDIS_SQL_GRAMMAR,
  s3: S3_SQL_GRAMMAR,
  snmp: SNMP_SQL_GRAMMAR,
  snowflake: SNOWFLAKE_SQL_GRAMMAR,
  spark: SPARK_SQL_GRAMMAR,
  sparkplug: SPARKPLUG_SQL_GRAMMAR,
  sqlite: SQLITE_SQL_GRAMMAR,
  trino: TRINO_SQL_GRAMMAR,
  weaviate: WEAVIATE_SQL_GRAMMAR,
});

/**
 * The grammar facts of a type: its row for a member of `DatabaseType`, `NO_CONNECTION_SQL_GRAMMAR` for `undefined`,
 * and `UNKNOWN_TYPE_SQL_GRAMMAR` for any other string.
 *
 * `Object.hasOwn` rather than a bare lookup: the packaged confirmation dialog resolves its own grammar from an
 * optional prop a HOST application supplies as a plain string, and a prototype key (`"constructor"`, `"toString"`)
 * would otherwise return something that is not a spec at all.
 */
export function sqlGrammarFor(type: string | undefined): SqlGrammarSpec {
  if (type === undefined) return NO_CONNECTION_SQL_GRAMMAR;
  return Object.hasOwn(SQL_GRAMMAR, type) ? SQL_GRAMMAR[type as DatabaseType] : UNKNOWN_TYPE_SQL_GRAMMAR;
}

/**
 * `sqlGrammarFor` for the facts that were identity comparisons against a type id before they moved here
 * (`readsSqlText`, the update-target rules and completion quoting): a type that is not a primitive string, such as
 * `new String("mysql")` from a host calling in plain JavaScript, is the unknown-type spec rather than the row its
 * string conversion names. The span grammar and redaction were property-key lookups, which convert, and keep
 * `sqlGrammarFor`.
 */
export function sqlGrammarForExactType(type: string | undefined): SqlGrammarSpec {
  return type === undefined || typeof type === "string" ? sqlGrammarFor(type) : UNKNOWN_TYPE_SQL_GRAMMAR;
}
