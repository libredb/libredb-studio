import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `databend`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it, though the agent's `inspect_operations` tool still calls
 * the session, slow-query, table, index and storage members on every engine:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 *
 * Maintenance: `databend` offers `kill`, in its provider's declaration order.
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
};
