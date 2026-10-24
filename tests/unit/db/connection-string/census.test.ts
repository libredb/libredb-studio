import { describe, expect, test } from "bun:test";
import { ENGINE_URI_SCHEMES as PARSER_ENGINE_URI_SCHEMES } from "@/lib/connection-string-parser";
import { CONNECTION_STRING, connectionStringFor, ENGINE_URI_SCHEMES } from "@/lib/db/connection-string";
import { NO_CONNECTION_CONNECTION_STRING } from "@/lib/db/connection-string/no-connection";
import { UNKNOWN_TYPE_CONNECTION_STRING } from "@/lib/db/connection-string/unknown-type";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";

/** The flat and dual placements (spec 5.3); every other id is `<family>/<id>/connection-string.ts`. */
const FLAT: Readonly<Record<string, string>> = {
  postgres: "sql/postgres-connection-string",
  mysql: "sql/mysql-connection-string",
  mssql: "sql/mssql-connection-string",
  oracle: "sql/oracle-connection-string",
  sqlite: "sql/sqlite-connection-string",
  redis: "keyvalue/redis-connection-string",
  libredb: "embedded/libredb-connection-string",
  elasticsearch: "sql/search/elasticsearch-connection-string",
  opensearch: "sql/search/opensearch-connection-string",
  influxdb: "timeseries/influxdb/influxdb-connection-string",
  influxdb3: "timeseries/influxdb/influxdb3-connection-string",
};

const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  document: ["couchbase", "firestore", "mongodb"],
  graph: ["neo4j"],
  industrial: ["modbus", "mtconnect", "opcua", "sparkplug"],
  keyvalue: ["etcd", "mqtt", "oxia"],
  network: ["netconf", "snmp"],
  objectstore: ["s3"],
  platform: ["kubernetes"],
  sql: [
    "bigquery",
    "cassandra",
    "clickhouse",
    "databend",
    "db2",
    "druid",
    "duckdb",
    "libsql",
    "snowflake",
    "spark",
    "trino",
  ],
  stream: ["kafka", "rabbitmq"],
  timeseries: ["prometheus"],
  vector: ["milvus", "qdrant", "weaviate"],
};

function placement(id: string): string {
  if (FLAT[id]) return FLAT[id];
  const family = Object.keys(FAMILIES).find((name) => FAMILIES[name].includes(id));
  if (!family) throw new Error(`no placement for ${id}`);
  return `${family}/${id}/connection-string`;
}

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];
const idsWhere = (has: (id: DatabaseType) => boolean) => ALL.filter(has).sort();

describe("connection string registry census", () => {
  test("one row per shipped type id", () => {
    expect(Object.keys(CONNECTION_STRING).sort()).toEqual([...ALL].sort());
    expect(Object.isFrozen(CONNECTION_STRING)).toBe(true);
  });

  test("each row is the object its engine module exports", async () => {
    for (const id of ALL) {
      const exported = await import(`@/lib/db/providers/${placement(id)}`);
      expect(exported[`${id.toUpperCase()}_CONNECTION_STRING`]).toBe(CONNECTION_STRING[id]);
    }
  });

  test("rows are pairwise distinct objects", () => {
    expect(new Set(Object.values(CONNECTION_STRING)).size).toBe(ALL.length);
  });

  test("the scheme, URL TLS and seed check rows are the ones today's code has", () => {
    expect(idsWhere((id) => CONNECTION_STRING[id].scheme !== null)).toEqual([
      "clickhouse",
      "couchbase",
      "databend",
      "db2",
      "libsql",
      "mongodb",
      "mssql",
      "mysql",
      "oracle",
      "postgres",
      "redis",
    ]);
    for (const id of ALL) {
      const scheme = CONNECTION_STRING[id].scheme;
      if (scheme !== null) expect(scheme).toBe(id);
    }
    expect(idsWhere((id) => CONNECTION_STRING[id].readTls !== null)).toEqual(["db2", "mssql", "mysql", "postgres"]);
    expect(idsWhere((id) => CONNECTION_STRING[id].validateSeed !== null)).toEqual(["snowflake"]);
  });

  test("connectionStringFor answers no connection and unknown types with their own specs", () => {
    expect(connectionStringFor(undefined)).toBe(NO_CONNECTION_CONNECTION_STRING);
    for (const type of ["constructor", "__proto__", "not-an-engine"]) {
      expect(connectionStringFor(type)).toBe(UNKNOWN_TYPE_CONNECTION_STRING);
    }
    expect(NO_CONNECTION_CONNECTION_STRING).not.toBe(UNKNOWN_TYPE_CONNECTION_STRING);
    for (const spec of [NO_CONNECTION_CONNECTION_STRING, UNKNOWN_TYPE_CONNECTION_STRING]) {
      expect(spec).toEqual({ scheme: null, readTls: null, validateSeed: null });
    }
    expect(connectionStringFor("postgres")).toBe(CONNECTION_STRING.postgres);
  });

  test("the scheme map is derived inside the registry, and the parser re-exports that same object", () => {
    expect(PARSER_ENGINE_URI_SCHEMES).toBe(ENGINE_URI_SCHEMES);
    const withScheme = Object.entries(CONNECTION_STRING).filter(([, spec]) => spec.scheme !== null);
    expect(Object.fromEntries(withScheme.map(([type, spec]) => [type, spec.scheme]))).toEqual(
      ENGINE_URI_SCHEMES as Record<string, string>,
    );
  });
});
