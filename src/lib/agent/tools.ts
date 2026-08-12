/**
 * The agent's tool layer over the M1 operation pipeline (#329, epic #325).
 *
 * This is the only place in the agent runtime that reaches a database, and it does
 * so through exactly one path: `executeAuditedOperation` (`src/lib/db/operations/`)
 * against a provider acquired under the agent read-only execution profile. There is
 * no second path, no direct `provider.query()`, and no provider method reached
 * outside a registered operation — a reach that skipped this module would be a
 * defect by the milestone's own constraint, not a shortcut.
 *
 * Four properties are load-bearing, and each is asserted rather than asserted-in-prose:
 *
 * 1. **Tool selection is a server-side function of the run's persisted mode and
 *    workflow type.** `selectAgentTools` reads nothing else. Planning yields an EMPTY set whatever
 *    the run is for, and
 *    a client-supplied tool list has no way in — not because it is filtered, but
 *    because there is no parameter for it. The same rule is enforced a second time
 *    at the execution seam (`executeAgentOperation` refuses any mode but `agent`
 *    before the ledger, the deadline or an acquisition), so a caller holding a
 *    context cannot execute a tool the selector would never have offered.
 * 2. **A policy denial is a different KIND of outcome than a database error.** The
 *    two travel as distinct variants of `AgentToolRefusal` (T2 pinned that union so
 *    a denial has no readable `message` field at all), and the text handed to the
 *    model says a boundary decided this, never that the statement was ill-formed.
 *    Feeding a denial back as if it were bad SQL is what turns a refusal into a
 *    repair loop against the security layer.
 * 3. **The repair loop is bounded and never repeats a failed statement.** Every
 *    call passes the run's `AgentRepairLedger` first, keyed on a canonical
 *    fingerprint. A denial records the statement as unrepeatable but does NOT
 *    consume a repair attempt: nothing ran, and there is nothing to repair.
 * 4. **Database content is untrusted input.** Every result and every engine message
 *    that crosses into a prompt goes through `fenceUntrustedContent` first. Nothing
 *    in this module hands a model text that a row could have written.
 *
 * The run's wall-clock deadline (`deadline.ts`) is consulted here too, because this
 * is the layer that knows a call is about to be made: `admit` refuses a call that
 * no longer fits and clamps the statement timeout down to what is left of the run.
 * The clamp is applied by handing the pipeline a policy whose `statementTimeoutMs`
 * is the granted value, so the timeout the execution profile receives is the
 * pipeline's own `effectiveBudget` — there is no second budget to keep in step.
 *
 * The provider acquirer is INJECTED rather than imported. Two reasons, both real:
 * the spy-provider invariant above needs a seam, and a static import of
 * `@/lib/db/factory` would make this module's behaviour depend on whether some
 * other test file has replaced that module process-wide (`mock.module` is global —
 * five suites already stub the factory). Only the `ExecutionProfile` TYPE is
 * imported, so the profile literal still cannot drift from the factory's vocabulary.
 */

import { z } from "zod";
import { type AuditReason, emitAuditEvent } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { ConnectionError, DatabaseConfigError, DatabaseError, PoolExhaustedError } from "@/lib/db/errors";
import type { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import type { ExecutionBudget, ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { actorLabel, executeAuditedOperation } from "@/lib/db/operations/execution";
import type { ExecutionActor, ExecutionPolicy, PolicyDenyCode, TargetScope } from "@/lib/db/operations/policy";
import type { OperationRegistry } from "@/lib/db/operations/registry";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import {
  type AgentCatalogKind,
  AgentComposedSqlError,
  composeCatalogRead,
  composeEstimatingExplain,
} from "./composed-sql";
import type { AgentDeadlineDenyCode, AgentRunDeadline } from "./deadline";
import { AGENT_EXECUTION_POLICY, AGENT_EXECUTION_PROFILE, AGENT_MINIMUM_CALL_MS } from "./execution-policy";
import type { AgentRepairDenyCode, AgentRepairLedger } from "./repair-ledger";
import { fingerprintStatement } from "./repair-ledger";
import type {
  AgentArtifactReference,
  AgentEvidenceReference,
  AgentReportClaim,
  AgentRunActor,
  AgentRunMode,
  AgentRunRecord,
  AgentRunWorkflowType,
  AgentToolRefusal,
} from "./types";
import { fenceUntrustedContent } from "./untrusted-content";

/** The tools an agent-mode run may be offered. Nothing else is a tool. */
export type AgentToolName = "inspect_schema" | "run_read_query" | "inspect_plan" | "compose_report";

/**
 * The canonical operations a tool may drive. `sql.explain.analyze` is a member so
 * the approval gate is reachable — and therefore testable — from this layer, NOT
 * because a tool maps onto it: no entry in `AGENT_TOOL_DEFINITIONS` names it, and
 * its descriptor is default-denied, so the pipeline can only ever answer
 * require-approval for it.
 */
export type AgentOperationId = "sql.query.read" | "sql.explain.estimate" | "sql.explain.analyze";

export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  /** The contract a caller enforces on the model's arguments before invoking the tool. */
  readonly inputSchema: z.ZodType<unknown>;
  /** The canonical operation this tool drives; absent for the tool that reaches no database. */
  readonly operationId?: AgentOperationId;
}

export type AgentProviderAcquirer = (
  connection: DatabaseConnection,
  profile: ExecutionProfile,
) => Promise<DatabaseProvider>;

/**
 * Everything one run's tool call needs. Note what is NOT here: no execution
 * policy (this layer reads the frozen constant, so no caller can widen it) and no
 * tool list (the mode decides).
 */
export interface AgentToolContext {
  readonly runId: string;
  /** The run's PERSISTED mode. The only thing that decides which tools exist. */
  readonly mode: AgentRunMode;
  /** The persisted actor — the sole authority for authorizing this call. */
  readonly actor: AgentRunActor;
  readonly connection: DatabaseConnection;
  readonly capabilities: ProviderCapabilities;
  readonly registry: OperationRegistry;
  readonly scope: TargetScope;
  readonly tracker: ExecutionBudgetTracker;
  readonly artifacts: ExecutionArtifactStore<QueryResult>;
  readonly deadline: AgentRunDeadline;
  readonly repairs: AgentRepairLedger;
  readonly acquireProvider: AgentProviderAcquirer;
  /** Injected for the audited-execution elapsed measurement, as in `execution.ts`. */
  readonly clock?: () => number;
}

/**
 * Why a tool produced no result and no refusal. These are the run loop's own
 * outcomes — nothing was attempted at the database and no policy was consulted — so
 * they are deliberately not `AgentToolRefusal` variants (T2 pinned that union
 * closed, and widening it from here would blur "the boundary said no" with "the run
 * decided not to ask").
 */
export type AgentToolUnavailableCode =
  | "MODE_HAS_NO_TOOLS"
  | "INVALID_TOOL_INPUT"
  | "UNVERIFIABLE_EVIDENCE"
  | AgentDeadlineDenyCode
  | AgentRepairDenyCode;

export type AgentToolOutcome =
  | { readonly kind: "completed"; readonly artifact: AgentArtifactReference; readonly modelText: string }
  | { readonly kind: "refused"; readonly refusal: AgentToolRefusal; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

export type AgentReportOutcome =
  | { readonly kind: "composed"; readonly claims: readonly AgentReportClaim[]; readonly modelText: string }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentToolUnavailableCode; readonly modelText: string };

export interface AgentOperationRequest {
  readonly operationId: AgentOperationId;
  /** The statement as it will be evaluated — composed by the server for two of the tools. */
  readonly sql: string;
  /** Prose naming what the result is, for the untrusted-content header. */
  readonly label?: string;
  /** Declared target dimensions, so a scope allowlist can bound them. */
  readonly target?: { readonly catalog?: string; readonly schema?: string };
}

// ============================================================================
// Tool definitions and server-side selection
// ============================================================================

const catalogSelectorSchema = z.strictObject({
  /**
   * Which inventory to read. Absent means the column inventory, which is what a
   * bare catalog inspection has always meant — so a model that never sends this
   * field gets exactly the behaviour it got before the field existed.
   */
  kind: z.enum(["columns", "relations", "indexes"]).optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
});

const readStatementSchema = z.strictObject({
  sql: z.string().min(1),
  /**
   * Why the model wrote this statement. Accepted here and NOT recorded at this
   * commit: the `statement-drafted` event that carries it (`types.ts`) is emitted by
   * the run service, which does not exist yet. It is in the declared contract so the
   * model is asked for it from the first run rather than having the tool's shape
   * change under it later. Deliberately no `min(1)`: refusing an otherwise valid read
   * because its rationale came back blank would be a disproportionate refusal.
   */
  rationale: z.string().optional(),
});

const planStatementSchema = z.strictObject({ sql: z.string().min(1) });

const evidenceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("artifact"),
    correlationId: z.string().min(1),
    locator: z.string().min(1).optional(),
  }),
  z.strictObject({
    source: z.literal("context-snapshot"),
    fingerprint: z.string().min(1),
    locator: z.string().min(1).optional(),
  }),
]);

const reportSchema = z.strictObject({
  claims: z.array(z.strictObject({ claim: z.string().min(1), evidence: z.array(evidenceSchema).min(1) })).min(1),
});

export const AGENT_TOOL_DEFINITIONS: Readonly<Record<AgentToolName, AgentToolDefinition>> = Object.freeze({
  inspect_schema: {
    name: "inspect_schema",
    description:
      "Read the database's own catalog, optionally narrowed to one schema or table. Pass kind to choose the inventory: columns (the default: tables and their columns), relations (foreign keys) or indexes. The statement is composed by the server; you supply only the selector. On a large database pass a schema or table selector: the result is subject to the same row budget as any read and is refused, not truncated, if it overflows.",
    inputSchema: catalogSelectorSchema,
    operationId: "sql.query.read",
  },
  run_read_query: {
    name: "run_read_query",
    description:
      "Run one bounded read-only SQL statement. Writes, DDL and multi-statement text are refused before the database is reached.",
    inputSchema: readStatementSchema,
    operationId: "sql.query.read",
  },
  inspect_plan: {
    name: "inspect_plan",
    description:
      "Ask the engine for the ESTIMATED plan of one read-only statement. The plan is described, never executed, so no timings are produced.",
    inputSchema: planStatementSchema,
    operationId: "sql.explain.estimate",
  },
  compose_report: {
    name: "compose_report",
    description:
      "Compose the run's findings. Every claim must cite at least one artifact this run read or the schema snapshot it captured; an uncited claim is refused.",
    inputSchema: reportSchema,
  },
} satisfies Record<AgentToolName, AgentToolDefinition>);

const AGENT_MODE_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  AGENT_TOOL_DEFINITIONS.inspect_schema,
  AGENT_TOOL_DEFINITIONS.run_read_query,
  AGENT_TOOL_DEFINITIONS.inspect_plan,
  AGENT_TOOL_DEFINITIONS.compose_report,
]);

/** Planning is toolless. Not "filtered to nothing" — there is nothing to filter. */
const NO_TOOLS: readonly AgentToolDefinition[] = Object.freeze([]);

/**
 * Workflow type → the tools that workflow may use (#330 T2).
 *
 * A total record, so a workflow type added to the contract stops this file compiling
 * until somebody decides what it may do. All three name the same set today, and that
 * is the honest state rather than a placeholder: M3's two templates are about what
 * the model is ASKED to produce and how the run is JUDGED, and the tools that would
 * distinguish them — bounded per-table profiling, a monitor snapshot — arrive with
 * the templates themselves (#330 T3). What exists now is the seam, in the one place
 * a tool set may be decided, so widening one workflow later cannot become a second
 * decision about where that decision lives.
 */
const WORKFLOW_TOOLS: Readonly<Record<AgentRunWorkflowType, readonly AgentToolDefinition[]>> = Object.freeze({
  investigation: AGENT_MODE_TOOLS,
  "query-optimization": AGENT_MODE_TOOLS,
  "database-assessment": AGENT_MODE_TOOLS,
} satisfies Record<AgentRunWorkflowType, readonly AgentToolDefinition[]>);

/**
 * The tools this run may use, decided from its persisted mode and workflow type and
 * nothing else.
 *
 * The parameter is the run record (narrowed to the two fields that matter) rather
 * than bare strings, so the values can only have come from persisted state. There is
 * no parameter through which a request body could contribute a tool, which is what
 * "a client-supplied tool list is ignored, not merged" means here.
 *
 * Mode is checked FIRST and the workflow cannot override it: planning is toolless by
 * contract whatever it is for, so a workflow type is never a way to give a planning
 * run a tool.
 */
export function selectAgentTools(run: Pick<AgentRunRecord, "mode" | "workflowType">): readonly AgentToolDefinition[] {
  return run.mode === "agent" ? WORKFLOW_TOOLS[run.workflowType] : NO_TOOLS;
}

// ============================================================================
// Model-facing text
// ============================================================================

const UNAVAILABLE_TEXT: Readonly<Record<AgentToolUnavailableCode, string>> = Object.freeze({
  MODE_HAS_NO_TOOLS:
    "This run is in planning mode, which has no tools at all. Produce a plan in prose; no database call is possible from here.",
  INVALID_TOOL_INPUT:
    "The arguments could not be turned into a statement this layer will run. Correct them and call the tool again.",
  UNVERIFIABLE_EVIDENCE:
    "At least one evidence reference does not match anything this run produced. Cite an artifact this run actually read, or the schema snapshot it captured.",
  RUN_DEADLINE_EXCEEDED:
    "The run has spent its whole time budget. Stop calling tools and finish with what has already been established.",
  INSUFFICIENT_TIME_REMAINING:
    "Too little time is left in the run for a call of this size. Ask for something cheaper, or finish now.",
  STATEMENT_ALREADY_FAILED:
    "This exact statement has already failed in this run. Draft a different statement rather than sending the same one again.",
  REPAIR_BUDGET_EXHAUSTED:
    "This run has used all of its repair attempts. Stop drafting statements and report what has been established.",
});

/**
 * What a denial tells the model it may try next. Three answers, because the codes
 * genuinely differ in whether ANYTHING the model can change would help:
 *
 * - `absolute` — the run is not permitted to do this at all (privilege, risk class,
 *   budget, a malformed server context). No statement the model writes changes it,
 *   and saying otherwise invites a repair loop against the security layer.
 * - `shape` — the statement fell outside the bounded-read CONTRACT. Not a syntax
 *   error (the SQL may be perfectly valid), and a differently shaped read genuinely
 *   can be admitted: the guard refuses `SELECT copy FROM ads` because `copy` reads
 *   as a side-effect word and admits `SELECT "copy" FROM ads`, which
 *   `statement-guard.ts` records as the escape hatch. Telling the model not to
 *   bother is how a legitimate column becomes unreachable for the whole run.
 * - `target` — the DECLARED target is outside the run's scope. The statement's
 *   wording is irrelevant, but a tool that takes a target selector (today
 *   `inspect_schema`) can be asked for an in-scope one instead.
 *
 * A total `Record` rather than a comparison against a string: a new
 * `PolicyDenyCode` must not silently inherit whichever branch happened to be the
 * default. This is the same compiler-mirror pattern `DENY_REASONS` uses in
 * `execution.ts` and `DEADLINE_REASONS` uses below.
 *
 * The advice is keyed on the DENY CODE and not on the tool, which is a real
 * imprecision worth naming: for `inspect_schema` and `inspect_plan` the statement is
 * server-composed, so an `INPUT_VALIDATION_FAILED` there would be a server defect
 * rather than something the model shaped, and `shape`'s "a differently shaped read
 * may still be admitted" is advice it cannot act on. Left as-is on purpose. No
 * reachable case exists — every composed statement in `composed-sql.ts` is guard-clean
 * for both dialects and pinned by a test, and `inspect_plan`'s only model-supplied
 * part is the inner statement, which genuinely IS a shape the model chose. A per-tool
 * override would therefore be an uncoverable branch under the 100% line gate, which is
 * a worse trade than a sentence that is imprecise only in a state that cannot occur.
 */
type DenialAdvice = "absolute" | "shape" | "target";

const DENIAL_ADVICE: Record<PolicyDenyCode, DenialAdvice> = {
  UNKNOWN_OPERATION: "absolute",
  AMBIGUOUS_OPERATION: "absolute",
  MALFORMED_POLICY_CONTEXT: "absolute",
  INVALID_ACTOR: "absolute",
  TARGET_OUT_OF_SCOPE: "target",
  INPUT_VALIDATION_FAILED: "shape",
  CAPABILITY_UNSUPPORTED: "absolute",
  ROLE_FORBIDDEN: "absolute",
  MODE_FORBIDDEN: "absolute",
  RISK_EXCEEDS_POLICY: "absolute",
  CONCURRENCY_BUDGET_EXCEEDED: "absolute",
  STATEMENT_BUDGET_EXCEEDED: "absolute",
  TOTAL_RUN_BUDGET_EXCEEDED: "absolute",
};

const DENIAL_ADVICE_TEXT: Record<DenialAdvice, string> = {
  absolute:
    "This is a decision about what this run is permitted to do at all, not a remark about how the statement is written, so rewording it will not change the answer.",
  shape:
    "The statement's shape falls outside what a bounded read-only inspection may be, which is a decision about the contract rather than about valid SQL; a differently shaped read may still be admitted.",
  target:
    "The target this call declared falls outside the scope this run may reach, which is not about how the statement is written; where a tool takes a target selector, an in-scope one may still be admitted.",
};

/**
 * The text a policy denial produces. It names the reason code, says a boundary
 * decided this, and never describes the statement as ill-formed.
 */
function denialText(reasonCode: PolicyDenyCode): string {
  return [
    `The database operation layer refused this call: ${reasonCode} (policy ${AGENT_EXECUTION_POLICY.version}).`,
    DENIAL_ADVICE_TEXT[DENIAL_ADVICE[reasonCode]],
    "Choose a different approach that stays inside a bounded read-only inspection.",
  ].join(" ");
}

function approvalText(operationId: string): string {
  return [
    `The operation ${operationId} is default-denied and needs a human approval this run does not carry, so nothing was executed.`,
    "Use the estimating plan inspection instead; it describes a plan without running the statement.",
  ].join(" ");
}

function unavailable(
  reasonCode: AgentToolUnavailableCode,
  detail?: string,
): AgentToolOutcome & { kind: "unavailable" } {
  const base = UNAVAILABLE_TEXT[reasonCode];
  return { kind: "unavailable", reasonCode, modelText: detail === undefined ? base : `${base} (${detail})` };
}

/**
 * Renders result rows for a prompt.
 *
 * `bigint` is replaced rather than left to `JSON.stringify`, which throws on one:
 * `node:sqlite` returns a BigInt for an INTEGER outside the safe range, and mysql2
 * can too, so this is a live shape rather than a defensive guess.
 */
function renderRows(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((row) => JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)))
    .join("\n");
}

// ============================================================================
// The audited execution seam
// ============================================================================

/**
 * Deadline refusals mapped to their audit reasons, typed as a total record so a new
 * deny code cannot reach production without a reason an operator can filter on —
 * the same mirror `DENY_REASONS` builds for policy denials. A run that stops on its
 * own deadline would otherwise leave nothing in the trail at all, because the
 * refusal happens before `executeAuditedOperation` is reached.
 *
 * DELIBERATE ASYMMETRY: the ledger refusals (`STATEMENT_ALREADY_FAILED`,
 * `REPAIR_BUDGET_EXHAUSTED`) and the two input refusals are NOT audited, and the
 * deadline ones are. The line is whether the reason is visible anywhere else. A
 * deadline refusal can end a run with no other trace, because the preceding calls
 * may all have succeeded. Every ledger refusal is preceded by the audited failure
 * that put the fingerprint in the ledger or spent the budget, so the trail already
 * records the cause and an extra line would only restate it. `MODE_HAS_NO_TOOLS`
 * and `INVALID_TOOL_INPUT` never reached a database or a policy at all. Revisit
 * this if the run service turns out to need the run's whole refusal history from
 * the audit stream rather than from the run record, which holds it either way.
 */
const DEADLINE_REASONS: Record<AgentDeadlineDenyCode, AuditReason> = {
  RUN_DEADLINE_EXCEEDED: "agent_run_deadline_exceeded",
  INSUFFICIENT_TIME_REMAINING: "agent_insufficient_time_remaining",
};

const DEADLINE_TARGET = "agent/operations/deadline";
const UNRESOLVED_OPERATION = "unresolved";

function auditDeadlineRefusal(
  context: AgentToolContext,
  actor: ExecutionActor,
  operationId: AgentOperationId,
  reasonCode: AgentDeadlineDenyCode,
): void {
  // The registry-resolved id, never the caller's string: the audited action stays a
  // closed vocabulary even though this entry point is typed.
  const resolution = context.registry.resolve(operationId);
  emitAuditEvent({
    type: "agent_operation",
    action: resolution.kind === "resolved" ? resolution.descriptor.id : UNRESOLVED_OPERATION,
    target: DEADLINE_TARGET,
    user: actorLabel(actor),
    result: "failure",
    reason: DEADLINE_REASONS[reasonCode],
  });
}

/**
 * Failures of the environment the statement RAN IN. No statement the model writes
 * fixes one, so each propagates instead of being spent as a repair attempt and
 * hidden from the caller.
 *
 * Note which classes are deliberately NOT here, because both look like they belong
 * and both would re-break the repair loop:
 *
 * - **`AuthenticationError`** covers two unrelated events. `mapDatabaseError` answers
 *   it for anything matching `password`/`authentication`/`access denied`/
 *   `permission denied` (`errors.ts:270-277`), which folds a wrong agent credential
 *   together with `permission denied for table secrets`. The second is routine on the
 *   least-privilege `agentUser` this programme recommends — per-table `SELECT` grants
 *   are what bound an agent's reads — so it is the model's first probe of an ungranted
 *   object, and reading a different table is exactly the repair that helps. They are
 *   indistinguishable by class but not by PHASE, which is what `runStatement` splits
 *   on: a credential failure happens while connecting, a grant failure while running.
 * - **`QueryCancelledError`** is what a PostgreSQL statement timeout arrives as, and
 *   this layer is what CAUSES it: the clamped budget becomes `SET LOCAL
 *   statement_timeout` (`postgres.ts:892`), the engine says `canceling statement due
 *   to statement timeout`, and `mapDatabaseError` matches `canceling statement`
 *   BEFORE its timeout branch (`errors.ts:280-293`) — so the timeout never arrives as
 *   `TimeoutError` on this engine at all. Narrowing the read is the repair that helps.
 *   The message that would distinguish an operator cancel is discarded by the mapper
 *   (`docs/BACKLOG.md` B4), so this cannot be split on text.
 *   FOR T7: a run cancellation must therefore be enforced by the run loop's own
 *   persisted state between tool calls, NOT by expecting a driver cancel to propagate
 *   out of this layer — after this commit it does not.
 *
 * HONEST LIMIT: this split is only as sharp as `mapDatabaseError`'s classification,
 * which is SUBSTRING matching on the engine's message, and it is imprecise in BOTH
 * directions. Verified: `no such table: pooled_items` matches `pool` and arrives as
 * `PoolExhaustedError`, so a plainly repairable missing relation propagates and ends
 * the run; `Connection terminated unexpectedly` matches nothing, falls through to the
 * base class, and is offered to the model as a statement it could rewrite (bounded at
 * three attempts). Neither is a boundary failure — nothing runs that should not — and
 * neither is fixable here: the misreading happens before this layer sees the error.
 * Same root cause as `docs/BACKLOG.md` B4, which is where a real fix belongs.
 *
 * FOR T7, second: an error that PROPAGATES from this layer carries the driver's own
 * text unfenced, because it is an exception handed to server code rather than prompt
 * text. Anything that later renders one toward a model owes it `fenceUntrustedContent`,
 * which is otherwise applied to every engine message this module emits.
 */
const ENVIRONMENT_FAILURES = [ConnectionError, PoolExhaustedError, DatabaseConfigError] as const;

/**
 * A failure the STATEMENT caused, which a rewrite may fix.
 *
 * Only ever consulted for a QUERY-phase failure; see `runStatement` for why the
 * acquisition phase needs no predicate at all.
 *
 * Classified BY EXCLUSION rather than by naming the repairable classes, and that is
 * the load-bearing part. `mapDatabaseError` is what every profiled provider routes a
 * driver error through, and its fall-through is the BASE `DatabaseError`
 * (`errors.ts:332`) — so an enumeration of `QueryError | TimeoutError` missed the most
 * canonical repairable failure of all: `no such table: ordrs` on SQLite, and
 * PostgreSQL's `operator does not exist`, `invalid input syntax for type …`,
 * `function … does not exist` and `division by zero`. Each of those escaped this
 * layer as a raw throw instead of becoming a repairable refusal, which killed the
 * repair loop for exactly the errors it exists to serve.
 *
 * Exclusion also fails in the right direction as `mapDatabaseError` grows: a new
 * message pattern that lands on the base class is treated as the model's problem and
 * offered a repair, rather than crashing the run. A new ENVIRONMENT class has to be
 * added to the list above; the reflective test that walks the error module's exports
 * forces that decision to be recorded, though it cannot judge whether the recorded
 * answer is right — it says so itself.
 *
 * `ExecutionProfileError` needs no entry: it does not extend `DatabaseError` at all
 * (`errors.ts:177`), so it is outside this predicate by construction — and it is
 * raised during acquisition, which propagates everything anyway.
 */
function isStatementFailure(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError && !ENVIRONMENT_FAILURES.some((kind) => error instanceof kind);
}

/**
 * Acquires the provider and runs the one statement the pipeline allowed.
 *
 * The acquisition sits INSIDE this callback deliberately: `executeAuditedOperation`
 * only invokes it on a plain allow, so a denial, an approval requirement, a deadline
 * refusal and a ledger refusal all leave the connection pool untouched. The cost is
 * that an acquisition failure is accounted as one executed statement and audited as
 * `agent_execution_failed` even though nothing ran — a statement out of
 * `maxStatementsPerRun` spent on a misconfiguration. That is the right trade and
 * should not be "fixed" by acquiring earlier: acquiring before the decision would
 * open a pool for every denied call, which is exactly what the spy-provider
 * invariant exists to forbid.
 */
async function runStatement(
  context: AgentToolContext,
  validatedInput: unknown,
  budget: ExecutionBudget,
  phase: { statementSent: boolean },
): Promise<QueryResult> {
  const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
  if (typeof provider.queryReadOnly !== "function") {
    // Not a refusal: `acquireExecutionProfileProvider` already refuses such a
    // provider, so reaching here means the injected acquirer is not the profile
    // seam. That is a server fault and must be loud, never a model-visible outcome.
    //
    // Only the MISSING method is caught this loudly. The sibling fault — a provider
    // that has `queryReadOnly` but was not opened under the profile — is detected
    // inside the provider (`postgres.ts`, `sqlite.ts` both throw when the read-only
    // execution context is absent), which lands at the query phase and therefore
    // becomes a repairable database error that costs an attempt. Unreachable through
    // `acquireExecutionProfileProvider`, which sets that context for the profile it
    // was asked for, so it is a note rather than a second guard.
    throw new Error("agent tool layer: the acquired provider exposes no read-only execution path");
  }
  const { sql } = validatedInput as { readonly sql: string };
  // Set immediately before the statement leaves, and never reset. This flag is the
  // whole phase discriminator: anything that threw while we were still connecting
  // cannot be a statement the model could repair, whatever class it carries, so the
  // caller propagates it without consulting `isStatementFailure` at all. That is what
  // separates a wrong agent credential from `permission denied for table secrets`
  // without inspecting message text.
  phase.statementSent = true;
  return provider.queryReadOnly(sql, {
    statementTimeoutMs: budget.statementTimeoutMs,
    maxResultRows: budget.maxResultRows,
    maxResultBytes: budget.maxResultBytes,
  });
}

/**
 * Runs one canonical operation for this run, with every gate in front of it.
 *
 * Order matters and is the cheapest-and-most-certain first: the mode (no state to
 * read), the repair ledger (in-memory), the run deadline (a clock reading), then the
 * policy pipeline. Nothing acquires a provider until the pipeline has allowed the
 * call, so a refusal at any of these stages leaves the database untouched.
 */
export async function executeAgentOperation(
  context: AgentToolContext,
  request: AgentOperationRequest,
): Promise<AgentToolOutcome> {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");

  const fingerprint = fingerprintStatement(request.sql);
  const repairAdmission = context.repairs.admit(fingerprint);
  if (!repairAdmission.admitted) return unavailable(repairAdmission.reasonCode);

  const actor: ExecutionActor = { sessionId: context.actor.sessionId, role: context.actor.role, mode: "agent" };

  const admission = context.deadline.admit({
    statementTimeoutMs: AGENT_EXECUTION_POLICY.budgets.statementTimeoutMs,
    minimumMs: AGENT_MINIMUM_CALL_MS,
  });
  if (!admission.admitted) {
    auditDeadlineRefusal(context, actor, request.operationId, admission.reasonCode);
    return unavailable(admission.reasonCode);
  }

  // The clamp: the pipeline's own `effectiveBudget` becomes the clamped one, so the
  // execution profile cannot be handed a timeout larger than the run has left.
  const policy: ExecutionPolicy = {
    ...AGENT_EXECUTION_POLICY,
    budgets: { ...AGENT_EXECUTION_POLICY.budgets, statementTimeoutMs: admission.statementTimeoutMs },
  };

  // Which phase the invoke callback reached, read only on the failure path. A plain
  // mutable holder rather than a return value: the callback's result is the pipeline's
  // to shape, and on a throw there is no result to carry this in.
  const phase = { statementSent: false };

  let outcome: Awaited<ReturnType<typeof executeAuditedOperation<QueryResult>>>;
  try {
    outcome = await executeAuditedOperation<QueryResult>(
      {
        registry: context.registry,
        policy,
        actor,
        scope: context.scope,
        request: {
          operationId: request.operationId,
          target: { connectionId: context.scope.connectionId, ...request.target },
          input: { sql: request.sql },
        },
        capabilities: context.capabilities,
      },
      {
        runId: context.runId,
        tracker: context.tracker,
        artifacts: context.artifacts,
        clock: context.clock,
      },
      ({ validatedInput, budget }) => runStatement(context, validatedInput, budget, phase),
    );
  } catch (error) {
    // The phase gate comes FIRST and is unconditional. A failure raised before the
    // statement was sent — a wrong credential, an unreachable host, a refused
    // execution profile, or anything the pipeline itself threw — is the environment's,
    // so it propagates whatever class it carries and costs no repair attempt.
    if (!phase.statementSent || !isStatementFailure(error)) throw error;
    context.repairs.recordFailure(fingerprint, "database-error");
    return {
      kind: "refused",
      refusal: { class: "database-error", statementFingerprint: fingerprint, message: error.message },
      // The engine's own words: untrusted, so fenced. The fingerprint stands in for
      // a correlation id, which a failed execution never produced.
      modelText: fenceUntrustedContent(error.message, {
        label: "database error",
        operationId: request.operationId,
        reference: fingerprint,
      }),
    };
  }

  if (outcome.kind === "denied") {
    const { decision } = outcome;
    if (decision.kind === "deny") {
      context.repairs.recordFailure(fingerprint, "policy-denied");
      return {
        kind: "refused",
        refusal: { class: "policy-denied", reasonCode: decision.reasonCode },
        modelText: denialText(decision.reasonCode),
      };
    }
    context.repairs.recordFailure(fingerprint, "approval-required");
    return {
      kind: "refused",
      refusal: { class: "approval-required", operationId: decision.operationId },
      modelText: approvalText(decision.operationId),
    };
  }

  const { result } = outcome;
  // NOTE for whatever renders a run: `summary.columnNames` is engine-supplied text
  // and is NOT fenced — it is a durable record field, not prompt text. Anything that
  // later puts an artifact summary INTO a prompt owes it the same fence the rows get.
  const artifact: AgentArtifactReference = {
    correlationId: outcome.correlationId,
    runId: context.runId,
    operationId: outcome.decision.operationId,
    summary: {
      rowCount: result.rowCount,
      // Copied: the durable reference must not alias a provider's own array.
      columnNames: [...result.fields],
      elapsedMs: result.executionTime,
    },
  };
  return {
    kind: "completed",
    artifact,
    modelText: fenceUntrustedContent(renderRows(result.rows), {
      label: `${request.label ?? "result"}, ${result.rowCount} row(s)`,
      operationId: artifact.operationId,
      reference: artifact.correlationId,
    }),
  };
}

// ============================================================================
// The four tools
// ============================================================================

/** Trimmed, but a blank stays blank so the composer refuses it rather than ignoring it. */
function normalizeSelector(input: {
  readonly kind?: AgentCatalogKind;
  readonly schema?: string;
  readonly table?: string;
}) {
  return {
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.schema === undefined ? {} : { schema: input.schema.trim() }),
    ...(input.table === undefined ? {} : { table: input.table.trim() }),
  };
}

/** What each inventory is called in the untrusted-content header the model reads. */
const CATALOG_LABELS: Readonly<Record<AgentCatalogKind, string>> = Object.freeze({
  columns: "schema inventory",
  relations: "foreign-key inventory",
  indexes: "index inventory",
});

/**
 * The schema name to DECLARE as the policy target, given what the composer accepted.
 *
 * Only SQLite needs the fold: `main` is its whole schema set and the composer matches
 * it case-insensitively, so the canonical spelling is the one a scope allowlist can be
 * written against. PostgreSQL is left exactly as supplied — `information_schema`
 * compares `table_schema` case-sensitively, so folding it would declare a target that
 * is not the one the composed statement reads.
 */
function normalizeDeclaredSchema(context: AgentToolContext, schema: string): string {
  return context.connection.type === "sqlite" ? schema.toLowerCase() : schema;
}

/**
 * Parses a tool's arguments against the schema the tool DECLARES, so the declaration
 * is load-bearing rather than advisory.
 *
 * A caller is expected to have validated already — an SDK enforces the declared
 * schema before invoking a tool — but "expected to" is not a guarantee, and these
 * arguments originate from a model. Without this, a non-string selector reached
 * `.trim()` and left the tool as a raw `TypeError` instead of a typed outcome. The
 * failure returns the same `INVALID_TOOL_INPUT` as a composition refusal: from the
 * model's side both mean "these arguments cannot become a statement".
 */
function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): { ok: true; value: T } | { ok: false } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * Turns a composition refusal into a tool outcome.
 *
 * Only the closed reason CODE reaches the model, never the composer's message: that
 * message interpolates the selector the model supplied, and echoing model text back
 * inside a server-authored sentence is the habit that makes provenance unreadable.
 */
function composedSqlOutcome(error: unknown): AgentToolOutcome {
  if (error instanceof AgentComposedSqlError) return unavailable("INVALID_TOOL_INPUT", error.reasonCode);
  throw error;
}

/**
 * The catalog inspection. Per planning decision P1 this IS the canonical bounded
 * read — the server composes the statement, so no fourth operation descriptor is
 * needed and the reach is audited exactly like every other one.
 *
 * The two engines answer differently, and the difference is real rather than
 * cosmetic: PostgreSQL returns a structured column inventory from
 * `information_schema`, while SQLite returns each object's own DDL text from
 * `sqlite_master`, because the guard refuses the `pragma_*` table-valued functions
 * that would give SQLite a structured column list (see `composed-sql.ts`).
 */
export async function inspectSchemaTool(
  context: AgentToolContext,
  input: { readonly kind?: AgentCatalogKind; readonly schema?: string; readonly table?: string },
): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(catalogSelectorSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  const selector = normalizeSelector(parsed.value);
  let sql: string;
  try {
    sql = composeCatalogRead(context.connection.type, selector);
  } catch (error) {
    return composedSqlOutcome(error);
  }
  return executeAgentOperation(context, {
    operationId: "sql.query.read",
    sql,
    label: CATALOG_LABELS[selector.kind ?? "columns"],
    // Declared, so a scope carrying a schema allowlist bounds which schema may be
    // inspected. A raw read cannot declare its schema, which is why an allowlist
    // denies one — `docs/BACKLOG.md` B3 records that consequence and the two ways to
    // resolve it; it is not worked around here.
    // The CATALOG dimension is never declared by any tool in this layer, so a scope
    // built with a catalog allowlist denies every call here: `withinAllowlist`
    // refuses an undeclared dimension. That fails closed, which is the right
    // direction, but a caller wanting catalog scoping needs this layer to grow a
    // selector for it rather than expecting these calls to pass.
    //
    // The NORMALIZED name is declared, not the model's spelling: the composer
    // accepts SQLite's `main` case-insensitively while `withinAllowlist` compares
    // case-sensitively, so declaring a raw `MAIN` would compose fine and then be
    // denied against a `["main"]` allowlist.
    ...(selector.schema === undefined ? {} : { target: { schema: normalizeDeclaredSchema(context, selector.schema) } }),
  });
}

/** One bounded read the model drafted. The statement guard is what bounds it. */
export async function runReadQueryTool(
  context: AgentToolContext,
  input: { readonly sql: string; readonly rationale?: string },
): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(readStatementSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  return executeAgentOperation(context, { operationId: "sql.query.read", sql: parsed.value.sql, label: "read result" });
}

/**
 * The ESTIMATING plan inspection, and only that one. The executing variant is a
 * separate, approval-gated descriptor and no tool reaches it.
 */
export async function inspectPlanTool(
  context: AgentToolContext,
  input: { readonly sql: string },
): Promise<AgentToolOutcome> {
  const parsed = parseToolInput(planStatementSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");
  let sql: string;
  try {
    sql = composeEstimatingExplain(context.connection.type, parsed.value.sql);
  } catch (error) {
    return composedSqlOutcome(error);
  }
  return executeAgentOperation(context, { operationId: "sql.explain.estimate", sql, label: "query plan" });
}

/**
 * Composes the run's report. Reaches no database at all.
 *
 * Its job is to REFUSE, not to format: every evidence reference is checked against
 * the run's own event log, so a claim citing an artifact the run never read — or a
 * schema snapshot it never captured — cannot be composed. A report is only worth
 * anything if its citations are the run's, and the model is the one thing here that
 * can invent a correlation id.
 */
export function composeReportTool(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events">,
  input: unknown,
): AgentReportOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");

  // The event log has to be THIS run's. Without this the type would promise a check
  // it does not perform: a caller handed another run's record would happily verify
  // that run's correlation ids and compose a report citing evidence this run never
  // produced.
  //
  // A THROW rather than a refusal, for the same reason the acquirer check in
  // `runStatement` throws: the model cannot cause this and cannot fix it, so the only
  // thing a model-visible `UNVERIFIABLE_EVIDENCE` would achieve is an endless loop of
  // correctly-cited reports being rejected while the wiring bug stays invisible.
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the report's run record does not belong to this run");
  }

  const parsed = parseToolInput(reportSchema, input);
  if (!parsed.ok) return unavailable("INVALID_TOOL_INPUT");

  const artifactIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const event of run.events) {
    if (event.kind === "tool-completed") artifactIds.add(event.artifact.correlationId);
    else if (event.kind === "context-captured") fingerprints.add(event.fingerprint);
  }

  const verified = (reference: AgentEvidenceReference): boolean =>
    reference.source === "artifact"
      ? artifactIds.has(reference.correlationId)
      : fingerprints.has(reference.fingerprint);

  const claims: AgentReportClaim[] = [];
  for (const claim of parsed.value.claims) {
    if (!claim.evidence.every(verified)) return unavailable("UNVERIFIABLE_EVIDENCE");
    claims.push({
      claim: claim.claim,
      // The tuple cast is carried by the schema's `.min(1)`, which the type system
      // cannot see. An unreachable emptiness guard here would be a line no test
      // could cover, so the guarantee stays where it is enforced.
      evidence: claim.evidence as [AgentEvidenceReference, ...AgentEvidenceReference[]],
    });
  }

  return {
    kind: "composed",
    claims,
    // The claims themselves are the model's own prose and are NOT echoed: they go
    // into the run record, where a reader sees them with their citations attached.
    modelText: `Report composed: ${claims.length} claim(s), each carrying at least one evidence reference this run produced.`,
  };
}
