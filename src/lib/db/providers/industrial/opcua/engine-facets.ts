import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `opcua`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `tables`: `getTableStats` refuses with `OPCUA_NO_TABLE_STATISTICS` without asking the engine.
 * - `indexes`: `getIndexStats` refuses with `OPCUA_NO_TABLE_STATISTICS` without asking the engine.
 * - `storage`: `getStorageStats` refuses with `OPCUA_NO_TABLE_STATISTICS` without asking the engine.
 */
export const OPCUA_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "not-offered",
  },
};
