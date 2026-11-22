/**
 * The kubectl curated readings the run loop executes as evidence (#1821): `inspect_usage` and `profile_workloads`.
 * Execution tier: they run through the audited call in `tools.ts`, so this module sits above it and `tools.ts` never
 * imports it.
 */
import { clusterUsageReadInput, clusterWorkloadsReadInput } from "@/lib/db/operations/descriptors";
import type { AuditedInvocation } from "@/lib/db/operations/execution";
import type { ExecutionBudget } from "@/lib/db/operations/budgets";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { runReadOnlyReading } from "@/lib/db/operations/read-only-statement";
import type {
  ClusterUsageInput,
  ClusterUsageReading,
  WorkloadProfileInput,
  WorkloadProfileReading,
} from "@/lib/db/types";
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

/**
 * The most rows either cluster reading may carry: its own ceiling, which its tool description and its advice name, and
 * not the run's `maxResultRows`. Core holds the rows the provider answers to it (`runReadOnlyReading`), so a reading
 * the provider answered past it is refused here as its own `over-ceiling` answer is.
 */
const CLUSTER_READING_ROW_CEILING = 500;

/** The rows a cluster reading serves: its result's, or none for an answer that carries no rows. */
function readingRows(reading: ClusterUsageReading | WorkloadProfileReading): readonly Record<string, unknown>[] {
  return reading.kind === "rows" ? reading.result.rows : [];
}

/** The cluster usage reading's advice past its row ceiling: it takes no limit, so a smaller limit is not advice. */
const CLUSTER_OVER_CEILING_TEXT = `That reading holds more than ${CLUSTER_READING_ROW_CEILING} rows, the most it may carry, so none of it was kept. Ask again narrowed by a label selector, or for a smaller namespace.`;

/**
 * The same advice past the run's byte budget, which a few hundred wide rows can reach under the row ceiling. It names
 * the budget and not a size: core stops measuring at the row that carries the sum past it, so the sum it refuses on is
 * not the reading's size.
 */
const clusterOverBytesText = (allowed: number): string =>
  `That reading holds more than the ${allowed} bytes this run may carry, so none of it was kept. Ask again narrowed by a label selector, or for a smaller namespace.`;

/**
 * The cluster usage reading, inside the audited call.
 *
 * Acquired under the agent's read-only profile rather than the operations one: the selector is the model's and reaches
 * the API server, so the reading is a `data-read` under the kubectl read boundary, and machine redaction applies.
 * `metrics-unavailable` and `over-ceiling` are the provider's answers, not failures, and become the typed refusals
 * here, after the call was charged. Core holds the rows the provider answers (`runReadOnlyReading`): past the 500-row
 * ceiling, or past the run's byte budget summed per row, they are refused in this reading's own advice and nothing is
 * cut, and past the statement timeout the reading is refused in the time sentence, counted against the run's
 * concurrency until the provider's call settles.
 */
async function runClusterUsage(
  context: AgentToolContext,
  input: ClusterUsageInput,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
  holdUntilSettled: AuditedInvocation["holdUntilSettled"],
): Promise<QueryResult> {
  const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
  const readClusterUsage = provider.readClusterUsage;
  if (typeof readClusterUsage !== "function") throw new AgentCuratedReadError("KIND_UNSUPPORTED_BY_PROVIDER");
  phase.statementSent = true;
  const handed = readOnlyBudgetFor(context, budget);
  const reading = await runReadOnlyReading({
    type: context.connection.type,
    scrub: providerTextScrub(context.connection, "profiled"),
    statement: `usage ${input.namespace} ${input.selector ?? ""}`,
    budget: handed,
    wait: "statement-timeout",
    holdUntilSettled,
    read: () => readClusterUsage.call(provider, input, handed),
    servedRows: readingRows,
    maxRows: CLUSTER_READING_ROW_CEILING,
    refuseRows: () => new AgentCuratedReadError("READING_OVER_BUDGET", CLUSTER_OVER_CEILING_TEXT),
    refuseBytes: (_bytes, allowed) => new AgentCuratedReadError("READING_OVER_BUDGET", clusterOverBytesText(allowed)),
  });
  if (reading.kind === "metrics-unavailable") throw new AgentCuratedReadError("METRICS_UNAVAILABLE");
  if (reading.kind === "over-ceiling")
    throw new AgentCuratedReadError("READING_OVER_BUDGET", CLUSTER_OVER_CEILING_TEXT);
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
    invoke: (validatedInput, budget, phase, holdUntilSettled) =>
      runClusterUsage(context, validatedInput as ClusterUsageInput, budget, phase, holdUntilSettled),
  });
}

/** The workload profile's advice past its row ceiling: it takes a namespace alone, so a selector is not advice. */
const WORKLOADS_OVER_CEILING_TEXT = `That profile holds more than ${CLUSTER_READING_ROW_CEILING} workloads, the most it may carry, so none of it was kept. Profile a smaller namespace, or read the workloads in question with run_read_query.`;

/** The same advice past the run's byte budget, naming the budget and not a size, as `clusterOverBytesText` does. */
const workloadsOverBytesText = (allowed: number): string =>
  `That profile holds more than the ${allowed} bytes this run may carry, so none of it was kept. Profile a smaller namespace, or read the workloads in question with run_read_query.`;

/**
 * The workload profile, inside the audited call: `runClusterUsage`'s shape for `readWorkloadProfile`.
 *
 * The namespace is the model's and reaches the API server, so the profile is acquired under the agent's read-only
 * profile and machine redaction applies. `over-ceiling` is the provider's answer, not a failure, and becomes the typed
 * refusal here, after the call was charged. Core holds the rows the provider answers as `runClusterUsage` does: past
 * the 500-workload ceiling or the byte budget they are refused in this profile's own advice and nothing is cut.
 */
async function runWorkloadProfile(
  context: AgentToolContext,
  input: WorkloadProfileInput,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
  holdUntilSettled: AuditedInvocation["holdUntilSettled"],
): Promise<QueryResult> {
  const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
  const readWorkloadProfile = provider.readWorkloadProfile;
  if (typeof readWorkloadProfile !== "function") {
    throw new AgentCuratedReadError("KIND_UNSUPPORTED_BY_PROVIDER");
  }
  phase.statementSent = true;
  const handed = readOnlyBudgetFor(context, budget);
  const reading = await runReadOnlyReading({
    type: context.connection.type,
    scrub: providerTextScrub(context.connection, "profiled"),
    statement: `workloads ${input.namespace}`,
    budget: handed,
    wait: "statement-timeout",
    holdUntilSettled,
    read: () => readWorkloadProfile.call(provider, input, handed),
    servedRows: readingRows,
    maxRows: CLUSTER_READING_ROW_CEILING,
    refuseRows: () => new AgentCuratedReadError("READING_OVER_BUDGET", WORKLOADS_OVER_CEILING_TEXT),
    refuseBytes: (_bytes, allowed) => new AgentCuratedReadError("READING_OVER_BUDGET", workloadsOverBytesText(allowed)),
  });
  if (reading.kind === "over-ceiling")
    throw new AgentCuratedReadError("READING_OVER_BUDGET", WORKLOADS_OVER_CEILING_TEXT);
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
    invoke: (validatedInput, budget, phase, holdUntilSettled) =>
      runWorkloadProfile(context, validatedInput as WorkloadProfileInput, budget, phase, holdUntilSettled),
  });
}
