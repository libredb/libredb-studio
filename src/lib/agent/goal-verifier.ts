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
export type AgentGoalVerifierId = "agent-planning.1" | "agent-investigation.1" | "agent-query-optimization.1";

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
   * A query-optimization run never compared two plans.
   *
   * The template's own artifact. A run that recommends a rewrite without having
   * looked at what the engine does differently has recommended it on the strength
   * of its own opinion, and that is precisely what this workflow exists not to do.
   */
  | "no-plan-comparison"
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
/**
 * The optimization bar: everything an investigation must meet, and then its own
 * artifact.
 *
 * Composed rather than replaced. A run that answered nothing has not become
 * acceptable by comparing two plans, so the baseline is checked first and its
 * shortfall dominates — reporting `no-plan-comparison` about a run that never
 * composed a report at all would name the smaller of two problems.
 */
function verifyQueryOptimizationGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const baseline = verifyInvestigationGoal(run);
  if (baseline.length > 0) return baseline;
  return run.events.some((event) => event.kind === "plan-comparison") ? [] : ["no-plan-comparison"];
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
export const AGENT_WORKFLOW_GOALS: Readonly<Record<AgentRunWorkflowType, AgentWorkflowGoal>> = Object.freeze({
  investigation: { verifier: "agent-investigation.1", verify: verifyInvestigationGoal },
  "query-optimization": { verifier: "agent-query-optimization.1", verify: verifyQueryOptimizationGoal },
  "database-assessment": { verifier: "agent-investigation.1", verify: verifyInvestigationGoal },
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
