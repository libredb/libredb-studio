/**
 * What the server does for the etcdctl command language, assembled from the language's server modules.
 */
import type { AgentInventoryNoun } from "../../inventory-noun";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { ETCDCTL_ADAPTER } from "./adapter";
import { ETCDCTL_TOOL_OVERRIDES } from "./definitions";

const ETCDCTL_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    'Read the cluster with run_read_query, one etcdctl command at a time on one line: endpoint status for the version, the database size and the leader, member list, alarm list, auth status, lease list and lease timetolive <lease id>, get "" --prefix --count-only for the count of every key, and get <key> for a key the question names.',
    "Name a key exactly as the question names it, double-quoting one that holds a space, and add no flag: the revision, range, limit and consistency of every read are fixed.",
    "Answers carry names, counts and sizes only: key names and stored values are withheld, so no command lists keys, reads a value or watches, and what this run establishes is the cluster's state, the key count and the metadata of the keys it was told about.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
});

/**
 * No `inspect_schema` is offered, and the grounding holds no key name, so the omission advice names a read the run
 * holds. `relations` is false: an etcd key declares no relation the inventory draws. No `planningRules`: they reach
 * plan mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader
 * are never told to it.
 */
const ETCDCTL_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice:
    'No key name is listed to agent mode. Read the cluster with run_read_query and endpoint status, the key count with get "" --prefix --count-only, and a key the question names with get, for example get /config/feature-flags.',
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this cluster's keys has been established for you: not one ${noun.singular} name, and none will be, since key names are withheld from agent mode. Read what you need with run_read_query, starting with endpoint status.`,
});

export const ETCDCTL_SERVER_PACK = Object.freeze({
  adapter: ETCDCTL_ADAPTER,
  toolOverrides: ETCDCTL_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: ETCDCTL_GROUNDING,
  workflowToolRules: ETCDCTL_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
