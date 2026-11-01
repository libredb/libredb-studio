/**
 * What the server does for the mqttread request language, assembled from the language's server modules.
 */
import { MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { MQTT_TOPICS_WITHHELD_SENTENCE } from "@/lib/db/providers/keyvalue/mqtt/agent-surface";
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { MQTTREAD_ADAPTER } from "./adapter";
import { MQTTREAD_TOOL_OVERRIDES } from "./definitions";

/** Why no topic is listed for a run, the same words in the rule, the grounding advice and the ungrounded note. */
const NOT_LISTED =
  "No topic is listed for the run, and none ever will be: MQTT has no command that lists topics, and topic names are withheld from agent mode in any case.";

/** How to read what a question names without a whole-broker read first. */
const READ_WHAT_IS_NAMED =
  'When the question names a topic in full, read that topic directly with {"read": "topic", "topic": "<the topic, exactly as the question writes it>"}; read the window, {"read": "window"}, only for the broker\'s totals, never to look for a topic.';

const MQTTREAD_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the broker with run_read_query, one JSON request at a time: {"read": "window"} for the totals of one window over every topic, and {"read": "topic", "topic": "<topic>"} for one topic named in full.',
    NOT_LISTED,
    READ_WHAT_IS_NAMED,
    "Never write a topic the question does not name, and never derive one from another: a guessed topic not seen tells you nothing.",
    MQTT_TOPICS_WITHHELD_SENTENCE,
    `Report each answer with the window it listened for and its stop reason. ${MQTT_COMPLETENESS} So report a topic not seen as not seen in that window, never as absent, and a count as a count of that window, never of the broker.`,
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the provider declares no kind the grounding walk lists, so a run is always
 * ungrounded and the note says why and how the broker is read. `relations` is false: a broker declares no relation the
 * inventory draws. No `planningRules`: they reach plan mode alone, whose statement form is the provider's
 * `statementLanguage` label, so the rules of the agent's reader are never told to it; a plan on this engine is prose
 * (`client.ts`), since the editor runs no request on an MQTT connection.
 */
const MQTTREAD_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `${NOT_LISTED} ${MQTT_TOPICS_WITHHELD_SENTENCE} ${READ_WHAT_IS_NAMED} ${MQTT_COMPLETENESS}`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this broker has been established for you: not one ${noun.singular} name. ${NOT_LISTED} ${MQTT_TOPICS_WITHHELD_SENTENCE} ${READ_WHAT_IS_NAMED} ${MQTT_COMPLETENESS}`,
});

export const MQTTREAD_SERVER_PACK = Object.freeze({
  adapter: MQTTREAD_ADAPTER,
  toolOverrides: MQTTREAD_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: MQTTREAD_GROUNDING,
  workflowToolRules: MQTTREAD_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
