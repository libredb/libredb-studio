/**
 * Derives the context a follow-up run is handed about the run it follows
 * (`docs/BACKLOG.md` B36).
 *
 * The context is the previous run's objective and its report — the claims it
 * composed, the statement that WAS its answer when one was presented, and any
 * closing prose. All of it is somebody else's words (the user's, and a model's),
 * so `investigation.ts` fences the whole block before a model reads it; this
 * module only assembles the inert strings, which is what keeps the derivation
 * testable without a model and the context resumable without a browser.
 *
 * A run that answered nothing still yields a context: its report is simply empty,
 * and the follow-up is told what the previous run was ASKED, so it can either
 * resolve a referent against that or refuse for lack of one — which is the
 * second half of what B36 calls "done".
 */

import type { AgentPriorRunContext, AgentRunRecord } from "./types";

/**
 * The report half of a prior-run context, assembled from the events that carry
 * what the previous run concluded. Ordering is the ledger's own order, so a
 * reader gets the answer, the claims and the closing prose in the order they
 * were established.
 */
export function derivePriorRunContext(record: AgentRunRecord): AgentPriorRunContext {
  const lines: string[] = [];
  for (const event of record.events) {
    if (event.kind === "answer-composed") {
      lines.push(`Answer statement: ${event.sql}`);
    } else if (event.kind === "report-composed") {
      for (const [index, claim] of event.claims.entries()) {
        lines.push(`Claim ${index + 1}: ${claim.claim}`);
      }
    } else if (event.kind === "closing-statement") {
      lines.push(`Closing: ${event.text}`);
    }
  }
  return {
    runId: record.runId,
    objective: record.objective,
    report: lines.join("\n"),
  };
}
