/**
 * Audit correlation and artifact lifecycle for the agent execution path (#328).
 *
 * This is the glue that turns a policy decision into an accountable execution:
 * every attempt — allowed, denied, or held for approval — leaves an entry in
 * the SHIPPED audit layer (`src/lib/audit.ts`, reused rather than rebuilt), and
 * an allowed one leaves a run-scoped artifact that `releaseExecutionRun`
 * deletes when the run ends.
 *
 * Three properties are load-bearing:
 *
 * 1. **A denial is audited.** A decision that leaves no trace is the wrong
 *    default for a security layer: the log is how an operator learns an agent
 *    probed for something it could not have.
 * 2. **The decision event precedes the provider call.** Emission is not wrapped
 *    in a try/catch, so ANY audit-sink failure propagates and the provider is
 *    never invoked — the path fails closed on an unauditable execution rather
 *    than running it silently. (`src/proxy.ts` makes the opposite trade for a
 *    403 it has already decided; there, swallowing the sink error protects an
 *    answer that is not about to touch a database.)
 * 3. **Only closed vocabularies are logged.** The audited action is the
 *    registry-RESOLVED descriptor id, never the caller's raw operation string,
 *    and the actor is a `mode:role` label built only from values the pipeline
 *    validated. No SQL, no input, no driver message, no session identifier
 *    reaches an audit field — `src/lib/audit.ts` forbids exactly those, and the
 *    correlation id is what makes them unnecessary.
 *
 * No route wiring lives here: #328 builds the enforcement layer, and the agent
 * surface that calls it lands in a later milestone.
 */

import { randomUUID } from "node:crypto";
import { type AuditReason, emitAuditEvent } from "@/lib/audit";
import type { ExecutionArtifactStore } from "./artifacts";
import type { ExecutionBudget, ExecutionBudgetTracker } from "./budgets";
import type { ExecutionActor, PolicyDecision, PolicyDenyCode, PolicyEvaluationParams } from "./policy";
import { evaluateOperation, isValidActor } from "./policy";

/**
 * Every policy denial mapped to its audit reason. Typed as a total record, so
 * a new `PolicyDenyCode` cannot reach production without a reason code an
 * operator can filter on — the compiler is the mirror, not a convention.
 */
export const DENY_REASONS: Record<PolicyDenyCode, AuditReason> = {
  UNKNOWN_OPERATION: "agent_unknown_operation",
  AMBIGUOUS_OPERATION: "agent_ambiguous_operation",
  MALFORMED_POLICY_CONTEXT: "agent_malformed_policy_context",
  INVALID_ACTOR: "agent_invalid_actor",
  TARGET_OUT_OF_SCOPE: "agent_target_out_of_scope",
  INPUT_VALIDATION_FAILED: "agent_input_validation_failed",
  CAPABILITY_UNSUPPORTED: "agent_capability_unsupported",
  ROLE_FORBIDDEN: "agent_role_forbidden",
  MODE_FORBIDDEN: "agent_mode_forbidden",
  RISK_EXCEEDS_POLICY: "agent_risk_exceeds_policy",
  CONCURRENCY_BUDGET_EXCEEDED: "agent_concurrency_budget_exceeded",
  STATEMENT_BUDGET_EXCEEDED: "agent_statement_budget_exceeded",
  TOTAL_RUN_BUDGET_EXCEEDED: "agent_total_run_budget_exceeded",
};

/** `target` on the audit event (`route` on the stdout line) — the phase, not a URL. */
const DECISION_TARGET = "agent/operations/decision";
const EXECUTION_TARGET = "agent/operations/execution";
/** Logged instead of an operation id the registry refused to resolve. */
const UNRESOLVED_OPERATION = "unresolved";
/** Logged instead of a `mode:role` label the pipeline never validated. */
const UNKNOWN_ACTOR = "agent:unknown";

export interface AuditedExecutionContext<T = unknown> {
  /** Server-generated run id; the budget tracker and artifact store key on it. */
  readonly runId: string;
  readonly tracker: ExecutionBudgetTracker;
  readonly artifacts: ExecutionArtifactStore<T>;
  /** Injected so elapsed time is deterministic under test, as in `budgets.ts`. */
  readonly clock?: () => number;
}

type AllowDecision = Extract<PolicyDecision, { kind: "allow" }>;
type RefusedDecision = Exclude<PolicyDecision, AllowDecision>;

export type AuditedExecutionResult<T> =
  | { readonly kind: "denied"; readonly correlationId: string; readonly decision: RefusedDecision }
  | { readonly kind: "executed"; readonly correlationId: string; readonly decision: AllowDecision; readonly result: T };

/**
 * `mode:role`, but only when policy.ts's own actor validation accepts the
 * actor — otherwise `mode` and `role` are unvalidated caller text and have no
 * place in a log field. Asking `isValidActor` directly (rather than inferring
 * validity from the deny code) keeps this correct even if a future stage is
 * inserted ahead of the actor stage, and keeps the role/mode vocabulary in one
 * module.
 */
function actorLabel(actor: ExecutionActor): string {
  return isValidActor(actor) ? `${actor.mode}:${actor.role}` : UNKNOWN_ACTOR;
}

/**
 * Clamped: `Date.now` is the default clock and is not monotonic, and the budget
 * tracker refuses a negative or non-finite elapsed time — which would strand
 * the run's concurrency slot rather than merely mis-measure it, because the
 * statement has already run by the time it is accounted for. `Math.max` alone
 * is not enough: `Math.max(0, NaN)` is `NaN`.
 */
function elapsedSince(startedAtMs: number, clock: () => number): number {
  const elapsed = clock() - startedAtMs;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function refusalReason(decision: RefusedDecision): AuditReason {
  return decision.kind === "deny" ? DENY_REASONS[decision.reasonCode] : "agent_approval_required";
}

/**
 * Evaluates the request, audits the decision, and executes only on a plain
 * allow. The provider callback is unreachable on a denial or an approval
 * requirement (the spy-provider invariant `executeWithPolicy` pins, re-asserted
 * here because this entry point owns the audit and accounting around it — the
 * reason it is a separate function rather than a wrapper: there is no seam
 * between decision and invocation in `executeWithPolicy`).
 *
 * A provider failure is audited and rethrown untouched: the caller sees its own
 * error, and the audit line carries only the typed reason, never the message.
 */
export async function executeAuditedOperation<T>(
  params: Omit<PolicyEvaluationParams, "usage">,
  context: AuditedExecutionContext<T>,
  invoke: (execution: { readonly validatedInput: unknown; readonly budget: ExecutionBudget }) => Promise<T>,
): Promise<AuditedExecutionResult<T>> {
  const { runId, tracker, artifacts } = context;
  const clock = context.clock ?? Date.now;
  const correlationId = randomUUID();

  // Usage is read from the tracker rather than supplied by the caller — a
  // caller-passed snapshot could be stale or optimistic — and it is read BEFORE
  // this execution is registered, so a run's first execution cannot deny itself
  // on the concurrency budget.
  //
  // INVARIANT: nothing between this read and `beginExecution` below may await.
  // An await in that span would let two concurrent executions of the same run
  // both observe `activeExecutions: 0` and both pass the concurrency gate.
  const evaluation: PolicyEvaluationParams = { ...params, usage: tracker.usage(runId) };
  const decision = evaluateOperation(evaluation);

  // Resolved independently of the pipeline (resolution is pure and cheap): the
  // decision carries an operation id only when it allows or requires approval,
  // and a denial still has to name what was attempted.
  const resolution = params.registry.resolve(params.request?.operationId as string);
  const action = resolution.kind === "resolved" ? resolution.descriptor.id : UNRESOLVED_OPERATION;
  const user = actorLabel(params.actor);

  if (decision.kind !== "allow") {
    emitAuditEvent({
      type: "agent_operation",
      action,
      target: DECISION_TARGET,
      user,
      result: "failure",
      reason: refusalReason(decision),
      correlationId,
    });
    return { kind: "denied", correlationId, decision };
  }

  emitAuditEvent({
    type: "agent_operation",
    action,
    target: DECISION_TARGET,
    user,
    result: "success",
    correlationId,
  });

  const startedAtMs = clock();
  tracker.beginExecution(runId);

  // The try covers the provider call ONLY. Everything after it is this module's
  // own bookkeeping, and a compensating release that also covered it would call
  // endExecution twice — the tracker fails loud on the second, which would
  // replace whatever really went wrong and suppress the outcome event.
  let result: T;
  try {
    result = await invoke({ validatedInput: decision.validatedInput, budget: decision.effectiveBudget });
  } catch (error) {
    const failedAfterMs = elapsedSince(startedAtMs, clock);
    tracker.endExecution(runId, { statements: 1, elapsedMs: failedAfterMs });
    emitAuditEvent({
      type: "agent_operation",
      action,
      target: EXECUTION_TARGET,
      user,
      result: "failure",
      reason: "agent_execution_failed",
      duration: failedAfterMs,
      correlationId,
    });
    throw error;
  }

  const elapsedMs = elapsedSince(startedAtMs, clock);
  // Accounting, then the audit line, then the artifact. The statement ran, so
  // the trail is recorded before this module's in-memory store gets a say: a
  // store that refuses the result must not also erase the record that it ran.
  tracker.endExecution(runId, { statements: 1, elapsedMs });
  emitAuditEvent({
    type: "agent_operation",
    action,
    target: EXECUTION_TARGET,
    user,
    result: "success",
    duration: elapsedMs,
    correlationId,
  });
  // `createdAtMs` is the START instant, so the TTL is measured from when the
  // statement began, not from when it returned.
  artifacts.put(
    { correlationId, runId, operationId: decision.operationId, createdAtMs: startedAtMs, value: result },
    startedAtMs + elapsedMs,
  );
  return { kind: "executed", correlationId, decision, result };
}

/**
 * Ends a run: its artifacts and its budget accounting are released together, so
 * neither outlives the other. This is the deterministic cleanup path — the
 * artifact TTL exists only for runs that never reach it.
 *
 * The tracker goes first because it is the step that can refuse: `endRun`
 * throws while any execution is still live, and destroying the artifacts before
 * learning that would leave a live run with its results already gone.
 */
export function releaseExecutionRun(context: Pick<AuditedExecutionContext, "runId" | "tracker" | "artifacts">): void {
  context.tracker.endRun(context.runId);
  context.artifacts.releaseRun(context.runId);
}
