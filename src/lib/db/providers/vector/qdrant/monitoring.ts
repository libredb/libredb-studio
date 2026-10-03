/**
 * Pure mappings from Qdrant's descriptions to the monitoring types (vector-family spec 6.8). A figure Qdrant's
 * routes do not report is left out or reads "N/A", never zero: there is no uptime, no connection count, no size on
 * disk and no cache ratio in `GET /` or `GET /collections/{collection_name}`, and the reads that hold them
 * (`/telemetry`, `/metrics`) are never made. Collection `metadata` and every payload value stay out.
 *
 * Pure (3.13): it receives descriptions and never a client; monitoring-reads.ts makes the reads.
 */
import type { DatabaseOverview, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import { VISIBLE_TO_CREDENTIAL } from "./objects";
import { type QdrantCollection, qdrantCount, qdrantPayloadIndexes, qdrantVectors } from "./schema";

/** What Qdrant's read routes do not report, in the words the panels already render. */
const NOT_REPORTED = "N/A";

/** The collections the Tables and index panels describe, in listing order (spec 6.6). */
export const QDRANT_TABLE_STATS_LIMIT = 200;

/** Reachability only: `GET /` answers without a key, so this is never evidence of the credential. */
export function toQdrantHealth(): HealthInfo {
  return { databaseSize: NOT_REPORTED, cacheHitRatio: NOT_REPORTED, slowQueries: [], activeSessions: [] };
}

/** The indexes of described collections: one per payload index and one per vector. */
export function qdrantIndexCount(collections: readonly QdrantCollection[]): number {
  return collections.reduce(
    (total, collection) => total + qdrantPayloadIndexes(collection).length + qdrantVectors(collection).length,
    0,
  );
}

export interface QdrantOverviewInput {
  /** The version `GET /` reports, or null where it reports none Studio repeats. */
  readonly version: string | null;
  /** How many collections the listing holds. */
  readonly collections: number;
  /** The indexes of the collections within the Tables bound. */
  readonly indexCount: number;
  /** A credential is configured, so the listing holds what it may see. */
  readonly scoped: boolean;
}

/** The overview: the version, the visible collections and their indexes; every size and timing absent or "N/A". */
export function toQdrantOverview(input: QdrantOverviewInput): DatabaseOverview {
  return {
    version: input.version ?? NOT_REPORTED,
    uptime: NOT_REPORTED,
    maxConnections: 0,
    databaseSize: NOT_REPORTED,
    tableCount: input.collections,
    ...(input.scoped ? { tableCountSampledFrom: VISIBLE_TO_CREDENTIAL } : {}),
    indexCount: input.indexCount,
  };
}

/**
 * One row per collection: its `points_count`, which Qdrant documents as approximate (`tableStatsCaption` says so),
 * and no size, which no read route reports. A collection sits in no container, so `schemaName` is empty, as etcd's
 * and Prometheus's are.
 */
export function toQdrantTableStats(collections: readonly QdrantCollection[]): TableStats[] {
  return collections.map((collection) => ({
    schemaName: "",
    tableName: collection.name,
    rowCount: qdrantCount(collection.info.points_count) ?? 0,
    totalSize: NOT_REPORTED,
    totalSizeBytes: 0,
  }));
}

/**
 * One row per payload index, named by its key and typed by its index type, and one per vector, named by its column
 * and typed by its index in Qdrant's words. No index has a size, a scan count or a uniqueness in Qdrant's routes; a
 * payload index's point count and a vector's quantization are in the Source.
 */
export function toQdrantIndexStats(collections: readonly QdrantCollection[]): IndexStats[] {
  return collections.flatMap((collection) => {
    const row = (indexName: string, indexType: string): IndexStats => ({
      schemaName: "",
      tableName: collection.name,
      indexName,
      indexType,
      columns: [indexName],
      isUnique: false,
      isPrimary: false,
      indexSize: NOT_REPORTED,
      scans: 0,
    });
    return [
      ...qdrantPayloadIndexes(collection).map((index) => row(index.key, index.type)),
      ...qdrantVectors(collection).map((vector) => row(vector.column, vector.nativeIndex)),
    ];
  });
}
