import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `mtconnect`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `tables`: `getTableStats` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 * - `storage`: `getStorageStats` answers `[]` without asking the engine.
 *
 * Maintenance: `mtconnect` offers no maintenance operation.
 *
 * Agent readings: none.
 * `health` is withheld: the agent handle's `getHealth` refuses with `MTCONNECT_AGENT_WITHHELD.health`.
 */
export const MTCONNECT_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "not-offered",
  },
  maintenance: [],
  agentReadings: [],
};
