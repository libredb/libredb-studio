/**
 * The Milvus monitoring reads: the Tables and index panels read the first 200
 * collections of the selected database at concurrency 4, each row through the pure mapping and nothing else; a
 * collection refused for want of a privilege is left out, and a panel every collection of which is refused raises the
 * engine's sentence rather than an empty list; the overview reads the listing and the index rows; health is
 * CheckHealth; and no panel reads GetMetrics.
 */
import { describe, expect, test } from "bun:test";
import {
  MILVUS_PANEL_BOUND,
  readMilvusHealth,
  readMilvusIndexStats,
  readMilvusOverview,
  readMilvusTableStats,
} from "@/lib/db/providers/vector/milvus/monitoring-reads";
import { toMilvusIndexStats, toMilvusTableStats } from "@/lib/db/providers/vector/milvus/monitoring";
import type { MilvusVersion } from "@/lib/db/providers/vector/milvus/versions";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  type FakeCollection,
  permissionDenied,
  plainCollection,
  settle,
  testSurface,
  unimplemented,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

const VERSION: MilvusVersion = { reported: "v3.0.2", major: 3, minor: 0 };

/** `count` collections c_000 and up, each with `rowCount` rows and one HNSW index on `vec`. */
function many(count: number, database = "default"): FakeCollection[] {
  return Array.from({ length: count }, (_, at) => ({
    describe: plainCollection(`c_${String(at).padStart(3, "0")}`, database),
    indexes: [wireIndex("vec", "HNSW", "L2")],
    rowCount: String(at * 10),
  }));
}
const namesOf = (count: number) => Array.from({ length: count }, (_, at) => `c_${String(at).padStart(3, "0")}`);

describe("readMilvusTableStats", () => {
  test("one GetCollectionStatistics per collection of the first 200 names, mapped by toMilvusTableStats", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(250) } });
    const rows = await readMilvusTableStats(client, testSurface(), "default");
    expect(rows).toEqual(
      toMilvusTableStats(
        "default",
        namesOf(200).map((collection, at) => ({ collection, rowCount: String(at * 10) })),
      ),
    );
    expect(client.calls.filter((call) => call.method === "getCollectionStatistics")).toHaveLength(MILVUS_PANEL_BOUND);
    expect(client.calls[0]).toEqual({ method: "showCollections", args: ["default"] });
  });

  test("never more than 4 statistics reads in flight", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(10) } });
    const release = client.hold("getCollectionStatistics");
    const pending = readMilvusTableStats(client, testSurface({}, 8), "default");
    await settle();
    expect(client.inFlight()).toBe(4);
    release();
    expect(await pending).toHaveLength(10);
    expect(client.maxInFlight()).toBe(4);
  });

  test("a collection refused for want of a privilege is left out", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(3) } });
    client.on("getCollectionStatistics", (_db, request) =>
      (request as { collection_name: string }).collection_name === "c_001"
        ? permissionDenied("GetStatistics")
        : undefined,
    );
    const rows = await readMilvusTableStats(client, testSurface(), "default");
    expect(rows.map((row) => row.tableName)).toEqual(["c_000", "c_002"]);
  });

  test("a panel every collection of which is refused raises the engine's sentence, never an empty list", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(3) } });
    client.on("getCollectionStatistics", () => permissionDenied("GetStatistics"));
    await expect(readMilvusTableStats(client, testSurface(), "default")).rejects.toThrow(
      "The Milvus user lacks the privilege",
    );
  });

  test("an answer with no row_count is refused naming the collection", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(1) } });
    client.on("getCollectionStatistics", () => ({ status: { code: 0, error_code: "Success" }, stats: [] }));
    await expect(readMilvusTableStats(client, testSurface(), "default")).rejects.toThrow(
      "Milvus answered the statistics of collection c_000 with no row_count.",
    );
  });

  test("an empty database is an empty panel, after one listing", async () => {
    const client = createFakeMilvusClient({ databases: { default: [] } });
    expect(await readMilvusTableStats(client, testSurface(), "default")).toEqual([]);
    expectCalls(client, ["showCollections"]);
  });
});

describe("readMilvusIndexStats", () => {
  test("one DescribeIndex per collection under the bound, every index a row; 700 contributes none", async () => {
    const collections = [...many(2), { describe: plainCollection("noidx") }];
    const client = createFakeMilvusClient({ databases: { default: collections } });
    const rows = await readMilvusIndexStats(client, testSurface(), "default");
    expect(rows).toEqual([
      ...toMilvusIndexStats("default", "c_000", [wireIndex("vec", "HNSW", "L2")]),
      ...toMilvusIndexStats("default", "c_001", [wireIndex("vec", "HNSW", "L2")]),
    ]);
  });

  test("a gRPC 7 on one collection leaves it out, and every collection denied raises", async () => {
    const one = createFakeMilvusClient({ databases: { default: many(2) } });
    one.on("describeIndex", (_db, request) =>
      (request as { collection_name: string }).collection_name === "c_000"
        ? permissionDenied("IndexDetail")
        : undefined,
    );
    expect((await readMilvusIndexStats(one, testSurface(), "default")).map((row) => row.tableName)).toEqual(["c_001"]);
    const all = createFakeMilvusClient({ databases: { default: many(2) } });
    all.on("describeIndex", () => permissionDenied("IndexDetail"));
    await expect(readMilvusIndexStats(all, testSurface(), "default")).rejects.toThrow(
      "The Milvus user lacks the privilege",
    );
  });

  test("UNIMPLEMENTED is the panel's 'not supported by this server version', never an empty panel", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(1) } });
    client.on("describeIndex", () => unimplemented("DescribeIndex"));
    await expect(readMilvusIndexStats(client, testSurface(), "default")).rejects.toThrow(
      "not supported by this server version",
    );
  });
});

describe("readMilvusOverview", () => {
  test("the version from connect, the database's collections and the index rows of the bound", async () => {
    const client = createFakeMilvusClient({
      databases: { default: [...many(3), { describe: plainCollection("noidx") }] },
    });
    expect(await readMilvusOverview(client, testSurface(), "default", VERSION)).toEqual({
      version: "v3.0.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 4,
      tableCountSampledFrom: "the collections of database default visible to this Milvus user",
      indexCount: 3,
    });
    expect(client.calls.filter((call) => call.method === "showCollections")).toHaveLength(1);
  });
});

describe("readMilvusHealth", () => {
  test("CheckHealth, one call", async () => {
    const client = createFakeMilvusClient({ databases: {} });
    expect(await readMilvusHealth(client, testSurface())).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expectCalls(client, ["checkHealth"]);
  });

  test("an unhealthy server is raised with its reasons", async () => {
    const client = createFakeMilvusClient({ databases: {}, health: { isHealthy: false, reasons: ["querynode down"] } });
    await expect(readMilvusHealth(client, testSurface())).rejects.toThrow(
      "Milvus reports that it is not healthy: querynode down",
    );
  });
});

describe("no panel reads GetMetrics", () => {
  test("health, tables, indexes and the overview send no GetMetrics", async () => {
    const client = createFakeMilvusClient({ databases: { default: many(2) } });
    const context = testSurface();
    await readMilvusHealth(client, context);
    await readMilvusTableStats(client, context, "default");
    await readMilvusIndexStats(client, context, "default");
    await readMilvusOverview(client, context, "default", VERSION);
    expect(client.calls.map((call) => call.method)).not.toContain("getMetricsSystemInfo");
  });
});
