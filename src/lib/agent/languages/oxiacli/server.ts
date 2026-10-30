/**
 * What the server does for the oxiacli command language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { OXIACLI_ADAPTER } from "./adapter";
import { OXIACLI_TOOL_OVERRIDES } from "./definitions";

const OXIACLI_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the namespace with run_read_query, one command at a time on one line: shards for the shard and leader counts, get <key> for a key the question names, and list [MIN [MAX]], list -s <min> -e <max> or list --prefix <prefix> for how many keys a range holds.",
    "Name a key exactly as the question names it, single-quoting one that holds a space, and add no flag but the bounds of a count: the comparison, partition key, index, limit and namespace of every read are fixed.",
    "Answers carry names, counts and sizes only: key names and stored values are withheld, so no command lists keys or reads a value, a count larger than the row budget is refused rather than answered in part, and what this run establishes is the shard map, the counts of the ranges it named and the metadata of the keys it was told about.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds no key name, so the omission advice names a read the run
 * holds. `relations` is false: an Oxia key declares no relation the inventory draws. No `planningRules`: they reach
 * plan mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader
 * are never told to it.
 */
const OXIACLI_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    "No key name is listed to agent mode. Read the shard map with run_read_query and shards, the count of a range with list --prefix, and a key the question names with get, for example get /admin/policies/public.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this namespace's keys has been established for you: not one ${noun.singular} name, and none will be, since key names are withheld from agent mode. Read what you need with run_read_query, starting with shards.`,
});

export const OXIACLI_SERVER_PACK = Object.freeze({
  adapter: OXIACLI_ADAPTER,
  toolOverrides: OXIACLI_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: OXIACLI_GROUNDING,
  workflowToolRules: OXIACLI_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
