import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `libsql`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers the constant `{ deadlocks: 0 }` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 *
 * Maintenance: `libsql` offers `reindex` and `check`, in its provider's declaration order.
 */
export const LIBSQL_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["reindex", "check"],
};
