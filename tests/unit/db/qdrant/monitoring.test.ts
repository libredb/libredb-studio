/**
 * The pure monitoring mappings (vector-family spec 6.8), from the recorded descriptions of the seeded collections:
 * the figures Qdrant reports, "N/A" for what it does not, and the field mappings of the Tables and index panels.
 */
import { describe, expect, test } from "bun:test";
import {
  QDRANT_TABLE_STATS_LIMIT,
  qdrantIndexCount,
  toQdrantHealth,
  toQdrantIndexStats,
  toQdrantOverview,
  toQdrantTableStats,
} from "@/lib/db/providers/vector/qdrant/monitoring";
import { readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import { resultOf, SEEDED_COLLECTIONS, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";

const seeded = (collection: string) =>
  readQdrantCollection(collection, resultOf(vectorCapture(`describe-${collection}`)));
const ALL = SEEDED_COLLECTIONS.map(seeded);

describe("toQdrantHealth", () => {
  test("reachability only: no size, no cache ratio, no connection count", () => {
    expect(toQdrantHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
  });
});

describe("toQdrantOverview", () => {
  test("an open server: the version, the exact count and the indexes; every size and timing N/A", () => {
    expect(toQdrantOverview({ version: "1.19.1", collections: 7, indexCount: 38, scoped: false })).toEqual({
      version: "1.19.1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 7,
      indexCount: 38,
    });
  });

  test("with a credential the count is labelled as what it may see", () => {
    expect(toQdrantOverview({ version: "1.19.1", collections: 2, indexCount: 4, scoped: true })).toMatchObject({
      tableCount: 2,
      tableCountSampledFrom: "the collections visible to this credential",
    });
  });

  test("a server that reports no version Studio repeats reads N/A", () => {
    expect(toQdrantOverview({ version: null, collections: 0, indexCount: 0, scoped: false }).version).toBe("N/A");
  });
});

describe("qdrantIndexCount", () => {
  test("the payload indexes and the vectors of the seeded collections", () => {
    // docs: 11 payload indexes and 4 vectors; edge_values 5 vectors; empty_novec none; payload_spread and plain 1; scratch 2; small_dtypes 5.
    expect(qdrantIndexCount(ALL)).toBe(15 + 5 + 0 + 1 + 1 + 2 + 5);
    expect(qdrantIndexCount([])).toBe(0);
  });
});

describe("toQdrantTableStats", () => {
  test("one row per collection: the collection, its points_count, no size and no container", () => {
    expect(toQdrantTableStats([seeded("docs"), seeded("empty_novec")])).toEqual([
      { schemaName: "", tableName: "docs", rowCount: 2000, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "", tableName: "empty_novec", rowCount: 0, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
  });

  test("a points_count the server does not report reads 0, never a guess", () => {
    const collection = readQdrantCollection("probe", { config: { params: {} } });
    expect(toQdrantTableStats([collection])[0].rowCount).toBe(0);
  });

  test("the panels describe the first 200 collections", () => {
    expect(QDRANT_TABLE_STATS_LIMIT).toBe(200);
  });
});

describe("toQdrantIndexStats", () => {
  test("docs: a row per payload index named by its key, then a row per vector named by its column", () => {
    const rows = toQdrantIndexStats([seeded("docs")]);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toEqual({
      schemaName: "",
      tableName: "docs",
      indexName: "active",
      indexType: "bool",
      columns: ["active"],
      isUnique: false,
      isPrimary: false,
      indexSize: "N/A",
      scans: 0,
    });
    expect(rows.find((row) => row.indexName === "meta.owner.team")).toMatchObject({ indexType: "keyword" });
    expect(rows.slice(11).map((row) => [row.indexName, row.indexType, row.columns])).toEqual([
      ["vector.colbert", "HNSW", ["vector.colbert"]],
      ["vector.image", "HNSW", ["vector.image"]],
      ["vector.text", "HNSW", ["vector.text"]],
      ["vector.keywords", "sparse inverted index", ["vector.keywords"]],
    ]);
  });

  test("an unnamed vector's row is the column vector", () => {
    expect(toQdrantIndexStats([seeded("plain")])).toEqual([
      expect.objectContaining({ tableName: "plain", indexName: "vector", indexType: "HNSW", columns: ["vector"] }),
    ]);
  });

  test("no row carries the collection's metadata", () => {
    const collection = readQdrantCollection("probe", {
      config: {
        params: { vectors: { size: 4, distance: "Dot" } },
        hnsw_config: { m: 16 },
        metadata: { m: "MARKER_META" },
      },
    });
    const text = JSON.stringify([toQdrantIndexStats([collection]), toQdrantTableStats([collection])]);
    expect(text).not.toContain("MARKER_META");
  });
});
