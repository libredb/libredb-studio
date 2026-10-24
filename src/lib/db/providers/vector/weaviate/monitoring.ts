/**
 * Pure mappings from Weaviate's answers to the monitoring types (#1566 spec 7). A figure Weaviate's read routes do
 * not report is left out or reads "N/A", never zero: there is no uptime, no connection count and no size on disk in
 * `/v1/meta` or `/v1/schema`. `/v1/nodes` object counts are never used: they read 0 for collections that held objects
 * twenty minutes after they were written (spec A.9), so counts are aggregate `meta.count`, which is exact.
 *
 * Pure: it receives answers and never a client; monitoring-reads.ts makes the reads.
 */
import type { DatabaseOverview, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import { VISIBLE_TO_CREDENTIAL } from "./objects";
import { vectorColumnName, type WeaviateClass } from "./schema";

const NOT_REPORTED = "N/A";

/** The collections the Tables panel counts, in listing order, as Qdrant's 200. */
export const WEAVIATE_TABLE_STATS_LIMIT = 200;

/** Reachability and readiness only: `/v1/.well-known/ready` answers without a key. */
export function toWeaviateHealth(): HealthInfo {
  return { databaseSize: NOT_REPORTED, cacheHitRatio: NOT_REPORTED, slowQueries: [], activeSessions: [] };
}

export interface WeaviateOverviewInput {
  readonly version: string | null;
  readonly collections: readonly WeaviateClass[];
  readonly scoped: boolean;
}

/** One vector index per vector of every collection. */
export function weaviateIndexCount(collections: readonly WeaviateClass[]): number {
  return collections.reduce((total, collection) => total + collection.vectors.length, 0);
}

export function toWeaviateOverview(input: WeaviateOverviewInput): DatabaseOverview {
  return {
    version: input.version ?? NOT_REPORTED,
    uptime: NOT_REPORTED,
    maxConnections: 0,
    databaseSize: NOT_REPORTED,
    tableCount: input.collections.length,
    ...(input.scoped ? { tableCountSampledFrom: VISIBLE_TO_CREDENTIAL } : {}),
    indexCount: weaviateIndexCount(input.collections),
  };
}

/** One row per counted collection, its exact count; a collection whose count was not read is left out. */
export function toWeaviateTableStats(
  counts: readonly { readonly name: string; readonly count: number | null }[],
): TableStats[] {
  return counts.flatMap(({ name, count }) =>
    count === null
      ? []
      : [{ schemaName: "", tableName: name, rowCount: count, totalSize: NOT_REPORTED, totalSizeBytes: 0 }],
  );
}

/** One row per vector index: the collection, the vector's column, the index type with its distance and compression. */
export function toWeaviateIndexStats(collections: readonly WeaviateClass[]): IndexStats[] {
  return collections.flatMap((collection) =>
    collection.vectors.map(
      (vector): IndexStats => ({
        schemaName: "",
        tableName: collection.name,
        indexName: vectorColumnName(vector.name),
        indexType: [vector.indexType, vector.distance, vector.quantization].filter((part) => part !== null).join(", "),
        columns: [vectorColumnName(vector.name)],
        isUnique: false,
        isPrimary: false,
        indexSize: NOT_REPORTED,
        scans: 0,
      }),
    ),
  );
}
