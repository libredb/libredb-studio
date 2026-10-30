/**
 * What the server does for the rabbitread request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { RABBITREAD_ADAPTER } from "./adapter";
import { RABBITREAD_TOOL_OVERRIDES } from "./definitions";

const RABBITREAD_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read a stream with run_read_query, one JSON read request at a time with the keys vhost, stream, from and limit and no other, for example {"vhost": "/", "stream": "orders", "from": "first", "limit": 50}.',
    "Name the virtual host and the stream exactly as the inventory names them: an object the inventory lists as /.orders is the stream orders in the virtual host /. Only a stream is read; a classic or quorum queue is refused, since reading it removes its messages.",
    "Each message answers its offset and its body size, and nothing else: a message's body, headers, properties and routing key are withheld, so what this run establishes is how many messages a range holds, where they sit and how large their bodies are, never what they say.",
    'A read that stops before its limit for any reason but the stream\'s end is refused rather than answered in part; ask for fewer messages, or read on from the offset after the last one you read with {"offset": n}.',
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a stream
 * declares no relation the inventory draws. No `planningRules`: they reach plan mode alone, whose statement form is
 * the provider's `statementLanguage` label, so the rules of the agent's reader are never told to it.
 */
const RABBITREAD_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    'A stream\'s messages are listed to agent mode by offset and body size only. Read any stream with run_read_query, for example {"vhost": "/", "stream": "orders", "from": "last", "limit": 50} for the stream orders in the virtual host /.',
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this broker has been established for you: not one ${noun.singular} name. Read a stream the question names with run_read_query; each message answers its offset and body size only.`,
});

export const RABBITREAD_SERVER_PACK = Object.freeze({
  adapter: RABBITREAD_ADAPTER,
  toolOverrides: RABBITREAD_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: RABBITREAD_GROUNDING,
  workflowToolRules: RABBITREAD_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
