import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `duckdb`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 */
export const DUCKDB_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
};
