/**
 * Which keyword a SQL statement leads with, ignoring whitespace and comments.
 *
 * Extracted from `lib/explain/select-prefix.ts`, which asked it to decide whether
 * a statement can be wrapped in an EXPLAIN. `lib/db` needs the same tolerance to
 * classify a statement before injecting a LIMIT, where getting it wrong is worse:
 * a comment-led SELECT reaches the server unbounded (#275). Neither layer can own
 * the primitive - `lib/db` importing from `lib/explain` inverts today's dependency
 * direction, and a second copy of the pattern below would eventually lose the
 * reasoning attached to it - so it lives here, beside the other dialect-agnostic
 * SQL-text utilities, with both layers above it. Callers: `lib/explain`'s prefix
 * classifier, `db/utils/query-limiter`'s statement typing and already-bounded
 * probes, `sql-base`'s read-only and schema-modifying predicates, and the MSSQL
 * `TOP` splice.
 *
 * The answer is deliberately NOT checked against a keyword list. Callers
 * disagree about the list - the query limiter cares about
 * SELECT/INSERT/UPDATE/DELETE/DDL/WITH while `isReadOnlyQuery` also counts SHOW,
 * DESCRIBE, EXPLAIN and PRAGMA - so this reports whichever word leads and leaves
 * the vocabulary to the caller.
 */

/** Where a statement's leading keyword is, and what it is. */
export interface LeadingKeyword {
  /**
   * The keyword, upper-cased so callers can compare without re-normalising.
   * The input's own spelling stays reachable by slicing with the offsets below.
   */
  keyword: string;
  /** Index of the keyword's first character in the input. */
  start: number;
  /** Index one past its last character, so `sql.slice(start, end)` is the keyword as written. */
  end: number;
}

/**
 * Leading whitespace and SQL comments, then the statement's first word.
 *
 * The SHAPE of the trivia part matters as much as what it accepts. Each of the
 * three alternatives sits inside a `*` quantifier, so any way of matching the
 * same text twice is a way for a NON-matching input to backtrack, and all three
 * had to be made unambiguous independently. Measured on this pattern's
 * predecessors in `lib/explain/select-prefix.ts`, with a tail that never reaches
 * a keyword:
 *
 * - No leading `\s*`. Whitespace is already an alternative below; having both
 *   gives two ways to match one run of spaces. Quadratic - 958ms on 20k leading
 *   spaces.
 * - Both line-comment forms are anchored to a newline OR end-of-input. Without
 *   that tail `[^\n]*` can give characters back and let a later iteration match
 *   `--` again, so a run of bare dashes partitions exponentially - 634ms on a
 *   FORTY-NINE character input, by far the cheapest of the three to trigger.
 *   Found by CodeQL (`js/redos`) after the other two were already fixed. A run of
 *   single `#` characters partitions even more freely than a run of `--` pairs, so
 *   the anchor is load-bearing there too.
 * - The block-comment body is TEMPERED (`[^*]|\*(?!\/)`) rather than a lazy
 *   `[\s\S]*?\*\/`, which inside a `*` quantifier can run past the first `*\/`
 *   and let one iteration swallow several comments - 852ms on a 4 KB run of
 *   `/**\/`.
 *
 * All three answer in well under a millisecond, and `leading-keyword.test.ts`
 * keeps them that way with a bounded-time guard. This is the same care that made
 * `db/utils/query-limiter.ts` hand-write its semicolon strip "without regex to
 * avoid ReDoS".
 *
 * The word itself adds no ambiguity: no trivia alternative can begin with a
 * letter or underscore, so the first one ends the trivia run outright. Consuming
 * the whole word is what makes `SELECTED` fail a caller's `=== "SELECT"` test,
 * the job `\b` did when this pattern named its keywords inline.
 *
 * `#` is here because it is MySQL's and MariaDB's second line-comment marker, and
 * leaving it out left #275's reported bug live on that provider: `# note` before a
 * SELECT is an ordinary annotation there, and an unrecognised one meant no LIMIT.
 * It is NOT a comment in PostgreSQL, Oracle, SQL Server or SQLite - but no
 * statement in those dialects can OPEN with `#` either, so skipping it changes
 * which syntax error the server reports and never a result set.
 */
const LEADING_KEYWORD = /^(?:\s|(?:--|#)[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*([A-Za-z_]\w*)/;

/**
 * The keyword this statement leads with, or `null` when it leads with none -
 * empty, whitespace only, comments only, an unterminated comment, or anything
 * that does not open with a word (a parenthesised SELECT, a bare expression).
 *
 * A comment is not a statement, so a comment on its own answers `null` rather
 * than reaching past itself for a keyword that is not there.
 */
export function readLeadingKeyword(sql: string): LeadingKeyword | null {
  const match = LEADING_KEYWORD.exec(sql);
  if (match === null) return null;

  const keyword = match[1];
  const end = match[0].length;

  return { keyword: keyword.toUpperCase(), start: end - keyword.length, end };
}
