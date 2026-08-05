/**
 * Where a SQL statement's own text ends.
 *
 * Everything a statement carries after its last code character - whitespace, line
 * comments, block comments and the terminating semicolon - is trivia. The query
 * limiter used to have no notion of it at all, and that broke it in both
 * directions at once (#280):
 *
 * - Appending ` LIMIT n` after a trailing line comment put the bound INSIDE the
 *   comment. The engine ran the statement unbounded while the caller was handed
 *   `wasLimited: true`, so the UI reported a capped result set over a full table
 *   scan - the one shape worse than not limiting, because it stops the warning.
 * - Reading an existing bound off the same text made a commented-out one look
 *   real (`SELECT … -- LIMIT 10`), so nothing was injected and the statement ran
 *   unbounded again.
 *
 * One reading serves both: the placement inserts at this index and re-attaches
 * what follows, and the "already bounded" probes read only what precedes it. Two
 * notions of the end is what produced the pair of defects above, and it is also
 * what would make an intermediate state dangerous - a bound placed before a
 * comment while the probes still read past it collects a SECOND bound, which is
 * a syntax error rather than merely too many rows.
 *
 * The one place the two do differ is whether the end may be CUT, which is a
 * separate answer on the result rather than a separate reading - see
 * `rewritable`.
 *
 * A character scanner over `spans.ts`, not a regex, for the reason that module
 * documents: the pattern shape for "everything up to the trailing comment"
 * backtracks catastrophically, and `leading-keyword.ts` records three measured
 * failures of exactly that kind.
 */

import { DEFAULT_SQL_GRAMMAR, hashRunIsAmbiguous, type SqlGrammar } from "./grammar";
import { readSqlSpan, type SqlSpanKind } from "./spans";

export interface StatementEnd {
  /**
   * The index past the statement's last code character: `sql.slice(0, end)` is
   * the statement's own text and `sql.slice(end)` is its trailing trivia and
   * terminator, so the two halves always rejoin to the input exactly.
   */
  end: number;
  /**
   * Whether text may be INSERTED at `end`.
   *
   * `false` means the index is not one the statement may be split at - either
   * because the scan could not settle where the statement ends, or because it
   * settled somewhere only one dialect agrees with. The `end` above is then the
   * terminator strip: trailing whitespace and semicolons removed and nothing
   * else, which is what this module's callers read before it existed (their old
   * helper stopped after the first run of `;`, so `LIMIT 10 ; ;` reads one
   * character further here - in the direction that finds the bound rather than
   * doubling it). So a refused cut costs a caller nothing it used to have: its
   * probes see the text they always saw, and only the rewrite is declined.
   *
   * The two answers are separate because the risks are: a probe reading the
   * wrong text at worst reports a bound that is not there (and the caller then
   * leaves the statement alone), while a clause inserted at the wrong index
   * lands in the middle of the statement and the server rejects it outright.
   */
  rewritable: boolean;
}

/** The index past the last character that is neither whitespace nor `;`. */
function endBeforeTerminator(sql: string): number {
  let end = sql.length;
  while (end > 0 && (isTrailingSpace(sql[end - 1]) || sql[end - 1] === ";")) end--;
  return end;
}

/** Whitespace as the terminator strip counts it, matching `String.prototype.trim`. */
function isTrailingSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/**
 * Whether a span is the statement's own text rather than trivia between tokens.
 *
 * Everything but a comment and whitespace is: a literal, a quoted name and a
 * bracketed subscript are all tokens the statement is made of, so the end has to
 * advance past them. Reading one as trivia would leave the end at the last code
 * character BEFORE it, and the insert-before-trivia rewrite then splices the bound
 * into the middle of the statement - `SELECT [1,2]` emitted as
 * `SELECT LIMIT 500 [1,2]`, `SELECT m['k']` as `SELECT m LIMIT 500['k']` - a
 * corrupted statement rather than a missed bound. Both examples END with the run on
 * purpose: with code after it the end reaches the same index under either reading,
 * which is why the fixtures that pin this all end with the run.
 */
function isStatementText(kind: SqlSpanKind): boolean {
  return kind === "string" || kind === "quoted-identifier" || kind === "dollar-string" || kind === "subscript";
}

/**
 * Where this statement ends, and whether a clause may be inserted there.
 *
 * A semicolon does not advance the end - it terminates the statement rather than
 * belonging to it - but a semicolon with code after it does, since what follows
 * is another statement rather than trivia. Splitting statements is
 * `statement-splitter.ts`'s job; this reader only has to find the LAST end.
 *
 * Two shapes answer `rewritable: false`, and both then report the terminator
 * strip as their end:
 *
 * 1. **A span that never closes** - an unterminated block comment or literal, or
 *    a quote behind an odd backslash run, which `spans.ts` reports as
 *    undeterminable because MySQL escapes with backslashes and PostgreSQL does
 *    not, so the two readings end the statement in different places. (A `$` in a
 *    bare identifier reaches this too: `a$b$c` opens a dollar-quote tag that
 *    never closes.) Inserting on a guess emits `… 'O\'Brien'; LIMIT 500`, a bound
 *    after the statement's own `;`, which is a syntax error rather than too many
 *    rows.
 * 2. **A `#` line comment in the trailing run, and ONLY where no dialect was
 *    named.** `#` is a comment marker in MySQL, MariaDB and ClickHouse and
 *    ordinary code in the rest - `#tmp` is a T-SQL temp table, `ID#` a legal
 *    Oracle identifier, `flags # 5` a PostgreSQL XOR, `#id` a SQLite bind
 *    variable - and nothing in the TEXT tells the two apart (`#note` and `#tmp`
 *    are the same characters). Cutting on the wrong one emits
 *    `SELECT * FROM LIMIT 500 #tmp`. A caller that names its dialect has told
 *    them apart, so this refusal applies to the dialect-less reading alone
 *    (#292); there the `#` run is reported as part of the statement rather than
 *    trimmed off it, because the reading that costs least when wrong is the
 *    LONGER one: a bound written after a `#` is then still found
 *    (`… FROM #tmp ORDER BY id FETCH NEXT 10 ROWS ONLY` is a bounded T-SQL page,
 *    and a caller that could not see that bound would add a second), while the
 *    opposite mistake only reports a bound the caller responds to by leaving the
 *    statement alone - which is what it does here anyway.
 *
 * A `#` comment with code after it on a later line is unaffected: the end then
 * advances past it, and inserting at the end of the statement is correct under
 * both readings.
 */
export function readStatementEnd(sql: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): StatementEnd {
  let end = 0;
  let i = 0;
  // Whether the run since the last code character contains a `#` line comment
  // whose meaning is undecided. Under a named dialect there is nothing to be
  // wrong about: the comment is a comment (cut before it) or the run is the
  // statement's own code (the end has already advanced past it).
  let hashInTrailingRun = false;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);

    if (span !== null) {
      if (!span.terminated) return { end: endBeforeTerminator(sql), rewritable: false };
      // A literal is the statement's own text; trivia is not. Both are skipped
      // whole, which is what keeps a `;` or a `--` written inside one from
      // looking like the end of the statement.
      if (isStatementText(span.kind)) {
        end = span.end;
        hashInTrailingRun = false;
      } else if (span.kind === "line-comment" && sql[i] === "#" && hashRunIsAmbiguous(grammar)) {
        hashInTrailingRun = true;
      }
      i = span.end;
      continue;
    }

    if (sql[i] !== ";") {
      end = i + 1;
      hashInTrailingRun = false;
    }
    i++;
  }

  if (hashInTrailingRun) return { end: endBeforeTerminator(sql), rewritable: false };

  return { end, rewritable: true };
}
