import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `sqlite`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it, though the agent's `inspect_operations` tool still calls
 * the session, slow-query, table, index and storage members on every engine:
 *
 * - `performance`: `getPerformanceMetrics` answers the constant `{ deadlocks: 0 }` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers one synthetic session carrying Studio's own process id without asking the engine.
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
};
