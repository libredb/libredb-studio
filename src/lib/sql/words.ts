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

import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "./grammar";
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
 *
 * So a caller that must not be silent about such text asks about it separately
 * rather than reading this reader's `null` as "the word is not there": the
 * confirmation gate calls `hasUnterminatedSpan` and prompts on it (#297). This
 * reader's answer stays what it is - where the word was FOUND - because the readers
 * that walk a statement to rewrite it need exactly that.
 *
 * WHICH runs are not code is the dialect's answer for one character: a write
 * written after a `#` is commented out in MySQL and the statement's own code in
 * PostgreSQL, and the safety predicate above this reader has to prompt in the
 * second case and not the first (#292). Omitting `grammar` keeps the reading a
 * dialect-less call always had.
 */
export function findCodeWord(
  sql: string,
  word: string,
  from = 0,
  grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR,
): CodeWord | null {
  const target = word.toUpperCase();
  let i = from;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
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

/** What `indexCodeWords` collects in its one walk. Every word and prefix is upper-cased, as `readSqlWord` reports one. */
export interface CodeWordQuery {
  /** The words whose every code occurrence the index lists. */
  readonly words: ReadonlySet<string>;
  /** The prefixes the index tells whether some code word starts with. */
  readonly prefixes: readonly string[];
  /** Whether the index lists the closed quoted identifiers too, for a reader of quoted names called as functions. */
  readonly quotedIdentifiers: boolean;
}

/** The answers of one walk to a `CodeWordQuery`. Asking it about anything the query did not name throws. */
export interface CodeWordIndex {
  /**
   * Where `word` appears in the code at or after `from`, or `null`: what `findCodeWord(sql, word, from, grammar)`
   * answers, for a `from` that is 0 or the end of a code word this index found. Those are positions the walk stands on;
   * from any other one `findCodeWord` walks differently, so a caller holding such a position asks `findCodeWord`.
   */
  find(word: string, from?: number): CodeWord | null;
  /** Every code occurrence of `word`, in text order. */
  occurrences(word: string): readonly CodeWord[];
  /** Whether some code word starts with `prefix`. */
  startsWith(prefix: string): boolean;
  /** Every closed quoted identifier the walk crossed, its quotes included, in text order. */
  quotedIdentifiers(): readonly CodeWord[];
}

const NO_WORDS: readonly CodeWord[] = [];

class IndexedCodeWords implements CodeWordIndex {
  constructor(
    private readonly query: CodeWordQuery,
    private readonly found: ReadonlyMap<string, readonly CodeWord[]>,
    private readonly prefixed: ReadonlySet<string>,
    private readonly quoted: readonly CodeWord[],
  ) {}

  find(word: string, from = 0): CodeWord | null {
    const list = this.occurrences(word);
    // The first occurrence that starts at or after `from`, found by halving: the list is in text order.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle].start < from) low = middle + 1;
      else high = middle;
    }
    return list[low] ?? null;
  }

  occurrences(word: string): readonly CodeWord[] {
    if (!this.query.words.has(word)) throw new Error(`The code word index was not asked about ${word}.`);
    return this.found.get(word) ?? NO_WORDS;
  }

  startsWith(prefix: string): boolean {
    if (!this.query.prefixes.includes(prefix)) {
      throw new Error(`The code word index was not asked about the prefix ${prefix}.`);
    }
    return this.prefixed.has(prefix);
  }

  quotedIdentifiers(): readonly CodeWord[] {
    if (!this.query.quotedIdentifiers) throw new Error("The code word index was not asked about quoted identifiers.");
    return this.quoted;
  }
}

/**
 * The code words of `sql` that `query` names, read in one walk, for a reader with many questions about one text.
 *
 * The walk is `findCodeWord`'s from the start of the text, so the occurrences of a word are, in order, exactly what
 * `findCodeWord` finds for it from 0 and then from the end of each occurrence, and the quoted identifiers are the ones a
 * reader walking the same way crosses. A reader that asked `findCodeWord` once per word walked the text once per word:
 * the confirmation gate asks about some sixty words of one Snowflake text, and a 1,000,000-unit text cost it more than a
 * second.
 */
export function indexCodeWords(
  sql: string,
  query: CodeWordQuery,
  grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR,
): CodeWordIndex {
  const found = new Map<string, CodeWord[]>();
  const prefixed = new Set<string>();
  const quoted: CodeWord[] = [];
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span !== null) {
      if (query.quotedIdentifiers && span.kind === "quoted-identifier" && span.terminated) {
        quoted.push({ start: i, end: span.end });
      }
      i = span.end;
      continue;
    }

    const word = readSqlWord(sql, i);
    if (word === null) {
      i++;
      continue;
    }
    if (query.words.has(word.text)) {
      const list = found.get(word.text);
      if (list === undefined) found.set(word.text, [{ start: i, end: word.end }]);
      else list.push({ start: i, end: word.end });
    }
    for (const prefix of query.prefixes) {
      if (word.text.startsWith(prefix)) prefixed.add(prefix);
    }
    i = word.end;
  }

  return new IndexedCodeWords(query, found, prefixed, quoted);
}
