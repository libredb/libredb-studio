import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `druid`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 */
export const DRUID_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "not-offered",
    storage: "offered",
  },
};
