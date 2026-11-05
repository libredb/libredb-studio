/**
 * A seed entry for every engine an MCP statement tool serves, for the tests that read what a token reaching every
 * served engine is listed (#2252, part 3). Listing opens nothing, so no host answers and no file needs to exist; each
 * entry carries only what the seed schema needs to load it.
 *
 * A served engine without a row here fails by name, so a newly served engine is added here rather than read less.
 */
import { join } from "node:path";
import { servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseType } from "@/lib/types";
import { TEST_TOKEN } from "./kubernetes-connection";
import type { SeedEntry } from "./mcp-fixtures";
import { RABBITMQ_TEST_PASSWORD } from "./rabbitmq-connection";

const HOST = "127.0.0.1";
const STAND_IN = ["not", "a", "real", "secret"].join("-");
const OWN_KEY = ["AKID", "OWN", "STANDIN"].join("");
const READ_KEY = ["AKID", "READ", "STANDIN"].join("");

type SeedFields = Omit<SeedEntry, "id" | "type">;

function servedSeedFields(dir: string): Partial<Record<DatabaseType, SeedFields>> {
  return {
    postgres: { host: HOST, port: 5432, database: "shop" },
    sqlite: { database: join(dir, "served.db") },
    duckdb: { database: join(dir, "served.duckdb") },
    mssql: { host: HOST, port: 1433, database: "shop" },
    mysql: { host: HOST, port: 3306, database: "shop" },
    clickhouse: { host: HOST, port: 8123, database: "demo" },
    libsql: { host: HOST, port: 8080 },
    influxdb3: { host: HOST, port: 8181, database: "home" },
    elasticsearch: { host: HOST, port: 9200 },
    opensearch: { host: HOST, port: 9201 },
    oracle: { host: HOST, port: 1521, database: "FREEPDB1" },
    db2: { host: HOST, port: 50000, database: "SAMPLE" },
    cassandra: { host: HOST, port: 9042, database: "shop" },
    couchbase: { host: HOST, port: 8091, database: "travel" },
    kubernetes: { host: "api.example", port: 6443, database: "shop", password: TEST_TOKEN },
    mongodb: { host: HOST, port: 27017, database: "app" },
    libredb: { database: join(dir, "served.libredb") },
    weaviate: { host: HOST, port: 8080 },
    qdrant: { host: HOST, port: 6333 },
    neo4j: { host: HOST, port: 7687, database: "neo4j", user: "reader", password: STAND_IN },
    milvus: { host: HOST, port: 19530 },
    redis: { host: HOST, port: 6379, user: "reader", password: STAND_IN },
    etcd: { host: "etcd.test", port: 2379, user: "reader", password: STAND_IN },
    rabbitmq: { host: HOST, port: 15672, user: "studio-reader", password: RABBITMQ_TEST_PASSWORD },
    kafka: { host: "broker.example", port: 9092 },
    s3: { host: HOST, port: 9000, user: OWN_KEY, password: STAND_IN, agentUser: READ_KEY, agentPassword: STAND_IN },
    snmp: { host: HOST, port: 161, password: STAND_IN },
    opcua: { host: "opc.tcp://127.0.0.1:4840/plant", agentReadRoots: ["nsu=urn:libredb:test;s=Plant"] },
    mtconnect: { host: HOST, port: 5000 },
    mqtt: { host: "broker.test", port: 1883 },
    sparkplug: { host: "broker.test", port: 1883 },
  };
}

/** One seed per served engine, id `served-<type>`, offered to admins alone, file paths under `dir`. */
export function servedEngineSeeds(dir: string): SeedEntry[] {
  const fields = servedSeedFields(dir);
  const served = [...new Set(servingStatementArms().flatMap((arm) => arm.types))];
  return served.map((type) => {
    const row = fields[type];
    if (row === undefined) {
      throw new Error(
        `no seed row for the served engine ${type}: add one to servedSeedFields in tests/helpers/mcp-served-seeds.ts`,
      );
    }
    return Object.assign({ id: `served-${type}`, type }, row);
  });
}
