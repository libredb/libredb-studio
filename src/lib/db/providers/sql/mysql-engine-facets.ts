import type { EngineFacets } from "@/lib/db/engine-facets/types";

/** `mysql` offers all seven monitoring panels: each read asks the engine. */
export const MYSQL_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
};
