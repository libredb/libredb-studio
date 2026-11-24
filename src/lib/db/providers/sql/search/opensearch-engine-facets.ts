import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `opensearch`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 *
 * Maintenance: `opensearch` offers no maintenance operation.
 *
 * Agent readings: `table-stats`, `storage` and `health`.
 */
export const OPENSEARCH_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "offered",
    indexes: "not-offered",
    storage: "offered",
  },
  maintenance: [],
  agentReadings: ["table-stats", "storage", "health"],
};
