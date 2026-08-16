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
 *
 * It answers WHICH reading refused rather than whether one did (#387 review). The five
 * are distinguishable and this function has always known which applied; it used to
 * collapse them into a boolean, and the sentence built from that then offered three of
 * them as alternatives for the reader to pick from. Everywhere else this timeline says
 * what happened, so a menu was the odd one out — and it hides the one a user most needs,
 * because "the estimate is 4320000 against a ceiling of 50000" can be argued with and
 * "possibly expensive" cannot.
 */
type PlanRefusal =
  | "no-plan"
  | "unverified-dialect"
  | "unreadable-step"
  | "unreadable-access"
  | "reads-whole-table"
  | "no-estimate"
  | "over-ceiling";

/**
 * `unknown` and `full-scan` are separated here, and the first attempt at this grouped
 * them (#388 review). They are not the same reading: `full-scan` means at least one
 * relation is read end to end, and `unknown` means the reading could not tell
 * (`plan-summary.ts`). Calling the second one a whole-table read is a specific claim
 * about a plan nobody managed to interpret — which is worse than the menu this
 * replaced, because a reader can act on "or" and cannot act on a confident wrong
 * reason. The same applies to a dialect with no rule: a plan IS held, so "no plan" is
 * false; what is missing is a way to weigh it.
 */
function planRefusal(plan: AgentAutoExecutePlan | undefined): PlanRefusal | null {
  if (plan === undefined) return "no-plan";
  if (plan.summary.uninterpretedStep === true) return "unreadable-step";
  if (plan.format === "postgres-json") {
    if (plan.summary.access === "unknown") return "unreadable-access";
    if (plan.summary.access !== "index" && plan.summary.access !== "mixed") return "reads-whole-table";
    if (plan.summary.estimatedCost === undefined) return "no-estimate";
    return plan.summary.estimatedCost <= AGENT_AUTO_EXECUTE_MAX_PLAN_COST ? null : "over-ceiling";
  }
  // SQLite carries no cost at all, so `access` is the whole reading: anything wholly
  // indexed passes, an unreadable plan says so, and everything else reads a table whose
  // size nothing in the plan states.
  if (plan.format === "sqlite-queryplan") {
    if (plan.summary.access === "index") return null;
    return plan.summary.access === "unknown" ? "unreadable-access" : "reads-whole-table";
  }
  return "unverified-dialect";
}

/**
 * The refusal in the reader's terms. A total record, so a refusal added later cannot
 * ship without words — the rule `SHORTFALL_SENTENCES` follows in the timeline.
 */
const PLAN_REFUSAL_TEXT: Readonly<Record<PlanRefusal, string>> = Object.freeze({
  "no-plan": "this run holds no plan for that exact statement, so there was nothing to weigh",
  "unverified-dialect":
    "this server has no rule for weighing a plan from this database, and reading it by another engine's rule would be a claim about a plan nobody has looked at",
  "unreadable-step":
    "the plan carried a step this server could not read, and a reading it cannot interpret is not a reading that it is cheap",
  "unreadable-access":
    "this server could not tell from the plan how the statement reaches its rows, and said nothing must not read as said it was cheap",
  "reads-whole-table": "the plan reads the whole table rather than reaching its rows through an index",
  "no-estimate": "the engine returned a plan with no cost in it, so there was no number to weigh",
  "over-ceiling": "the plan is too expensive",
});

/** The cost case earns its numbers: a ceiling nobody can see is a ceiling nobody can argue with. */
function planRefusalText(refusal: PlanRefusal, plan: AgentAutoExecutePlan | undefined): string {
  if (refusal !== "over-ceiling" || plan?.summary.estimatedCost === undefined) return PLAN_REFUSAL_TEXT[refusal];
  return `${PLAN_REFUSAL_TEXT[refusal]} — the engine estimates ${plan.summary.estimatedCost}, against a ceiling of ${AGENT_AUTO_EXECUTE_MAX_PLAN_COST}`;
}

/**
 * The refusal sentences, in the register the timeline already speaks in: what was
 * not done, why, and whose the statement now is.
 */
const NOT_EXECUTED_WARNING =
  "Not run for you: this run never executed this exact statement itself, so this one is yours to run.";

/** Decides the `handover` an `answer-composed` event records. */
export function evaluateAutoExecute(input: AgentAutoExecuteInput): AgentAutoExecuteDecision {
  // In condition order, so a refusal names the first thing that failed rather than
  // whichever check happened to be written last.
  if (!input.executedStatements.includes(input.sql)) {
    return { handover: "applied", condition: "not-executed", warning: NOT_EXECUTED_WARNING };
  }
  const refusal = planRefusal(input.plan);
  if (refusal !== null) {
    return {
      handover: "applied",
      condition: "plan-risky",
      // `condition` stays as it was: it is recorded on the ledger and read back by
      // runs older than this change. What got more specific is what a reader sees.
      warning: `Not run for you: ${planRefusalText(refusal, input.plan)}, so this one is yours to run.`,
    };
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
