/**
 * What the server does for the Milvus request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { MILVUSRPC_ADAPTER } from "./adapter";
import { MILVUSRPC_TOOL_OVERRIDES } from "./definitions";

const MILVUSRPC_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the server with run_read_query, one Milvus REST v2 request at a time: POST /v2/vectordb/collections/list, then collections/describe with {"collectionName": "..."} for its fields, their types and indexes, and collections/get_stats, collections/get_load_state, partitions/list, indexes/list, aliases/list and databases/list for the rest.',
    "Name a collection as collections/list lists it, in the connection's own database: a dbName naming another is refused.",
    "Answers carry names, counts and flags only: no stored field value or vector is read, so queries, gets and searches are refused, and what this run establishes is the store's shape and counts.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a Milvus
 * collection declares no relation the inventory draws. No `planningRules`: they reach plan mode alone, whose statement
 * form is the provider's `statementLanguage` label, so the rules of the agent's reader are never told to it.
 */
const MILVUSRPC_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    'Read any of them with run_read_query, for example POST /v2/vectordb/collections/describe with {"collectionName": "articles"} for the collection articles.',
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with POST /v2/vectordb/collections/list.`,
});

export const MILVUSRPC_SERVER_PACK = Object.freeze({
  adapter: MILVUSRPC_ADAPTER,
  toolOverrides: MILVUSRPC_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: MILVUSRPC_GROUNDING,
  workflowToolRules: MILVUSRPC_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
