import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `oracle` offers all seven monitoring panels: each read asks the engine.
 *
 * Maintenance: `oracle` offers `analyze`, `optimize` and `kill`, in its provider's declaration order.
 */
export const ORACLE_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["analyze", "optimize", "kill"],
};
