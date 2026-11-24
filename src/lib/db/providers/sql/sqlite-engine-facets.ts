import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `sqlite`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers the constant `{ deadlocks: 0 }` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers one synthetic session carrying Studio's own process id without asking the engine.
 *
 * Maintenance: `sqlite` offers `vacuum`, `analyze`, `reindex` and `check`, in its provider's declaration order.
 *
 * Agent readings: `table-stats`, `index-stats`, `storage` and `health`.
 */
export const SQLITE_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["vacuum", "analyze", "reindex", "check"],
  agentReadings: ["table-stats", "index-stats", "storage", "health"],
};
