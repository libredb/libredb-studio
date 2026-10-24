import { BIGQUERY_CONNECTION_STRING } from "@/lib/db/providers/sql/bigquery/connection-string";
import { CASSANDRA_CONNECTION_STRING } from "@/lib/db/providers/sql/cassandra/connection-string";
import { CLICKHOUSE_CONNECTION_STRING } from "@/lib/db/providers/sql/clickhouse/connection-string";
import { COUCHBASE_CONNECTION_STRING } from "@/lib/db/providers/document/couchbase/connection-string";
import { DATABEND_CONNECTION_STRING } from "@/lib/db/providers/sql/databend/connection-string";
import { DB2_CONNECTION_STRING } from "@/lib/db/providers/sql/db2/connection-string";
import { DRUID_CONNECTION_STRING } from "@/lib/db/providers/sql/druid/connection-string";
import { DUCKDB_CONNECTION_STRING } from "@/lib/db/providers/sql/duckdb/connection-string";
import { ELASTICSEARCH_CONNECTION_STRING } from "@/lib/db/providers/sql/search/elasticsearch-connection-string";
import { ETCD_CONNECTION_STRING } from "@/lib/db/providers/keyvalue/etcd/connection-string";
import { FIRESTORE_CONNECTION_STRING } from "@/lib/db/providers/document/firestore/connection-string";
import { INFLUXDB_CONNECTION_STRING } from "@/lib/db/providers/timeseries/influxdb/influxdb-connection-string";
import { INFLUXDB3_CONNECTION_STRING } from "@/lib/db/providers/timeseries/influxdb/influxdb3-connection-string";
import { KAFKA_CONNECTION_STRING } from "@/lib/db/providers/stream/kafka/connection-string";
import { KUBERNETES_CONNECTION_STRING } from "@/lib/db/providers/platform/kubernetes/connection-string";
import { LIBREDB_CONNECTION_STRING } from "@/lib/db/providers/embedded/libredb-connection-string";
import { LIBSQL_CONNECTION_STRING } from "@/lib/db/providers/sql/libsql/connection-string";
import { MILVUS_CONNECTION_STRING } from "@/lib/db/providers/vector/milvus/connection-string";
import { MODBUS_CONNECTION_STRING } from "@/lib/db/providers/industrial/modbus/connection-string";
import { MONGODB_CONNECTION_STRING } from "@/lib/db/providers/document/mongodb/connection-string";
import { MQTT_CONNECTION_STRING } from "@/lib/db/providers/keyvalue/mqtt/connection-string";
import { MSSQL_CONNECTION_STRING } from "@/lib/db/providers/sql/mssql-connection-string";
import { MTCONNECT_CONNECTION_STRING } from "@/lib/db/providers/industrial/mtconnect/connection-string";
import { MYSQL_CONNECTION_STRING } from "@/lib/db/providers/sql/mysql-connection-string";
import { NEO4J_CONNECTION_STRING } from "@/lib/db/providers/graph/neo4j/connection-string";
import { NETCONF_CONNECTION_STRING } from "@/lib/db/providers/network/netconf/connection-string";
import { OPCUA_CONNECTION_STRING } from "@/lib/db/providers/industrial/opcua/connection-string";
import { OPENSEARCH_CONNECTION_STRING } from "@/lib/db/providers/sql/search/opensearch-connection-string";
import { ORACLE_CONNECTION_STRING } from "@/lib/db/providers/sql/oracle-connection-string";
import { OXIA_CONNECTION_STRING } from "@/lib/db/providers/keyvalue/oxia/connection-string";
import { POSTGRES_CONNECTION_STRING } from "@/lib/db/providers/sql/postgres-connection-string";
import { PROMETHEUS_CONNECTION_STRING } from "@/lib/db/providers/timeseries/prometheus/connection-string";
import { QDRANT_CONNECTION_STRING } from "@/lib/db/providers/vector/qdrant/connection-string";
import { WEAVIATE_CONNECTION_STRING } from "@/lib/db/providers/vector/weaviate/connection-string";
import { RABBITMQ_CONNECTION_STRING } from "@/lib/db/providers/stream/rabbitmq/connection-string";
import { REDIS_CONNECTION_STRING } from "@/lib/db/providers/keyvalue/redis-connection-string";
import { S3_CONNECTION_STRING } from "@/lib/db/providers/objectstore/s3/connection-string";
import { SNMP_CONNECTION_STRING } from "@/lib/db/providers/network/snmp/connection-string";
import { SNOWFLAKE_CONNECTION_STRING } from "@/lib/db/providers/sql/snowflake/connection-string";
import { SPARK_CONNECTION_STRING } from "@/lib/db/providers/sql/spark/connection-string";
import { SPARKPLUG_CONNECTION_STRING } from "@/lib/db/providers/industrial/sparkplug/connection-string";
import { SQLITE_CONNECTION_STRING } from "@/lib/db/providers/sql/sqlite-connection-string";
import { TRINO_CONNECTION_STRING } from "@/lib/db/providers/sql/trino/connection-string";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_CONNECTION_STRING } from "./no-connection";
import type { ConnectionStringSpec } from "./types";
import { UNKNOWN_TYPE_CONNECTION_STRING } from "./unknown-type";

/**
 * Each engine's connection string facts, one row per type id, each declared beside its provider. A missing id is a
 * compile error here, so a new engine cannot ship without saying whether it has a scheme, URL TLS or seed checks.
 */
export const CONNECTION_STRING: Readonly<Record<DatabaseType, ConnectionStringSpec>> = Object.freeze({
  bigquery: BIGQUERY_CONNECTION_STRING,
  cassandra: CASSANDRA_CONNECTION_STRING,
  clickhouse: CLICKHOUSE_CONNECTION_STRING,
  couchbase: COUCHBASE_CONNECTION_STRING,
  databend: DATABEND_CONNECTION_STRING,
  db2: DB2_CONNECTION_STRING,
  druid: DRUID_CONNECTION_STRING,
  duckdb: DUCKDB_CONNECTION_STRING,
  elasticsearch: ELASTICSEARCH_CONNECTION_STRING,
  etcd: ETCD_CONNECTION_STRING,
  firestore: FIRESTORE_CONNECTION_STRING,
  influxdb: INFLUXDB_CONNECTION_STRING,
  influxdb3: INFLUXDB3_CONNECTION_STRING,
  kafka: KAFKA_CONNECTION_STRING,
  kubernetes: KUBERNETES_CONNECTION_STRING,
  libredb: LIBREDB_CONNECTION_STRING,
  libsql: LIBSQL_CONNECTION_STRING,
  milvus: MILVUS_CONNECTION_STRING,
  modbus: MODBUS_CONNECTION_STRING,
  mongodb: MONGODB_CONNECTION_STRING,
  mqtt: MQTT_CONNECTION_STRING,
  mssql: MSSQL_CONNECTION_STRING,
  mtconnect: MTCONNECT_CONNECTION_STRING,
  mysql: MYSQL_CONNECTION_STRING,
  neo4j: NEO4J_CONNECTION_STRING,
  netconf: NETCONF_CONNECTION_STRING,
  opcua: OPCUA_CONNECTION_STRING,
  opensearch: OPENSEARCH_CONNECTION_STRING,
  oracle: ORACLE_CONNECTION_STRING,
  oxia: OXIA_CONNECTION_STRING,
  postgres: POSTGRES_CONNECTION_STRING,
  prometheus: PROMETHEUS_CONNECTION_STRING,
  qdrant: QDRANT_CONNECTION_STRING,
  rabbitmq: RABBITMQ_CONNECTION_STRING,
  redis: REDIS_CONNECTION_STRING,
  s3: S3_CONNECTION_STRING,
  snmp: SNMP_CONNECTION_STRING,
  snowflake: SNOWFLAKE_CONNECTION_STRING,
  spark: SPARK_CONNECTION_STRING,
  sparkplug: SPARKPLUG_CONNECTION_STRING,
  sqlite: SQLITE_CONNECTION_STRING,
  trino: TRINO_CONNECTION_STRING,
  weaviate: WEAVIATE_CONNECTION_STRING,
});

/**
 * The spec for a connection's type: `NO_CONNECTION_CONNECTION_STRING` without one, the engine's row for a shipped
 * id, otherwise `UNKNOWN_TYPE_CONNECTION_STRING`. `Object.hasOwn`, so `"constructor"` or `"__proto__"` never reaches
 * an Object.prototype member.
 */
export function connectionStringFor(type: string | undefined): ConnectionStringSpec {
  if (type === undefined) return NO_CONNECTION_CONNECTION_STRING;
  return Object.hasOwn(CONNECTION_STRING, type)
    ? CONNECTION_STRING[type as DatabaseType]
    : UNKNOWN_TYPE_CONNECTION_STRING;
}

/**
 * The canonical URI scheme each engine is reachable by, for the engines that HAVE one.
 * Built from the `scheme` of each engine's row in `CONNECTION_STRING` above, declared beside its provider, so a
 * scheme is added there. Its key order is `CONNECTION_STRING`'s and carries no meaning: readers look a type up by
 * key, and the login signature orders by the engine list.
 *
 * Deliberately partial, and the gaps are the point: SQLite is a file path, LibreDB is
 * embedded in the process, and Druid is reached over plain HTTP through the form. Inventing
 * `sqlite://` or `druid://` to make the map look complete would put a scheme on the login
 * page that `parseConnectionString` (src/lib/connection-string-parser.ts) rejects - a claim the product does not honour,
 * which is the class of defect issue #425 exists to remove.
 *
 * Cassandra is absent for a different reason again, and a stronger one: its driver needs
 * a REQUIRED `localDataCenter` alongside the contact points (measured on 4.9.0 - it
 * refuses to construct a client without one), and no URI convention in use carries that
 * field. A `cassandra://host:9042/keyspace` form would therefore parse into a connection
 * that cannot open, which is worse than no paste at all.
 *
 * Trino is the sharpest version of that gap, and worth naming because it looks like it
 * belongs here: it HAS a canonical URL, `jdbc:trino://host:port/catalog/schema`. That is
 * a JDBC URL and not a URI - `new URL()` reads its scheme as `jdbc:` - and stripping the
 * prefix to make one would invent a `trino://` form no Trino tool emits. So the id is
 * absent, its capabilities say `supportsConnectionString: false`, and its form offers no
 * paste toggle. Pinned by tests/unit/lib/connection-string-parser.test.ts.
 *
 * Apache Spark is absent on purpose too, though its `sc://` address is pasted and decomposed (`parseSparkConnectUri`):
 * the login signature prints every scheme here with the tail `user@db.internal:<port>/app`, and Spark's grammar
 * refuses both a user part and a path, so the hero would show an address the product refuses.
 *
 * Aliases the parser also accepts (`postgresql://`, `mongodb+srv://`, `rediss://`,
 * `sqlserver://`, `couchbases://`, and ClickHouse's `http(s)://`) are not listed: this map
 * answers "what is the one scheme to show a reader for this engine", not "what will parse".
 *
 * `tests/unit/lib/connection-string-parser.test.ts` pins the entries against the parser
 * itself - every scheme here must round-trip to its own `DatabaseType` - so the map cannot
 * drift away from the parser's `startsWith` checks without failing CI.
 */
export const ENGINE_URI_SCHEMES: Partial<Record<DatabaseType, string>> = Object.fromEntries(
  Object.entries(CONNECTION_STRING).flatMap(([type, spec]) => (spec.scheme === null ? [] : [[type, spec.scheme]])),
);
