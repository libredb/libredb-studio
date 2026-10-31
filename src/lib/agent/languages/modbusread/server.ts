/**
 * What the server does for the modbusread request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { MODBUS_AGENT_DEVICE_GAP_MS } from "@/lib/db/providers/industrial/modbus/agent-pacing";
import { MODBUS_AGENT_RUN_REQUESTS } from "@/lib/db/providers/industrial/modbus/agent-read";
import { MODBUSREAD_ADAPTER } from "./adapter";
import { MODBUSREAD_TOOL_OVERRIDES } from "./definitions";

/** Where the inventory comes from, the same words in the rule, the grounding advice and the ungrounded note. */
const FROM_THE_MAP =
  "Modbus has no discovery: the inventory lists the points the connection's register map names, read from the map and never from the device, and a connection with no map lists none, which says nothing about what the device holds.";

const MODBUSREAD_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the device with run_read_query, one JSON request at a time: {"read": ["name", ...]} for points the register map names, {"unit": 1, "table": "holding_register", "address": 0, "count": 10} for one block of one table, and {"identify": "basic"} for the device identification objects.',
    `${FROM_THE_MAP} The inventory lists each point after its unit and a dot, such as 1.tank_level for the point tank_level of unit 1, and a points read names the point alone, {"read": ["tank_level"]}; a block read needs its unit, table and zero-based address, which only the map or the device's documentation can give.`,
    `Reads of one device are taken one at a time with a ${MODBUS_AGENT_DEVICE_GAP_MS} ms gap after each, and one run sends at most ${MODBUS_AGENT_RUN_REQUESTS} requests to Modbus devices, so ask for every point you need in one read rather than one read per point, and do not read a value again to see whether it changed.`,
    "Values are the device's own readings, answered as the console renders them.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds the register map's points by name, which sends nothing to
 * the device. `relations` is false: a map declares no relation the inventory draws. No `planningRules`: they reach plan
 * mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader are
 * never told to it.
 */
const MODBUSREAD_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `Points are listed by name from the connection's register map, never with a value. ${FROM_THE_MAP} Read the device with run_read_query, for example {"read": ["a point name"]} or {"identify": "basic"}.`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this device has been established for you: not one ${noun.singular} name. ${FROM_THE_MAP} Read what you need with run_read_query, starting with {"identify": "basic"}.`,
});

export const MODBUSREAD_SERVER_PACK = Object.freeze({
  adapter: MODBUSREAD_ADAPTER,
  toolOverrides: MODBUSREAD_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: MODBUSREAD_GROUNDING,
  workflowToolRules: MODBUSREAD_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
