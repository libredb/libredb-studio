/**
 * What the server does for kubectl (#1821), assembled from the language's server modules.
 */
import type { AgentGoalShortfall } from "../../goal-verifier";
import type { AgentInventoryNoun } from "../../inventory-noun";
import { AGENT_ANSWER_CONTRACT, UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack, ShortfallNotice } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { KUBECTL_ADAPTER } from "./adapter";
import { KUBECTL_BASE_DEFINITIONS, KUBECTL_RESOURCES_CARD, KUBECTL_TOOL_OVERRIDES } from "./definitions";

/**
 * The kubectl tool rules. The investigation names what the redaction removes, because a model told nothing would
 * read `<redacted>` as the value and report it, or guess at it: the honest claim is that the value was not available
 * to the run.
 */
const KUBECTL_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the cluster with run_read_query, one kubectl statement at a time: get, describe, logs, top, events, api-resources, explain and auth can-i are the reads there are.",
    "Narrow every read to what the question needs with -n, -l or --field-selector: a read past the row budget is refused, never cut.",
    "Some values never reach you: env values, annotation values, ConfigMap data, a container's command and args, and Secret names and values read as <redacted>. Say so where it matters rather than guessing what they hold.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  "query-optimization": [
    "Read usage with inspect_usage on the namespace in question, narrowed by a label selector where the objective names a workload: one row per container, its CPU and memory use against its requests and limits.",
    "Usage is metrics-server's latest sample, a moment and not a history. Say so, and never claim a trend.",
    'Before you report, either call recommend_change with change "resources" for a container whose requests or limits do not fit what it uses, citing the inspect_usage artifact, or, if every container is sized sensibly, report that nothing needs to change and cite the inspect_usage artifact.',
    "A recommendation is offered to the user and never applied by this run.",
    "If the cluster serves no usage metrics, say so: install metrics-server to measure usage. Do not estimate usage from anything else.",
  ].join(" "),
  "database-assessment": [
    "You must call profile_workloads on the namespace before you report: this workflow answers with the profile that tool takes, and reads you compose yourself with run_read_query do not establish it.",
    "Grade what you find: workloads not ready or missing pods, restarts and why they ended, containers without requests, limits or probes, and the Warning events. Say which workload each finding is about.",
    "Restart counts are cumulative since each container started, not a rate: never present one as recent.",
    "A namespace with no workloads is an answer: cite the profile and say so.",
    "Use run_read_query (describe, logs, events) to explain what the profile shows.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  // The SQL analysis rules less the profile, which a cluster has no table for, and with the chart rule said up
  // front: most kubectl cells are text, which a chart refuses as not numeric, though a server-side Table's integer
  // columns (a Deployment's Up-to-date and Available, a ReplicaSet's Desired, Current and Ready) can be charted.
  "data-analysis": [
    "Answer from what you have READ with run_read_query: only a result you ran can be the answer.",
    "When you have it, call present_answer with the artifact id of the read that IS the answer. Most kubectl columns are text, so present the read as a table unless the columns you would chart are numeric, such as a Deployment's Up-to-date and Available counts.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
});

const KUBECTL_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: "Read any of them with run_read_query, for example get TYPE NAME -n NAMESPACE.",
  relations: false,
  ungrounded: (detail: string, noun: AgentInventoryNoun) =>
    `${detail}\nSo nothing about this cluster has been established for you: not one ${noun.singular} name. Read what you need with run_read_query, starting with get on the kinds your objective names.`,
});

const KUBECTL_SHORTFALL_NOTICES: Readonly<Partial<Record<AgentGoalShortfall, ShortfallNotice>>> = Object.freeze({
  // The resource-efficiency arms. Both are narrowed: `inspect_usage` and `recommend_change` are the variant's
  // `narrowedExtras`, so the tools these sentences name survive the narrowing. `no-usage-metrics` has no arm, because
  // there is nothing the model can do about a cluster without metrics-server; the rail's sentence names it instead.
  "no-usage-reading": () => {
    return {
      said: [
        "This workflow is judged on a usage reading, and this run has taken none: a report without one is scored as having established nothing.",
        "Your compose_report call was not run. Call inspect_usage on the namespace in question, then either recommend_change citing its artifact id or compose_report citing it, and then call compose_report.",
      ].join(" "),
      narrow: true,
    };
  },
  "no-usage-evidence": () => {
    return {
      said: [
        "Your report rests on no usage reading of this run: a resources recommendation, or a finding that nothing needs to change, must cite the inspect_usage artifact it rests on.",
        "Your compose_report call was not run. Cite the inspect_usage artifact id in the recommendation or in a claim, and then call compose_report again.",
      ].join(" "),
      narrow: true,
    };
  },
  // The cluster-health arm, narrowed for the same reason: `profile_workloads` is the variant's `narrowedExtras`.
  "no-workload-profile": () => {
    return {
      said: [
        "This workflow answers with the profile profile_workloads takes, and no namespace has been profiled, so the report would be scored as having established nothing.",
        "Your compose_report call was not run. Call profile_workloads on the namespace in question, and then call compose_report again.",
      ].join(" "),
      narrow: true,
    };
  },
});

/**
 * What a resource-efficiency run is told the moment it reads usage: the `AGENT_PLAN_BAR_NOTICE` argument on a
 * cluster. The bar is otherwise delivered by holding `compose_report`, which the report reserve suppresses, so a run
 * that spends its turns reading would hear it only once it could no longer act on it.
 */
const KUBECTL_USAGE_BAR_NOTICE = [
  "You have a usage reading in hand, and this workflow is judged on it: a report answers when a resources recommendation cites that reading, or when the report cites it and says nothing needs to change.",
  'Before you call compose_report, either call recommend_change with change "resources" citing the inspect_usage artifact, or compose the report citing it.',
].join(" ");

export const KUBECTL_SERVER_PACK = Object.freeze({
  adapter: KUBECTL_ADAPTER,
  toolOverrides: KUBECTL_TOOL_OVERRIDES,
  baseDefinitions: KUBECTL_BASE_DEFINITIONS,
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  recommendationCard: KUBECTL_RESOURCES_CARD,
  grounding: KUBECTL_GROUNDING,
  workflowToolRules: KUBECTL_WORKFLOW_TOOL_RULES,
  shortfallNotices: KUBECTL_SHORTFALL_NOTICES,
  usageBarNotice: KUBECTL_USAGE_BAR_NOTICE,
  usageBarTool: "inspect_usage",
} satisfies AgentLanguageServerPack);
