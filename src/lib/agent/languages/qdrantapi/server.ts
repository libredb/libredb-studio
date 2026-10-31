/**
 * What the server does for the Qdrant request language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import { QDRANTAPI_ADAPTER } from "./adapter";
import { QDRANTAPI_TOOL_OVERRIDES } from "./definitions";

const QDRANTAPI_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the server with run_read_query, one Qdrant REST request at a time: GET /collections, GET /collections/{collection} for its vectors and payload indexes, its exists, aliases and cluster reads, GET /aliases, and POST /collections/{collection}/points/count for a count.",
    "Name a collection as GET /collections lists it; an alias names its collection in GET /aliases.",
    "Answers carry names, counts and flags only: no payload value or vector is read, so point reads, scrolls, facets, queries and a count filter are refused, and what this run establishes is the store's shape and counts.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a Qdrant
 * collection declares no relation the inventory draws. No `planningRules`: they reach plan
 * mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader are
 * never told to it.
 */
const QDRANTAPI_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    "Read any of them with run_read_query, for example GET /collections/articles for the collection articles.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with GET /collections.`,
});

export const QDRANTAPI_SERVER_PACK = Object.freeze({
  adapter: QDRANTAPI_ADAPTER,
  toolOverrides: QDRANTAPI_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: QDRANTAPI_GROUNDING,
  workflowToolRules: QDRANTAPI_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
