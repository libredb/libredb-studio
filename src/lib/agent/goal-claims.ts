/**
 * The facts about a ledger that more than one goal rule reads (#1821): the claims a run composed, the investigation
 * baseline, the plans it read and whether an event recommends an index.
 *
 * Shared by `goal-verifier.ts` and the language rules in `languages/<id>/verifiers.ts`. It never imports
 * `goal-verifier.ts` at runtime: a language rule that reached the core rules through that module would read
 * `AGENT_WORKFLOW_GOALS` while it is still evaluating, so a rule both sides need lives here instead.
 */

import { PLAN_ESTIMATE_OPERATIONS } from "./agent-manifest";
import type { AgentGoalShortfall, VerifiableAgentRun } from "./goal-verifier";
import type { AgentReportClaim, AgentRunEvent } from "./types";

/**
 * Every claim the run composed, across every report entry it wrote.
 *
 * More than one is possible: `composeReport` is idempotent in its VERIFICATION but
 * not in its appending, so a run resumed after a death between the append and the
 * finish can add a second (`investigation.ts` says so). Reading all of them means
 * the verdict does not depend on which one a reader picked.
 */
export function composedClaims(events: readonly AgentRunEvent[]): readonly AgentReportClaim[] {
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
 *
 * `unbounded` is the set of artifacts whose row count says nothing about whether the
 * question was answered. The caller names them, because which artifacts those are is a
 * fact about a WORKFLOW's evidence and not about arithmetic — only the optimization rule
 * passes any (B45).
 *
 * A cited `unbounded` artifact SETTLES this question rather than leaving it, and that is the
 * B45 lesson a fourth time. Skipping one made the exemption work in exactly one shape — a
 * report whose only citation was the plan, where the census comes out empty and an empty
 * census is not an emptiness finding — and invert everywhere else: where a report cited a
 * plan AND a read that came back empty, the only evidence that was not empty was the piece
 * removed, and the empty read decided alone. Measured 2026-10-19 on `bonsai-2:4b`
 * query-optimization, the cell at 4/5 and the model at 29/30: four of five runs ended
 * `report-composed` with `empty-evidence` in 44-65 seconds, and the first cited a read of
 * zero rows beside a `sql.explain.estimate` carrying FIVE. The exemption threw the five away.
 *
 * The exemption's own reason is that such an artifact is COMPLETE and its count measures
 * nothing — so a report resting on one rests on something. That is the whole claim this
 * function makes, and it is not widened: an id nobody cited is still not evidence, and an
 * empty bounded read cited ALONE still ends the run `empty-evidence`, because zero rows from
 * a read is the answer that read gave.
 */
function restsOnlyOnEmptyResults(
  claims: readonly AgentReportClaim[],
  events: readonly AgentRunEvent[],
  unbounded: ReadonlySet<string>,
): boolean {
  const counts = rowCountsByArtifact(events);
  const cited: number[] = [];
  for (const claim of claims) {
    for (const reference of claim.evidence) {
      if (reference.source !== "artifact") continue;
      if (unbounded.has(reference.correlationId)) return false;
      const rowCount = counts.get(reference.correlationId);
      if (rowCount !== undefined) cited.push(rowCount);
    }
  }
  return cited.length > 0 && cited.every((rowCount) => rowCount === 0);
}

/** No artifact is exempt from the emptiness census, which is every rule but one. */
const EVERY_COUNT_MEANS_SOMETHING: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * An investigation answered when it composed claims that rest on something it read.
 *
 * `unbounded` is the composing rules' seam and defaults to empty, so `agent-investigation.1`
 * means exactly what it meant: a workflow that has an artifact whose row count is not a
 * measure of its answer says so at the call, and nothing is exempt by default.
 */
export function verifyInvestigationGoal(
  run: VerifiableAgentRun,
  unbounded: ReadonlySet<string> = EVERY_COUNT_MEANS_SOMETHING,
): readonly AgentGoalShortfall[] {
  const claims = composedClaims(run.events);
  if (claims.length === 0) return run.status === "cancelled" ? ["cancelled"] : ["no-report"];
  return restsOnlyOnEmptyResults(claims, run.events, unbounded) ? ["empty-evidence"] : [];
}

/**
 * Every plan THIS run read from the engine, by the id a citation would name: an artifact recorded under any
 * language's plan-estimate operation (`PLAN_ESTIMATE_OPERATIONS`), so a language's plans count here by being
 * registered there.
 */
export function planArtifacts(events: readonly AgentRunEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool-completed" && PLAN_ESTIMATE_OPERATIONS.has(event.artifact.operationId)) {
      ids.add(event.artifact.correlationId);
    }
  }
  return ids;
}

/**
 * Whether an event recommends an INDEX, in any language: a statement's `CREATE INDEX` card or a document-index card.
 * The index arm of `agent-query-optimization.3` accepts either, and the drive's compare-before-report hold reads it
 * the same way, so the two cannot come to disagree about what an index recommendation is.
 */
export function recommendsIndex(
  event: AgentRunEvent,
): event is Extract<AgentRunEvent, { kind: "recommendation"; change: "index" | "document-index" }> {
  return event.kind === "recommendation" && (event.change === "index" || event.change === "document-index");
}
