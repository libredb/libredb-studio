/**
 * The host core instance (docs/providers/CONTRACT.md, clauses C-52 and C-53), part of the provider host core.
 *
 * `createHostCore` answers what a composition root installs once per process (src/lib/provider-host/instance.ts): the
 * core's console calls, its tree call, its maintenance calls, its monitoring calls and its health call in a frozen
 * object, and nothing else. `executeCall` is bound to a page budget of `LARGE_PAGE_SLOTS` slots the core creates for
 * itself (src/lib/provider-host/core/page-budget.ts), so the process holds one page budget as it holds one core;
 * `cancelCall`, `endScopeCall` and `transactionCall` pump nothing and are the console's own functions, `treeCall` is
 * the object facet's own (src/lib/provider-host/core/objects.ts), `maintenanceRunCall` and `maintenancePreviewCall` are
 * the maintenance facets' own (src/lib/provider-host/core/maintenance.ts), and `panelCall` and `poolStatsCall` are the
 * monitoring facets' own and `healthCall` the mandatory health call's (src/lib/provider-host/core/monitoring.ts). The
 * budget is not exposed: it is reached only through the core's execute.
 *
 * Next.js bundles instrumentation apart from every route handler, and each bundle holds its own copy of Studio's error
 * classes. The core answers records and constructs no class, so the
 * functions installed by the instrumentation bundle serve a route bundle as well as its own copy would. What a caller
 * tests with `instanceof`, the error classes and the ports that read them (`HostCallPorts`), stays the caller's and is
 * built by the caller per call, so the instance holds no port and no logger. The open tables and the teardown stay the
 * factory's, per bundle, since the factory is part of the npm package and needs no core.
 */
import { type ConsoleCalls, consoleCalls } from "./console";
import { type MaintenanceCalls, maintenancePreviewCall, maintenanceRunCall } from "./maintenance";
import { healthCall, type MonitoringCalls, panelCall, poolStatsCall } from "./monitoring";
import { type ObjectsCalls, treeCall } from "./objects";
import { createPageBudget, LARGE_PAGE_SLOTS } from "./page-budget";

/**
 * The host core one process holds: the core's console calls, on its page budget, its tree call, its maintenance calls,
 * its monitoring calls and its health call.
 */
export type HostCore = ConsoleCalls & ObjectsCalls & MaintenanceCalls & MonitoringCalls;

/** A new host core instance, with a page budget of its own, frozen, for a composition root to install. */
export function createHostCore(): HostCore {
  return Object.freeze({
    ...consoleCalls(createPageBudget(LARGE_PAGE_SLOTS)),
    treeCall,
    maintenanceRunCall,
    maintenancePreviewCall,
    panelCall,
    poolStatsCall,
    healthCall,
  });
}
