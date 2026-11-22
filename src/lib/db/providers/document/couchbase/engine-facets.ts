import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `couchbase` offers all seven monitoring panels: each read asks the engine.
 *
 * Maintenance: `couchbase` offers `analyze`, `reindex` and `kill`, in its provider's declaration order.
 *
 * Agent readings: `sessions`, `slow-queries`, `table-stats`, `index-stats`, `storage` and `health`.
 */
export const COUCHBASE_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["analyze", "reindex", "kill"],
  agentReadings: ["sessions", "slow-queries", "table-stats", "index-stats", "storage", "health"],
};
