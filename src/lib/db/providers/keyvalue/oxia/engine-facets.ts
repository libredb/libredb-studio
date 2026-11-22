import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `oxia` offers no monitoring panel: no read asks the engine, so core reads none and the dashboard draws none.
 *
 * - `overview`: `getOverview` answers constants after a reachability probe, never a figure the server reports.
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `tables`: `getTableStats` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 * - `storage`: `getStorageStats` answers `[]` without asking the engine.
 *
 * Maintenance: `oxia` offers no maintenance operation.
 *
 * Agent readings: `health`.
 */
export const OXIA_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "not-offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "not-offered",
  },
  maintenance: [],
  agentReadings: ["health"],
};
