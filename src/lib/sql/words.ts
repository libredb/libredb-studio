/**
 * Where a SQL statement's own code WORDS are.
 *
 * `spans.ts` answers where a statement's non-code runs are - trivia and literals -
 * and this is the complement every reader above it needs: a word is only the
 * statement's if it is not inside one of those runs. Splitting them this way is what
 * lets `readSqlWord` be shared by the readers that walk a statement token by token
 * (`operative-keyword.ts`) and by the ones that only need to know whether a word is
 * present at all.
 *
 * `findCodeWord` exists because the alternative - `/\bWORD\b/i` over the whole text
 * - answers for a word the statement merely MENTIONS. That is the same defect this
 * folder has now fixed four times over (#275, #280, #287, #294): a keyword inside a
 * comment, a string or a quoted identifier is not the statement doing it. It is also
 * measurably cheaper on the shapes that matter: the pattern it replaced in the
 * dangerous-query predicate, `/\bUPDATE\b[\s\S]*?\bSET\b/i`, restarts its lazy tail
 * at every `UPDATE` in the input and took 1025ms on 140 KB of them (guarded in
 * `tests/components/QuerySafetyDialog.test.tsx`), while a scan that advances one span
 * or one word at a time cannot backtrack at all.
 */

import { IDENTIFIER_PART, IDENTIFIER_START, readSqlSpan } from "./spans";

/** A word (identifier or keyword) and where it ends. */
export interface SqlWord {
  /**
   * The word, upper-cased so callers can compare without re-normalising. The
   * input's own spelling stays reachable by slicing up to `end`.
   */
  text: string;
  /** Index one past its last character. */
  end: number;
}

/**
 * The word at `index`, or `null` when one does not start there.
 *
 * A word runs over the shared identifier alphabet, plus `$` after the first
 * character: it is legal inside a MySQL identifier and after the first character in
 * PostgreSQL. It stays out of the START position so a dollar-quoted string is still
 * read as the literal it is.
 */
export function readSqlWord(sql: string, index: number): SqlWord | null {
  if (index >= sql.length || !IDENTIFIER_START.test(sql[index])) return null;

  let end = index + 1;
  while (end < sql.length && (IDENTIFIER_PART.test(sql[end]) || sql[end] === "$")) end++;

  // Upper-cased for the keyword comparisons callers make. Every keyword read
  // through this module is ASCII, so the locale-independent mapping is all it needs.
  return { text: sql.slice(index, end).toUpperCase(), end };
}

/** Where a word the statement's code contains begins and ends. */
export interface CodeWord {
  start: number;
  end: number;
}

/**
 * Where `word` appears in this statement's CODE at or after `from`, or `null`.
 *
 * Whole words only - `UPDATED` and `xUPDATE` are not `UPDATE` - and `word` may be
 * written in any case.
 *
 * An undeterminable literal or comment (`spans.ts` reports one as reaching the end
 * of the input) therefore hides whatever follows it, which for a caller asking "does
 * this statement write?" is the unhelpful direction. It is left where `spans.ts`
 * decided it: the two dialect readings of `'\'` put the end of the string in
 * different places, the text is a syntax error under one of them, and guessing here
 * would answer for words inside a literal under the other. Pinned by a test in
 * `tests/unit/sql/words.test.ts`.
 */
export function findCodeWord(sql: string, word: string, from = 0): CodeWord | null {
  const target = word.toUpperCase();
  let i = from;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i);
    if (span !== null) {
      i = span.end;
      continue;
    }

    const found = readSqlWord(sql, i);
    if (found === null) {
      i++;
      continue;
    }
    if (found.text === target) return { start: i, end: found.end };
    i = found.end;
  }

  return null;
}
