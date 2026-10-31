/**
 * What the server does for the kafkaread request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { KAFKAREAD_ADAPTER } from "./adapter";
import { KAFKAREAD_TOOL_OVERRIDES } from "./definitions";

const KAFKAREAD_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the cluster with run_read_query, one JSON request at a time: {"read": "topics"}, {"read": "brokers"}, {"read": "partitions", "topic": "orders"} or {"read": "offsets", "topic": "orders"}, each with an optional "limit" and "after" and no other key.',
    "Name a topic exactly as the inventory names it. Kafka's internal topics are never read.",
    "Answers carry names, counts and offsets only: a record's key, value, headers and timestamp, a broker's host and port, configs, log directories and consumer groups are withheld, so what this run establishes is the cluster's topics, partitions, replicas, brokers and offset ranges, never what a record says or who consumes it.",
    "An offset span is how far a partition's offsets reach, not how many records it holds: compaction, transaction markers and retention make the two differ, so never report a span as a message count.",
    'A read whose answer says more follow is a page: read on with "after" set to the last topic, node id or partition of the answer.',
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a topic
 * declares no relation the inventory draws. No `planningRules`: they reach plan mode alone, whose statement form is
 * the provider's `statementLanguage` label, so the rules of the agent's reader are never told to it.
 */
const KAFKAREAD_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    'A topic is listed to agent mode by its partitions and offsets only. Read any topic with run_read_query, for example {"read": "offsets", "topic": "orders"} for each partition\'s earliest and end offsets of the topic orders.',
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this cluster has been established for you: not one ${noun.singular} name. List the topics with run_read_query, {"read": "topics"}; answers carry names, counts and offsets only.`,
});

export const KAFKAREAD_SERVER_PACK = Object.freeze({
  adapter: KAFKAREAD_ADAPTER,
  toolOverrides: KAFKAREAD_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: KAFKAREAD_GROUNDING,
  workflowToolRules: KAFKAREAD_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
