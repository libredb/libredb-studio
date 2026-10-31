/**
 * What the server does for the fsquery statement language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { FSQUERY_ADAPTER } from "./adapter";
import { FSQUERY_TOOL_OVERRIDES } from "./definitions";

const FSQUERY_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the database with run_read_query, one Firestore statement at a time, written as one chain starting at db: db.listCollections() for the root collection ids, db.doc("PATH").listCollections() for the subcollections of a document the question names in full, db.collection("PATH").count() or db.collectionGroup("ID").count() for one whole collection\'s document count, and db.doc("PATH").get() for whether a document the question names in full exists and when it was created and last updated.',
    "Name a collection exactly as the inventory names it and a document path exactly as the question names it, and narrow nothing: a where, orderBy, cursor, offset, limit or select on a count is withheld, since narrower counts would reveal stored values.",
    "Answers carry collection ids, counts, flags and times only: document ids and paths, field names and field values are withheld, so no statement returns a document or lists document ids, a collection holding more documents than the row budget is refused rather than counted in part, every read is charged to this run's read allowance, and what this run establishes is the collections, their sizes, and the existence and times of the documents it was told about.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds collection ids with `__name__` as their one column, so the
 * omission advice names a read the run holds. `relations` is false: a collection declares no relation the inventory
 * draws. No `planningRules`: they reach plan mode alone, whose statement form is the provider's `statementLanguage`
 * label, so the rules of the agent's reader are never told to it.
 */
const FSQUERY_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    'Collections are listed to agent mode by id only, each with __name__ as its one column, and no document id, field name or field value is listed, since they count as stored values. Read a collection with run_read_query, for example db.collection("users").count() for its document count, db.doc("users/alice").listCollections() for the subcollections of a document the question names, and db.doc("users/alice").get() for whether that document exists and when it was created and last updated.',
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this database has been established for you: not one ${noun.singular} id, and no document id, field name or field value will be, since they are withheld from agent mode. Read what you need with run_read_query, starting with db.listCollections().`,
});

export const FSQUERY_SERVER_PACK = Object.freeze({
  adapter: FSQUERY_ADAPTER,
  toolOverrides: FSQUERY_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: FSQUERY_GROUNDING,
  workflowToolRules: FSQUERY_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
