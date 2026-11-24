import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `mongodb` offers all seven monitoring panels: each read asks the engine.
 *
 * Maintenance: `mongodb` offers `vacuum`, `analyze`, `check` and `kill`, in its provider's declaration order.
 *
 * Agent readings: `sessions`, `slow-queries`, `table-stats`, `index-stats`, `storage` and `health`.
 */
export const MONGODB_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["vacuum", "analyze", "check", "kill"],
  agentReadings: ["sessions", "slow-queries", "table-stats", "index-stats", "storage", "health"],
};
