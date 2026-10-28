/**
 * The kubectl curated readings the run loop executes as evidence (#1821): `inspect_usage` and `profile_workloads`.
 * Execution tier: they run through the audited call in `tools.ts`, so this module sits above it and `tools.ts` never
 * imports it.
 */
import { clusterUsageReadInput, clusterWorkloadsReadInput } from "@/lib/db/operations/descriptors";
import type { ExecutionBudget } from "@/lib/db/operations/budgets";
import { measureResultBytes } from "@/lib/db/providers/sql/read-only-budget";
import type { ClusterUsageInput, WorkloadProfileInput } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { AGENT_EXECUTION_PROFILE } from "../../execution-policy";
import { unavailable } from "../../tool-contracts";
import {
  AgentCuratedReadError,
  type AgentToolContext,
  type AgentToolOutcome,
  parseToolInput,
  readOnlyBudgetFor,
  runAuditedAgentCall,
} from "../../tools";

/** The cluster usage reading's advice past its row ceiling: it takes no limit, so a smaller limit is not advice. */
const CLUSTER_OVER_CEILING_TEXT =
  "That reading holds more than 500 rows, the most it may carry, so none of it was kept. Ask again narrowed by a label selector, or for a smaller namespace.";

/** The same advice past the run's byte budget, which a few hundred wide rows can reach under the row ceiling. */
const clusterOverBytesText = (bytes: number, allowed: number): string =>
  `That reading came to ${bytes} bytes, more than the ${allowed} bytes this run may carry, so none of it was kept. Ask again narrowed by a label selector, or for a smaller namespace.`;

/**
 * The cluster usage reading, inside the audited call.
 *
 * Acquired under the agent's read-only profile rather than the operations one: the selector is the model's and reaches
 * the API server, so the reading is a `data-read` under the kubectl read boundary, and machine redaction applies.
 * `metrics-unavailable` and `over-ceiling` are the provider's answers, not failures, and become the typed refusals
 * here, after the call was charged. Both bounds refuse and nothing is cut: the provider's own 500-row ceiling, and the
 * run's byte budget measured as the read path measures it.
 */
async function runClusterUsage(
  context: AgentToolContext,
  input: ClusterUsageInput,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
): Promise<QueryResult> {
  const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
  if (typeof provider.readClusterUsage !== "function") throw new AgentCuratedReadError("KIND_UNSUPPORTED_BY_PROVIDER");
  phase.statementSent = true;
  const reading = await provider.readClusterUsage(input, readOnlyBudgetFor(context, budget));
  if (reading.kind === "metrics-unavailable") throw new AgentCuratedReadError("METRICS_UNAVAILABLE");
  if (reading.kind === "over-ceiling")
    throw new AgentCuratedReadError("READING_OVER_BUDGET", CLUSTER_OVER_CEILING_TEXT);
  const bytes = measureResultBytes(reading.result.rows);
  if (bytes > budget.maxResultBytes) {
    throw new AgentCuratedReadError("READING_OVER_BUDGET", clusterOverBytesText(bytes, budget.maxResultBytes));
  }
  return reading.result;
}

/** Container usage against requests and limits in one namespace: one audited call, one statement charge. */
export async function inspectUsageTool(context: AgentToolContext, input: unknown): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(clusterUsageReadInput, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT", parsed.problems);
  const selector = parsed.value;
  return runAuditedAgentCall(context, {
    operationId: "cluster.usage.read",
    // The kubectl fingerprint, which keeps case: two selectors differing in case are two reads.
    fingerprintSource: `usage ${selector.namespace} ${selector.selector ?? ""}`,
    fingerprintLanguage: "kubectl",
    input: selector,
    label: `container usage in ${selector.namespace}`,
    invoke: (validatedInput, budget, phase) =>
      runClusterUsage(context, validatedInput as ClusterUsageInput, budget, phase),
  });
}

/** The workload profile's advice past its row ceiling: it takes a namespace alone, so a selector is not advice. */
const WORKLOADS_OVER_CEILING_TEXT =
  "That profile holds more than 500 workloads, the most it may carry, so none of it was kept. Profile a smaller namespace, or read the workloads in question with run_read_query.";

/** The same advice past the run's byte budget. */
const workloadsOverBytesText = (bytes: number, allowed: number): string =>
  `That profile came to ${bytes} bytes, more than the ${allowed} bytes this run may carry, so none of it was kept. Profile a smaller namespace, or read the workloads in question with run_read_query.`;

/**
 * The workload profile, inside the audited call: `runClusterUsage`'s shape for `readWorkloadProfile`.
 *
 * The namespace is the model's and reaches the API server, so the profile is acquired under the agent's read-only
 * profile and machine redaction applies. `over-ceiling` is the provider's answer, not a failure, and becomes the typed
 * refusal here, after the call was charged; the byte budget is measured as the read path measures it. Both refuse and
 * nothing is cut.
 */
async function runWorkloadProfile(
  context: AgentToolContext,
  input: WorkloadProfileInput,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
): Promise<QueryResult> {
  const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
  if (typeof provider.readWorkloadProfile !== "function") {
    throw new AgentCuratedReadError("KIND_UNSUPPORTED_BY_PROVIDER");
  }
  phase.statementSent = true;
  const reading = await provider.readWorkloadProfile(input, readOnlyBudgetFor(context, budget));
  if (reading.kind === "over-ceiling")
    throw new AgentCuratedReadError("READING_OVER_BUDGET", WORKLOADS_OVER_CEILING_TEXT);
  const bytes = measureResultBytes(reading.result.rows);
  if (bytes > budget.maxResultBytes) {
    throw new AgentCuratedReadError("READING_OVER_BUDGET", workloadsOverBytesText(bytes, budget.maxResultBytes));
  }
  return reading.result;
}

/** One namespace's workload profile: one audited call, one statement charge. */
export async function profileWorkloadsTool(context: AgentToolContext, input: unknown): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(clusterWorkloadsReadInput, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT", parsed.problems);
  const target = parsed.value;
  return runAuditedAgentCall(context, {
    operationId: "cluster.workloads.read",
    fingerprintSource: `workloads ${target.namespace}`,
    fingerprintLanguage: "kubectl",
    input: target,
    label: `workload profile of ${target.namespace}`,
    invoke: (validatedInput, budget, phase) =>
      runWorkloadProfile(context, validatedInput as WorkloadProfileInput, budget, phase),
  });
}
