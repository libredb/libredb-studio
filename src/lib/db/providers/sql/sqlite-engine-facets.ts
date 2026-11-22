import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `sqlite`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `performance`: `getPerformanceMetrics` answers the constant `{ deadlocks: 0 }` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers one synthetic session carrying Studio's own process id without asking the engine.
 */
export const SQLITE_ENGINE_FACETS: EngineFacets = {
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
