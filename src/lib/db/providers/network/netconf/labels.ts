/**
 * What this engine calls its own things (issue #1724).
 *
 * A NETCONF device holds a YANG data tree, not tables, so the words follow the standard rather
 * than the database vocabulary: a top-level container or list is a Node, and what a read returns
 * is a Row of that node's list.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { NETCONF_WITHHELD_TEXT } from "./agent-withheld";

/**
 * What a statement on this engine is written in, for plan mode: the console's JSON read request, the one shape the
 * editor runs (agent mode's schema request is agent mode's alone). Its name alone would send a model to raw NETCONF XML
 * (`<rpc><edit-config>...`) or to a RESTCONF URL, and neither runs here.
 */
const NETCONF_STATEMENT_LANGUAGE = `one NETCONF read request this editor runs, a JSON object written as the console writes it: {"datastore": "running", "path": "ietf-interfaces:interfaces", "limit": 100}, which reads the configuration (running, candidate or startup) or the configuration and state (operational or intended) under a path that names its module on its first node, one more name per level and a list entry's keys after = (interface=eth0), with a key's "/" written %2F (interface=ge-0%2F0%2F0). There is no XML, no edit-config or other operation, and no RESTCONF URL. Never draft a read of a node agent mode withholds: nothing checks a draft, and the editor that runs it answers every value, those included. ${NETCONF_WITHHELD_TEXT} The inventory names each module's top-level nodes, never a value the device holds`;

export const NETCONF_LABELS: ProviderLabels = Object.freeze({
  statementLanguage: NETCONF_STATEMENT_LANGUAGE,
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
