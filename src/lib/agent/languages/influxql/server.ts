/**
 * What the server does for the InfluxQL language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { AGENT_ANSWER_CONTRACT, UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { INFLUXQL_ADAPTER } from "./adapter";
import { INFLUXQL_TOOL_OVERRIDES } from "./definitions";

/** How a statement names what the inventory lists, and how it stays inside the row budget. */
const INFLUXQL_NAMING_RULE =
  'Every statement runs against the connection\'s database: name a measurement as "home", or as "db".."home" to read another database the connection may read. Double-quote a name and single-quote a string.';

const INFLUXQL_BOUND_RULE =
  "Bound every SELECT by time, as in WHERE time > now() - 1h, and with LIMIT, which counts per series: a read past the row budget is refused, never cut.";

const INFLUXQL_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the database with run_read_query, one InfluxQL statement at a time: SELECT, SHOW of the catalog and EXPLAIN of a SELECT are the reads there are.",
    INFLUXQL_NAMING_RULE,
    INFLUXQL_BOUND_RULE,
    "INTO, writes, SHOW QUERIES and comments are refused: this run reads and reports, and what it establishes goes into the report.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  "data-analysis": [
    "Answer from data you have READ with run_read_query: the schema inventory tells you where to look; only a result you ran can be the answer.",
    INFLUXQL_NAMING_RULE,
    INFLUXQL_BOUND_RULE,
    "When you have the answer, call present_answer with the artifact id of the read that IS the answer.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: a
 * measurement declares no reference to another. No `planningRules`: plan mode drafts writes too, so the read-only
 * rules of the agent's reader are never told to it.
 */
const INFLUXQL_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: 'Read any of them with run_read_query, for example SHOW FIELD KEYS FROM "home" for the measurement home.',
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with SHOW MEASUREMENTS.`,
});

export const INFLUXQL_SERVER_PACK = Object.freeze({
  adapter: INFLUXQL_ADAPTER,
  toolOverrides: INFLUXQL_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: INFLUXQL_GROUNDING,
  workflowToolRules: INFLUXQL_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
