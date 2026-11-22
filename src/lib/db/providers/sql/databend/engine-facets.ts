import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `databend`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 *
 * Maintenance: `databend` offers `kill`, in its provider's declaration order.
 *
 * Agent readings: `sessions`, `slow-queries`, `table-stats`, `index-stats`, `storage` and `health`.
 */
export const DATABEND_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["kill"],
  agentReadings: ["sessions", "slow-queries", "table-stats", "index-stats", "storage", "health"],
};
