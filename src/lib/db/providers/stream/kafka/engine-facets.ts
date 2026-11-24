import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `kafka`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `tables`: `getTableStats` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 *
 * Maintenance: `kafka` offers no maintenance operation.
 *
 * Agent readings: `health`.
 * `storage` is withheld: the agent handle's `getStorageStats` refuses with `KAFKA_AGENT_WITHHELD.storage`.
 */
export const KAFKA_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "offered",
  },
  maintenance: [],
  agentReadings: ["health"],
};
