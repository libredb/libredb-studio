/**
 * What the server does for the Redis command language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { REDISCLI_ADAPTER } from "./adapter";
import { REDISCLI_TOOL_OVERRIDES } from "./definitions";

const REDISCLI_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the server with run_read_query, one Redis command at a time on one line: DBSIZE for the database's key count, then, for a key the question names, TYPE, EXISTS, TTL or PTTL, the length read of its type (STRLEN, LLEN, HLEN, SCARD, ZCARD or XLEN), OBJECT ENCODING and MEMORY USAGE.",
    "Every command reads the connection's own database. Name a key exactly as the question names it, double-quoting one that holds a space.",
    "Answers carry counts, types and sizes only: key names and stored values are withheld, so no command lists keys or reads a value, field or member, and what this run establishes is the database's size and the shape of the keys it was told about.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds no key name, so the omission advice names a read the run
 * holds. `relations` is false: a Redis key declares no relation the inventory draws. No `planningRules`: they reach
 * plan mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader
 * are never told to it.
 */
const REDISCLI_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    "No key name is listed to agent mode. Read the database's key count with run_read_query and DBSIZE, and a key the question names with TYPE and the length read of its type, for example TYPE session:42.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} name, and none will be, since key names are withheld from agent mode. Read what you need with run_read_query, starting with DBSIZE.`,
});

export const REDISCLI_SERVER_PACK = Object.freeze({
  adapter: REDISCLI_ADAPTER,
  toolOverrides: REDISCLI_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: REDISCLI_GROUNDING,
  workflowToolRules: REDISCLI_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
