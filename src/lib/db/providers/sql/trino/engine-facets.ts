import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `trino`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 *
 * Maintenance: `trino` offers `kill`, in its provider's declaration order.
 *
 * Agent readings: `sessions`, `slow-queries`, `table-stats`, `storage` and `health`.
 */
export const TRINO_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "not-offered",
    storage: "offered",
  },
  maintenance: ["kill"],
  agentReadings: ["sessions", "slow-queries", "table-stats", "storage", "health"],
};
