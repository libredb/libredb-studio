import type { EngineFacets } from "@/lib/db/engine-facets/types";

/**
 * `etcd`: the monitoring panels whose reads ask the engine, now or from what it said at connect. `getMonitoringData`
 * never reads a panel not offered and no surface draws it:
 *
 * - `performance`: `getPerformanceMetrics` answers `{}` without asking the engine.
 * - `slowQueries`: `getSlowQueries` answers `[]` without asking the engine.
 * - `activeSessions`: `getActiveSessions` answers `[]` without asking the engine.
 * - `indexes`: `getIndexStats` answers `[]` without asking the engine.
 *
 * Maintenance: `etcd` offers `compact`, `defragment` and `disarm`, in its provider's declaration order.
 *
 * Agent readings: `storage` and `health`.
 * `table-stats` is withheld: the agent handle's `getTableStats` refuses with `KEY_NAMES_WITHHELD`.
 */
export const ETCD_ENGINE_FACETS: EngineFacets = {
  monitoring: {
    overview: "offered",
    performance: "not-offered",
    slowQueries: "not-offered",
    activeSessions: "not-offered",
    tables: "offered",
    indexes: "not-offered",
    storage: "offered",
  },
  maintenance: ["compact", "defragment", "disarm"],
  agentReadings: ["storage", "health"],
};
