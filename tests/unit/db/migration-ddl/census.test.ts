/**
 * The migration DDL registry is total over the type-id union, one module per id at its spec 5.3
 * placement, and its reader answers the three cases by name.
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { MIGRATION_DDL, migrationDdlFor, migrationDialectHeader } from "@/lib/db/migration-ddl";
import { NO_CONNECTION_DIALECT, NO_CONNECTION_MIGRATION_DDL } from "@/lib/db/migration-ddl/no-connection";
import { UNKNOWN_TYPE_MIGRATION_DDL } from "@/lib/db/migration-ddl/unknown-type";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";
import type { DatabaseType } from "@/lib/types";

const PROVIDERS = "@/lib/db/providers";

const PLACEMENT: Record<DatabaseType, string> = {
  postgres: "sql/postgres-migration-ddl",
  mysql: "sql/mysql-migration-ddl",
  mssql: "sql/mssql-migration-ddl",
  oracle: "sql/oracle-migration-ddl",
  sqlite: "sql/sqlite-migration-ddl",
  redis: "keyvalue/redis-migration-ddl",
  libredb: "embedded/libredb-migration-ddl",
  elasticsearch: "sql/search/elasticsearch-migration-ddl",
  opensearch: "sql/search/opensearch-migration-ddl",
  influxdb: "timeseries/influxdb/influxdb-migration-ddl",
  influxdb3: "timeseries/influxdb/influxdb3-migration-ddl",
  couchbase: "document/couchbase/migration-ddl",
  firestore: "document/firestore/migration-ddl",
  mongodb: "document/mongodb/migration-ddl",
  neo4j: "graph/neo4j/migration-ddl",
  modbus: "industrial/modbus/migration-ddl",
  mtconnect: "industrial/mtconnect/migration-ddl",
  opcua: "industrial/opcua/migration-ddl",
  sparkplug: "industrial/sparkplug/migration-ddl",
  etcd: "keyvalue/etcd/migration-ddl",
  mqtt: "keyvalue/mqtt/migration-ddl",
  oxia: "keyvalue/oxia/migration-ddl",
  netconf: "network/netconf/migration-ddl",
  snmp: "network/snmp/migration-ddl",
  s3: "objectstore/s3/migration-ddl",
  kubernetes: "platform/kubernetes/migration-ddl",
  bigquery: "sql/bigquery/migration-ddl",
  cassandra: "sql/cassandra/migration-ddl",
  clickhouse: "sql/clickhouse/migration-ddl",
  databend: "sql/databend/migration-ddl",
  db2: "sql/db2/migration-ddl",
  druid: "sql/druid/migration-ddl",
  duckdb: "sql/duckdb/migration-ddl",
  libsql: "sql/libsql/migration-ddl",
  snowflake: "sql/snowflake/migration-ddl",
  spark: "sql/spark/migration-ddl",
  trino: "sql/trino/migration-ddl",
  kafka: "stream/kafka/migration-ddl",
  rabbitmq: "stream/rabbitmq/migration-ddl",
  prometheus: "timeseries/prometheus/migration-ddl",
  milvus: "vector/milvus/migration-ddl",
  qdrant: "vector/qdrant/migration-ddl",
  weaviate: "vector/weaviate/migration-ddl",
};

const REFUSED: DatabaseType[] = [
  "mongodb",
  "redis",
  "libredb",
  "couchbase",
  "druid",
  "elasticsearch",
  "opensearch",
  "prometheus",
  "kafka",
  "etcd",
  "neo4j",
  "milvus",
  "qdrant",
  "weaviate",
  "influxdb",
  "influxdb3",
  "oxia",
  "s3",
  "kubernetes",
  "mqtt",
  "firestore",
  "rabbitmq",
  "opcua",
  "mtconnect",
  "modbus",
  "netconf",
  "snmp",
  "sparkplug",
];

const ids = Object.keys(MIGRATION_DDL) as DatabaseType[];

describe("migration DDL registry census", () => {
  test("one row per shipped type id", () => {
    expect([...ids].sort()).toEqual([...EXTERNAL_DATABASE_TYPES, "libredb" as const].sort());
    expect(Object.keys(PLACEMENT).sort()).toEqual([...ids].sort());
  });

  for (const id of Object.keys(PLACEMENT) as DatabaseType[]) {
    test(`${id} is declared at its placement`, async () => {
      const imported = (await import(`${PROVIDERS}/${PLACEMENT[id]}`)) as Record<string, MigrationDdlSpec>;
      expect(imported[`${id.toUpperCase()}_MIGRATION_DDL`]).toBe(MIGRATION_DDL[id]);
    });
  }

  test("every row is its own object, distinct from both named specs", () => {
    const rows = ids.map((id) => MIGRATION_DDL[id]);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows).not.toContain(NO_CONNECTION_MIGRATION_DDL);
    expect(rows).not.toContain(UNKNOWN_TYPE_MIGRATION_DDL);
    expect(NO_CONNECTION_MIGRATION_DDL).not.toBe(UNKNOWN_TYPE_MIGRATION_DDL);
  });

  test("the registry is frozen", () => {
    expect(Object.isFrozen(MIGRATION_DDL)).toBe(true);
  });

  test("the refused ids are the REFUSED list, the engines that print no table DDL", () => {
    expect(ids.filter((id) => MIGRATION_DDL[id].tableDdl === "refused").sort()).toEqual([...REFUSED].sort());
  });

  test("the reader answers no connection, a member and an unknown string by name", () => {
    expect(migrationDdlFor(undefined)).toBe(NO_CONNECTION_MIGRATION_DDL);
    expect(migrationDdlFor("postgres")).toBe(MIGRATION_DDL.postgres);
    for (const unknown of ["constructor", "__proto__", "toString", "not-an-engine"]) {
      expect(migrationDdlFor(unknown)).toBe(UNKNOWN_TYPE_MIGRATION_DDL);
    }
  });

  test("the no-connection dialect is the word SchemaDiff passed", () => {
    expect(NO_CONNECTION_DIALECT).toBe("postgres");
  });

  test("the header word is the no-connection dialect with no connection and the type string otherwise", () => {
    expect(migrationDialectHeader(undefined)).toBe(NO_CONNECTION_DIALECT);
    for (const type of ["postgres", "mysql", "constructor", "not-an-engine"]) {
      expect(migrationDialectHeader(type)).toBe(type);
    }
  });
});
