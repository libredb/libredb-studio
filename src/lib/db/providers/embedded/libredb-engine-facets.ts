import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `libredb`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it, though the agent's `inspect_operations` tool still calls
 * the session, slow-query, table, index and storage members on every engine:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` refuses with `LIBREDB_ACTIVE_SESSIONS_REFUSAL` without asking the engine.
 * - `indexes`: `getIndexStats` refuses with `LIBREDB_INDEX_STATS_REFUSAL` without asking the engine.
 *
 * Maintenance: `libredb` offers no maintenance operation.
 */
export const LIBREDB_ENGINE_FACETS: EngineFacets = {
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
};
