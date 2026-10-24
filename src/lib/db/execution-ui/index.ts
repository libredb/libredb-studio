import { BIGQUERY_EXECUTION_UI } from "@/lib/db/providers/sql/bigquery/execution-ui";
import { CASSANDRA_EXECUTION_UI } from "@/lib/db/providers/sql/cassandra/execution-ui";
import { CLICKHOUSE_EXECUTION_UI } from "@/lib/db/providers/sql/clickhouse/execution-ui";
import { COUCHBASE_EXECUTION_UI } from "@/lib/db/providers/document/couchbase/execution-ui";
import { DATABEND_EXECUTION_UI } from "@/lib/db/providers/sql/databend/execution-ui";
import { DB2_EXECUTION_UI } from "@/lib/db/providers/sql/db2/execution-ui";
import { DRUID_EXECUTION_UI } from "@/lib/db/providers/sql/druid/execution-ui";
import { DUCKDB_EXECUTION_UI } from "@/lib/db/providers/sql/duckdb/execution-ui";
import { ELASTICSEARCH_EXECUTION_UI } from "@/lib/db/providers/sql/search/elasticsearch-execution-ui";
import { ETCD_EXECUTION_UI } from "@/lib/db/providers/keyvalue/etcd/execution-ui";
import { FIRESTORE_EXECUTION_UI } from "@/lib/db/providers/document/firestore/execution-ui";
import { INFLUXDB_EXECUTION_UI } from "@/lib/db/providers/timeseries/influxdb/influxdb-execution-ui";
import { INFLUXDB3_EXECUTION_UI } from "@/lib/db/providers/timeseries/influxdb/influxdb3-execution-ui";
import { KAFKA_EXECUTION_UI } from "@/lib/db/providers/stream/kafka/execution-ui";
import { KUBERNETES_EXECUTION_UI } from "@/lib/db/providers/platform/kubernetes/execution-ui";
import { LIBREDB_EXECUTION_UI } from "@/lib/db/providers/embedded/libredb-execution-ui";
import { LIBSQL_EXECUTION_UI } from "@/lib/db/providers/sql/libsql/execution-ui";
import { MILVUS_EXECUTION_UI } from "@/lib/db/providers/vector/milvus/execution-ui";
import { MODBUS_EXECUTION_UI } from "@/lib/db/providers/industrial/modbus/execution-ui";
import { MONGODB_EXECUTION_UI } from "@/lib/db/providers/document/mongodb/execution-ui";
import { MQTT_EXECUTION_UI } from "@/lib/db/providers/keyvalue/mqtt/execution-ui";
import { MSSQL_EXECUTION_UI } from "@/lib/db/providers/sql/mssql-execution-ui";
import { MTCONNECT_EXECUTION_UI } from "@/lib/db/providers/industrial/mtconnect/execution-ui";
import { MYSQL_EXECUTION_UI } from "@/lib/db/providers/sql/mysql-execution-ui";
import { NEO4J_EXECUTION_UI } from "@/lib/db/providers/graph/neo4j/execution-ui";
import { NETCONF_EXECUTION_UI } from "@/lib/db/providers/network/netconf/execution-ui";
import { OPCUA_EXECUTION_UI } from "@/lib/db/providers/industrial/opcua/execution-ui";
import { OPENSEARCH_EXECUTION_UI } from "@/lib/db/providers/sql/search/opensearch-execution-ui";
import { ORACLE_EXECUTION_UI } from "@/lib/db/providers/sql/oracle-execution-ui";
import { OXIA_EXECUTION_UI } from "@/lib/db/providers/keyvalue/oxia/execution-ui";
import { POSTGRES_EXECUTION_UI } from "@/lib/db/providers/sql/postgres-execution-ui";
import { PROMETHEUS_EXECUTION_UI } from "@/lib/db/providers/timeseries/prometheus/execution-ui";
import { QDRANT_EXECUTION_UI } from "@/lib/db/providers/vector/qdrant/execution-ui";
import { WEAVIATE_EXECUTION_UI } from "@/lib/db/providers/vector/weaviate/execution-ui";
import { RABBITMQ_EXECUTION_UI } from "@/lib/db/providers/stream/rabbitmq/execution-ui";
import { REDIS_EXECUTION_UI } from "@/lib/db/providers/keyvalue/redis-execution-ui";
import { S3_EXECUTION_UI } from "@/lib/db/providers/objectstore/s3/execution-ui";
import { SNMP_EXECUTION_UI } from "@/lib/db/providers/network/snmp/execution-ui";
import { SNOWFLAKE_EXECUTION_UI } from "@/lib/db/providers/sql/snowflake/execution-ui";
import { SPARK_EXECUTION_UI } from "@/lib/db/providers/sql/spark/execution-ui";
import { SPARKPLUG_EXECUTION_UI } from "@/lib/db/providers/industrial/sparkplug/execution-ui";
import { SQLITE_EXECUTION_UI } from "@/lib/db/providers/sql/sqlite-execution-ui";
import { TRINO_EXECUTION_UI } from "@/lib/db/providers/sql/trino/execution-ui";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_EXECUTION_UI } from "./no-connection";
import type { ExecutionUiSpec } from "./types";
import { UNKNOWN_TYPE_EXECUTION_UI } from "./unknown-type";

/**
 * Each engine's execution UI facts, one row per type id, each declared beside its provider. A missing id is a
 * compile error here, so a new engine cannot ship without naming its commit keyword and its consent deadline.
 */
export const EXECUTION_UI: Readonly<Record<DatabaseType, ExecutionUiSpec>> = Object.freeze({
  bigquery: BIGQUERY_EXECUTION_UI,
  cassandra: CASSANDRA_EXECUTION_UI,
  clickhouse: CLICKHOUSE_EXECUTION_UI,
  couchbase: COUCHBASE_EXECUTION_UI,
  databend: DATABEND_EXECUTION_UI,
  db2: DB2_EXECUTION_UI,
  druid: DRUID_EXECUTION_UI,
  duckdb: DUCKDB_EXECUTION_UI,
  elasticsearch: ELASTICSEARCH_EXECUTION_UI,
  etcd: ETCD_EXECUTION_UI,
  firestore: FIRESTORE_EXECUTION_UI,
  influxdb: INFLUXDB_EXECUTION_UI,
  influxdb3: INFLUXDB3_EXECUTION_UI,
  kafka: KAFKA_EXECUTION_UI,
  kubernetes: KUBERNETES_EXECUTION_UI,
  libredb: LIBREDB_EXECUTION_UI,
  libsql: LIBSQL_EXECUTION_UI,
  milvus: MILVUS_EXECUTION_UI,
  modbus: MODBUS_EXECUTION_UI,
  mongodb: MONGODB_EXECUTION_UI,
  mqtt: MQTT_EXECUTION_UI,
  mssql: MSSQL_EXECUTION_UI,
  mtconnect: MTCONNECT_EXECUTION_UI,
  mysql: MYSQL_EXECUTION_UI,
  neo4j: NEO4J_EXECUTION_UI,
  netconf: NETCONF_EXECUTION_UI,
  opcua: OPCUA_EXECUTION_UI,
  opensearch: OPENSEARCH_EXECUTION_UI,
  oracle: ORACLE_EXECUTION_UI,
  oxia: OXIA_EXECUTION_UI,
  postgres: POSTGRES_EXECUTION_UI,
  prometheus: PROMETHEUS_EXECUTION_UI,
  qdrant: QDRANT_EXECUTION_UI,
  rabbitmq: RABBITMQ_EXECUTION_UI,
  redis: REDIS_EXECUTION_UI,
  s3: S3_EXECUTION_UI,
  snmp: SNMP_EXECUTION_UI,
  snowflake: SNOWFLAKE_EXECUTION_UI,
  spark: SPARK_EXECUTION_UI,
  sparkplug: SPARKPLUG_EXECUTION_UI,
  sqlite: SQLITE_EXECUTION_UI,
  trino: TRINO_EXECUTION_UI,
  weaviate: WEAVIATE_EXECUTION_UI,
});

/**
 * The spec for a connection's type: `NO_CONNECTION_EXECUTION_UI` without one, the engine's row for a shipped id,
 * otherwise `UNKNOWN_TYPE_EXECUTION_UI`. `Object.hasOwn`, so `"constructor"` or `"__proto__"` never reaches an
 * Object.prototype member.
 */
export function executionUiFor(type: string | undefined): ExecutionUiSpec {
  if (type === undefined) return NO_CONNECTION_EXECUTION_UI;
  return Object.hasOwn(EXECUTION_UI, type) ? EXECUTION_UI[type as DatabaseType] : UNKNOWN_TYPE_EXECUTION_UI;
}
