/**
 * Whether a run met the goal its mode was opened for (#330 T1, epic #325).
 *
 * This module exists because of a measurement, not a design preference. On
 * 2026-08-12 nine consecutive runs against a real model produced zero reports
 * (#341), and every gate this repository owns was green while they did: the unit
 * suites passed, line coverage was 100%, and the rail rendered a timeline for each
 * one. Nothing was broken. The code ran correctly, and no requirement said a run
 * has to ANSWER, so nothing looked.
 *
 * `stopReason` (#338) closed half of the gap: it tells a reader whether the loop
 * ended because the model composed a report or because it stopped talking. The
 * half it cannot reach is a run that DID compose a report and still answered
 * nothing — a report resting entirely on empty result sets carries a valid
 * `report-composed` entry, verified citations and `stopReason: report-composed`,
 * and is indistinguishable from a good run in every field this ledger has.
 *
 * Three properties are deliberate:
 *
 *  - **It is a pure fold over the ledger.** No clock, no model, no database. The
 *    same events verify to the same verdict in a test, in an eval and on a server,
 *    which is what lets an eval assert against a ledger rather than against prose.
 *  - **The rule is chosen by the run's own mode**, from a total record, so a new
 *    mode cannot silently inherit another mode's bar. Planning is toolless by
 *    contract and can never cite evidence; judging it by the investigation rule
 *    would fail every planning run that did exactly what the mode is for. M3's
 *    workflow types extend this registry rather than widening one predicate.
 *  - **Nothing here is persisted, and that is a decision rather than an omission.**
 *    Writing a verdict into the ledger means spending the terminal-status
 *    vocabulary, which `docs/BACKLOG.md` B24 hands to the owner rather than to the
 *    implementer. The verdict is computed and reported; where it is RECORDED is one
 *    call site, and it moves when B24 is ratified.
 *
 * The honest limit: `empty-evidence` is mechanical, and it has to be. Whether a
 * model "stated uncertainty" about an empty result is a judgement about prose, and
 * a verifier that read the model's own words to decide whether the model answered
 * would be grading the answer with the answer. What is checked instead is what the
 * claims RESTED on, which is a fact about the run.
 */

import type { AgentReportClaim, AgentRunEvent, AgentRunMode, AgentRunRecord, AgentRunWorkflowType } from "./types";

/**
 * Which rule judged a run. Versioned in the value, like the execution policy: a
 * verdict read months later has to say which bar it was measured against, and a
 * rule that changes its mind is a new id rather than the same one meaning
 * something else.
 */
export type AgentGoalVerifierId =
  | "agent-planning.1"
  | "agent-investigation.1"
  /**
   * Retired by #356 and kept in the union anyway: verdicts recorded under it are on
   * ledgers that outlive the rule, and this is the type a reader of one holds. What
   * a versioned id must never do is mean something else later, so `.1` still means
   * what it meant — a run judged to need a before/after comparison whatever it
   * recommended.
   */
  | "agent-query-optimization.1"
  | "agent-query-optimization.2"
  | "agent-database-assessment.1"
  | "agent-operations.1";

/**
 * What a run was required to produce and did not. Deliberately a closed union of
 * FACTS about the ledger, never a sentence: the rail and the eval harness render
 * their own words, and a reason a machine cannot group is a reason nothing can
 * count.
 */
export type AgentGoalShortfall =
  /** An agent run finished without composing a report with claims in it. */
  | "no-report"
  /** Every result the report cited returned zero rows, so `0 rows` IS the answer. */
  | "empty-evidence"
  /** A planning run left no prose at all — the mute run of #341 F1. */
  | "no-plan"
  /**
   * A query-optimization run never compared two plans, and recommended no index
   * either.
   *
   * The template's own artifact. A run that recommends a rewrite without having
   * looked at what the engine does differently has recommended it on the strength
   * of its own opinion, and that is precisely what this workflow exists not to do.
   */
  | "no-plan-comparison"
  /**
   * A query-optimization run recommended an index and cited no plan it had read.
   *
   * The index arm of the same requirement (#356). What the comparison establishes
   * for a rewrite — that the recommendation rests on what the engine actually does
   * — the diagnosed plan establishes for an index, and this is a run that produced
   * neither.
   */
  | "no-plan-evidence"
  /**
   * A database-assessment run never profiled a table.
   *
   * The template's own artifact. An assessment composed from the schema alone is a
   * description of the shape of the database, not of the state of its data — which
   * is what the workflow is for.
   */
  | "no-table-profile"
  /**
   * The run was stopped before it could conclude. Substituted for the missing
   * output rather than reported alongside it: a user's stop is not a defect of the
   * run, and counting it as one would make every cancellation read as a model that
   * would not answer.
   */
  | "cancelled";

export interface AgentGoalVerdict {
  readonly outcome: "answered" | "unanswered";
  readonly verifier: AgentGoalVerifierId;
  /** Empty exactly when the outcome is `answered`. */
  readonly unmet: readonly AgentGoalShortfall[];
}

/** The rule for the mode that has no tools and therefore no evidence to cite. */
export const AGENT_PLANNING_VERIFIER: AgentGoalVerifierId = "agent-planning.1";

/**
 * A rule and the id that names it, which are two halves of ONE decision.
 *
 * Every workflow but query optimization names `agent-investigation.1`, and that is a
 * claim rather than a placeholder: composing claims that rest on something the run
 * actually read is the BASELINE every workflow has to meet, whatever else it is
 * asked for. A template ADDS to it. Naming an id before its rule exists would make a
 * verdict say it was measured against a bar that was not yet being applied, which is
 * the one thing a versioned id must never do.
 */
export interface AgentWorkflowGoal {
  readonly verifier: AgentGoalVerifierId;
  readonly verify: (run: VerifiableAgentRun) => readonly AgentGoalShortfall[];
}

/** Everything the verdict is a function of, and nothing else. */
export type VerifiableAgentRun = Pick<AgentRunRecord, "mode" | "workflowType" | "status" | "events">;

/**
 * Every claim the run composed, across every report entry it wrote.
 *
 * More than one is possible: `composeReport` is idempotent in its VERIFICATION but
 * not in its appending, so a run resumed after a death between the append and the
 * finish can add a second (`investigation.ts` says so). Reading all of them means
 * the verdict does not depend on which one a reader picked.
 */
function composedClaims(events: readonly AgentRunEvent[]): readonly AgentReportClaim[] {
  return events.flatMap((event) => (event.kind === "report-composed" ? event.claims : []));
}

/** Correlation id → how many rows that read actually returned. */
function rowCountsByArtifact(events: readonly AgentRunEvent[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "tool-completed") counts.set(event.artifact.correlationId, event.artifact.summary.rowCount);
  }
  return counts;
}

/**
 * True when the report cited results, and every result it cited was empty.
 *
 * A citation the ledger cannot resolve is skipped rather than assumed empty:
 * `composeReportTool` refuses an invented correlation id, so this only arises from
 * a hand-written or older ledger, and calling a result empty when nobody has seen
 * it would be the verifier inventing the very evidence it is checking for.
 */
function restsOnlyOnEmptyResults(claims: readonly AgentReportClaim[], events: readonly AgentRunEvent[]): boolean {
  const counts = rowCountsByArtifact(events);
  const cited: number[] = [];
  for (const claim of claims) {
    for (const reference of claim.evidence) {
      if (reference.source !== "artifact") continue;
      const rowCount = counts.get(reference.correlationId);
      if (rowCount !== undefined) cited.push(rowCount);
    }
  }
  return cited.length > 0 && cited.every((rowCount) => rowCount === 0);
}

/** Planning produced its whole output, or it produced nothing. */
function verifyPlanningGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const spoke = run.events.some((event) => event.kind === "closing-statement" && event.text.length > 0);
  if (spoke) return [];
  return run.status === "cancelled" ? ["cancelled"] : ["no-plan"];
}

/** An investigation answered when it composed claims that rest on something it read. */
function verifyInvestigationGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const claims = composedClaims(run.events);
  if (claims.length === 0) return run.status === "cancelled" ? ["cancelled"] : ["no-report"];
  return restsOnlyOnEmptyResults(claims, run.events) ? ["empty-evidence"] : [];
}

type GoalRule = (run: VerifiableAgentRun) => readonly AgentGoalShortfall[];

/**
 * Workflow type → the rule an agent run of it is judged by. Kept in step with
 * `AGENT_WORKFLOW_VERIFIERS` by construction: a rule and the id that names it are
 * two halves of one decision, and the half that drifted would be the one a reader
 * could not interpret.
 */
/** The operation an inspected plan is read under. */
const PLAN_OPERATION = "sql.explain.estimate";

/** Every plan THIS run read from the engine, by the id a citation would name. */
function planArtifacts(events: readonly AgentRunEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool-completed" && event.artifact.operationId === PLAN_OPERATION) {
      ids.add(event.artifact.correlationId);
    }
  }
  return ids;
}

/**
 * The optimization bar: everything an investigation must meet, and then evidence
 * that the change it proposes rests on what the engine actually does.
 *
 * Composed rather than replaced. A run that answered nothing has not become
 * acceptable by comparing two plans, so the baseline is checked first and its
 * shortfall dominates — reporting a missing comparison about a run that never
 * composed a report at all would name the smaller of two problems.
 *
 * **Two arms, because the two changes this workflow can propose are not equally
 * checkable (#356).** A rewrite's "after" plan is readable without changing
 * anything, so a rewrite is still held to the comparison. An index's is not: the
 * second plan requires the index to EXIST, and the run is read-only by contract —
 * a live run on 2026-08-12 diagnosed the scan, recommended the right index, tried
 * `CREATE INDEX ...; SELECT ...`, was refused as it should be, and was then told by
 * this rule that it had not answered. The requirement was never wrong; it was
 * stated in terms of the one artifact only one of the two answers can produce.
 *
 * So an index answers on the plan it DIAGNOSED, cited by the recommendation itself.
 * Not merely "a plan is somewhere on the ledger": the citation is what ties this
 * recommendation to that plan, and without it the run is proposing an index beside
 * a plan rather than because of one.
 */
function verifyQueryOptimizationGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const baseline = verifyInvestigationGoal(run);
  if (baseline.length > 0) return baseline;
  if (run.events.some((event) => event.kind === "plan-comparison")) return [];

  const indexes = run.events.flatMap((event) =>
    event.kind === "recommendation" && event.change === "index" ? [event] : [],
  );
  if (indexes.length === 0) return ["no-plan-comparison"];

  const plans = planArtifacts(run.events);
  const grounded = indexes.some((event) =>
    event.evidence.some((reference) => reference.source === "artifact" && plans.has(reference.correlationId)),
  );
  return grounded ? [] : ["no-plan-evidence"];
}

/**
 * The assessment bar: the investigation baseline, and then a table actually
 * profiled.
 *
 * Composed the same way the optimization rule is, and the baseline dominates for
 * the same reason. An assessment written from the schema alone describes the SHAPE
 * of a database; this workflow is about the STATE of its data, and only a profile
 * establishes that.
 */
function verifyDatabaseAssessmentGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const baseline = verifyInvestigationGoal(run);
  if (baseline.length > 0) return baseline;
  return run.events.some((event) => event.kind === "table-profiled") ? [] : ["no-table-profile"];
}

/**
 * Workflow type → the rule an agent run of it is judged by, AND the id that names
 * that rule — ONE entry, so the two cannot drift.
 *
 * These were two records until review pointed out that the lockstep this file
 * claimed was enforced by nothing: changing a workflow's id without changing its
 * rule typechecked, and the verdict would then say it had been measured against a
 * bar nobody applied. A versioned id whose meaning can change silently is worse
 * than no id at all, so the two halves are one value.
 */
/**
 * The operations bar: a cited report resting on what the engine said about ITSELF.
 *
 * **The one template that does NOT compose on the investigation baseline, and the
 * exception is the whole #356 lesson applied rather than repeated.** The baseline
 * ends a run `empty-evidence` when every result it cited returned zero rows, and for
 * a bounded read that is right — `0 rows` means the question found nothing. For an
 * operational reading it is precisely backwards. "No session is blocked", "the engine
 * reports no slow queries", "no index is unused" are ANSWERS, and they are the
 * answers a healthy database gives. Holding this workflow to the baseline would mark
 * every run against a healthy server unanswered, which is the same error as demanding
 * an artifact only some valid answers can produce.
 *
 * **Why "the report cites a reading" is not a second arm here, though it IS the rule
 * the model is told.** It cannot fail in this workflow, and an arm that cannot fail
 * is a verdict a user is promised and no run can ever show. `composeReportTool`
 * refuses any claim whose evidence does not name something this run produced, and the
 * only citable things an operations run can produce are `db.operations.read`
 * artifacts: it is offered no other tool that settles a step, and it captures no
 * schema snapshot to cite. So a composed report already IS a report citing a reading,
 * enforced at composition rather than judged afterwards. Writing the arm anyway would
 * have bought its own line coverage from a hand-built ledger no run can produce —
 * the same dead-arm objection that kept the recon template to one arm.
 *
 * What is left is therefore real: a run that composed nothing has not answered, and a
 * cancelled one says so instead. Both are written out here rather than borrowed, so
 * that a later change to the baseline's emptiness rule cannot silently arrive through
 * a call this function no longer makes.
 */
function verifyOperationsGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const claims = composedClaims(run.events);
  if (claims.length === 0) return run.status === "cancelled" ? ["cancelled"] : ["no-report"];
  return [];
}

export const AGENT_WORKFLOW_GOALS: Readonly<Record<AgentRunWorkflowType, AgentWorkflowGoal>> = Object.freeze({
  investigation: { verifier: "agent-investigation.1", verify: verifyInvestigationGoal },
  "query-optimization": { verifier: "agent-query-optimization.2", verify: verifyQueryOptimizationGoal },
  "database-assessment": { verifier: "agent-database-assessment.1", verify: verifyDatabaseAssessmentGoal },
  operations: { verifier: "agent-operations.1", verify: verifyOperationsGoal },
} satisfies Record<AgentRunWorkflowType, AgentWorkflowGoal>);

const PLANNING_GOAL: AgentWorkflowGoal = { verifier: AGENT_PLANNING_VERIFIER, verify: verifyPlanningGoal };

/**
 * The goal this run is judged against. Mode decides first and the workflow cannot
 * override it, for the same reason it cannot in `selectAgentTools`: planning has no
 * tools whatever it is for, so it can never be held to a bar requiring evidence.
 */
function goalFor(run: VerifiableAgentRun): AgentWorkflowGoal {
  return run.mode === "planning" ? PLANNING_GOAL : AGENT_WORKFLOW_GOALS[run.workflowType];
}

/**
 * Did this run meet the goal its mode was opened for?
 *
 * Answerable from the ledger alone, which is the point: a user reads the ledger, a
 * resumed process reads the ledger, and an eval asserts against the ledger. A
 * verdict derived from anything else would be a claim about a run that the run's
 * own record could not support.
 */
export function verifyRunGoal(run: VerifiableAgentRun): AgentGoalVerdict {
  // One lookup, so the id in the verdict is by construction the id of the rule that
  // produced it.
  const goal = goalFor(run);
  const unmet = goal.verify(run);
  return { outcome: unmet.length === 0 ? "answered" : "unanswered", verifier: goal.verifier, unmet };
}
