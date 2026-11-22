import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ENGINE_FACETS, engineFacetsFor } from "@/lib/db/engine-facets";
import { MONITORING_PANELS, type MonitoringPanel } from "@/lib/db/engine-facets/types";
import type { MonitoringData } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";

/** The flat and dual placements, as the execution UI census keeps them; every other id is `<family>/<id>/engine-facets.ts`. */
const FLAT: Readonly<Record<string, string>> = {
  postgres: "sql/postgres-engine-facets",
  mysql: "sql/mysql-engine-facets",
  mssql: "sql/mssql-engine-facets",
  oracle: "sql/oracle-engine-facets",
  sqlite: "sql/sqlite-engine-facets",
  redis: "keyvalue/redis-engine-facets",
  libredb: "embedded/libredb-engine-facets",
  elasticsearch: "sql/search/elasticsearch-engine-facets",
  opensearch: "sql/search/opensearch-engine-facets",
  influxdb: "timeseries/influxdb/influxdb-engine-facets",
  influxdb3: "timeseries/influxdb/influxdb3-engine-facets",
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
  return `${family}/${id}/engine-facets`;
}

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

const ALL_SEVEN: readonly MonitoringPanel[] = [
  "overview",
  "performance",
  "slowQueries",
  "activeSessions",
  "tables",
  "indexes",
  "storage",
];
const OVERVIEW_ONLY: readonly MonitoringPanel[] = ["overview"];
const EMBEDDED_FILE: readonly MonitoringPanel[] = ["overview", "tables", "indexes", "storage"];
const CATALOG_AND_STORAGE: readonly MonitoringPanel[] = ["overview", "tables", "storage"];
const VECTOR: readonly MonitoringPanel[] = ["overview", "tables", "indexes"];

/**
 * The monitoring panels each engine offers, as measured cell by cell when the registry landed (FND-4): every provider
 * built unconnected and each of its seven reads called, and every overview body read. A panel is offered when its read
 * asks the engine (or an embedded engine's own file), and a read that answers a stub empty, a constant or a refusal
 * without asking is not offered.
 *
 * This table is transcribed from that measurement, never derived from `ENGINE_FACETS`, so the census certifies the
 * declaration rather than agreeing with it. When the two disagree the repair is to the declaration, or to a new
 * measurement recorded first and then copied here, and never to this table to make it agree with the code.
 */
const EXPECTED_OFFERED: Readonly<Record<DatabaseType, readonly MonitoringPanel[]>> = {
  bigquery: ["overview", "performance", "slowQueries", "activeSessions", "tables", "storage"],
  cassandra: ["overview", "performance", "activeSessions"],
  clickhouse: ALL_SEVEN,
  couchbase: ALL_SEVEN,
  databend: ["overview", "slowQueries", "activeSessions", "tables", "indexes", "storage"],
  db2: ["overview", "tables"],
  druid: ["overview", "activeSessions", "tables", "storage"],
  duckdb: EMBEDDED_FILE,
  elasticsearch: CATALOG_AND_STORAGE,
  etcd: CATALOG_AND_STORAGE,
  firestore: OVERVIEW_ONLY,
  influxdb: OVERVIEW_ONLY,
  influxdb3: OVERVIEW_ONLY,
  kafka: ["overview", "storage"],
  kubernetes: OVERVIEW_ONLY,
  libredb: CATALOG_AND_STORAGE,
  libsql: EMBEDDED_FILE,
  milvus: VECTOR,
  modbus: [],
  mongodb: ALL_SEVEN,
  mqtt: OVERVIEW_ONLY,
  mssql: ALL_SEVEN,
  mtconnect: OVERVIEW_ONLY,
  mysql: ALL_SEVEN,
  neo4j: ["overview", "activeSessions", "tables", "indexes"],
  netconf: OVERVIEW_ONLY,
  opcua: OVERVIEW_ONLY,
  opensearch: CATALOG_AND_STORAGE,
  oracle: ALL_SEVEN,
  oxia: [],
  postgres: ALL_SEVEN,
  prometheus: CATALOG_AND_STORAGE,
  qdrant: VECTOR,
  rabbitmq: OVERVIEW_ONLY,
  redis: ["overview", "performance", "slowQueries", "activeSessions", "storage"],
  s3: [],
  snmp: OVERVIEW_ONLY,
  snowflake: ALL_SEVEN,
  spark: OVERVIEW_ONLY,
  sparkplug: OVERVIEW_ONLY,
  sqlite: EMBEDDED_FILE,
  trino: ["overview", "performance", "slowQueries", "activeSessions", "tables", "storage"],
  weaviate: VECTOR,
};

const offeredBy = (id: DatabaseType): MonitoringPanel[] =>
  MONITORING_PANELS.filter((panel) => ENGINE_FACETS[id].monitoring[panel] === "offered");

/** Compile-time: every panel is a key of the payload. */
type PanelsMissingFromPayload = Exclude<MonitoringPanel, keyof MonitoringData>;
const NO_PANEL_MISSING: PanelsMissingFromPayload[] = [];

describe("engine facets registry census", () => {
  test("ENGINE_FACETS holds one row per type id, each imported from the module beside its provider", async () => {
    expect(Object.keys(ENGINE_FACETS).sort()).toEqual([...ALL].sort());
    expect(Object.isFrozen(ENGINE_FACETS)).toBe(true);
    expect(new Set(Object.values(ENGINE_FACETS)).size).toBe(ALL.length);
    const exported = await Promise.all(ALL.map((id) => import(`@/lib/db/providers/${placement(id)}`)));
    ALL.forEach((id, at) => {
      expect(exported[at][`${id.toUpperCase()}_ENGINE_FACETS`], id).toBe(ENGINE_FACETS[id]);
    });
  });

  test("every row states each of the seven monitoring panels as offered or not offered", () => {
    for (const id of ALL) {
      const monitoring = ENGINE_FACETS[id].monitoring;
      expect(Object.keys(monitoring).sort(), id).toEqual([...MONITORING_PANELS].sort());
      for (const panel of MONITORING_PANELS) {
        expect(["offered", "not-offered"], `${id} ${panel}`).toContain(monitoring[panel]);
      }
    }
  });

  test("each engine offers the monitoring panels measured when the registry landed", () => {
    const measured = Object.fromEntries(ALL.map((id) => [id, offeredBy(id)]));
    expect(measured).toEqual(Object.fromEntries(ALL.map((id) => [id, [...EXPECTED_OFFERED[id]]])));
  });

  test("no row lists a maintenance operation twice", () => {
    const repeated = ALL.filter(
      (id) => new Set(ENGINE_FACETS[id].maintenance).size !== ENGINE_FACETS[id].maintenance.length,
    );
    expect(repeated).toEqual([]);
  });

  test("engineFacetsFor answers the row of a type id", () => {
    for (const id of ALL) expect(engineFacetsFor(id)).toBe(ENGINE_FACETS[id]);
  });

  test.each(OUTSIDE_THE_UNION)("engineFacetsFor refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => engineFacetsFor(value))).toEqual(refusalOf(value));
  });

  test("MONITORING_PANELS names the panels MonitoringData carries, in the dashboard's order", () => {
    expect(NO_PANEL_MISSING).toEqual([]);
    expect([...MONITORING_PANELS]).toEqual([...ALL_SEVEN]);
    expect(Object.isFrozen(MONITORING_PANELS)).toBe(true);
  });
});
