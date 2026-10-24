/**
 * The monitoring reads of #1566 spec 7: `/v1/.well-known/ready` for readiness, `/v1/meta` for the version,
 * `/v1/schema` for the collections and their vector indexes, and one aggregate count per single-tenant collection
 * of the first 200, one after another. monitoring.ts shapes every answer.
 */
import type { DatabaseOverview, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import { countWeaviateCollection, readWeaviateClasses, type WeaviateSurfaceContext } from "./objects";
import {
  toWeaviateHealth,
  toWeaviateIndexStats,
  toWeaviateOverview,
  toWeaviateTableStats,
  WEAVIATE_TABLE_STATS_LIMIT,
} from "./monitoring";
import { readWeaviateVersion } from "./versions";

export async function readWeaviateHealth(context: WeaviateSurfaceContext<"ready">): Promise<HealthInfo> {
  await context.send({ op: "ready", params: {}, query: {} }, context.signal);
  return toWeaviateHealth();
}

export async function readWeaviateOverview(
  context: WeaviateSurfaceContext<"meta" | "schema">,
): Promise<DatabaseOverview> {
  const meta = await context.send({ op: "meta", params: {}, query: {} }, context.signal);
  const collections = await readWeaviateClasses(context);
  return toWeaviateOverview({
    version: readWeaviateVersion(meta.text).reported,
    collections,
    scoped: context.scoped,
  });
}

/** One exact count per single-tenant collection of the first 200; a multi-tenant one is left out, as the caption says. */
export async function readWeaviateTableStats(
  context: WeaviateSurfaceContext<"schema" | "aggregate" | "graphql">,
): Promise<TableStats[]> {
  const collections = (await readWeaviateClasses(context)).slice(0, WEAVIATE_TABLE_STATS_LIMIT);
  const counts: { name: string; count: number | null }[] = [];
  for (const collection of collections) {
    if (collection.multiTenant) continue;
    // oxlint-disable-next-line no-await-in-loop -- one count at a time, so the panel never floods the server.
    counts.push({ name: collection.name, count: await countWeaviateCollection(context, collection) });
  }
  return toWeaviateTableStats(counts);
}

export async function readWeaviateIndexStats(context: WeaviateSurfaceContext<"schema">): Promise<IndexStats[]> {
  return toWeaviateIndexStats(await readWeaviateClasses(context));
}
