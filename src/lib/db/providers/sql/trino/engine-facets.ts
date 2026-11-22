import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `trino`: the monitoring panels whose reads ask the engine. Each panel not offered is never read and not drawn:
 *
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 */
export const TRINO_ENGINE_FACETS: EngineFacets = {
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
