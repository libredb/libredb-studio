/**
 * The migration DDL registry: one row per type id, each the spec its engine module declares beside its provider
 * (spec 5.3). Total over the `DatabaseType` union, so a new id without a module is a compile error here.
 */
import { COUCHBASE_MIGRATION_DDL } from "@/lib/db/providers/document/couchbase/migration-ddl";
import { FIRESTORE_MIGRATION_DDL } from "@/lib/db/providers/document/firestore/migration-ddl";
import { MONGODB_MIGRATION_DDL } from "@/lib/db/providers/document/mongodb/migration-ddl";
import { LIBREDB_MIGRATION_DDL } from "@/lib/db/providers/embedded/libredb-migration-ddl";
import { NEO4J_MIGRATION_DDL } from "@/lib/db/providers/graph/neo4j/migration-ddl";
import { MODBUS_MIGRATION_DDL } from "@/lib/db/providers/industrial/modbus/migration-ddl";
import { MTCONNECT_MIGRATION_DDL } from "@/lib/db/providers/industrial/mtconnect/migration-ddl";
import { OPCUA_MIGRATION_DDL } from "@/lib/db/providers/industrial/opcua/migration-ddl";
import { SPARKPLUG_MIGRATION_DDL } from "@/lib/db/providers/industrial/sparkplug/migration-ddl";
import { ETCD_MIGRATION_DDL } from "@/lib/db/providers/keyvalue/etcd/migration-ddl";
import { MQTT_MIGRATION_DDL } from "@/lib/db/providers/keyvalue/mqtt/migration-ddl";
import { OXIA_MIGRATION_DDL } from "@/lib/db/providers/keyvalue/oxia/migration-ddl";
import { REDIS_MIGRATION_DDL } from "@/lib/db/providers/keyvalue/redis-migration-ddl";
import { NETCONF_MIGRATION_DDL } from "@/lib/db/providers/network/netconf/migration-ddl";
import { SNMP_MIGRATION_DDL } from "@/lib/db/providers/network/snmp/migration-ddl";
import { S3_MIGRATION_DDL } from "@/lib/db/providers/objectstore/s3/migration-ddl";
import { KUBERNETES_MIGRATION_DDL } from "@/lib/db/providers/platform/kubernetes/migration-ddl";
import { BIGQUERY_MIGRATION_DDL } from "@/lib/db/providers/sql/bigquery/migration-ddl";
import { CASSANDRA_MIGRATION_DDL } from "@/lib/db/providers/sql/cassandra/migration-ddl";
import { CLICKHOUSE_MIGRATION_DDL } from "@/lib/db/providers/sql/clickhouse/migration-ddl";
import { DATABEND_MIGRATION_DDL } from "@/lib/db/providers/sql/databend/migration-ddl";
import { DB2_MIGRATION_DDL } from "@/lib/db/providers/sql/db2/migration-ddl";
import { DRUID_MIGRATION_DDL } from "@/lib/db/providers/sql/druid/migration-ddl";
import { DUCKDB_MIGRATION_DDL } from "@/lib/db/providers/sql/duckdb/migration-ddl";
import { LIBSQL_MIGRATION_DDL } from "@/lib/db/providers/sql/libsql/migration-ddl";
import { MSSQL_MIGRATION_DDL } from "@/lib/db/providers/sql/mssql-migration-ddl";
import { MYSQL_MIGRATION_DDL } from "@/lib/db/providers/sql/mysql-migration-ddl";
import { ORACLE_MIGRATION_DDL } from "@/lib/db/providers/sql/oracle-migration-ddl";
import { POSTGRES_MIGRATION_DDL } from "@/lib/db/providers/sql/postgres-migration-ddl";
import { ELASTICSEARCH_MIGRATION_DDL } from "@/lib/db/providers/sql/search/elasticsearch-migration-ddl";
import { OPENSEARCH_MIGRATION_DDL } from "@/lib/db/providers/sql/search/opensearch-migration-ddl";
import { SNOWFLAKE_MIGRATION_DDL } from "@/lib/db/providers/sql/snowflake/migration-ddl";
import { SPARK_MIGRATION_DDL } from "@/lib/db/providers/sql/spark/migration-ddl";
import { SQLITE_MIGRATION_DDL } from "@/lib/db/providers/sql/sqlite-migration-ddl";
import { TRINO_MIGRATION_DDL } from "@/lib/db/providers/sql/trino/migration-ddl";
import { KAFKA_MIGRATION_DDL } from "@/lib/db/providers/stream/kafka/migration-ddl";
import { RABBITMQ_MIGRATION_DDL } from "@/lib/db/providers/stream/rabbitmq/migration-ddl";
import { INFLUXDB_MIGRATION_DDL } from "@/lib/db/providers/timeseries/influxdb/influxdb-migration-ddl";
import { INFLUXDB3_MIGRATION_DDL } from "@/lib/db/providers/timeseries/influxdb/influxdb3-migration-ddl";
import { PROMETHEUS_MIGRATION_DDL } from "@/lib/db/providers/timeseries/prometheus/migration-ddl";
import { MILVUS_MIGRATION_DDL } from "@/lib/db/providers/vector/milvus/migration-ddl";
import { QDRANT_MIGRATION_DDL } from "@/lib/db/providers/vector/qdrant/migration-ddl";
import { WEAVIATE_MIGRATION_DDL } from "@/lib/db/providers/vector/weaviate/migration-ddl";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_DIALECT, NO_CONNECTION_MIGRATION_DDL } from "./no-connection";
import type { MigrationDdlSpec } from "./types";
import { UNKNOWN_TYPE_MIGRATION_DDL } from "./unknown-type";

export const MIGRATION_DDL: Readonly<Record<DatabaseType, MigrationDdlSpec>> = Object.freeze({
  bigquery: BIGQUERY_MIGRATION_DDL,
  cassandra: CASSANDRA_MIGRATION_DDL,
  clickhouse: CLICKHOUSE_MIGRATION_DDL,
  couchbase: COUCHBASE_MIGRATION_DDL,
  databend: DATABEND_MIGRATION_DDL,
  db2: DB2_MIGRATION_DDL,
  druid: DRUID_MIGRATION_DDL,
  duckdb: DUCKDB_MIGRATION_DDL,
  elasticsearch: ELASTICSEARCH_MIGRATION_DDL,
  etcd: ETCD_MIGRATION_DDL,
  firestore: FIRESTORE_MIGRATION_DDL,
  influxdb: INFLUXDB_MIGRATION_DDL,
  influxdb3: INFLUXDB3_MIGRATION_DDL,
  kafka: KAFKA_MIGRATION_DDL,
  kubernetes: KUBERNETES_MIGRATION_DDL,
  libredb: LIBREDB_MIGRATION_DDL,
  libsql: LIBSQL_MIGRATION_DDL,
  milvus: MILVUS_MIGRATION_DDL,
  modbus: MODBUS_MIGRATION_DDL,
  mongodb: MONGODB_MIGRATION_DDL,
  mqtt: MQTT_MIGRATION_DDL,
  mssql: MSSQL_MIGRATION_DDL,
  mtconnect: MTCONNECT_MIGRATION_DDL,
  mysql: MYSQL_MIGRATION_DDL,
  neo4j: NEO4J_MIGRATION_DDL,
  netconf: NETCONF_MIGRATION_DDL,
  opcua: OPCUA_MIGRATION_DDL,
  opensearch: OPENSEARCH_MIGRATION_DDL,
  oracle: ORACLE_MIGRATION_DDL,
  oxia: OXIA_MIGRATION_DDL,
  postgres: POSTGRES_MIGRATION_DDL,
  prometheus: PROMETHEUS_MIGRATION_DDL,
  qdrant: QDRANT_MIGRATION_DDL,
  rabbitmq: RABBITMQ_MIGRATION_DDL,
  redis: REDIS_MIGRATION_DDL,
  s3: S3_MIGRATION_DDL,
  snmp: SNMP_MIGRATION_DDL,
  snowflake: SNOWFLAKE_MIGRATION_DDL,
  spark: SPARK_MIGRATION_DDL,
  sparkplug: SPARKPLUG_MIGRATION_DDL,
  sqlite: SQLITE_MIGRATION_DDL,
  trino: TRINO_MIGRATION_DDL,
  weaviate: WEAVIATE_MIGRATION_DDL,
});

/**
 * The spec for a connection's type: `undefined` (no connection) gives the no-connection spec, a member of the union
 * its row (checked with `Object.hasOwn`, so `"constructor"` is not a member), and any other string the unknown-type
 * spec.
 */
export function migrationDdlFor(type: string | undefined): MigrationDdlSpec {
  if (type === undefined) return NO_CONNECTION_MIGRATION_DDL;
  if (Object.hasOwn(MIGRATION_DDL, type)) return MIGRATION_DDL[type as DatabaseType];
  return UNKNOWN_TYPE_MIGRATION_DDL;
}

/**
 * The word the migration's `-- Dialect:` header prints: the no-connection dialect for `undefined`, the type string
 * as given otherwise, so the generator holds no type id of its own.
 */
export function migrationDialectHeader(type: string | undefined): string {
  return type === undefined ? NO_CONNECTION_DIALECT : type;
}
