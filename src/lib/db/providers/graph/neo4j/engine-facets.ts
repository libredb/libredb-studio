import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `neo4j`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `storage`: `getStorageStats` answers `[]` without asking the engine.
 */
export const NEO4J_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "not-offered",
  },
};
