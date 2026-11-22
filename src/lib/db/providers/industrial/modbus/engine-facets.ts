import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `modbus` offers no monitoring panel: no read asks the engine, so core reads none and the dashboard draws none.
 *
 * - `overview`: `getOverview` answers constants and the size of the configured register map, never a figure the device reports.
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `tables`: `getTableStats` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 * - `storage`: `getStorageStats` answers `[]` without asking the engine.
 */
export const MODBUS_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "not-offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "not-offered",
  },
};
