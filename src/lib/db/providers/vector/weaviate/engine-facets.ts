import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `weaviate`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `storage`: `getStorageStats` answers `[]` without asking the engine.
 *
 * Maintenance: `weaviate` offers no maintenance operation.
 *
 * Agent readings: `table-stats`, `index-stats` and `health`.
 */
export const WEAVIATE_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "offered",
    indexes: "offered",
    storage: "not-offered",
  },
  maintenance: [],
  agentReadings: ["table-stats", "index-stats", "health"],
};
