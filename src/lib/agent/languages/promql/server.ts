/**
 * What the server does for the PromQL language, assembled from the language's server modules.
 */
import { PROMETHEUS_AGENT_PROJECTION } from "@/lib/db/providers/timeseries/prometheus/agent-projection";
import type { AgentInventoryNoun } from "../../inventory-noun";
import { AGENT_ANSWER_CONTRACT, UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { PROMQL_ADAPTER } from "./adapter";
import { PROMQL_TOOL_OVERRIDES } from "./definitions";

/** What is withheld and why, the same words in the rule, the grounding advice and the ungrounded note. */
const WITHHELD = `${PROMETHEUS_AGENT_PROJECTION.flags} ${PROMETHEUS_AGENT_PROJECTION.urls}`;

/** How a read is written, and how it stays inside the row budget. */
const PROMQL_READ_RULE =
  "Read the server with run_read_query, one PromQL expression at a time, written alone: it is evaluated as an instant query at the server's now, so cover a window with a range vector or a subquery inside it (rate(x[5m]), max_over_time(x[1h])), never with a time or range parameter, which cannot be written.";

const PROMQL_BOUND_RULE =
  "A vector answers one row per series and a matrix one row per sample, and a read past the row budget is refused, never cut: aggregate (sum by (job) (...)), narrow the selector with label matchers, and keep a matrix's range short or its subquery step wide.";

const PROMQL_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    PROMQL_READ_RULE,
    "Name a metric as the inventory names it, with a label matcher from its label names; up tells which targets were scraped, and ALERTS which alerts are pending or firing.",
    PROMQL_BOUND_RULE,
    WITHHELD,
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  "data-analysis": [
    "Answer from data you have READ with run_read_query: the inventory tells you where to look; only a result you ran can be the answer.",
    PROMQL_READ_RULE,
    PROMQL_BOUND_RULE,
    "When you have the answer, call present_answer with the artifact id of the read that IS the answer.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
});

/**
 * No `inspect_schema` is offered, and the grounding holds the metrics with their label names, the rule groups and
 * rules, and the scrape pools and targets, by name, so the omission advice names a read the run holds and the withheld
 * items' reasons. `relations` is false: a metric declares no reference to another. No `planningRules`: they reach plan
 * mode alone, whose statement form is the provider's `statementLanguage` label, so the rules of the agent's reader are
 * never told to it.
 */
const PROMQL_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: `Metrics are listed with their label names, and rules, scrape pools and targets by name, never with a value. Read any of them with run_read_query, for example up, count by (job) (up) or ALERTS. ${WITHHELD}`,
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this server has been established for you: not one ${noun.singular} name. ${WITHHELD} Read what you need with run_read_query, starting with up.`,
});

export const PROMQL_SERVER_PACK = Object.freeze({
  adapter: PROMQL_ADAPTER,
  toolOverrides: PROMQL_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  grounding: PROMQL_GROUNDING,
  workflowToolRules: PROMQL_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
