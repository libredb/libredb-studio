/**
 * What the server does for the netconfrpc request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { NETCONF_WITHHELD_TEXT } from "@/lib/db/providers/network/netconf/agent-withheld";
import { NETCONFRPC_ADAPTER } from "./adapter";
import { NETCONFRPC_TOOL_OVERRIDES } from "./definitions";

const NETCONFRPC_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the device with run_read_query, one JSON request at a time: {"datastore": "running", "path": "ietf-interfaces:interfaces"} for the configuration, {"datastore": "operational", "path": ...} for the configuration and its state, and {"schema": "ietf-interfaces"} for a module\'s YANG text.',
    "Name the module on the path's first node as the inventory names it, and read the narrowest path that answers the question, such as one entry by its keys (interface=eth0), with a key's \"/\" written %2F (interface=ge-0%2F0%2F0), since a list holding more entries than the row budget is refused rather than cut.",
    `${NETCONF_WITHHELD_TEXT} A path that names a withheld node or filters on a withheld key is refused before it is sent; a read covering one answers [withheld] in its place and names it in a warning.`,
    "Values are the device's own configuration and state, answered as text; the inventory lists each module's top-level nodes, not what each holds, so a listed node may hold no data here.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds each module's top-level nodes by name, never a value, so the
 * omission advice names a read the run holds and every withheld kind with its reason. `relations` is false: a YANG
 * tree declares no relation the inventory draws. No `planningRules`: they reach plan mode alone, whose statement form
 * is the provider's `statementLanguage` label, so the rules of the agent's reader are never told to it.
 */
const NETCONFRPC_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `Nodes are listed by name for each module the device implements, with no value. Read the device with run_read_query, for example {"datastore": "running", "path": "ietf-interfaces:interfaces"} or {"schema": "ietf-interfaces"}. ${NETCONF_WITHHELD_TEXT}`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this device has been established for you: not one ${noun.singular} name. ${NETCONF_WITHHELD_TEXT} Read what you need with run_read_query, starting with {"datastore": "operational", "path": "ietf-interfaces:interfaces"}.`,
});

export const NETCONFRPC_SERVER_PACK = Object.freeze({
  adapter: NETCONFRPC_ADAPTER,
  toolOverrides: NETCONFRPC_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: NETCONFRPC_GROUNDING,
  workflowToolRules: NETCONFRPC_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
