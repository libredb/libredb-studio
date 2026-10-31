/**
 * What the server does for the opcuaread request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { OPCUA_WITHHELD_SENTENCE } from "@/lib/db/providers/industrial/opcua/agent-withheld";
import { OPCUAREAD_ADAPTER } from "./adapter";
import { OPCUAREAD_TOOL_OVERRIDES } from "./definitions";

/** Where the address space comes from, the same words in the rule, the grounding advice and the ungrounded note. */
const BROWSED =
  'An OPC UA address space is browsed one level at a time rather than listed, so no node is listed for the run: read a node id the question names exactly as it is written, without browsing to it first, and browse from the Objects folder with {"browse": "i=85"} only to find a node the question does not name, going down from what it answers.';

/** The units rule, the same words in the rule and the grounding advice. */
const UNITS =
  "Every value row carries the node's engineering units and EU range as the server publishes them, or \"no units published\": report the unit beside each value, and never assume one from a node's name.";

const OPCUAREAD_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the server with run_read_query, one JSON request at a time: {"browse": "<node id>"} for the children of one node, {"read": ["<node id>", ...]} for current values, and {"history": "<node id>", "start": "...", "end": "...", "limit": 100} for one node\'s raw history.',
    `${BROWSED} Write any other node id exactly as a browse answers it, and ask for every value you need in one read rather than one read per node.`,
    UNITS,
    OPCUA_WITHHELD_SENTENCE,
    "Values are the server's own readings, answered as the console renders them.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the provider declares no kind the grounding walk lists, so a run is ungrounded
 * and the note says how the address space is reached. `relations` is false: an address space declares no relation
 * the inventory draws. No `planningRules`: they reach plan mode alone, whose statement form is the provider's
 * `statementLanguage` label, so the rules of the agent's reader are never told to it.
 */
const OPCUAREAD_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `${BROWSED} ${UNITS} ${OPCUA_WITHHELD_SENTENCE}`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this server has been established for you: not one ${noun.singular} name. ${BROWSED} ${UNITS} ${OPCUA_WITHHELD_SENTENCE}`,
});

export const OPCUAREAD_SERVER_PACK = Object.freeze({
  adapter: OPCUAREAD_ADAPTER,
  toolOverrides: OPCUAREAD_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: OPCUAREAD_GROUNDING,
  workflowToolRules: OPCUAREAD_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
