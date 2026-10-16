/**
 * What this engine calls its own things (issue #1724).
 *
 * A NETCONF device holds a YANG data tree, not tables, so the words follow the standard rather
 * than the database vocabulary: a top-level container or list is a Node, and what a read returns
 * is a Row of that node's list.
 */
import type { ProviderLabels } from "@/lib/db/types";

export const NETCONF_LABELS: ProviderLabels = Object.freeze({
  entityName: "Node",
  entityNamePlural: "Nodes",
  rowName: "Row",
  rowNamePlural: "Rows",
  selectAction: "Read",
  generateAction: "Not available",
  analyzeAction: "Not available",
  vacuumAction: "Not available",
  searchPlaceholder: "Filter nodes",
  analyzeGlobalLabel: "Not available",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc:
    "This provider sends four read operations and a close, and nothing else, so there is no analyse to run on a device.",
  vacuumGlobalLabel: "Not available",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc:
    "This provider performs no maintenance on a device: it sends four read operations and a close, and nothing else.",
});
