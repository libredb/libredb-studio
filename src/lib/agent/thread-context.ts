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

/** The whole report, rather than its tail, had no room left. */
const REPORT_ABSENT_NOTICE = "[This step's report is not shown here at all.]";

const cap = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);

/**
 * The predecessor's report: what it concluded, in its ledger's own order.
 *
 * Order is the ledger's rather than a chosen one, so a reader gets the answer, the
 * claims and the closing prose in the order they were established.
 */
function reportOf(record: AgentRunRecord): readonly string[] {
  const items: string[] = [];
  for (const event of record.events) {
    if (event.kind === "answer-composed") {
      items.push(`Answer statement: ${event.sql}`);
    } else if (event.kind === "report-composed") {
      for (const [index, claim] of event.claims.entries()) {
        items.push(`Claim ${index + 1}: ${claim.claim}`);
      }
    } else if (event.kind === "closing-statement") {
      items.push(`Closing: ${event.text}`);
    }
  }
  return items;
}

/**
 * Keeps whole ITEMS, so a report is never cut mid-claim.
 *
 * Items rather than lines, because a statement and a claim may both carry newlines of
 * their own: fitting by line would keep the first line of a multi-line `SELECT` and
 * then announce that the rest was omitted at a claim boundary, which would be a
 * sentence about a cut that did not happen there. A partial claim is worse than a
 * missing one — the model would read it as complete.
 */
function fitItems(items: readonly string[], room: number): readonly string[] {
  const kept: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.length + 1 > room) break;
    kept.push(item);
    used += item.length + 1;
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
  const shed = Math.max(0, all.length - AGENT_THREAD_MAX_STEPS);
  const steps = shed === 0 ? all : all.slice(shed);
  // CUMULATIVE, not per-derivation. Each header carries at most the cap, so `shed` is
  // 1 forever once a conversation passes it: a thirty-step thread would keep saying
  // that one step was dropped. A count that is only ever right on the first link is a
  // worse sentence than no count at all.
  const droppedSteps = (previous.thread.droppedSteps ?? 0) + shed;

  const notices: string[] = [];
  if (droppedSteps > 0) {
    notices.push(`[${droppedSteps} earlier step${droppedSteps === 1 ? " is" : "s are"} no longer carried.]`);
  }

  // Numbered from where the conversation actually is, not from what is left of it: a
  // spine that restarts at 1 after five steps fell off tells the model this is the
  // first question when it is the sixth.
  const spineLines = steps.map((step, index) => `Step ${droppedSteps + index + 1}: ${step.objective}`);
  const spineBudget = Math.floor(budget * SPINE_BUDGET_SHARE);
  let hidden = 0;
  while (spineLines.length > 1 && spineLines.join("\n").length > spineBudget) {
    spineLines.shift();
    hidden += 1;
  }
  if (hidden > 0) {
    notices.push(`[${hidden} earlier step${hidden === 1 ? " is" : "s are"} no longer shown here.]`);
  }

  // Notices lead, and that is load-bearing rather than tidy: what has to survive a
  // final `cap` is the account of what is MISSING, and `cap` cuts the tail.
  const headWith = (extra: readonly string[]): string => [...notices, ...extra, ...spineLines].join("\n");
  const threadId = previous.thread.threadId;
  const carried = droppedSteps === 0 ? {} : { droppedSteps };
  const report = reportOf(previous);
  const reportText = report.join("\n");
  const head = headWith([]);
  const remaining = budget - head.length - 1;

  if (report.length === 0) {
    return { threadId, steps, ...carried, text: cap(head, budget) };
  }
  // A report existed and there is no room for any of it. Said rather than dropped: the
  // spine's own share can leave nothing behind at a small operator-set budget, and a
  // conversation that silently loses its evidence is the one thing the rest of this
  // module refuses to do. The notice goes at the HEAD, because appending it and then
  // capping is how it would be the first thing lost.
  if (remaining <= 0) {
    return { threadId, steps, ...carried, text: cap(headWith([REPORT_ABSENT_NOTICE]), budget) };
  }
  if (reportText.length <= remaining) {
    return { threadId, steps, ...carried, text: `${head}\n${reportText}` };
  }

  const kept = fitItems(report, remaining - REPORT_CUT_NOTICE.length - 1);
  return { threadId, steps, ...carried, text: [head, ...kept, REPORT_CUT_NOTICE].join("\n") };
}
