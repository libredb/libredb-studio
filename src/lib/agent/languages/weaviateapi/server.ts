/**
 * What the server does for the Weaviate request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import { WEAVIATEAPI_ADAPTER } from "./adapter";
import { WEAVIATEAPI_TOOL_OVERRIDES } from "./definitions";

const WEAVIATEAPI_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the server with run_read_query, one Weaviate REST request at a time: the meta, schema, shard, tenant, alias and node reads, and POST /v1/aggregate/{collection} for a count.",
    'Name a collection as the schema spells it, and a tenant of a multi-tenant collection with ?tenant=... on a shard read or "tenant" in the aggregate body; a COLD tenant is refused, never woken.',
    "Answers carry names, counts and flags only: no object, property value or vector is read, so object reads, searches, filters and groupBy are refused, and what this run establishes is the store's shape and counts.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a
 * cross-reference is a property, not a declared relation the inventory draws. No `planningRules`: they reach plan
 * mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader are
 * never told to it.
 */
const WEAVIATEAPI_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    "Read any of them with run_read_query, for example GET /v1/schema/Article for the collection Article.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with GET /v1/schema.`,
});

export const WEAVIATEAPI_SERVER_PACK = Object.freeze({
  adapter: WEAVIATEAPI_ADAPTER,
  toolOverrides: WEAVIATEAPI_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: WEAVIATEAPI_GROUNDING,
  workflowToolRules: WEAVIATEAPI_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
