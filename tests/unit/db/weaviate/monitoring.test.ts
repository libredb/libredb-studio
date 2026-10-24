/**
 * The Weaviate monitoring shapes (#1566 spec 7): a figure Weaviate's read routes do not report reads "N/A" or is
 * left out, never zero; the overview counts the collections and one vector index per vector; the Tables panel holds
 * exact counts only, a collection whose count was not read left out; the Indexes panel names each vector's index
 * type, distance and compression.
 */
import { describe, expect, test } from "bun:test";
import {
  toWeaviateHealth,
  toWeaviateIndexStats,
  toWeaviateOverview,
  toWeaviateTableStats,
  WEAVIATE_TABLE_STATS_LIMIT,
  weaviateIndexCount,
} from "@/lib/db/providers/vector/weaviate/monitoring";
import { VISIBLE_TO_CREDENTIAL } from "@/lib/db/providers/vector/weaviate/objects";
import { readWeaviateSchema } from "@/lib/db/providers/vector/weaviate/schema";
import { capturedText } from "../../../helpers/weaviate-surface";

const COLLECTIONS = readWeaviateSchema(JSON.parse(capturedText("weaviate/surface.json", "GET", "/v1/schema")));
const byName = (name: string) => COLLECTIONS.filter((collection) => collection.name === name);

describe("health", () => {
  test("readiness only: no size, no cache ratio, no slow query, no session", () => {
    expect(toWeaviateHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
  });
});

describe("the overview", () => {
  test("the version, the collection count, one index per vector; uptime and size not reported", () => {
    expect(weaviateIndexCount(COLLECTIONS)).toBe(8);
    expect(toWeaviateOverview({ version: "1.40.2", collections: COLLECTIONS, scoped: false })).toEqual({
      version: "1.40.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 7,
      indexCount: 8,
    });
  });

  test("a version not reported reads N/A; a credential says what the count was taken from", () => {
    expect(toWeaviateOverview({ version: null, collections: [], scoped: true })).toEqual({
      version: "N/A",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 0,
      tableCountSampledFrom: VISIBLE_TO_CREDENTIAL,
      indexCount: 0,
    });
  });
});

describe("the Tables panel", () => {
  test("one row per counted collection with its exact count, in the order given", () => {
    expect(
      toWeaviateTableStats([
        { name: "Article", count: 500 },
        { name: "Broken", count: null },
        { name: "Empty", count: 0 },
      ]),
    ).toEqual([
      { schemaName: "", tableName: "Article", rowCount: 500, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "", tableName: "Empty", rowCount: 0, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
    expect(WEAVIATE_TABLE_STATS_LIMIT).toBe(200);
  });
});

describe("the Indexes panel", () => {
  test("one row per vector: the unnamed one as $vector, a named one as $vector.<name>", () => {
    expect(toWeaviateIndexStats(byName("Product"))).toEqual([
      {
        schemaName: "",
        tableName: "Product",
        indexName: "$vector.image",
        indexType: "hnsw, cosine",
        columns: ["$vector.image"],
        isUnique: false,
        isPrimary: false,
        indexSize: "N/A",
        scans: 0,
      },
      {
        schemaName: "",
        tableName: "Product",
        indexName: "$vector.text",
        indexType: "flat, dot",
        columns: ["$vector.text"],
        isUnique: false,
        isPrimary: false,
        indexSize: "N/A",
        scans: 0,
      },
    ]);
    expect(toWeaviateIndexStats(byName("Article")).map((row) => row.indexName)).toEqual(["$vector"]);
  });

  test("the compression joins the type; a distance not declared is left out", () => {
    const [compressed] = readWeaviateSchema({
      classes: [
        { class: "C", vectorIndexType: "hnsw", vectorIndexConfig: { distance: "cosine", pq: { enabled: true } } },
      ],
    });
    const [bare] = readWeaviateSchema({ classes: [{ class: "D", vectorIndexType: "flat" }] });
    expect(toWeaviateIndexStats([compressed, bare]).map((row) => row.indexType)).toEqual(["hnsw, cosine, pq", "flat"]);
  });

  test("a collection with no vector has no index row", () => {
    expect(toWeaviateIndexStats(readWeaviateSchema({ classes: [{ class: "Plain" }] }))).toEqual([]);
  });
});
