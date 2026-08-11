/**
 * The agent programme's own execution policy and run-level bounds (#329, epic #325).
 *
 * The M1 enforcement layer takes an `ExecutionPolicy` as data and refuses a
 * malformed one (`policy.ts` denies with `MALFORMED_POLICY_CONTEXT` before any
 * stage runs), but M1 shipped no policy: nothing called the pipeline. This module
 * is that missing constant, and it is deliberately a first-class artifact rather
 * than an object literal at a call site — a policy inlined where it is used is a
 * policy nobody can review, diff, or test against the pipeline that enforces it.
 *
 * The constant is frozen all the way down and the tool layer reads it directly
 * rather than accepting one from its caller. That is the point: an injectable
 * policy is a seam through which a route, a workflow step or a resumed run could
 * widen the agent's privileges, and there is no legitimate reason for any of them
 * to hold a different one. A test that needs a different policy tests
 * `evaluateOperation`, which already takes one.
 *
 * Two of the numbers below are choices worth stating rather than reading off:
 *
 * - **`allowedRoles` admits both roles**, because that is this product's own
 *   authorization model: `src/proxy.ts` gates `/admin` on the admin role and
 *   leaves every database route open to any authenticated session, so an agent
 *   restricted to admins would be more restrictive than the editor it reads for.
 *   Least privilege for the agent path is enforced where it belongs — the
 *   database-native read-only profile, and optionally a dedicated `agentUser`.
 * - **`maxResultRows` / `maxResultBytes` are model-sized, not editor-sized.** A
 *   read on this path is going to be rendered into a prompt, so the cap that
 *   matters is the one that keeps a result affordable in tokens; the editor's
 *   own paging limits are irrelevant here. The caps refuse rather than truncate
 *   (the providers throw on an over-budget result), which is what lets a caller
 *   trust that a delivered result is complete.
 */

import type { ExecutionProfile } from "@/lib/db/factory";
import type { ExecutionBudget } from "@/lib/db/operations/budgets";
import type { ExecutionPolicy } from "@/lib/db/operations/policy";

/**
 * The only profile an agent execution may be served under. Named here so the
 * tool layer cannot be handed the shared writable path by a caller that supplies
 * its own profile string; `acquireExecutionProfileProvider` refuses anything else
 * anyway, and the type keeps the two in step at compile time.
 */
export const AGENT_EXECUTION_PROFILE: ExecutionProfile = "agent-read-only";

const BUDGETS: ExecutionBudget = Object.freeze({
  /** The run loop is sequential: one statement in flight, so a run cannot fan out. */
  maxConcurrentExecutions: 1,
  /** A whole investigation — catalog reads, drafts, repairs, plan inspections. */
  maxStatementsPerRun: 20,
  /** DATABASE time only. The wall clock is `AGENT_RUN_DEADLINE_MS` below. */
  maxTotalRunMs: 60_000,
  statementTimeoutMs: 10_000,
  maxResultRows: 200,
  maxResultBytes: 262_144,
});

/**
 * The policy every agent tool call is evaluated against.
 *
 * `version` is what reaches a policy decision and, through it, an operator's view
 * of a run. Bump the trailing number whenever any field here changes, so a
 * recorded decision can be traced back to the constant that produced it.
 */
export const AGENT_EXECUTION_POLICY: ExecutionPolicy = Object.freeze({
  version: "agent-read-only.1",
  /** A bounded data read is risk class 1; nothing above it is registrable at all. */
  maxRiskClass: 1,
  allowedRoles: Object.freeze(["admin", "user"] as const),
  allowedModes: Object.freeze(["agent"] as const),
  budgets: BUDGETS,
});

/**
 * The run's wall-clock budget, handed to `AgentRunDeadline` when a run starts.
 *
 * Larger than `maxTotalRunMs` on purpose: the two bound different things, and the
 * database-time budget is a subset of the run's life. Model latency, the repair
 * loop and time spent waiting on a caller are invisible to the database budget
 * and are exactly what this one counts.
 */
export const AGENT_RUN_DEADLINE_MS = 300_000;

/**
 * The least time a single call could plausibly need. Below this, the deadline
 * refuses to start the call rather than beginning one it cannot finish. Kept well
 * under `statementTimeoutMs`, which `AgentRunDeadline.admit` requires: a minimum
 * above the ceiling is a miswired call site and throws there.
 */
export const AGENT_MINIMUM_CALL_MS = 250;

/**
 * How many statements that FAILED AT THE DATABASE a run may try to repair.
 *
 * Policy denials and approval requirements deliberately do not consume one — they
 * are boundary decisions, not defects in a statement, and nothing ran. What bounds
 * a model that keeps producing distinct denied statements is the run deadline and
 * the statement budget, not this counter.
 */
export const AGENT_MAX_REPAIR_ATTEMPTS = 3;

/**
 * How many times ONE DRIVE of the run loop may ask the model for its next move.
 *
 * A backstop, not the primary bound: the statement budget above, the repair ledger
 * and `AGENT_RUN_DEADLINE_MS` are what govern the cost of a drive, and each of them
 * ends it for a reason a user can read. This one exists for the case none of them
 * catches — a model that keeps producing tool calls the loop refuses without ever
 * reaching the database, which spends no statements and no repair attempts. Set
 * well above the number of turns a real investigation takes, so hitting it is
 * evidence of a loop rather than of an ambitious question.
 *
 * **Every one of those ceilings is per-DRIVE, not per-run.** The budget tracker, the
 * repair ledger and the deadline all live in the process that drives a run, so a run
 * resumed after a process death starts each of them again: N resumes cost up to N
 * times a single drive's ceiling. Nothing here is a lie about a run's total cost
 * because nothing here claims to bound one — bounding a run ACROSS resumes needs a
 * ceiling folded from its own ledger (the record carries `createdAtMs`, so the data
 * exists), and that is recorded in `docs/BACKLOG.md` rather than implied here.
 */
export const AGENT_MAX_MODEL_TURNS = 16;
