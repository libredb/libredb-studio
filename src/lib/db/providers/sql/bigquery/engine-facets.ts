import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `bigquery`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 *
 * Maintenance: `bigquery` offers no maintenance operation.
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
  maintenance: [],
};
