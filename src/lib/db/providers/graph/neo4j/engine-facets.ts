import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `neo4j`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `storage`: `getStorageStats` answers `[]` without asking the engine.
 *
 * Maintenance: `neo4j` offers no maintenance operation.
 *
 * Agent readings: `sessions`, `table-stats`, `index-stats` and `health`.
 */
export const NEO4J_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "not-offered",
  },
  maintenance: [],
  agentReadings: ["sessions", "table-stats", "index-stats", "health"],
};
