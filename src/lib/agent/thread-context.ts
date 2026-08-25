/**
 * Derives the conversation a run is handed about the steps before it.
 *
 * The context has two halves, drawn from different places, and the split IS the
 * design:
 *
 * - The **spine** — every step's objective — comes off the predecessor's header and
 *   costs nothing to read. It is the conversation's skeleton, and it is the half a
 *   later step actually lacks: a transformation step ("chart those", "export it")
 *   has an objective that is itself a pronoun, so the plain statement of intent
 *   lives further back. Carrying only the previous step would hand a run a dangling
 *   referent and call it context.
 * - The **evidence** — the predecessor's report — comes off the record the route has
 *   already loaded, and also costs nothing. Older steps' reports are deliberately
 *   NOT carried: that would be one ledger read per step, for the half the spine
 *   already supplies.
 *
 * Nothing is truncated silently. A spine that outgrows its share, a step dropped
 * past the cap, a report cut at a claim boundary — each says so in the text, because
 * a model that half-read a conversation must not be confident about the half it has.
 *
 * Everything assembled here is somebody else's words: a user's objectives and a
 * model's claims. `investigation.ts` fences the whole block before a model reads it;
 * this module produces inert strings only, which is what keeps the derivation
 * testable without a model and the context resumable without a browser.
 */

import {
  AGENT_THREAD_CONTEXT_MAX_CHARS,
  AGENT_THREAD_MAX_STEPS,
  AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS,
} from "./execution-policy";
import type { AgentRunRecord, AgentThreadContext, AgentThreadStep } from "./types";

/**
 * The share of the budget the spine may take.
 *
 * Reserved rather than first-come because the most recent report is the strongest
 * referent source there is: losing it to an old objective would be the wrong trade,
 * and a long conversation is exactly where that trade would otherwise be made.
 */
const SPINE_BUDGET_SHARE = 0.75;

const REPORT_CUT_NOTICE = "[The rest of this step's report is not shown here.]";

const cap = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);

/**
 * The predecessor's report: what it concluded, in its ledger's own order.
 *
 * Order is the ledger's rather than a chosen one, so a reader gets the answer, the
 * claims and the closing prose in the order they were established.
 */
function reportOf(record: AgentRunRecord): string {
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
  return lines.join("\n");
}

/** Keeps whole lines only, so a report is never cut mid-claim. */
function fitLines(text: string, room: number): readonly string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept;
}

export function deriveThreadContext(
  previous: AgentRunRecord,
  budget: number = AGENT_THREAD_CONTEXT_MAX_CHARS,
): AgentThreadContext {
  const appended: AgentThreadStep = {
    runId: previous.runId,
    objective: cap(previous.objective, AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS),
  };
  const all = [...previous.thread.steps, appended];
  const dropped = Math.max(0, all.length - AGENT_THREAD_MAX_STEPS);
  const steps = dropped === 0 ? all : all.slice(dropped);

  const notices: string[] = [];
  if (dropped > 0) {
    notices.push(`[${dropped} earlier step${dropped === 1 ? " is" : "s are"} no longer carried.]`);
  }

  const spineLines = steps.map((step, index) => `Step ${index + 1}: ${step.objective}`);
  const spineBudget = Math.floor(budget * SPINE_BUDGET_SHARE);
  let hidden = 0;
  while (spineLines.length > 1 && spineLines.join("\n").length > spineBudget) {
    spineLines.shift();
    hidden += 1;
  }
  if (hidden > 0) {
    notices.push(`[${hidden} earlier step${hidden === 1 ? " is" : "s are"} no longer shown here.]`);
  }

  const head = [...notices, ...spineLines].join("\n");
  const threadId = previous.thread.threadId;
  const report = reportOf(previous);
  const remaining = budget - head.length - 1;

  if (report.length === 0 || remaining <= 0) {
    return { threadId, steps, text: cap(head, budget) };
  }
  if (report.length <= remaining) {
    return { threadId, steps, text: `${head}\n${report}` };
  }

  const kept = fitLines(report, remaining - REPORT_CUT_NOTICE.length - 1);
  return { threadId, steps, text: [head, ...kept, REPORT_CUT_NOTICE].join("\n") };
}
