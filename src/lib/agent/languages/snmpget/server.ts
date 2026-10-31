/**
 * What the server does for the snmpget command language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { SNMP_WITHHELD_MODULES_TEXT } from "@/lib/db/providers/network/snmp/agent-statement";
import { SNMPGET_ADAPTER } from "./adapter";
import { SNMPGET_TOOL_OVERRIDES } from "./definitions";

/** Which modules are withheld and why, the same words in the rule, the grounding advice and the ungrounded note. */
const WITHHELD = `${SNMP_WITHHELD_MODULES_TEXT} Nothing of a withheld module is read or answered.`;

const SNMPGET_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the agent with run_read_query, one console command at a time on one line: get OID [OID ...] for named instances, next OID for the instance after one, walk SUBTREE for every instance under a subtree, and table ENTRY for a conceptual table's rows, named by its entry (table ifEntry).",
    "Name an object as the inventory names it, or numerically, and walk the narrowest subtree that answers the question, such as one column (walk ifDescr) or one group (walk system), since a walk or table holding more instances than the row budget is refused rather than cut.",
    `${WITHHELD} A get or next landing inside one answers a row typed withheld; a walk or table covering one, such as walk mib-2 (1.3.6.1.2.1) or walk 1.3.6.1.4.1, steps over it and names it in a warning; and a walk or table inside one is refused.`,
    "Values are the device's own readings, answered as the console renders them, and the inventory lists what the bundled MIB modules define, not what this agent serves, so a listed table may hold no rows here.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds the bundled MIB modules' tables and scalar groups with their
 * declared columns, which none of the withheld modules is among, so the omission advice names a read the run holds and
 * the withheld modules' reason. `relations` is false: a MIB declares no relation the inventory draws. No
 * `planningRules`: they reach plan mode alone, whose statement form is the provider's `statementLanguage` label, so
 * the rules of the agent's reader are never told to it.
 */
const SNMPGET_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `Object groups are listed from the bundled MIB modules with their declared columns, never with a value. Read the agent with run_read_query, for example get sysDescr.0 sysUpTime.0, walk ifDescr or table ifEntry. ${WITHHELD}`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this agent has been established for you: not one ${noun.singular} name. ${WITHHELD} Read what you need with run_read_query, starting with get sysDescr.0 sysUpTime.0.`,
});

export const SNMPGET_SERVER_PACK = Object.freeze({
  adapter: SNMPGET_ADAPTER,
  toolOverrides: SNMPGET_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: SNMPGET_GROUNDING,
  workflowToolRules: SNMPGET_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
