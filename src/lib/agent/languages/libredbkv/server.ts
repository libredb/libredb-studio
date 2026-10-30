/**
 * What the server does for the LibreDB command language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { AGENT_ANSWER_CONTRACT, UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { LIBREDBKV_ADAPTER } from "./adapter";
import { LIBREDBKV_TOOL_OVERRIDES } from "./definitions";

/**
 * How a command spells what the inventory names. The inventory lists each namespace as `users:*`, which reads as a
 * wildcard this grammar does not have: `get users:*` looks up a key literally named `users:*` and answers no row and no
 * error, which on a key-value store reads as "nothing stored there" (the plan run that drafted it is recorded beside
 * `statementLanguage` in the provider's labels).
 */
const LIBREDBKV_KEY_RULE =
  "The inventory names each namespace as users:*, a grouping and not a key: read every key under it with prefix users: and one key by its exact name with get users:1. A command matches keys exactly, with no glob and no wildcard.";

const LIBREDBKV_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the database with run_read_query, one LibreDB command at a time: get, prefix and range are the reads there are.",
    LIBREDBKV_KEY_RULE,
    "Narrow every read to what the question needs with a longer prefix or a closer range: a read past the row budget is refused, never cut.",
    "put and delete are refused: this run reads and reports, and what it establishes goes into the report.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  "data-analysis": [
    "Answer from data you have READ with run_read_query: the schema inventory tells you where to look; only a result you ran can be the answer.",
    LIBREDBKV_KEY_RULE,
    "When you have the answer, call present_answer with the artifact id of the read that IS the answer. A read answers key and value columns, both text, so present it as a table.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
});

/**
 * No `inspect_schema` is offered, so the omission advice names a read the run holds. `relations` is false: the catalog
 * declares no reference between namespaces. No `planningRules`: plan mode drafts writes too, so the read-only rules
 * of the agent's reader are never told to it.
 */
const LIBREDBKV_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: "Read any of them with run_read_query, for example prefix users: for the namespace users:*.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with prefix on the namespaces your objective names.`,
});

export const LIBREDBKV_SERVER_PACK = Object.freeze({
  adapter: LIBREDBKV_ADAPTER,
  toolOverrides: LIBREDBKV_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: LIBREDBKV_GROUNDING,
  workflowToolRules: LIBREDBKV_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
