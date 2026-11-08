/**
 * Where a parenthesised run closes, remembered for every index a walk stood on, for a reader that crosses the same runs
 * again and again.
 *
 * The confirmation gate reads the CTE list of every `WITH` that opens a CTE body. Where such bodies nest, each list
 * holds the next one inside a parenthesised run, and crossing that run anew for every list crossed the innermost run
 * once per level: 65 s for 250,000 units of nested bodies, growing with the square of the text, and the same for a
 * Spark call whose name a run computes (`IDENTIFIER(...)(...)`) nested in another.
 *
 * Remembering is exact because a walk's next step depends only on the index it stands on: `readSqlSpan` reads the text
 * at that index and the characters before it, never the walk that got there. So where the walk from an index meets the
 * `)` of a run it did not open is a fact of that index, whoever asks and wherever their walk started, and the answer
 * kept for an index is the answer for every later walk that reaches it. Each index is read once, however many walks
 * cross it.
 */

import type { SqlGrammar } from "./grammar";
import { readSqlSpan } from "./spans";
import { readSqlWord } from "./words";

/**
 * How a walk steps over code that is no span.
 *
 * - `characters` - one character at a time: how `operative-keyword.ts` crosses a CTE body or a column list, and how
 *   `confirm-forms.ts` crosses the run of a computed call.
 * - `words` - a word (`readSqlWord`) at once, and any other character alone: how `operative-keyword.ts` crosses a run
 *   inside a CTE element that is an expression.
 *
 * The two disagree where a word holds a `$$`: the first walk reads a dollar-quoted run there and the second reads the
 * word whole, so each has its own answers.
 */
export type RunWalk = "characters" | "words";

/** No walk has stood on the index yet. */
const UNKNOWN = -2;

/**
 * An index's entry while its answer is the answer at another index, the next one its walk stood on: `-3 - next`. An
 * answer itself is -1 or an index, so the two never meet.
 */
function pointerTo(next: number): number {
  return -3 - next;
}

export class ParenthesisedRuns {
  /**
   * For each index a walk stood on, where the walk from it at depth 0 first meets a `)` it did not open: the index past
   * it, or -1 when the text ends first or a span on the way never closes. Until that is found, the entry points to the
   * next index the walk stood on (`pointerTo`), whose answer it shares.
   */
  private closes: Int32Array | undefined;

  constructor(
    private readonly sql: string,
    private readonly grammar: SqlGrammar,
    private readonly walk: RunWalk,
  ) {}

  /**
   * The index past the `)` that closes the run opening at `open`, a `(` the walk reads as code, or -1 when the run
   * never closes: the text ends first, or a span inside the run never closes.
   */
  closeOf(open: number): number {
    return this.closeFrom(open + 1);
  }

  private closeFrom(from: number): number {
    const sql = this.sql;
    this.closes ??= new Int32Array(sql.length + 1).fill(UNKNOWN);
    const closes = this.closes;
    // The `(` of every run the walk is inside, innermost last: each one's answer is the answer past its run's close.
    const runs: number[] = [];
    let at = from;

    for (;;) {
      let close: number;
      if (closes[at] !== UNKNOWN) {
        close = this.answerAt(at);
      } else {
        const span = at < sql.length ? readSqlSpan(sql, at, this.grammar) : null;
        if (at >= sql.length || (span !== null && !span.terminated)) {
          close = -1;
        } else if (span !== null) {
          closes[at] = pointerTo(span.end);
          at = span.end;
          continue;
        } else if (sql[at] === ")") {
          close = at + 1;
        } else if (sql[at] === "(") {
          runs.push(at);
          at += 1;
          continue;
        } else {
          const next = this.walk === "words" ? (readSqlWord(sql, at)?.end ?? at + 1) : at + 1;
          closes[at] = pointerTo(next);
          at = next;
          continue;
        }
        closes[at] = close;
      }

      // `close` closes the innermost run the walk is inside, and past it the walk goes on as that run's `(` does. A run
      // that never closes leaves every run around it unclosed too.
      const open = runs.pop();
      if (open === undefined) return close;
      if (close === -1) {
        closes[open] = -1;
        for (const outer of runs) closes[outer] = -1;
        return -1;
      }
      closes[open] = pointerTo(close);
      at = close;
    }
  }

  /** The answer at an index a walk stood on, following its pointers and pointing every index on the way at it. */
  private answerAt(index: number): number {
    const closes = this.closes as Int32Array;
    let last = index;
    while (closes[last] <= -3) last = -3 - closes[last];
    const answer = closes[last];
    let at = index;
    while (at !== last) {
      const next = -3 - closes[at];
      closes[at] = answer;
      at = next;
    }
    return answer;
  }
}
