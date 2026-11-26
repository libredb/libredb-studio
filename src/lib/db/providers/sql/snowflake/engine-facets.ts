import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `snowflake` offers all seven monitoring panels: each read asks the engine.
 *
 * Maintenance: `snowflake` offers no maintenance operation.
 */
export const SNOWFLAKE_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: [],
};
