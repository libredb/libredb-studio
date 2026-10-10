/**
 * The Kubernetes provider's labels: the words the shared panels use for this engine.
 *
 * Pure, and shipped to the browser: `getLabels()` answers before connect, through `POST /api/db/provider-meta`.
 */
import type { ProviderLabels } from "@/lib/db/types";

export const KUBERNETES_LABELS: ProviderLabels = Object.freeze({
  // The noun plan mode's inventory and the object search use for a kind's objects.
  entityName: "Resource",
  entityNamePlural: "Resources",
  rowName: "Object",
  rowNamePlural: "Objects",
  selectAction: "Get",
  generateAction: "Generate Command",
  // Never rendered (`supportsMaintenance: false`); worded true anyway, as etcd's and Oxia's are.
  analyzeAction: "Statistics",
  vacuumAction: "Maintenance",
  searchPlaceholder: "Search namespaces and objects...",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "Kubernetes keeps no statistics for Studio to update.",
  vacuumGlobalLabel: "Maintenance",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Studio sends a Kubernetes cluster no maintenance and no write.",
  slowQueriesEmptyState: "Kubernetes keeps no query log",
  sessionsEmptyState: "Kubernetes does not list client sessions",
  tableStatsCaption:
    "Kubernetes has no tables: the tree lists objects per kind and namespace, and the console reads them with get.",
});
