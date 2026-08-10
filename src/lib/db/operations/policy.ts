/**
 * Fail-closed policy decision pipeline (#328).
 *
 * Fixed evaluation order: actor/session → classification (registry
 * resolution) → immutable target scope → schema-validated input → provider
 * capability → risk/mode/role policy → budgets. The six spec stages run in
 * their pinned order with actor/session literally first; classification slots
 * immediately after it because every descriptor-dependent stage (input schema,
 * capabilities, risk class, approval flag) needs the resolved descriptor,
 * while the actor stage reads nothing from it. First denial wins. Every
 * outcome is a typed allow / deny / require-approval carrying a reason code,
 * the policy version, and the effective budget — and on anything but a plain
 * allow the provider callback is never invoked (`executeWithPolicy`).
 *
 * The pipeline reads only modeled descriptor fields (id, riskClass,
 * requiredCapabilities, requiresApproval, inputSchema) — never a spread of the
 * descriptor object — so unmodeled fields smuggled past the registry types
 * cannot influence a decision. Capabilities arrive as data, not as a provider
 * instance: they are a fast deny signal and stay a UI-affordance contract; the
 * security boundary is database-native (the T3/T4 execution profiles).
 *
 * `requiresApproval` is resolved AFTER all deny stages pass: an approval-
 * flagged request that is also over budget denies — approval must never be a
 * channel around a denial. Server-side context integrity (policy, usage,
 * scope) is a precondition checked before the stages; a malformed context
 * denies with `MALFORMED_POLICY_CONTEXT` because a NaN budget limit or junk
 * usage would otherwise compare permissively and fail open.
 */

import type { Role } from "@/lib/auth";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ExecutionBudget, ExecutionUsage } from "./budgets";
import type { OperationRegistry } from "./registry";

/**
 * Execution modes this layer serves today. The normal editor path is
 * deliberately NOT a mode: it stays un-gated by this pipeline (#328 keeps the
 * editor/API write path regression-unchanged). New modes are added here only
 * when a policy decision admits them — an unknown mode is an invalid actor,
 * never a permissive default.
 */
type ExecutionMode = "agent";

/**
 * Runtime vocabularies for actor validation. `Role` is compile-time coupled to
 * the auth seam (`src/lib/auth.ts`); this set intentionally does NOT widen
 * automatically if a new role is added there — a new role stays denied by this
 * layer until policy work admits it explicitly (fail closed).
 */
const ROLES: ReadonlySet<unknown> = new Set<Role>(["admin", "user"]);
const MODES: ReadonlySet<unknown> = new Set<ExecutionMode>(["agent"]);

export interface ExecutionActor {
  readonly sessionId: string;
  readonly role: Role;
  readonly mode: ExecutionMode;
}

/** Server-injected target scope. Build via `createTargetScope`; never caller-chosen. */
export interface TargetScope {
  readonly connectionId: string;
  /** When present, the request must name a member. An empty list is deny-all. */
  readonly catalogAllowlist?: readonly string[];
  readonly schemaAllowlist?: readonly string[];
}

export interface OperationRequest {
  readonly operationId: string;
  /** Caller-declared target; every present field must fall inside the scope. */
  readonly target?: {
    readonly connectionId?: string;
    readonly catalog?: string;
    readonly schema?: string;
  };
  readonly input: unknown;
}

export interface ExecutionPolicy {
  readonly version: string;
  readonly maxRiskClass: 0 | 1;
  readonly allowedRoles: readonly Role[];
  readonly allowedModes: readonly ExecutionMode[];
  readonly budgets: ExecutionBudget;
}

export interface PolicyEvaluationParams {
  readonly registry: OperationRegistry;
  readonly policy: ExecutionPolicy;
  readonly actor: ExecutionActor;
  readonly scope: TargetScope;
  readonly request: OperationRequest;
  readonly capabilities: ProviderCapabilities;
  readonly usage: ExecutionUsage;
}

export type PolicyDenyCode =
  | "UNKNOWN_OPERATION"
  | "AMBIGUOUS_OPERATION"
  | "MALFORMED_POLICY_CONTEXT"
  | "INVALID_ACTOR"
  | "TARGET_OUT_OF_SCOPE"
  | "INPUT_VALIDATION_FAILED"
  | "CAPABILITY_UNSUPPORTED"
  | "ROLE_FORBIDDEN"
  | "MODE_FORBIDDEN"
  | "RISK_EXCEEDS_POLICY"
  | "CONCURRENCY_BUDGET_EXCEEDED"
  | "STATEMENT_BUDGET_EXCEEDED"
  | "TOTAL_RUN_BUDGET_EXCEEDED";

interface PolicyDecisionBase {
  readonly policyVersion: string;
  readonly effectiveBudget: ExecutionBudget;
}

interface PolicyAllowDecision extends PolicyDecisionBase {
  readonly kind: "allow";
  readonly reasonCode: "ALLOWED";
  readonly operationId: string;
  /** The schema-parsed input snapshot — execution consumes this, never the raw request input. */
  readonly validatedInput: unknown;
}

interface PolicyApprovalDecision extends PolicyDecisionBase {
  readonly kind: "require-approval";
  readonly reasonCode: "APPROVAL_REQUIRED";
  readonly operationId: string;
}

interface PolicyDenyDecision extends PolicyDecisionBase {
  readonly kind: "deny";
  readonly reasonCode: PolicyDenyCode;
}

export type PolicyDecision = PolicyAllowDecision | PolicyApprovalDecision | PolicyDenyDecision;

export class TargetScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetScopeError";
    Object.setPrototypeOf(this, TargetScopeError.prototype);
  }
}

/** Nothing is executable under this budget; attached to malformed-context denials. */
const ZERO_BUDGET: ExecutionBudget = Object.freeze({
  maxConcurrentExecutions: 0,
  maxStatementsPerRun: 0,
  maxTotalRunMs: 0,
  statementTimeoutMs: 0,
  maxResultRows: 0,
  maxResultBytes: 0,
});

const BUDGET_FIELDS = [
  "maxConcurrentExecutions",
  "maxStatementsPerRun",
  "maxTotalRunMs",
  "statementTimeoutMs",
  "maxResultRows",
  "maxResultBytes",
] as const;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidAllowlist(list: readonly string[] | undefined): boolean {
  return list === undefined || (Array.isArray(list) && list.every(isNonBlankString));
}

function frozenAllowlist(entries: readonly string[], label: string): readonly string[] {
  if (!entries.every(isNonBlankString)) {
    throw new TargetScopeError(`every ${label} allowlist entry must be a non-empty string`);
  }
  return Object.freeze([...entries]);
}

/**
 * Builds the immutable, server-injected target scope. Construction is a
 * trusted server-side act and fails loud, mirroring `OperationRegistry.register`.
 */
export function createTargetScope(
  connectionId: string,
  allowlists: { readonly catalogs?: readonly string[]; readonly schemas?: readonly string[] } = {},
): TargetScope {
  if (!isNonBlankString(connectionId)) {
    throw new TargetScopeError("connectionId must be a non-empty string");
  }
  const scope: TargetScope = {
    connectionId,
    ...(allowlists.catalogs === undefined ? {} : { catalogAllowlist: frozenAllowlist(allowlists.catalogs, "catalog") }),
    ...(allowlists.schemas === undefined ? {} : { schemaAllowlist: frozenAllowlist(allowlists.schemas, "schema") }),
  };
  return Object.freeze(scope);
}

function isValidBudget(budgets: ExecutionBudget): boolean {
  if (typeof budgets !== "object" || budgets === null) return false;
  return BUDGET_FIELDS.every((field) => {
    const value = budgets[field];
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
  });
}

function isValidPolicy(policy: ExecutionPolicy): boolean {
  if (typeof policy !== "object" || policy === null) return false;
  if (!isNonBlankString(policy.version)) return false;
  if (policy.maxRiskClass !== 0 && policy.maxRiskClass !== 1) return false;
  if (!Array.isArray(policy.allowedRoles) || !policy.allowedRoles.every((role) => ROLES.has(role))) return false;
  if (!Array.isArray(policy.allowedModes) || !policy.allowedModes.every((mode) => MODES.has(mode))) return false;
  return isValidBudget(policy.budgets);
}

function isValidUsage(usage: ExecutionUsage): boolean {
  if (typeof usage !== "object" || usage === null) return false;
  const { activeExecutions, executedStatements, totalElapsedMs } = usage;
  if (!Number.isInteger(activeExecutions) || activeExecutions < 0) return false;
  if (!Number.isInteger(executedStatements) || executedStatements < 0) return false;
  return typeof totalElapsedMs === "number" && Number.isFinite(totalElapsedMs) && totalElapsedMs >= 0;
}

function isValidScope(scope: TargetScope): boolean {
  if (typeof scope !== "object" || scope === null) return false;
  return (
    isNonBlankString(scope.connectionId) &&
    isValidAllowlist(scope.catalogAllowlist) &&
    isValidAllowlist(scope.schemaAllowlist)
  );
}

/**
 * Exported for the audit glue (`execution.ts`), which may only put an actor's
 * `mode`/`role` into a log field once this has accepted them: before that they
 * are unvalidated caller text. Keeping the check here keeps the role/mode
 * vocabulary in one module.
 */
export function isValidActor(actor: ExecutionActor): boolean {
  if (typeof actor !== "object" || actor === null) return false;
  return isNonBlankString(actor.sessionId) && ROLES.has(actor.role) && MODES.has(actor.mode);
}

/** An absent allowlist leaves the dimension unconstrained beyond the connection boundary. */
function withinAllowlist(allowlist: readonly string[] | undefined, requested: string | undefined): boolean {
  if (allowlist === undefined) return true;
  return requested !== undefined && allowlist.includes(requested);
}

/** Explicit-field frozen copy: unmodeled fields on a caller's budget object never propagate. */
function freezeBudget(budgets: ExecutionBudget): ExecutionBudget {
  return Object.freeze({
    maxConcurrentExecutions: budgets.maxConcurrentExecutions,
    maxStatementsPerRun: budgets.maxStatementsPerRun,
    maxTotalRunMs: budgets.maxTotalRunMs,
    statementTimeoutMs: budgets.statementTimeoutMs,
    maxResultRows: budgets.maxResultRows,
    maxResultBytes: budgets.maxResultBytes,
  });
}

export function evaluateOperation(params: PolicyEvaluationParams): PolicyDecision {
  const { registry, policy, actor, scope, request, capabilities, usage } = params;

  // Precondition — server-side context integrity. A NaN budget limit or junk
  // usage would compare permissively below, so a malformed context can only deny.
  if (!isValidPolicy(policy) || !isValidUsage(usage) || !isValidScope(scope)) {
    return {
      kind: "deny",
      reasonCode: "MALFORMED_POLICY_CONTEXT",
      policyVersion: isNonBlankString(policy?.version) ? policy.version : "invalid",
      effectiveBudget: ZERO_BUDGET,
    };
  }

  const policyVersion = policy.version;
  const effectiveBudget = freezeBudget(policy.budgets);
  const deny = (reasonCode: PolicyDenyCode): PolicyDenyDecision => ({
    kind: "deny",
    reasonCode,
    policyVersion,
    effectiveBudget,
  });

  // Stage 1 — actor/session (spec-pinned first stage).
  if (!isValidActor(actor)) return deny("INVALID_ACTOR");

  // Classification. Unknown and alias-shaped ids are typed denials; every
  // descriptor-dependent stage below needs the resolved descriptor.
  const resolution = registry.resolve(request?.operationId as string);
  if (resolution.kind === "denied") return deny(resolution.reasonCode);
  const { descriptor } = resolution;

  // Stage 2 — immutable target scope. The scope's connection id is server-
  // injected; a caller-named connection may only restate it, never change it.
  const target = request.target ?? {};
  if (target.connectionId !== undefined && target.connectionId !== scope.connectionId) {
    return deny("TARGET_OUT_OF_SCOPE");
  }
  if (!withinAllowlist(scope.catalogAllowlist, target.catalog)) return deny("TARGET_OUT_OF_SCOPE");
  if (!withinAllowlist(scope.schemaAllowlist, target.schema)) return deny("TARGET_OUT_OF_SCOPE");

  // Stage 3 — schema-validated input.
  const parsed = descriptor.inputSchema.safeParse(request.input);
  if (!parsed.success) return deny("INPUT_VALIDATION_FAILED");

  // Stage 4 — provider capability (fast deny; never the security boundary).
  const capabilityView: Partial<ProviderCapabilities> = capabilities ?? {};
  if (!descriptor.requiredCapabilities.every((key) => capabilityView[key] === true)) {
    return deny("CAPABILITY_UNSUPPORTED");
  }

  // Stage 5 — risk/mode/role policy.
  if (!policy.allowedRoles.includes(actor.role)) return deny("ROLE_FORBIDDEN");
  if (!policy.allowedModes.includes(actor.mode)) return deny("MODE_FORBIDDEN");
  if (descriptor.riskClass > policy.maxRiskClass) return deny("RISK_EXCEEDS_POLICY");

  // Stage 6 — budgets. This request counts as one statement: the input model
  // admits exactly one statement string, and the execution profiles enforce
  // single-statement database-natively.
  if (usage.activeExecutions >= effectiveBudget.maxConcurrentExecutions) return deny("CONCURRENCY_BUDGET_EXCEEDED");
  if (usage.executedStatements + 1 > effectiveBudget.maxStatementsPerRun) return deny("STATEMENT_BUDGET_EXCEEDED");
  if (usage.totalElapsedMs >= effectiveBudget.maxTotalRunMs) return deny("TOTAL_RUN_BUDGET_EXCEEDED");

  if (descriptor.requiresApproval) {
    return {
      kind: "require-approval",
      reasonCode: "APPROVAL_REQUIRED",
      operationId: descriptor.id,
      policyVersion,
      effectiveBudget,
    };
  }
  return {
    kind: "allow",
    reasonCode: "ALLOWED",
    operationId: descriptor.id,
    validatedInput: parsed.data,
    policyVersion,
    effectiveBudget,
  };
}

/**
 * Evaluates the request and invokes the provider callback ONLY on a plain
 * allow — the spy-provider invariant: on any deny or require-approval the
 * callback is never reached. Provider failures propagate untouched.
 */
export async function executeWithPolicy<T>(
  params: PolicyEvaluationParams,
  invoke: (execution: { readonly validatedInput: unknown; readonly budget: ExecutionBudget }) => Promise<T>,
): Promise<
  | { readonly decision: PolicyApprovalDecision | PolicyDenyDecision }
  | { readonly decision: PolicyAllowDecision; readonly result: T }
> {
  const decision = evaluateOperation(params);
  if (decision.kind !== "allow") return { decision };
  const result = await invoke({ validatedInput: decision.validatedInput, budget: decision.effectiveBudget });
  return { decision, result };
}
