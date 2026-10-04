/**
 * The monitoring reads of vector-family spec 6.8, minimised (QE16): `GET /` for the version and reachability,
 * `GET /collections` for the listing, and `GET /collections/{collection_name}` for the first 200 collections, four
 * in flight. The client cannot build `/telemetry`, `/metrics` or any health, profiler or debug path, and nothing
 * here asks for one. monitoring.ts shapes every answer.
 */
import type { DatabaseOverview, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import { describeQdrantCollections, listQdrantCollectionNames, type QdrantSurfaceContext } from "./objects";
import {
  QDRANT_TABLE_STATS_LIMIT,
  qdrantIndexCount,
  toQdrantHealth,
  toQdrantIndexStats,
  toQdrantOverview,
  toQdrantTableStats,
} from "./monitoring";
import { readQdrantVersion } from "./versions";

/** The reads monitoring sends, and nothing else (3.13). */
export type QdrantMonitoringOp = "root" | "get_collections" | "get_collection";

export type QdrantMonitoringContext = QdrantSurfaceContext<QdrantMonitoringOp>;

/** `GET /`, reachability only. */
export async function readQdrantHealth(context: QdrantSurfaceContext<"root">): Promise<HealthInfo> {
  await context.send({ op: "root", params: {}, query: {} }, context.signal);
  return toQdrantHealth();
}

/** The first 200 listed collections' descriptions. */
async function describedWithinBound(context: QdrantSurfaceContext<"get_collections" | "get_collection">) {
  const names = await listQdrantCollectionNames(context);
  return {
    names,
    described: await describeQdrantCollections(context, names.slice(0, QDRANT_TABLE_STATS_LIMIT)),
  };
}

/** The version from `GET /`, the visible collections, and the indexes of the first 200. */
export async function readQdrantOverview(context: QdrantMonitoringContext): Promise<DatabaseOverview> {
  const root = await context.send({ op: "root", params: {}, query: {} }, context.signal);
  const { names, described } = await describedWithinBound(context);
  return toQdrantOverview({
    version: readQdrantVersion(root.text).reported,
    collections: names.length,
    indexCount: qdrantIndexCount(described),
    scoped: context.scoped,
  });
}

/** One row per collection, the first 200, read when the panel opens. */
export async function readQdrantTableStats(
  context: QdrantSurfaceContext<"get_collections" | "get_collection">,
): Promise<TableStats[]> {
  return toQdrantTableStats((await describedWithinBound(context)).described);
}

/** One row per payload index and per vector of the first 200 collections. */
export async function readQdrantIndexStats(
  context: QdrantSurfaceContext<"get_collections" | "get_collection">,
): Promise<IndexStats[]> {
  return toQdrantIndexStats((await describedWithinBound(context)).described);
}
