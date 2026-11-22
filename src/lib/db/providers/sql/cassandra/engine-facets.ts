import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `cassandra`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `tables`: `getTableStats` refuses with `CASSANDRA_TABLE_STATS_REFUSAL` without asking the engine.
 * - `indexes`: `getIndexStats` refuses with `CASSANDRA_INDEX_STATS_REFUSAL` without asking the engine.
 * - `storage`: `getStorageStats` refuses with `CASSANDRA_STORAGE_STATS_REFUSAL` without asking the engine.
 *
 * Maintenance: `cassandra` offers no maintenance operation.
 *
 * Agent readings: `sessions` and `health`.
 */
export const CASSANDRA_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "not-offered",
    activeSessions: "offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "not-offered",
  },
  maintenance: [],
  agentReadings: ["sessions", "health"],
};
