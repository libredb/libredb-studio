/**
 * Reading a plan run's deliverable out of its closing prose: the statement it drafted,
 * the refusal it wrote instead, or neither.
 *
 * Split out of `plan-statement.ts` on 2026-08-15 for a reason CSP measured (#396). The
 * rail has to reach this reader — the browser deciding for itself whether a run refused
 * is what let the two disagree about the same run — but `plan-statement.ts` also holds
 * the validation half, which imports the shared statement guard, which imports **zod
 * v4**. Zod v4 probes `new Function("")` at module load to decide whether it may JIT,
 * and a browser under a strict `script-src` fires `securitypolicyviolation` even though
 * the throw is caught. Importing the module for its reader therefore put an eval probe
 * on every page that renders an agent run.
 *
 * The lesson is narrower than "don't import server code", and it is the one worth
 * keeping: a module's direct imports were checked and called pure, and the TRANSITIVE
 * cost is what the policy actually measures. This file is the boundary — it may import
 * nothing but types and the fence-tag predicate, and `plan-draft-boundary.test.ts`
 * pins that, because the next dependency added here would be invisible until an end-to-
 * end run in a real browser caught it again.
 */

import { fenceTagEngine, isQueryFenceTag } from "@/lib/sql/fence-tags";
import type { DatabaseType } from "@/lib/types";

/**
 * The convention that makes a toolless mode's two legitimate endings mechanically
 * distinguishable: a statement, or a refusal that says what is missing.
 *
 * Exported because three places have to agree on the same characters — the rules the
 * model is given, this reader, and the goal verifier that stops accepting a lecture —
 * and a marker written out three times is a marker that drifts twice.
 */
export const PLAN_NO_STATEMENT_MARKER = "NO STATEMENT:";

/**
 * A fence line: three backticks, and whatever the model called the block.
 *
 * The info string may hold no backtick, and that restriction is load-bearing rather
 * than spec-following: CommonMark forbids it so that a whole fence written on ONE
 * line — ```` ```sql SELECT 1``` ```` — is not read as an opener. Without the rule
 * that single line opens a block nothing closes, and every line after it is read as
 * part of the statement. `src/components/rich-text.tsx` carries the identical
 * pattern for the identical reason (#389), and the two MUST agree: this module
 * decides what the ledger records and that one decides what the rail renders, so a
 * disagreement is a user shown a block the run does not know it wrote.
 *
 * Duplicated rather than imported because that module is client code — it returns
 * React nodes — and the server layer does not import the browser layer. The OTHER
 * dimension of that agreement is not duplicated at all: which block counts as a
 * statement is `isQueryFenceTag`, shared by both readers, because that one was left
 * to a comment and the two promptly disagreed (see `readPlanStatement`).
 */
const FENCE_LINE = /^\s*```([^`]*)$/;

/**
 * The refusal, as a line of its own. Case-insensitive: the rules ask for the marker
 * in capitals, and a run that answered correctly in every other respect should not
 * lose its refusal to a lower-case `s`.
 */
const REFUSAL_LINE = /^\s*NO STATEMENT:\s*(.*)$/i;

/**
 * A line that plainly OPENS a statement, for a run that wrote one without a fence.
 *
 * Measured on two local models asked for the same plan. One wrote the engine tag
 * on its own line and the statement under it, backticks and all left out:
 *
 *     sqlite
 *     SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
 *
 * and lost the cell to `no-statement` — the plan-mode bar — for a formatting slip around
 * a real statement. The other wrote prose in XML-ish tags on the same objective, and
 * that one must keep failing: `plan-statement-drafted` is recorded whenever this reader
 * returns a statement, with the validation riding along rather than gating it, so a reader
 * that accepted a sentence would score the run answered while the user reads prose. The
 * whole value of relaxing the fence rule is that it stays closed to that.
 *
 * A leading query verb is the narrowest signal that separates them, and it is checked
 * against the START of the candidate rather than searched for anywhere in it — a sentence
 * ABOUT a select is not a select. The list is the read-shaped openers a plan-mode
 * deliverable can have; anything a guard would reject as a write is deliberately absent,
 * because a plan run's statement is a read by contract and this reader should not be the
 * place a write first becomes plausible.
 */
const STATEMENT_OPENER = /^\s*(SELECT|WITH|EXPLAIN|SHOW|PRAGMA|DESCRIBE|DESC)\b/i;

/**
 * What a plan run's closing prose turned out to hold.
 *
 * Three outcomes and not two: "no statement" and "an explicit refusal" are different
 * facts about a run, and collapsing them is what let a four-paragraph lecture score
 * as a success for as long as it did.
 */
export type PlanStatementDraft =
  | {
      readonly kind: "statement";
      /** The block's text as the model typed it, with surrounding blank lines removed. */
      readonly sql: string;
      /** The fence's info string, lower-cased; absent when the fence carried none. */
      readonly tag: string | undefined;
    }
  | {
      readonly kind: "refusal";
      /**
       * What the run said was missing: the rest of the marker line, never empty.
       *
       * A bare marker is read as `absent` rather than as a refusal with nothing in it
       * (#396 review) — the convention exists so the run says what it lacks, and a
       * token that says nothing is not the ending the mode is for.
       */
      readonly detail: string;
    }
  | { readonly kind: "absent" };

type FencedBlock = { readonly tag: string | undefined; readonly sql: string };

/**
 * A collected fence as a block, or `null` when it is not this run's deliverable.
 *
 * Two ways to be neither, and they are different facts about the same text: a fence
 * with nothing in it is not a statement, for the same reason `renderProse` renders no
 * empty block — recording one would say the run drafted something — and a fence the
 * model tagged as something other than a query language is a block it told us is not
 * SQL, which the rail believes and so does this.
 */
function fencedBlock(
  tag: string | undefined,
  lines: readonly string[],
  dialect: DatabaseType | undefined,
): FencedBlock | null {
  const sql = lines.join("\n").trim();
  if (sql.length === 0 || !isQueryFenceTag(tag)) return null;
  // A block the model tagged for ANOTHER engine is not this run's deliverable (#396
  // review). `isQueryFenceTag` answers "is this a query", which is yes for `mysql` on
  // a PostgreSQL connection — and the recorder stamps the event with the CONNECTION's
  // dialect, so taking it would file the model's MySQL as PostgreSQL and report the
  // run as answered. An untagged fence and a bare `sql` name no engine and so cannot
  // contradict one; only an explicit engine can.
  const named = fenceTagEngine(tag);
  return named !== null && dialect !== undefined && named !== dialect ? null : { tag, sql };
}

/**
 * The statement, the refusal, or neither.
 *
 * Precedence is refusal first, and that is a decision about honesty rather than an
 * ordering convenience: a run that refused and then pasted an illustrative block has
 * not produced a deliverable, and recording that block would offer the user a
 * statement its own author declined to stand behind.
 *
 * The first fenced block whose TAG names a query language wins among several. Two
 * halves to that, and both were paid for:
 *
 *  - the first, because the contract asks for one statement and nothing here can tell
 *    which of two the user meant. The rest are not lost — #389's per-block control
 *    still offers every block in the rail by hand — they are simply not the run's
 *    recorded deliverable.
 *  - the tag, because `renderProse` offers the editor only a block `isQueryFenceTag`
 *    accepts, and this reader used to take any block at all. A run that opened with a
 *    ```text illustration and wrote its SQL below had the illustration recorded as its
 *    deliverable, shown in the statement card, and — the guard reading prose as
 *    `NO_STATEMENT` — marked there as SQL that may change data. Asking the shared
 *    predicate is what makes the agreement this module claims a fact.
 *
 * Fail-closed on an unrecognised tag, exactly as the rail is: a run whose only block is
 * a `bash` script drafted no statement, and the verdict reads that as the shortfall it
 * is rather than recording a shell command as this run's SQL.
 *
 * A fence the model never closed still yields what it holds, matching `renderProse`
 * line for line: a run cut off at its turn ceiling or its deadline ends mid-block,
 * and the half it had written is the half the user came for.
 */
export function readPlanStatement(text: string, dialect?: DatabaseType): PlanStatementDraft {
  let open: { readonly tag: string | undefined; readonly lines: string[] } | null = null;
  let block: FencedBlock | null = null;
  let refusal: string | null = null;
  /*
    Set when a refusal marker was read whose OWN line carried nothing after it, so the
    reason may still arrive on a later line.

    Measured on four losing runs across three models, all
    ending the same way: the marker, a line break, then the explanation and the question.
    Every one of those runs did what plan mode asks and every one was scored as having said
    nothing, because this reader only ever looked at the remainder of the marker's own line.

    The #396 rule is unchanged — a marker with nothing after it ANYWHERE is still `absent`,
    since the convention exists so the run says what it lacks. Only where "after it" may be
    has moved. A fence does not answer for it either: prose is what is being waited for, and
    a run that followed its marker with a code block has still not said what is missing.
  */
  let awaitingReason = false;
  /*
    The lines that were never inside a fence, kept for the unfenced reading below.

    Collected here rather than re-scanned afterwards, and that is what makes the relaxed
    reading safe: a fence the model tagged for ANOTHER engine is rejected on purpose
    (`fencedBlock`), and a reader that went back over the whole text would find the SELECT
    inside that rejected fence and take it anyway — filing the model's MySQL as this
    connection's dialect, which is the exact mislabelling the rejection exists to prevent.
    Caught by the eval that pins it.
  */
  const plain: string[] = [];

  for (const line of text.split("\n")) {
    const marker = FENCE_LINE.exec(line);
    if (open !== null) {
      // Inside a fence NOTHING is prose — including a line that begins with the
      // refusal marker — so this branch comes before every other reading of the line.
      if (marker === null) open.lines.push(line);
      else {
        block = block ?? fencedBlock(open.tag, open.lines, dialect);
        open = null;
      }
      continue;
    }
    if (marker !== null) {
      const tag = marker[1].trim().toLowerCase();
      open = { tag: tag.length === 0 ? undefined : tag, lines: [] };
      continue;
    }
    if (refusal === null) {
      // Only the first: a run that states its refusal twice refused once.
      //
      // The marker ALONE is not a refusal (#396 review). The whole point of the
      // convention is that the run says what is missing and asks for it, and a bare
      // token says neither — accepting it would let the emptiest possible output pass
      // the very check that exists to stop a run being scored as answered when it
      // answered nothing. The bar is substantive text and deliberately not a question
      // mark: "Tell me which column records the rental price." is a proper request and
      // carries none.
      const refused = REFUSAL_LINE.exec(line);
      if (refused !== null) {
        const said = refused[1].trim();
        if (said.length > 0) refusal = said;
        else awaitingReason = true;
      } else if (awaitingReason && line.trim().length > 0) {
        refusal = line.trim();
        awaitingReason = false;
      }
    }
    plain.push(line);
  }
  if (open !== null) block = block ?? fencedBlock(open.tag, open.lines, dialect);

  if (refusal !== null) return { kind: "refusal", detail: refusal };
  if (block !== null) return { kind: "statement", sql: block.sql, tag: block.tag };

  // No fence anywhere, so the last chance is a statement the model wrote plainly. Read
  // only AFTER the fenced and refusal paths, which keeps every existing precedence
  // untouched: a fenced block still wins among several, and a refusal still wins over an
  // illustration the run declined to stand behind.
  const unfenced = unfencedStatement(plain);
  return unfenced === null ? { kind: "absent" } : { kind: "statement", sql: unfenced, tag: undefined };
}

/**
 * The statement in text that never opened a fence: from the first line that opens one to
 * the last line that still looks like part of it.
 *
 * Ends at the first BLANK line, because that is where these models put the explanation
 * they were also asked for, and carrying prose into the SQL would hand the editor
 * something no engine accepts. No tag is returned: the model named no fence, so there is
 * nothing it told us about the engine, and the recorder stamps the connection's own
 * dialect the way it does for an untagged fence.
 */
function unfencedStatement(lines: readonly string[]): string | null {
  const start = lines.findIndex((line) => STATEMENT_OPENER.test(line));
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim().length === 0) break;
    body.push(line);
  }
  const sql = body.join("\n").trim();
  return sql.length === 0 ? null : sql;
}
