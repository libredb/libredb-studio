/**
 * Health and the overview of an Oxia connection (SB2-9.5, SB1-9.5).
 *
 * Health reads the shard map afresh with the client, never the provider's brief cache, so a server that stopped
 * serving its map is seen at once; the adapter runs the dial policy over every leader as it reads it; then it asks
 * `grpc.health.v1.Health/Check`. Each call has the deadline the provider hands in. The overview counts no table and
 * no index, because the shared card that draws `tableCount` is titled Tables and Oxia has none (ruling R34); the
 * shard count, the namespace, the order and the leaders are in each shard's Source tab. No call's failure is worded
 * here but the two plan-defined health outcomes; every other failure is the adapter's `OxiaError`, which the
 * provider words.
 */
import { ConnectionError } from "@/lib/db/errors";
import type { DatabaseOverview, HealthInfo } from "@/lib/db/types";
import type { OxiaCallOptions } from "./client";
import { OXIA_TYPE } from "./constants";
import { deadlineSeconds, OXIA_HEALTH_NO_SHARD_MAP, OxiaError, silentAssignmentsSentence } from "./errors";
import type { OxiaSurface } from "./walks";

/** SB1-9.5's outcome for a server that answers Check SERVING and sends no shard map. */
function noShardMapSentence(deadlineMs: number): string {
  return `${OXIA_HEALTH_NO_SHARD_MAP}: ${silentAssignmentsSentence(deadlineSeconds(deadlineMs))}`;
}

/** SB1-9.5: the snapshot, then Health/Check, each under `deadlineMs`; healthy when both pass and Check is SERVING. */
export async function oxiaHealth(surface: OxiaSurface, deadlineMs: number, signal: AbortSignal): Promise<HealthInfo> {
  const callFor = (): OxiaCallOptions => ({ signal, deadline: Date.now() + deadlineMs });
  try {
    await surface.client.getSnapshot(callFor());
  } catch (error) {
    if (!(error instanceof OxiaError) || error.category !== "silent-assignments") throw error;
    // The map did not arrive: a server that answers Check SERVING has no shard map to serve yet.
    const status = await surface.client.health(callFor());
    if (status === "SERVING") throw new ConnectionError(noShardMapSentence(deadlineMs), OXIA_TYPE);
    throw error;
  }
  const status = await surface.client.health(callFor());
  if (status !== "SERVING")
    throw new ConnectionError(`Oxia answered the health check with ${status}: it serves no reads now.`, OXIA_TYPE);
  // No count of connections is reported, which is a different fact from zero.
  return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}

/**
 * SB2-9.5: the client API reports no version, uptime or size, and Oxia holds no table or index (ruling R34). The shard
 * map is still read, so a server that serves none fails the panel instead of drawing a quiet overview.
 */
export async function oxiaOverview(surface: OxiaSurface, call: OxiaCallOptions): Promise<DatabaseOverview> {
  await surface.snapshot(call);
  return {
    version: "N/A",
    uptime: "N/A",
    maxConnections: 0,
    databaseSize: "N/A",
    tableCount: 0,
    indexCount: 0,
  };
}
