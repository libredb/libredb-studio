/**
 * The Weaviate monitoring reads (#1566 spec 7) over a recording `send`: health is one readiness probe, the overview
 * `GET /v1/meta` and `GET /v1/schema`, the Tables panel one schema read then one exact count per single-tenant
 * collection of the first 200 by name, one after another, and the Indexes panel the schema read alone.
 */
import { describe, expect, test } from "bun:test";
import {
  readWeaviateHealth,
  readWeaviateIndexStats,
  readWeaviateOverview,
  readWeaviateTableStats,
} from "@/lib/db/providers/vector/weaviate/monitoring-reads";
import { toWeaviateIndexStats } from "@/lib/db/providers/vector/weaviate/monitoring";
import { VISIBLE_TO_CREDENTIAL } from "@/lib/db/providers/vector/weaviate/objects";
import { readWeaviateSchema } from "@/lib/db/providers/vector/weaviate/schema";
import { expectCalls } from "../../../helpers/call-log";
import {
  type Answering,
  capturedServer,
  capturedText,
  json,
  overriding,
  surfaceContext,
} from "../../../helpers/weaviate-surface";

const SURFACE = capturedServer("weaviate/surface.json");
const SURFACE_1_37 = capturedServer("weaviate-1-37/surface.json");

describe("health", () => {
  test("one readiness probe, which carries no credential evidence", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    expect(await readWeaviateHealth(context)).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expectCalls(calls, [{ method: "ready", args: [{ op: "ready", params: {}, query: {} }] }]);
  });
});

describe("the overview", () => {
  test("meta for the version, the schema for the collections and their indexes", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    expect(await readWeaviateOverview(context)).toEqual({
      version: "1.40.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 7,
      indexCount: 8,
    });
    expectCalls(calls, ["meta", "schema"]);
  });

  test("a version that is not a short token reads N/A; a credential scopes the count", async () => {
    const { context } = surfaceContext(
      overriding(SURFACE, { meta: () => json({ version: "a sentence, not a version" }) }),
      {
        scoped: true,
      },
    );
    const overview = await readWeaviateOverview(context);
    expect(overview.version).toBe("N/A");
    expect(overview.tableCountSampledFrom).toBe(VISIBLE_TO_CREDENTIAL);
  });
});

describe("the Tables panel", () => {
  test("one exact count per single-tenant collection, by name, one after another; multi-tenant ones left out", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const counting: Answering = async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(1);
      inFlight -= 1;
      return SURFACE(request);
    };
    const { context, calls } = surfaceContext(counting);
    expect(await readWeaviateTableStats(context)).toEqual(
      (
        [
          ["Article", 500],
          ["Author", 12],
          ["EdgeValues", 8],
          ["Empty", 0],
          ["Product", 200],
        ] as const
      ).map(([tableName, rowCount]) => ({ schemaName: "", tableName, rowCount, totalSize: "N/A", totalSizeBytes: 0 })),
    );
    expect(calls.map((call) => call.method)).toEqual(["schema", ...Array(5).fill("aggregate")]);
    expect(
      calls.slice(1).map((call) => (call.args as [{ params: { collection: string } }])[0].params.collection),
    ).toEqual(["Article", "Author", "EdgeValues", "Empty", "Product"]);
    expect(maxInFlight).toBe(1);
  });

  test("on 1.37 each count goes over GraphQL", async () => {
    const { context, calls } = surfaceContext(SURFACE_1_37, { version: "1.37.4" });
    const stats = await readWeaviateTableStats(context);
    expect(stats.map((row) => row.rowCount)).toEqual([500, 12, 8, 0, 200]);
    expect(calls.slice(1).every((call) => call.method === "graphql")).toBe(true);
  });

  test("a count that fails leaves its collection out, and the rest are still read", async () => {
    const { context, calls } = surfaceContext(
      overriding(SURFACE, {
        aggregate: (request) =>
          request.params.collection === "Author" ? json({ error: [{ message: "boom" }] }, 500) : SURFACE(request),
      }),
    );
    const stats = await readWeaviateTableStats(context);
    expect(stats.map((row) => row.tableName)).toEqual(["Article", "EdgeValues", "Empty", "Product"]);
    expect(calls).toHaveLength(6);
  });

  test("only the first 200 collections by name are counted", async () => {
    const classes = Array.from({ length: 205 }, (_, index) => ({ class: `C${String(204 - index).padStart(3, "0")}` }));
    const { context, calls } = surfaceContext((request) =>
      request.op === "schema" ? json({ classes }) : json({ count: 1 }),
    );
    const stats = await readWeaviateTableStats(context);
    expect(stats).toHaveLength(200);
    expect(stats[0].tableName).toBe("C000");
    expect(stats.at(-1)?.tableName).toBe("C199");
    expect(calls).toHaveLength(201);
  });
});

describe("the Indexes panel", () => {
  test("the schema read alone, one row per vector", async () => {
    const { context, calls } = surfaceContext(SURFACE);
    const schema = readWeaviateSchema(JSON.parse(capturedText("weaviate/surface.json", "GET", "/v1/schema")));
    const sorted = [...schema].sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(await readWeaviateIndexStats(context)).toEqual(toWeaviateIndexStats(sorted));
    expectCalls(calls, ["schema"]);
  });
});
