import { BIGQUERY_ENGINE_FACETS } from "@/lib/db/providers/sql/bigquery/engine-facets";
import { CASSANDRA_ENGINE_FACETS } from "@/lib/db/providers/sql/cassandra/engine-facets";
import { CLICKHOUSE_ENGINE_FACETS } from "@/lib/db/providers/sql/clickhouse/engine-facets";
import { COUCHBASE_ENGINE_FACETS } from "@/lib/db/providers/document/couchbase/engine-facets";
import { DATABEND_ENGINE_FACETS } from "@/lib/db/providers/sql/databend/engine-facets";
import { DB2_ENGINE_FACETS } from "@/lib/db/providers/sql/db2/engine-facets";
import { DRUID_ENGINE_FACETS } from "@/lib/db/providers/sql/druid/engine-facets";
import { DUCKDB_ENGINE_FACETS } from "@/lib/db/providers/sql/duckdb/engine-facets";
import { ELASTICSEARCH_ENGINE_FACETS } from "@/lib/db/providers/sql/search/elasticsearch-engine-facets";
import { ETCD_ENGINE_FACETS } from "@/lib/db/providers/keyvalue/etcd/engine-facets";
import { FIRESTORE_ENGINE_FACETS } from "@/lib/db/providers/document/firestore/engine-facets";
import { INFLUXDB_ENGINE_FACETS } from "@/lib/db/providers/timeseries/influxdb/influxdb-engine-facets";
import { INFLUXDB3_ENGINE_FACETS } from "@/lib/db/providers/timeseries/influxdb/influxdb3-engine-facets";
import { KAFKA_ENGINE_FACETS } from "@/lib/db/providers/stream/kafka/engine-facets";
import { KUBERNETES_ENGINE_FACETS } from "@/lib/db/providers/platform/kubernetes/engine-facets";
import { LIBREDB_ENGINE_FACETS } from "@/lib/db/providers/embedded/libredb-engine-facets";
import { LIBSQL_ENGINE_FACETS } from "@/lib/db/providers/sql/libsql/engine-facets";
import { MILVUS_ENGINE_FACETS } from "@/lib/db/providers/vector/milvus/engine-facets";
import { MODBUS_ENGINE_FACETS } from "@/lib/db/providers/industrial/modbus/engine-facets";
import { MONGODB_ENGINE_FACETS } from "@/lib/db/providers/document/mongodb/engine-facets";
import { MQTT_ENGINE_FACETS } from "@/lib/db/providers/keyvalue/mqtt/engine-facets";
import { MSSQL_ENGINE_FACETS } from "@/lib/db/providers/sql/mssql-engine-facets";
import { MTCONNECT_ENGINE_FACETS } from "@/lib/db/providers/industrial/mtconnect/engine-facets";
import { MYSQL_ENGINE_FACETS } from "@/lib/db/providers/sql/mysql-engine-facets";
import { NEO4J_ENGINE_FACETS } from "@/lib/db/providers/graph/neo4j/engine-facets";
import { NETCONF_ENGINE_FACETS } from "@/lib/db/providers/network/netconf/engine-facets";
import { OPCUA_ENGINE_FACETS } from "@/lib/db/providers/industrial/opcua/engine-facets";
import { OPENSEARCH_ENGINE_FACETS } from "@/lib/db/providers/sql/search/opensearch-engine-facets";
import { ORACLE_ENGINE_FACETS } from "@/lib/db/providers/sql/oracle-engine-facets";
import { OXIA_ENGINE_FACETS } from "@/lib/db/providers/keyvalue/oxia/engine-facets";
import { POSTGRES_ENGINE_FACETS } from "@/lib/db/providers/sql/postgres-engine-facets";
import { PROMETHEUS_ENGINE_FACETS } from "@/lib/db/providers/timeseries/prometheus/engine-facets";
import { QDRANT_ENGINE_FACETS } from "@/lib/db/providers/vector/qdrant/engine-facets";
import { RABBITMQ_ENGINE_FACETS } from "@/lib/db/providers/stream/rabbitmq/engine-facets";
import { REDIS_ENGINE_FACETS } from "@/lib/db/providers/keyvalue/redis-engine-facets";
import { S3_ENGINE_FACETS } from "@/lib/db/providers/objectstore/s3/engine-facets";
import { SNMP_ENGINE_FACETS } from "@/lib/db/providers/network/snmp/engine-facets";
import { SNOWFLAKE_ENGINE_FACETS } from "@/lib/db/providers/sql/snowflake/engine-facets";
import { SPARK_ENGINE_FACETS } from "@/lib/db/providers/sql/spark/engine-facets";
import { SPARKPLUG_ENGINE_FACETS } from "@/lib/db/providers/industrial/sparkplug/engine-facets";
import { SQLITE_ENGINE_FACETS } from "@/lib/db/providers/sql/sqlite-engine-facets";
import { TRINO_ENGINE_FACETS } from "@/lib/db/providers/sql/trino/engine-facets";
import { WEAVIATE_ENGINE_FACETS } from "@/lib/db/providers/vector/weaviate/engine-facets";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import type { EngineFacets } from "./types";

/**
 * What each engine offers, one row per type id, each declared beside its provider (FND-4). A missing id is a compile
 * error here, and a row missing a panel or its maintenance list is a compile error in its own module, so a new engine
 * cannot ship without stating each monitoring panel as offered or not and the maintenance operations it offers.
 *
 * The rows' `agentReadings` are Studio's review record of the claim an engine declaration requests at
 * `facets.agentReadings`: the declaration states each shipped engine's request as its row, and the rows are never a
 * projection of declarations (docs/providers/CONTRACT.md, clauses M-52, M-53 and M-83). Only Studio's grant reader,
 * src/lib/db/claim-grants.ts, reads that member, and every gate reads its grant, `GRANTED_AGENT_READINGS`, the
 * intersection of the request and the row. The rows
 * stay in Studio's source: the change that moves a provider into a package, or first makes Studio read the claim from
 * a declaration, keeps the claim's row in a core record keyed by the engine, so a package never carries its own grant
 * (M-54).
 */
export const ENGINE_FACETS: Readonly<Record<DatabaseType, EngineFacets>> = Object.freeze({
  bigquery: BIGQUERY_ENGINE_FACETS,
  cassandra: CASSANDRA_ENGINE_FACETS,
  clickhouse: CLICKHOUSE_ENGINE_FACETS,
  couchbase: COUCHBASE_ENGINE_FACETS,
  databend: DATABEND_ENGINE_FACETS,
  db2: DB2_ENGINE_FACETS,
  druid: DRUID_ENGINE_FACETS,
  duckdb: DUCKDB_ENGINE_FACETS,
  elasticsearch: ELASTICSEARCH_ENGINE_FACETS,
  etcd: ETCD_ENGINE_FACETS,
  firestore: FIRESTORE_ENGINE_FACETS,
  influxdb: INFLUXDB_ENGINE_FACETS,
  influxdb3: INFLUXDB3_ENGINE_FACETS,
  kafka: KAFKA_ENGINE_FACETS,
  kubernetes: KUBERNETES_ENGINE_FACETS,
  libredb: LIBREDB_ENGINE_FACETS,
  libsql: LIBSQL_ENGINE_FACETS,
  milvus: MILVUS_ENGINE_FACETS,
  modbus: MODBUS_ENGINE_FACETS,
  mongodb: MONGODB_ENGINE_FACETS,
  mqtt: MQTT_ENGINE_FACETS,
  mssql: MSSQL_ENGINE_FACETS,
  mtconnect: MTCONNECT_ENGINE_FACETS,
  mysql: MYSQL_ENGINE_FACETS,
  neo4j: NEO4J_ENGINE_FACETS,
  netconf: NETCONF_ENGINE_FACETS,
  opcua: OPCUA_ENGINE_FACETS,
  opensearch: OPENSEARCH_ENGINE_FACETS,
  oracle: ORACLE_ENGINE_FACETS,
  oxia: OXIA_ENGINE_FACETS,
  postgres: POSTGRES_ENGINE_FACETS,
  prometheus: PROMETHEUS_ENGINE_FACETS,
  qdrant: QDRANT_ENGINE_FACETS,
  rabbitmq: RABBITMQ_ENGINE_FACETS,
  redis: REDIS_ENGINE_FACETS,
  s3: S3_ENGINE_FACETS,
  snmp: SNMP_ENGINE_FACETS,
  snowflake: SNOWFLAKE_ENGINE_FACETS,
  spark: SPARK_ENGINE_FACETS,
  sparkplug: SPARKPLUG_ENGINE_FACETS,
  sqlite: SQLITE_ENGINE_FACETS,
  trino: TRINO_ENGINE_FACETS,
  weaviate: WEAVIATE_ENGINE_FACETS,
});

/**
 * The row of a connection's type, read through `typeIdRow`, so any value that is not a type id is refused by name and
 * a prototype key never reaches an `Object.prototype` member.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function engineFacetsFor(type: unknown): EngineFacets {
  return typeIdRow(ENGINE_FACETS, type);
}
