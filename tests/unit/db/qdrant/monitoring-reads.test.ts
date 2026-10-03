/**
 * The monitoring reads (vector-family spec 6.8, QE16) over a recording `send` that answers from the captures of the
 * seeded server: which reads each panel makes, the 200-collection bound, four descriptions in flight, and that no
 * panel asks for anything but `GET /`, `GET /collections` and `GET /collections/{collection_name}`.
 */
import { describe, expect, test } from "bun:test";
import type { QdrantAnswer, QdrantRequest } from "@/lib/db/providers/vector/qdrant/client";
import { readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import {
  readQdrantHealth,
  readQdrantIndexStats,
  readQdrantOverview,
  readQdrantTableStats,
  type QdrantMonitoringContext,
} from "@/lib/db/providers/vector/qdrant/monitoring-reads";
import { toQdrantIndexStats, toQdrantTableStats } from "@/lib/db/providers/vector/qdrant/monitoring";
import { expectCalls } from "../../../helpers/call-log";
import { recordedAnswer, resultOf, SEEDED_COLLECTIONS, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";
import { recordingSend } from "../../../helpers/qdrant-surface-client";

function contextOf(answer?: (request: QdrantRequest) => QdrantAnswer | Promise<QdrantAnswer>, scoped = false) {
  const recording = recordingSend(answer);
  const context: QdrantMonitoringContext = {
    send: recording.send,
    signal: new AbortController().signal,
    sliceSupported: true,
    scoped,
  };
  return { context, recording };
}

const DESCRIBES = SEEDED_COLLECTIONS.map(() => "get_collection");

/** A server listing `count` collections, each described as the seeded `plain` collection is. */
function manyCollections(count: number) {
  return async (request: QdrantRequest): Promise<QdrantAnswer> => {
    if (request.op !== "get_collections") {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return recordedAnswer({ ...request, params: { collection_name: "plain" } });
    }
    const collections = Array.from({ length: count }, (_, index) => ({ name: `c${index}` }));
    return {
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: JSON.stringify({ result: { collections } }),
    };
  };
}

describe("readQdrantHealth", () => {
  test("one GET /, and the health is reachability only", async () => {
    const { context, recording } = contextOf();
    expect(await readQdrantHealth(context)).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expectCalls(recording, ["root"]);
  });
});

describe("readQdrantOverview", () => {
  test("GET /, the listing, then every listed collection's description", async () => {
    const { context, recording } = contextOf();
    const overview = await readQdrantOverview(context);
    expectCalls(recording, ["root", "get_collections", ...DESCRIBES]);
    expect(overview).toEqual({
      version: "1.19.1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 7,
      indexCount: 29,
    });
  });

  test("with a credential the count is labelled as what it may see", async () => {
    const { context } = contextOf(undefined, true);
    expect((await readQdrantOverview(context)).tableCountSampledFrom).toBe(
      "the collections visible to this credential",
    );
  });

  test("past 200 collections the count is every listed one and the indexes are the first 200's", async () => {
    const { context, recording } = contextOf(manyCollections(203));
    const overview = await readQdrantOverview(context);
    expect(overview.tableCount).toBe(203);
    expect(overview.indexCount).toBe(200);
    expect(recording.calls.filter((call) => call.method === "get_collection")).toHaveLength(200);
    expect(recording.maxInFlight()).toBe(4);
  });
});

describe("readQdrantTableStats and readQdrantIndexStats", () => {
  test("the listing, then each description: the rows are monitoring.ts's over the same answers", async () => {
    const described = SEEDED_COLLECTIONS.map((name) =>
      readQdrantCollection(name, resultOf(vectorCapture(`describe-${name}`))),
    );
    const tables = contextOf();
    expect(await readQdrantTableStats(tables.context)).toEqual(toQdrantTableStats(described));
    expectCalls(tables.recording, ["get_collections", ...DESCRIBES]);
    const indexes = contextOf();
    expect(await readQdrantIndexStats(indexes.context)).toEqual(toQdrantIndexStats(described));
    expectCalls(indexes.recording, ["get_collections", ...DESCRIBES]);
  });

  test("the first 200 collections, four described at a time", async () => {
    const { context, recording } = contextOf(manyCollections(250));
    const rows = await readQdrantTableStats(context);
    expect(rows).toHaveLength(200);
    expect(rows[199].tableName).toBe("c199");
    expect(recording.calls).toHaveLength(201);
    expect(recording.maxInFlight()).toBe(4);
  });

  test("no panel sends any operation but root, the listing and a description", async () => {
    const { context, recording } = contextOf();
    await readQdrantHealth(context);
    await readQdrantOverview(context);
    await readQdrantTableStats(context);
    await readQdrantIndexStats(context);
    expect(new Set(recording.calls.map((call) => call.method))).toEqual(
      new Set(["root", "get_collections", "get_collection"]),
    );
  });
});
