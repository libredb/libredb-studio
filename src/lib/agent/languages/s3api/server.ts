/**
 * What the server does for the s3api command language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { S3API_ADAPTER } from "./adapter";
import { S3API_TOOL_OVERRIDES } from "./definitions";

const S3API_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the store with run_read_query, one AWS CLI command at a time on one line: aws s3api list-buckets for the buckets, aws s3api head-bucket, get-bucket-location or get-bucket-versioning --bucket BUCKET for one bucket, aws s3 ls s3://BUCKET --recursive --summarize for one whole bucket's object count and total size, and aws s3api head-object --bucket BUCKET --key KEY for an object the question names in full.",
    "Name a bucket exactly as the inventory names it and a key exactly as the question names it, single-quoting one that holds a space, and add no other flag: a --prefix, --delimiter, --starting-token or key path is withheld, since narrower counts would reveal key names, and the endpoint, region and paging of every read are the connection's.",
    "Answers carry names, counts and flags only: object keys, bodies, user metadata, tags, ETags, version ids, owners, ACLs, policies and the endpoint are withheld, so no command lists keys or reads an object, a bucket holding more objects than the row budget is refused rather than counted in part, and what this run establishes is the buckets, their regions, versioning and totals, and the metadata of the objects it was told about.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds no key, so the omission advice names a read the run holds.
 * `relations` is false: a bucket declares no relation the inventory draws. No `planningRules`: they reach plan mode
 * alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader are never
 * told to it.
 */
const S3API_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    "Buckets are listed to agent mode by name and creation date only, and no object key is listed, since keys count as stored values. Read a bucket with run_read_query, for example aws s3 ls s3://sales --recursive --summarize for its object count and total size, and an object the question names with aws s3api head-object --bucket sales --key 2026/orders.csv.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this store has been established for you: not one ${noun.singular} name, and no object key will be, since keys are withheld from agent mode. Read what you need with run_read_query, starting with aws s3api list-buckets.`,
});

export const S3API_SERVER_PACK = Object.freeze({
  adapter: S3API_ADAPTER,
  toolOverrides: S3API_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: S3API_GROUNDING,
  workflowToolRules: S3API_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
