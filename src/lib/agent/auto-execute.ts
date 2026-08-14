/**
 * The auto-execute gate: whether a run may hand its answer's statement to the
 * editor to be RUN there, rather than only to be placed there.
 *
 * The distinction is the whole feature. The run's own answer never comes from this
 * path — it comes from an artifact the run already read, under the read-only
 * profile, inside the statement ceiling, counted against its budget and written to
 * its ledger. What this gate decides is one extra thing: whether that same
 * statement is also sent to the user's editor to run on the user's own connection,
 * where NONE of those bounds apply. There is no statement timeout on that path, no
 * policy evaluation and no audit event, so the only protection a user has is that
 * this function refused.
 *
 * It is therefore fail-closed everywhere, and it is pure: everything it weighs is
 * passed in, so the decision can be enumerated over every combination of its three
 * conditions rather than reasoned about.
 *
 * THREE conditions, all of which must hold:
 *
 *  1. **The run executed this exact statement itself.** A model may compose a final
 *     statement wider than anything it ran; that one is never auto-executed. This is
 *     close to free and it removes most of the risk class on its own, because the
 *     agent path REFUSES rather than truncates: an artifact exists only for a
 *     statement that provably came back inside the row, byte and time ceilings.
 *  2. **The plan reads as safe**, per engine, with unknown resolving to risky — and
 *     so does a plan the server could only PARTLY read, which is the same rule applied
 *     one step down (`uninterpretedStep`, #373).
 *  3. **The run measured that execution as quick** — `artifact.summary.elapsedMs`,
 *     which is already on the ledger and costs nothing to read.
 *
 * Any one failing means the statement is applied to the editor unrun, with a warning
 * naming which condition failed. Never a silent skip: a user who ticked the box and
 * sees the statement sitting there has to be told that was the feature working.
 */

import type { ExplainFormat } from "@/lib/db/types";
import type { AgentPlanSummary } from "./plan-summary";

/**
 * The measured ceiling, in milliseconds.
 *
 * A CALIBRATION, not a measurement, and it should be measured against both
 * reference engines before it is trusted. The reasoning behind the number: the
 * agent's own statement ceiling is 10 s, and a statement that took 8 s at 200 rows
 * will take longer at the editor's 500, so a 2 s reading leaves roughly a 5x margin
 * inside a ceiling the editor does not have.
 *
 * Two honest caveats on the measurement it reads. The two executions are not
 * identical — the second has a different row limit, a warm plan cache and warm
 * buffers, and the database may have acquired load in between — and on SQLite the
 * first execution's elapsed time is a post-hoc reading rather than a bounded one.
 * A strong signal, not a guarantee.
 */
export const AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS = 2_000;

/**
 * The PostgreSQL planner-cost ceiling.
 *
 * Also a calibration. At the default `seq_page_cost = 1.0` it corresponds to
 * roughly 50 000 pages, about 400 MB of sequential reading — seconds, not minutes.
 * The number is in arbitrary planner units calibrated by `seq_page_cost` /
 * `random_page_cost` and by how recently `ANALYZE` ran; it is not a time and does
 * not convert to one, which is exactly why it is not the only condition.
 */
export const AGENT_AUTO_EXECUTE_MAX_PLAN_COST = 50_000;

/** An estimating plan for the answer's statement, as the server read it. */
export interface AgentAutoExecutePlan {
  /** Which engine's grammar the summary was read from. An unverified dialect is risky. */
  readonly format: ExplainFormat | undefined;
  readonly summary: AgentPlanSummary;
}

export interface AgentAutoExecuteInput {
  /** The statement the answer rests on, verbatim — what would be handed over. */
  readonly sql: string;
  /** The statements this run executed on its own bounded path, verbatim. */
  readonly executedStatements: readonly string[];
  /** What the run recorded for the answer's own execution (`artifact.summary.elapsedMs`). */
  readonly elapsedMs: number;
  /** The plan the run holds for that statement. Absent is risky, never a pass. */
  readonly plan?: AgentAutoExecutePlan;
}

/** Which condition refused. Named, because "it did not run" is not an explanation. */
export type AgentAutoExecuteCondition = "not-executed" | "plan-risky" | "measured-slow";

export type AgentAutoExecuteDecision =
  | { readonly handover: "auto-executed" }
  | {
      readonly handover: "applied";
      readonly condition: AgentAutoExecuteCondition;
      /** The run's own words for what it declined to do, and why. */
      readonly warning: string;
    };

/**
 * Condition 2, per engine.
 *
 * PostgreSQL and SQLite are read by their own rules and every other dialect is
 * risky — the same fail-closed posture `summarisePlan` takes, and for the same
 * reason: applying one engine's rule to another's grammar would be a claim about a
 * plan nobody has looked at.
 *
 * `unknown` fails on BOTH engines, which is why this is written as a membership
 * test rather than as `access !== "full-scan"`. A plan the server could not
 * interpret says nothing about how the statement reaches its rows, and "said
 * nothing" must not read as "said it was cheap".
 *
 * That guarantee used to hold only when NO step was recognised, which is the narrower
 * thing (#373 review). A plan can be PARTLY read — `SEARCH t USING INDEX ix` beside a
 * step this build has never seen — and `access` then describes the recognised steps
 * while saying nothing at all about the rest. `summarisePlan` now carries that as
 * `uninterpretedStep`, and it is refused HERE, before either engine's rule, because
 * the sentence above is about a reading rather than about a dialect.
 *
 * Only the SQLite reading sets the flag; PostgreSQL's does not, and that asymmetry is
 * argued in `plan-summary.ts` rather than assumed. The short of it: PostgreSQL reports
 * a numeric `Total Cost` for the whole plan that condition 2 already weighs, and it
 * preempts a statement that overruns, so a node this server did not recognise is
 * bounded by something other than the reading. On SQLite the reading is the only
 * evidence there is. The check below is written over the summary rather than inside
 * the SQLite branch so that a reading which later starts reporting the flag for another
 * engine is refused by default rather than admitted by omission.
 *
 * SQLite is stricter than PostgreSQL and deliberately so. PostgreSQL reports a cost
 * that can be weighed and preempts a statement that overruns; SQLite reports no cost
 * and no row estimate at all, does not preempt, and a read that runs long blocks
 * writers and this application until it finishes. So a `mixed` plan passes on
 * PostgreSQL and does not pass here: any `SCAN` is a full read of a table whose size
 * nothing in the plan states.
 */
function planIsSafe(plan: AgentAutoExecutePlan | undefined): boolean {
  if (plan === undefined) return false;
  if (plan.summary.uninterpretedStep === true) return false;
  if (plan.format === "postgres-json") {
    if (plan.summary.access !== "index" && plan.summary.access !== "mixed") return false;
    return plan.summary.estimatedCost !== undefined && plan.summary.estimatedCost <= AGENT_AUTO_EXECUTE_MAX_PLAN_COST;
  }
  if (plan.format === "sqlite-queryplan") return plan.summary.access === "index";
  return false;
}

/**
 * The refusal sentences, in the register the timeline already speaks in: what was
 * not done, why, and whose the statement now is.
 */
const CONDITION_WARNINGS: Readonly<Record<Exclude<AgentAutoExecuteCondition, "measured-slow">, string>> = Object.freeze(
  {
    "not-executed":
      "Not run for you: this run never executed this exact statement itself, so this one is yours to run.",
    "plan-risky":
      "Not run for you: the plan for this statement reads as a full table read, or the engine gave this server no plan it could weigh, or the plan carried a step this server could not read, so this one is yours to run.",
  },
);

/** Decides the `handover` an `answer-composed` event records. */
export function evaluateAutoExecute(input: AgentAutoExecuteInput): AgentAutoExecuteDecision {
  // In condition order, so a refusal names the first thing that failed rather than
  // whichever check happened to be written last.
  if (!input.executedStatements.includes(input.sql)) {
    return { handover: "applied", condition: "not-executed", warning: CONDITION_WARNINGS["not-executed"] };
  }
  if (!planIsSafe(input.plan)) {
    return { handover: "applied", condition: "plan-risky", warning: CONDITION_WARNINGS["plan-risky"] };
  }
  if (input.elapsedMs > AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS) {
    return {
      handover: "applied",
      condition: "measured-slow",
      warning: `Not run for you: this run measured the statement at ${input.elapsedMs} ms, over the ${AGENT_AUTO_EXECUTE_MAX_ELAPSED_MS} ms this gate allows, so this one is yours to run.`,
    };
  }
  return { handover: "auto-executed" };
}
