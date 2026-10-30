/**
 * What the server does for the Cypher language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { AGENT_ANSWER_CONTRACT, UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { CYPHER_ADAPTER } from "./adapter";
import { CYPHER_TOOL_OVERRIDES } from "./definitions";

/** How a statement names what the inventory lists, and how it stays inside the row budget. */
const CYPHER_NAMING_RULE =
  "Every statement runs against the connection's database: match a label as (n:Person) and a relationship type as -[:KNOWS]->, backtick a name that holds spaces or a reserved word, and single-quote a string.";

const CYPHER_BOUND_RULE =
  "Bound every MATCH with LIMIT, or aggregate it with count() or collect(): a read past the row budget is refused, never cut.";

const CYPHER_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the database with run_read_query, one Cypher statement at a time: MATCH ... RETURN, the SHOW forms of the schema and the db.labels() family of procedures are the reads there are.",
    CYPHER_NAMING_RULE,
    CYPHER_BOUND_RULE,
    "Writes, LOAD CSV, USE, other procedures and comments are refused: this run reads and reports, and what it establishes goes into the report.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  "data-analysis": [
    "Answer from data you have READ with run_read_query: the schema inventory tells you where to look; only a result you ran can be the answer.",
    CYPHER_NAMING_RULE,
    CYPHER_BOUND_RULE,
    "When you have the answer, call present_answer with the artifact id of the read that IS the answer.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a label
 * declares no reference to another. No `planningRules`: they reach plan mode alone, whose statement form is the
 * provider's `statementLanguage` label, so the rules of the agent's reader are never told to it.
 */
const CYPHER_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: "Read any of them with run_read_query, for example CALL db.schema.nodeTypeProperties().",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with CALL db.labels().`,
});

export const CYPHER_SERVER_PACK = Object.freeze({
  adapter: CYPHER_ADAPTER,
  toolOverrides: CYPHER_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: CYPHER_GROUNDING,
  workflowToolRules: CYPHER_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
