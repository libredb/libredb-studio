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
import type { AgentRunRecord, AgentThreadContext, AgentThreadHeader, AgentThreadStep } from "./types";

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

/**
 * The conversation a follow-up may have, once the DATABASE behind it has been checked.
 *
 * Everything above assembles a conversation from a predecessor's ledger. This decides
 * whether the predecessor was even talking about the same database, which is a separate
 * question and was not being asked: a conversation was single-connection by INDUCTION,
 * because every link checked the connection ID at its own open. That is an identity
 * check on the RECORD. A user who edits a saved connection to address another server
 * keeps its id — an ordinary thing to do, and nothing about the id says it happened —
 * so a follow-up asked afterwards was handed the earlier steps' claims about the old
 * database while reading the new one. Nothing was refused and nothing looked wrong; the
 * run simply reported on one database using what had been established against another
 * (#509).
 *
 * The identity is `connectionIdentity`'s and not a second fingerprint, and its two
 * exclusions are what make it the right one here. It carries engine, host, port,
 * database, service, instance, role and the SSH tunnel the database is reached through,
 * so re-pointing any of those ends the conversation. It does NOT carry the password, so rotating a credential does not — a
 * rotation changes who may reach the database, never which database it is, and it must
 * not cost a user the conversation they were having.
 *
 * Absent on the predecessor is CARRIED rather than refused. A run opened before the
 * field existed records nothing about the database it read, and a mismatch invented out
 * of that silence would end every conversation in flight across a deploy — the same
 * read-side compatibility rule every other optional header field here follows.
 *
 * A header rather than a context, and `declined: "repointed"` rather than the
 * `"unavailable"` the five other ways a continuation does not happen share. The line is
 * that this is the only one that is not a FAILURE. It is reached only after the
 * predecessor was found, was this session's, was on this connection and had ended — every
 * check the route makes has passed — and the carry is then refused on purpose, because
 * the earlier steps' claims are about a database this run is not reading. The five are
 * the caller's own bug, transient, or another session's (`types.ts`,
 * `AgentThreadContext.declined`), and a sentence covering all six was true of each and
 * specific about none (#512).
 *
 * What the split is NOT is a longer-lived remedy. The decline lasts one question: the
 * route writes the current identity onto the run that question opens, and the rail's next
 * follow-up continues that run, so it matches and carries. Pointing the connection back
 * afterwards declines once more rather than restoring anything.
 *
 * It leaks nothing the route was withholding either, for the same reason the split is
 * earned: a caller told `"repointed"` has already been told everything a carried
 * conversation would have told it. That is why the five stay collapsed and this one does
 * not have to.
 *
 * It carries no `threadId`, so the refused follow-up starts a conversation of its own
 * named after itself — a later question must not inherit a root that was never part of it.
 */
export function threadContextFor(
  previous: AgentRunRecord,
  currentIdentity: string,
  budget?: number,
): AgentThreadHeader {
  if (previous.connectionIdentity !== undefined && previous.connectionIdentity !== currentIdentity) {
    return { steps: [], text: "", declined: "repointed" };
  }
  return deriveThreadContext(previous, budget);
}
