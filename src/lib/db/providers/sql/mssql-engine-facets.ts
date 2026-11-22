import type { EngineFacets } from "@/lib/db/engine-facets/types";

/** `mssql` offers all seven monitoring panels: each read asks the engine. */
export const MSSQL_ENGINE_FACETS: EngineFacets = {
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
