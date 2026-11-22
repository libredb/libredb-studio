import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `clickhouse` offers all seven monitoring panels: each read asks the engine.
 *
 * Maintenance: `clickhouse` offers `optimize`, `analyze` and `kill`, in its provider's declaration order.
 *
 * Agent readings: `sessions`, `slow-queries`, `table-stats`, `index-stats`, `storage` and `health`.
 */
export const CLICKHOUSE_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "offered",
    slowQueries: "offered",
    activeSessions: "offered",
    tables: "offered",
    indexes: "offered",
    storage: "offered",
  },
  maintenance: ["optimize", "analyze", "kill"],
  agentReadings: ["sessions", "slow-queries", "table-stats", "index-stats", "storage", "health"],
};
