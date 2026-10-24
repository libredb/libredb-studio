import type { DatabaseType } from "@/lib/types";
import { COUCHBASE_SQL_WRITING } from "@/lib/db/providers/document/couchbase/sql-writing";
import { FIRESTORE_SQL_WRITING } from "@/lib/db/providers/document/firestore/sql-writing";
import { MONGODB_SQL_WRITING } from "@/lib/db/providers/document/mongodb/sql-writing";
import { LIBREDB_SQL_WRITING } from "@/lib/db/providers/embedded/libredb-sql-writing";
import { NEO4J_SQL_WRITING } from "@/lib/db/providers/graph/neo4j/sql-writing";
import { MODBUS_SQL_WRITING } from "@/lib/db/providers/industrial/modbus/sql-writing";
import { MTCONNECT_SQL_WRITING } from "@/lib/db/providers/industrial/mtconnect/sql-writing";
import { OPCUA_SQL_WRITING } from "@/lib/db/providers/industrial/opcua/sql-writing";
import { SPARKPLUG_SQL_WRITING } from "@/lib/db/providers/industrial/sparkplug/sql-writing";
import { ETCD_SQL_WRITING } from "@/lib/db/providers/keyvalue/etcd/sql-writing";
import { MQTT_SQL_WRITING } from "@/lib/db/providers/keyvalue/mqtt/sql-writing";
import { OXIA_SQL_WRITING } from "@/lib/db/providers/keyvalue/oxia/sql-writing";
import { REDIS_SQL_WRITING } from "@/lib/db/providers/keyvalue/redis-sql-writing";
import { NETCONF_SQL_WRITING } from "@/lib/db/providers/network/netconf/sql-writing";
import { SNMP_SQL_WRITING } from "@/lib/db/providers/network/snmp/sql-writing";
import { S3_SQL_WRITING } from "@/lib/db/providers/objectstore/s3/sql-writing";
import { KUBERNETES_SQL_WRITING } from "@/lib/db/providers/platform/kubernetes/sql-writing";
import { BIGQUERY_SQL_WRITING } from "@/lib/db/providers/sql/bigquery/sql-writing";
import { CASSANDRA_SQL_WRITING } from "@/lib/db/providers/sql/cassandra/sql-writing";
import { CLICKHOUSE_SQL_WRITING } from "@/lib/db/providers/sql/clickhouse/sql-writing";
import { DATABEND_SQL_WRITING } from "@/lib/db/providers/sql/databend/sql-writing";
import { DB2_SQL_WRITING } from "@/lib/db/providers/sql/db2/sql-writing";
import { DRUID_SQL_WRITING } from "@/lib/db/providers/sql/druid/sql-writing";
import { DUCKDB_SQL_WRITING } from "@/lib/db/providers/sql/duckdb/sql-writing";
import { LIBSQL_SQL_WRITING } from "@/lib/db/providers/sql/libsql/sql-writing";
import { MSSQL_SQL_WRITING } from "@/lib/db/providers/sql/mssql-sql-writing";
import { MYSQL_SQL_WRITING } from "@/lib/db/providers/sql/mysql-sql-writing";
import { ORACLE_SQL_WRITING } from "@/lib/db/providers/sql/oracle-sql-writing";
import { POSTGRES_SQL_WRITING } from "@/lib/db/providers/sql/postgres-sql-writing";
import { ELASTICSEARCH_SQL_WRITING } from "@/lib/db/providers/sql/search/elasticsearch-sql-writing";
import { OPENSEARCH_SQL_WRITING } from "@/lib/db/providers/sql/search/opensearch-sql-writing";
import { SNOWFLAKE_SQL_WRITING } from "@/lib/db/providers/sql/snowflake/sql-writing";
import { SPARK_SQL_WRITING } from "@/lib/db/providers/sql/spark/sql-writing";
import { SQLITE_SQL_WRITING } from "@/lib/db/providers/sql/sqlite-sql-writing";
import { TRINO_SQL_WRITING } from "@/lib/db/providers/sql/trino/sql-writing";
import { KAFKA_SQL_WRITING } from "@/lib/db/providers/stream/kafka/sql-writing";
import { RABBITMQ_SQL_WRITING } from "@/lib/db/providers/stream/rabbitmq/sql-writing";
import { INFLUXDB_SQL_WRITING } from "@/lib/db/providers/timeseries/influxdb/influxdb-sql-writing";
import { INFLUXDB3_SQL_WRITING } from "@/lib/db/providers/timeseries/influxdb/influxdb3-sql-writing";
import { PROMETHEUS_SQL_WRITING } from "@/lib/db/providers/timeseries/prometheus/sql-writing";
import { MILVUS_SQL_WRITING } from "@/lib/db/providers/vector/milvus/sql-writing";
import { QDRANT_SQL_WRITING } from "@/lib/db/providers/vector/qdrant/sql-writing";
import { WEAVIATE_SQL_WRITING } from "@/lib/db/providers/vector/weaviate/sql-writing";
import { NO_CONNECTION_SQL_WRITING } from "./no-connection";
import type { SqlWritingSpec } from "./types";
import { UNKNOWN_TYPE_SQL_WRITING } from "./unknown-type";

/**
 * Each engine's SQL writing rules, one row per type id, each declared in the module beside
 * its provider.
 *
 * The record is total on purpose: a new provider cannot be added without TypeScript
 * demanding an answer here, because the silent wrong answer is exactly the defect the
 * literal rules exist to close (issue #290).
 */
export const SQL_WRITING: Readonly<Record<DatabaseType, SqlWritingSpec>> = Object.freeze({
  bigquery: BIGQUERY_SQL_WRITING,
  cassandra: CASSANDRA_SQL_WRITING,
  clickhouse: CLICKHOUSE_SQL_WRITING,
  couchbase: COUCHBASE_SQL_WRITING,
  databend: DATABEND_SQL_WRITING,
  db2: DB2_SQL_WRITING,
  druid: DRUID_SQL_WRITING,
  duckdb: DUCKDB_SQL_WRITING,
  elasticsearch: ELASTICSEARCH_SQL_WRITING,
  etcd: ETCD_SQL_WRITING,
  firestore: FIRESTORE_SQL_WRITING,
  influxdb: INFLUXDB_SQL_WRITING,
  influxdb3: INFLUXDB3_SQL_WRITING,
  kafka: KAFKA_SQL_WRITING,
  kubernetes: KUBERNETES_SQL_WRITING,
  libredb: LIBREDB_SQL_WRITING,
  libsql: LIBSQL_SQL_WRITING,
  milvus: MILVUS_SQL_WRITING,
  modbus: MODBUS_SQL_WRITING,
  mongodb: MONGODB_SQL_WRITING,
  mqtt: MQTT_SQL_WRITING,
  mssql: MSSQL_SQL_WRITING,
  mtconnect: MTCONNECT_SQL_WRITING,
  mysql: MYSQL_SQL_WRITING,
  neo4j: NEO4J_SQL_WRITING,
  netconf: NETCONF_SQL_WRITING,
  opcua: OPCUA_SQL_WRITING,
  opensearch: OPENSEARCH_SQL_WRITING,
  oracle: ORACLE_SQL_WRITING,
  oxia: OXIA_SQL_WRITING,
  postgres: POSTGRES_SQL_WRITING,
  prometheus: PROMETHEUS_SQL_WRITING,
  qdrant: QDRANT_SQL_WRITING,
  rabbitmq: RABBITMQ_SQL_WRITING,
  redis: REDIS_SQL_WRITING,
  s3: S3_SQL_WRITING,
  snmp: SNMP_SQL_WRITING,
  snowflake: SNOWFLAKE_SQL_WRITING,
  spark: SPARK_SQL_WRITING,
  sparkplug: SPARKPLUG_SQL_WRITING,
  sqlite: SQLITE_SQL_WRITING,
  trino: TRINO_SQL_WRITING,
  weaviate: WEAVIATE_SQL_WRITING,
});

/**
 * The rules for `type`: its row for a member of the union, the no-connection spec for
 * `undefined`, and the unknown-type spec for any other string.
 *
 * The empty string, and the `null` an untyped JS caller can pass, also mean no connection:
 * every writer tested `dialect ? ... : "standard"` before this contract, and a published
 * component's `databaseType?: string` can still hand either one over.
 *
 * `Object.hasOwn` is the membership test, so `"constructor"` or `"__proto__"` is not read
 * off the prototype as if it were a row.
 */
export function sqlWritingFor(type: string | undefined): SqlWritingSpec {
  if (!type) return NO_CONNECTION_SQL_WRITING;
  return Object.hasOwn(SQL_WRITING, type) ? SQL_WRITING[type as DatabaseType] : UNKNOWN_TYPE_SQL_WRITING;
}
