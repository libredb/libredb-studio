import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_READING_PANELS } from "@libredb/provider-sdk/calls";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import { EXTERNAL_DATABASE_TYPES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ENGINE_FACETS, engineFacetsFor } from "@/lib/db/engine-facets";
import { type EngineFacets, MONITORING_PANELS, type MonitoringPanel } from "@/lib/db/engine-facets/types";
import { CURATED_OPERATION_KINDS, type CuratedOperationKind } from "@/lib/db/operations/descriptors";
import type { MonitoringData } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { legacyRegisterTable } from "../../../helpers/legacy-register";
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

const SIX_READINGS: readonly CuratedOperationKind[] = [
  "sessions",
  "slow-queries",
  "table-stats",
  "index-stats",
  "storage",
  "health",
];
const HEALTH_ONLY: readonly CuratedOperationKind[] = ["health"];
const EMBEDDED_READINGS: readonly CuratedOperationKind[] = ["table-stats", "index-stats", "storage", "health"];
const CATALOG_AND_STORAGE_READINGS: readonly CuratedOperationKind[] = ["table-stats", "storage", "health"];
const VECTOR_READINGS: readonly CuratedOperationKind[] = ["table-stats", "index-stats", "health"];

/**
 * The curated `inspect_operations` readings each engine answers on the agent handle (`{ readOnly: true,
 * sendsStatements: false }`), as measured when the agent first read the registry (FND-4 slice 3): every provider built
 * through the real factory, each of the six curated methods called on an editor handle and on the agent handle. A
 * reading is offered when it is the kind of a panel the row offers and the agent handle answers it, and `health`
 * (the mandatory core, no panel) unless the agent handle withholds it. Kafka withholds `storage`
 * (`KAFKA_AGENT_WITHHELD.storage`), etcd withholds `table-stats`, and MQTT, Sparkplug, OPC UA and MTConnect withhold
 * `health`.
 *
 * Transcribed from that measurement, never derived from `ENGINE_FACETS` or from the grant register's legacy rows, which
 * hold Studio's review of the claim, for the reason `EXPECTED_OFFERED` gives.
 */
const EXPECTED_AGENT_READINGS: Readonly<Record<DatabaseType, readonly CuratedOperationKind[]>> = {
  bigquery: ["sessions", "slow-queries", "table-stats", "storage", "health"],
  cassandra: ["sessions", "health"],
  clickhouse: SIX_READINGS,
  couchbase: SIX_READINGS,
  databend: SIX_READINGS,
  db2: ["table-stats", "health"],
  druid: ["sessions", "table-stats", "storage", "health"],
  duckdb: EMBEDDED_READINGS,
  elasticsearch: CATALOG_AND_STORAGE_READINGS,
  etcd: ["storage", "health"],
  firestore: HEALTH_ONLY,
  influxdb: HEALTH_ONLY,
  influxdb3: HEALTH_ONLY,
  kafka: HEALTH_ONLY,
  kubernetes: HEALTH_ONLY,
  libredb: CATALOG_AND_STORAGE_READINGS,
  libsql: EMBEDDED_READINGS,
  milvus: VECTOR_READINGS,
  modbus: HEALTH_ONLY,
  mongodb: SIX_READINGS,
  mqtt: [],
  mssql: SIX_READINGS,
  mtconnect: [],
  mysql: SIX_READINGS,
  neo4j: ["sessions", "table-stats", "index-stats", "health"],
  netconf: HEALTH_ONLY,
  opcua: [],
  opensearch: CATALOG_AND_STORAGE_READINGS,
  oracle: SIX_READINGS,
  oxia: HEALTH_ONLY,
  postgres: SIX_READINGS,
  prometheus: CATALOG_AND_STORAGE_READINGS,
  qdrant: VECTOR_READINGS,
  rabbitmq: HEALTH_ONLY,
  redis: ["sessions", "slow-queries", "storage", "health"],
  s3: HEALTH_ONLY,
  snmp: HEALTH_ONLY,
  snowflake: SIX_READINGS,
  spark: HEALTH_ONLY,
  sparkplug: [],
  sqlite: EMBEDDED_READINGS,
  trino: ["sessions", "slow-queries", "table-stats", "storage", "health"],
  weaviate: VECTOR_READINGS,
};

/** Studio's review of each engine's agent readings claim: its legacy row's `agentReadings` in the grant register. */
const REVIEWED_AGENT_READINGS = legacyRegisterTable("agentReadings");

const offeredBy = (id: DatabaseType): MonitoringPanel[] =>
  MONITORING_PANELS.filter((panel) => ENGINE_FACETS[id].monitoring[panel] === "offered");

/** The engine's committed declaration file, whose `facets` members are authored there. */
function committedDeclaration(id: DatabaseType): EngineDeclaration {
  const file = path.join(import.meta.dir, "../../../../src/lib/db/engine-declarations", `${id}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
}

/**
 * Where a provider's facet row and its engine's declaration disagree: `<id> monitoring` unless the declaration states
 * every panel, in `MONITORING_PANELS` order, as the row states it, and `<id> maintenance` unless the declaration lists
 * the row's maintenance operations in the row's order.
 */
function facetRowDifferences(
  id: DatabaseType,
  row: Pick<EngineFacets, "monitoring" | "maintenance">,
  facets: EngineDeclaration["facets"],
): string[] {
  const monitoring = MONITORING_PANELS.map((panel) => [panel, row.monitoring[panel]]);
  return [
    ...(JSON.stringify(Object.entries(facets.monitoring)) === JSON.stringify(monitoring) ? [] : [`${id} monitoring`]),
    ...(JSON.stringify(facets.maintenance) === JSON.stringify(row.maintenance) ? [] : [`${id} maintenance`]),
  ];
}

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
      // A row holds its monitoring panels and maintenance operations only: Studio's review of the agent readings is
      // the engine's legacy row in the grant register.
      expect(Object.keys(ENGINE_FACETS[id]), id).toEqual(["monitoring", "maintenance"]);
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

  test("each engine offers the agent readings measured on the agent handle", () => {
    const reviewed = Object.fromEntries(ALL.map((id) => [id, [...REVIEWED_AGENT_READINGS[id]]]));
    expect(reviewed).toEqual(Object.fromEntries(ALL.map((id) => [id, [...EXPECTED_AGENT_READINGS[id]]])));
  });

  test("every agent reading is the kind of a panel the row offers, or health", () => {
    const stray = ALL.flatMap((id) =>
      REVIEWED_AGENT_READINGS[id]
        .filter((kind) => {
          const panel = AGENT_READING_PANELS[kind];
          return panel !== null && ENGINE_FACETS[id].monitoring[panel] !== "offered";
        })
        .map((kind) => `${id} ${kind}`),
    );
    expect(stray).toEqual([]);
  });

  test("agent readings are listed once each, in CURATED_OPERATION_KINDS order", () => {
    const misordered = ALL.filter((id) => {
      const readings = REVIEWED_AGENT_READINGS[id];
      return readings.join() !== CURATED_OPERATION_KINDS.filter((kind) => readings.includes(kind)).join();
    });
    expect(misordered).toEqual([]);
  });

  test("each provider's facet row equals its declaration's authored facets, for every engine the catalog serves", () => {
    expect([...SHIPPED_DATABASE_TYPES].sort()).toEqual([...ALL].sort());
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((id) =>
        facetRowDifferences(id, ENGINE_FACETS[id], committedDeclaration(id).facets),
      ),
    ).toEqual([]);
    // Vacuity: a row with one panel flipped, and one with an operation dropped, each fails by name.
    const postgres = ENGINE_FACETS.postgres;
    const flipped = { ...postgres, monitoring: { ...postgres.monitoring, performance: "not-offered" as const } };
    const dropped = { ...postgres, maintenance: postgres.maintenance.filter((operation) => operation !== "kill") };
    const declaration = committedDeclaration("postgres").facets;
    expect(facetRowDifferences("postgres", flipped, declaration)).toEqual(["postgres monitoring"]);
    expect(facetRowDifferences("postgres", dropped, declaration)).toEqual(["postgres maintenance"]);
    // A declaration stating every panel but out of `MONITORING_PANELS` order differs too.
    const { overview, ...rest } = declaration.monitoring;
    const reordered = { ...declaration, monitoring: { ...rest, overview } };
    expect(facetRowDifferences("postgres", postgres, reordered)).toEqual(["postgres monitoring"]);
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
