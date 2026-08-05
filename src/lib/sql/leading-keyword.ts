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

import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "./grammar";
import { readSqlSpan, type SqlSpanKind } from "./spans";

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
 * Whether a span is trivia the keyword can sit behind.
 *
 * Whitespace and comments are; a literal, a quoted name and a bracketed run are
 * the statement's own text, so the scan STOPS at one rather than stepping over it
 * looking for a word. Skipping them instead would report `UPDATE` as the leading
 * keyword of `'x' UPDATE t SET …`.
 */
function isLeadingTrivia(kind: SqlSpanKind): boolean {
  return kind === "whitespace" || kind === "line-comment" || kind === "block-comment";
}

/**
 * Whitespace as this reader counts it, which is JS `\s` and therefore WIDER than the
 * ASCII set `spans.ts` reads as a whitespace span.
 *
 * The pattern this scan replaced used `\s`, and the compatibility rule is reason
 * enough on its own: with `\s` tested per character, this scan answers what that
 * pattern answered, for every input.
 *
 * One engine makes the narrower alphabet cost something real rather than merely
 * differ, which is why the rule is stated here rather than quietly dropped: on a
 * `latin1` connection MySQL reads byte 0xA0 as a space and RUNS the statement behind
 * it - verified on MySQL 26.7 through this repo's own mysql2, where a leading U+00A0
 * before `SELECT 2` returns a row under `charset=latin1` and is rejected under the
 * `utf8mb4` this provider negotiates by default. A connection string selects that
 * charset (`mysql.ts`'s `buildPoolConfig` hands the URI straight to mysql2), so the
 * case is reachable rather than theoretical, and the cost would be a bound lost on an
 * ordinary read and the confirmation prompt taken off a leading-U+00A0
 * `DROP TABLE users` that the server still executes. U+2028, U+3000 and a BOM were
 * rejected on every charset tried, and PostgreSQL 18 rejects all four - they are here
 * for the compatibility rule alone.
 *
 * Applied one character at a time, so it carries no quantifier and cannot backtrack.
 */
const UNICODE_SPACE = /\s/;

/** Whether `ch` can open a keyword, i.e. `/[A-Za-z_]/`. */
function isKeywordStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

/** Whether `ch` continues one, i.e. `/\w/`. */
function isKeywordPart(ch: string): boolean {
  return isKeywordStart(ch) || (ch >= "0" && ch <= "9");
}

/**
 * The trivia grammar this reader applies, which is the caller's with one
 * deliberate override.
 *
 * `#` in LEADING position is read as a comment on every dialect, including the
 * ones where `#` is code (`#tmp` is a T-SQL temp table, `ID#` an Oracle
 * identifier, `#id` a SQLite bind variable, `#>` a PostgreSQL operator). No
 * dialect here can OPEN a statement with one, so skipping the run costs nothing
 * anywhere and keeps every dialect's `# note`-led statement classified - which is
 * what #275 fixed and what the provider suites pin. Reading it as the dialect
 * would take those bounds back off, so this override is the same decision the
 * previous reading made, now stated instead of implied (#292 left this reader
 * alone for exactly this reason).
 *
 * Every other fact is the caller's: where a block comment ENDS is the dialect's
 * answer (#300), and so is whether a `q'…'` tag or a bracketed run is a literal,
 * because the scan has to stop at one of those and stopping in the wrong place
 * reports a word from inside a literal.
 */
function leadingTriviaGrammar(grammar: SqlGrammar): SqlGrammar {
  return grammar.hash === "comment" ? grammar : { ...grammar, hash: "comment" };
}

/**
 * The keyword this statement leads with, or `null` when it leads with none -
 * empty, whitespace only, comments only, an unterminated comment, or anything
 * that does not open with a word (a parenthesised SELECT, a bare expression, a
 * literal).
 *
 * A comment is not a statement, so a comment on its own answers `null` rather
 * than reaching past itself for a keyword that is not there.
 *
 * `grammar` is the dialect's reading of the characters the engines disagree about;
 * omitting it means no dialect was named and applies the compatibility default.
 * It matters here because where a comment ENDS is one of those disagreements: a
 * dialect that nests block comments keeps reading past the `*\/` a flat reading
 * stops at, so the word a flat reading reports can be one the operator commented
 * out - and this reader is what the confirmation gate and the query limiter type a
 * statement by (#300).
 *
 * The trivia scan is `readSqlSpan`'s, so this reader and the ones that walk the
 * rest of the statement cannot disagree about a comment. It used to be a regex
 * whose own trivia grammar was hard-coded, and the SHAPE of that pattern was
 * load-bearing: each of its three alternatives sat inside a `*` quantifier, so any
 * way of matching the same text twice was a way for a NON-matching input to
 * backtrack. All three were measured on its predecessors in
 * `lib/explain/select-prefix.ts`, with a tail that never reaches a keyword:
 *
 * - No leading `\s*` beside a `\s` alternative - two ways to match one run of
 *   spaces. Quadratic: 958ms on 20k leading spaces.
 * - Both line-comment forms anchored to a newline OR end-of-input. Without that
 *   tail `[^\n]*` could give characters back and let a later iteration match `--`
 *   again, so a run of bare dashes partitioned exponentially: 634ms on a
 *   FORTY-NINE character input, found by CodeQL (`js/redos`) after the other two
 *   were fixed.
 * - A TEMPERED block-comment body (`[^*]|\*(?!\/)`) rather than a lazy
 *   `[\s\S]*?\*\/`, which inside a `*` quantifier could run past the first `*\/`
 *   and swallow several comments: 852ms on a 4 KB run of `/**\/`.
 *
 * None of that risk transfers to a scanner: it advances one span or one character
 * at a time and cannot backtrack at all. The reasoning is kept because it is why
 * the replacement may not be a regex again, and `leading-keyword.test.ts` keeps
 * its bounded-time guard on both readings - the flat one and the nesting one,
 * whose depth count is the new thing that could have made this quadratic.
 */
export function readLeadingKeyword(sql: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): LeadingKeyword | null {
  const triviaGrammar = leadingTriviaGrammar(grammar);
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, triviaGrammar);
    if (span === null) {
      // Code, unless it is whitespace this module counts and the span reader does
      // not - see `UNICODE_SPACE`.
      if (!UNICODE_SPACE.test(sql[i])) break;
      i++;
      continue;
    }
    // A comment or literal that never closes: there is no "what follows it" to
    // read a keyword out of, which is the answer the pattern before this gave too.
    if (!isLeadingTrivia(span.kind) || !span.terminated) return null;
    i = span.end;
  }

  const first = sql[i];
  if (first === undefined || !isKeywordStart(first)) return null;

  let end = i + 1;
  while (end < sql.length && isKeywordPart(sql[end])) end++;

  // Consuming the whole word is what makes `SELECTED` fail a caller's
  // `=== "SELECT"` test, the job `\b` did when this was a pattern. The alphabet
  // stays ASCII - deliberately narrower than `spans.ts`'s identifier classes -
  // because every keyword any caller here tests for is ASCII, and a statement
  // opening with a localized identifier is not a keyword under either alphabet.
  return { keyword: sql.slice(i, end).toUpperCase(), start: i, end };
}
