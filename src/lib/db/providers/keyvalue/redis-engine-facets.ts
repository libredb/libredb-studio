import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `redis`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `tables`: `getTableStats` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 *
 * Maintenance: `redis` offers `analyze`, in its provider's declaration order.
 */
export const REDIS_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "not-offered",
    indexes: "not-offered",
    storage: "offered",
  },
  maintenance: ["analyze"],
};
