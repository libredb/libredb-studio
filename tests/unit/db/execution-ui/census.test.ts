import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { EXECUTION_UI, executionUiFor } from "@/lib/db/execution-ui";
import { NO_CONNECTION_EXECUTION_UI } from "@/lib/db/execution-ui/no-connection";
import { UNKNOWN_TYPE_EXECUTION_UI } from "@/lib/db/execution-ui/unknown-type";
import type { DatabaseType } from "@/lib/types";

/** The flat and dual placements (spec 5.3); every other id is `<family>/<id>/execution-ui.ts`. */
const FLAT: Readonly<Record<string, string>> = {
  postgres: "sql/postgres-execution-ui",
  mysql: "sql/mysql-execution-ui",
  mssql: "sql/mssql-execution-ui",
  oracle: "sql/oracle-execution-ui",
  sqlite: "sql/sqlite-execution-ui",
  redis: "keyvalue/redis-execution-ui",
  libredb: "embedded/libredb-execution-ui",
  elasticsearch: "sql/search/elasticsearch-execution-ui",
  opensearch: "sql/search/opensearch-execution-ui",
  influxdb: "timeseries/influxdb/influxdb-execution-ui",
  influxdb3: "timeseries/influxdb/influxdb3-execution-ui",
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
  return `${family}/${id}/execution-ui`;
}

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];
const idsWhere = (has: (id: DatabaseType) => boolean) => ALL.filter(has).sort();

describe("execution UI registry census", () => {
  test("one row per shipped type id", () => {
    expect(Object.keys(EXECUTION_UI).sort()).toEqual([...ALL].sort());
    expect(Object.isFrozen(EXECUTION_UI)).toBe(true);
  });

  test("each row is the object its engine module exports", async () => {
    for (const id of ALL) {
      const exported = await import(`@/lib/db/providers/${placement(id)}`);
      expect(exported[`${id.toUpperCase()}_EXECUTION_UI`]).toBe(EXECUTION_UI[id]);
    }
  });

  test("rows are pairwise distinct objects", () => {
    expect(new Set(Object.values(EXECUTION_UI)).size).toBe(ALL.length);
  });

  test("the commit keyword and consent deadline rows are the ones today's code has", () => {
    expect(idsWhere((id) => EXECUTION_UI[id].commitKeyword !== "COMMIT")).toEqual(["redis"]);
    expect(EXECUTION_UI.redis.commitKeyword).toBe("EXEC");
    expect(idsWhere((id) => EXECUTION_UI[id].consentDeadline !== null)).toEqual(["sqlite"]);
    expect(EXECUTION_UI.sqlite.consentDeadline).toEqual({
      chip: "SQLite: killed at its timeout",
      sentence:
        "On SQLite a read that runs past its timeout is now killed mid-flight; the in-memory database is the exception and still blocks this application until the read finishes.",
    });
  });

  test("executionUiFor answers no connection and unknown types with their own specs", () => {
    expect(executionUiFor(undefined)).toBe(NO_CONNECTION_EXECUTION_UI);
    for (const type of ["constructor", "__proto__", "", "not-an-engine"]) {
      expect(executionUiFor(type)).toBe(UNKNOWN_TYPE_EXECUTION_UI);
    }
    expect(NO_CONNECTION_EXECUTION_UI).not.toBe(UNKNOWN_TYPE_EXECUTION_UI);
    for (const spec of [NO_CONNECTION_EXECUTION_UI, UNKNOWN_TYPE_EXECUTION_UI]) {
      expect(spec).toEqual({ commitKeyword: "COMMIT", consentDeadline: null });
    }
    expect(executionUiFor("redis")).toBe(EXECUTION_UI.redis);
  });
});
