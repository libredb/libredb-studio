/**
 * The engine facets contract (FND-4): what each engine offers, declared in one row beside its provider and collected
 * by `ENGINE_FACETS` in `./index.ts`. `getMonitoringData`, the dashboard, the admin Operations page and fleet health
 * read a row before they call a provider member, so none of them calls a member the engine does not offer, the two
 * maintenance routes read it before they build a provider, so neither opens a connection for an operation the engine
 * does not offer. Studio grants the agent readings from the engine's legacy row in the grant register
 * (src/lib/db/claim-grants.ts), never from a row here.
 *
 * This module loads nothing: a row module imports it only as types, and the one value here is the panel vocabulary.
 */

import type { MaintenanceOperation } from "@/lib/db/types";

/**
 * The seven monitoring panels, in the order the dashboard draws them. Each is the key of `MonitoringData` its read
 * fills: `overview` from `getOverview`, `performance` from `getPerformanceMetrics`, `slowQueries` from
 * `getSlowQueries`, `activeSessions` from `getActiveSessions`, `tables` from `getTableStats`, `indexes` from
 * `getIndexStats` and `storage` from `getStorageStats`.
 */
export const MONITORING_PANELS = Object.freeze([
  "overview",
  "performance",
  "slowQueries",
  "activeSessions",
  "tables",
  "indexes",
  "storage",
] as const);

export type MonitoringPanel = (typeof MONITORING_PANELS)[number];

/**
 * Whether an engine offers a facet. `"offered"`: its read asks the engine (or an embedded engine's own file), now or
 * from what the engine said at connect. `"not-offered"`: the engine has nothing to read for it, so `getMonitoringData`
 * never calls the member and no surface draws it; a member that would answer a stub empty, a constant or a refusal without asking
 * the engine is declared not offered.
 */
export type FacetOffer = "offered" | "not-offered";

/** Every monitoring panel, each stated as offered or not, so no panel is offered or withheld by default. */
export type MonitoringPanelOffer = Readonly<Record<MonitoringPanel, FacetOffer>>;

/** One engine's row. */
export interface EngineFacets {
  /** The monitoring panels the engine offers, read by `getMonitoringData`, the dashboard and fleet health. */
  readonly monitoring: MonitoringPanelOffer;
  /**
   * The maintenance operations the engine offers before Studio connects, in the provider's declaration order.
   * `POST /api/db/maintenance` and its preview refuse any other operation by name before a provider is built. A
   * connected server may accept fewer (PostgreSQL and MySQL, through `narrowMaintenance`), never more.
   */
  readonly maintenance: readonly MaintenanceOperation[];
}
