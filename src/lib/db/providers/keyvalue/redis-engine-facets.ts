import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `redis`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `tables`: `getTableStats` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
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
};
