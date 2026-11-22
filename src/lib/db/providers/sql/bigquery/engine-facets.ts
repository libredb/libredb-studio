import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `bigquery`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it, though the agent's `inspect_operations` tool still calls
 * the session, slow-query, table, index and storage members on every engine:
 *
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 */
export const BIGQUERY_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "not-offered",
    storage: "offered",
  },
};
