/**
 * Whether a statement carries a comment the ENGINE acts on (#373 review).
 *
 * Every other reader in this folder skips comments as trivia, and every one of them
 * is right to: a comment changes nothing about what a statement does. Except when it
 * does. Three forms in the dialects this repository serves are read by the server
 * rather than discarded by it:
 *
 * - `/*+ … *\/` — an optimizer hint. `pg_hint_plan` (PostgreSQL), Oracle and MySQL 8
 *   all spell it this way, and it FORCES a plan: `/*+ SeqScan(orders) *\/` turns the
 *   cheap indexed plan the planner would have chosen into a sequential scan.
 * - `--+ …` — Oracle's line form of the same thing.
 * - `/*! … *\/` — MySQL's and MariaDB's conditional-execution comment, whose body the
 *   server executes. It is not a comment at all; it is code every other engine
 *   happens to ignore.
 *
 * The predicate is deliberately a PRESENCE test rather than an extraction. Its one
 * caller (`heldPlanFor` in `src/lib/agent/tools.ts`) uses it to refuse a canonical
 * join, and for that decision "this statement carries a directive" is the whole of
 * what needs answering — what the directive SAYS would only matter to a caller that
 * intended to honour it.
 *
 * It reads spans rather than matching text, which is the only way to get the answer
 * right: the characters that open a hint are ordinary characters inside a string
 * literal or a quoted name (`SELECT '/*+ SeqScan(t) *\/'` carries no hint), and this
 * folder already owns the reader that knows the difference.
 *
 * The escaped comment delimiters above are an artifact of writing SQL comments inside
 * a JSDoc block; the real syntax has no backslash.
 */

import { DEFAULT_SQL_GRAMMAR } from "./grammar";
import { readSqlSpan } from "./spans";

/**
 * What a comment must open with to be a directive rather than trivia, per span kind.
 *
 * A record rather than a flat list so a new marker cannot be added without saying
 * which comment form it belongs to — `--+` is a hint and `/*-` is not, and one list
 * of suffixes would have lost that.
 */
const DIRECTIVE_MARKERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "block-comment": Object.freeze(["/*+", "/*!"]),
  "line-comment": Object.freeze(["--+"]),
});

/**
 * True when `sql` carries at least one comment the engine reads as an instruction.
 *
 * Unterminated spans answer true as readily as closed ones: the reader reports where
 * the run ended, the opening characters are all this asks about, and refusing text
 * nobody can finish parsing is the safe direction anyway.
 */
export function hasOptimizerHint(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, DEFAULT_SQL_GRAMMAR);
    if (span === null) {
      index += 1;
      continue;
    }
    const markers = DIRECTIVE_MARKERS[span.kind];
    if (markers !== undefined && markers.some((marker) => sql.startsWith(marker, index))) return true;
    index = span.end;
  }
  return false;
}
