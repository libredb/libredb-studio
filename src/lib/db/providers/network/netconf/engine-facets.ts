import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `netconf`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `performance`: `getPerformanceMetrics` refuses with `SENTENCES.noMetrics` without asking the engine.
 * - `slowQueries`: `getSlowQueries` refuses with `SENTENCES.noMetrics` without asking the engine.
 * - `activeSessions`: `getActiveSessions` refuses with `SENTENCES.noSessions` without asking the engine.
 * - `tables`: `getTableStats` refuses with `SENTENCES.noTables` without asking the engine.
 * - `indexes`: `getIndexStats` refuses with `SENTENCES.noTables` without asking the engine.
 * - `storage`: `getStorageStats` refuses with `SENTENCES.noStorage` without asking the engine.
 */
export const NETCONF_ENGINE_FACETS: EngineFacets = {
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
