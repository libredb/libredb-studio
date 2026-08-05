/**
 * Where the non-code runs of a SQL statement are: trivia and literals.
 *
 * Every reader in this folder that has to answer a question about a statement's
 * STRUCTURE - where its CTE list ends, where its text ends, where it splits -
 * first has to know which characters are code. A paren written inside a comment,
 * a semicolon inside a string and a keyword inside a quoted identifier all look
 * like code to a reader that only sees characters, and each one has already cost
 * this project a bug (#275, #280, #287).
 *
 * This is deliberately a character scanner rather than a regex. The regex shape
 * for the same job backtracks catastrophically over parenthesised bodies and
 * comment runs: `leading-keyword.ts` records three measured failures in its
 * predecessors (quadratic 958ms, quadratic 852ms, and exponential 634ms on a
 * FORTY-NINE character input, the last found by CodeQL), and
 * `db/utils/query-limiter.ts` hand-writes its semicolon strip for the same
 * reason. A scanner that advances one span at a time cannot backtrack at all.
 *
 * Two older readers in this folder overlap with it and are deliberately left
 * alone, because rewriting either changes behaviour this module is not chartered
 * to change:
 *
 * - `statement-splitter.ts` inlines the same scan, wound together with the line
 *   counting it needs, and treats `#` as ordinary code - so a MySQL hash comment
 *   containing a `;` still splits there. Reusing this module would move statement
 *   boundaries: a separate bug with its own tests.
 * - `alias-extractor.ts:134-135` blanks literals with a regex that honours
 *   BACKSLASH escapes, which this module reports as undeterminable instead (see
 *   `readQuoted`). Its job is autocomplete, where a wrong alias costs a
 *   suggestion; here a wrong literal boundary costs a bound on a write.
 *
 * This module is what every NEW reader builds on, so the count does not grow.
 */

/**
 * What kind of non-code run a span is.
 *
 * Callers care about the distinction in two ways: trivia (`whitespace`,
 * `line-comment`, `block-comment`) can be skipped between tokens, while a
 * literal is a token - a quoted identifier can BE a name, so a reader that
 * skipped it as trivia would misread `WITH "my cte" AS (…)`.
 */
export type SqlSpanKind =
  | "whitespace"
  | "line-comment"
  | "block-comment"
  | "string"
  | "quoted-identifier"
  | "dollar-string";

export interface SqlSpan {
  kind: SqlSpanKind;
  /** Index one past the span's last character, so `sql.slice(index, end)` is the span. */
  end: number;
  /**
   * Whether the span reached its closing delimiter.
   *
   * `false` means the input ended inside the span, and a caller that needs to
   * know what follows it cannot: there is no "what follows". Callers deciding
   * whether to REWRITE a statement must treat that as undeterminable rather than
   * guessing - see `operative-keyword.ts`, where the guess would be a bound
   * appended to a write.
   *
   * A line comment closed by the end of the input is `true`: end-of-input closes
   * it in every dialect, and nothing follows it to be wrong about.
   */
  terminated: boolean;
}

/** Whitespace as SQL counts it - the same set `String.prototype.trim` removes. */
function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** The characters that turn a `#` into a PostgreSQL operator rather than a comment. */
function isHashOperatorTail(ch: string | undefined): boolean {
  return ch === ">" || ch === "-" || ch === "#";
}

/**
 * The identifier alphabet, shared with `operative-keyword.ts` so the two readers
 * in one walk cannot disagree about what a name is.
 *
 * Deliberately not `\w`: an ASCII-only alphabet fails on ordinary localized names
 * (`WITH müşteri AS (SELECT 1) SELECT * FROM müşteri` is a plain read-only CTE),
 * and every name a reader cannot read costs its statement a bound. `$` is legal
 * inside identifiers in MySQL and after the first character in PostgreSQL, but it
 * is left OUT of these classes because it also closes a dollar-quote tag; the
 * caller that wants it adds it.
 */
export const IDENTIFIER_START = /[\p{L}\p{Nl}_]/u;
export const IDENTIFIER_PART = /[\p{L}\p{N}\p{Mn}\p{Pc}]/u;

/** Whether the delimiter at `at` is preceded by an odd number of backslashes. */
function hasOddBackslashRunBefore(sql: string, from: number, at: number): boolean {
  let backslashes = 0;
  let i = at - 1;
  while (i > from && sql[i] === "\\") {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

/**
 * A quoted run (`'…'`, `"…"`, `` `…` ``) where the delimiter is escaped by
 * doubling it.
 *
 * `backslashEscapes` marks the delimiters for which a preceding backslash MIGHT
 * also escape. Whether it does is a dialect setting rather than a property of the
 * text - MySQL escapes with backslashes by default, PostgreSQL does not unless the
 * literal is written `E'…'` - and the two readings put the end of the string in
 * different places, which then moves the end of every construct around it. So a
 * delimiter behind an odd backslash run is reported as UNDETERMINABLE instead of
 * guessed: `WITH t AS (SELECT '\') SELECT ') DELETE FROM users` reads as a SELECT
 * under one dialect and a DELETE under the other, and guessing the first would
 * append a bound to a DELETE. Callers already decline to rewrite what they cannot
 * read, so the cost of the safe answer is at most an unbounded read.
 */
function readQuoted(sql: string, index: number, quote: string, kind: SqlSpanKind, backslashEscapes: boolean): SqlSpan {
  let i = index + 1;

  while (i < sql.length) {
    if (sql[i] === quote) {
      // The backslash question is asked BEFORE the doubling rule, because the two
      // meet: `\''` is how a MySQL string ending in an apostrophe is written, and
      // testing the doubling first consumes both quotes and never reaches the
      // ambiguity. Asking first also makes the invariant provable - the two
      // readings can diverge ONLY at a delimiter behind an odd backslash run,
      // since everywhere else both consume identically and both honour doubling -
      // so `terminated: true` here is a dialect-independent answer.
      if (backslashEscapes && hasOddBackslashRunBefore(sql, index, i)) {
        return { kind, end: sql.length, terminated: false };
      }
      // A doubled delimiter is an escape, not the end. Reading it as the end is
      // how "find the next quote" scanners lose track of the rest of the
      // statement - and a run of quotes is ALL escapes, so it never closes.
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return { kind, end: i + 1, terminated: true };
    }
    i++;
  }

  return { kind, end: sql.length, terminated: false };
}

/**
 * The length of a PostgreSQL dollar-quote tag at `index` (`$$`, `$fn$`), or 0
 * when this `$` opens no tag.
 *
 * The tag body follows identifier rules - the same ones names follow, non-ASCII
 * included - which is what keeps a positional parameter (`$1`) and a bare `$` out
 * of it.
 */
function measureDollarTag(sql: string, index: number): number {
  let i = index + 1;

  if (sql[i] !== "$") {
    if (i >= sql.length || !IDENTIFIER_START.test(sql[i])) return 0;
    i++;
    while (i < sql.length && IDENTIFIER_PART.test(sql[i])) i++;
    if (sql[i] !== "$") return 0;
  }

  return i + 1 - index;
}

/**
 * The trivia or literal run starting at `index`, or `null` when code starts there
 * (including when `index` is past the end of the input).
 *
 * Callers walk a statement by asking at every position: is this a span? If yes,
 * jump to `end`; if no, this character is the statement's own code.
 */
export function readSqlSpan(sql: string, index: number): SqlSpan | null {
  const ch = sql[index];
  if (ch === undefined) return null;

  if (isWhitespace(ch)) {
    let end = index + 1;
    while (end < sql.length && isWhitespace(sql[end])) end++;
    return { kind: "whitespace", end, terminated: true };
  }

  // `#` is MySQL's and MariaDB's second line-comment marker. Unlike
  // `leading-keyword.ts`, which only ever looks at a statement's LEADING trivia,
  // this reader is asked about every position - and mid-statement `#` is a live
  // PostgreSQL operator: `#>` and `#>>` walk a jsonb path, `#-` deletes one, `##`
  // is geometric. Reading `SELECT meta #> '{a}'` as a comment swallows the rest of
  // the line and costs an everyday jsonb query its bound, so a `#` that opens one
  // of those operators is code.
  //
  // The trade is stated exactly, because this is the one place the module takes a
  // dialect's SIDE instead of reporting that the dialects disagree. A MySQL comment
  // whose first character is one of those (`#- note`) reads as code here, so the
  // rest of that line is read as SQL where MySQL reads it as comment - and if that
  // text contains a paren, the two readings end a construct in different places.
  // `WITH t AS (\n #- note )\n SELECT 1) DELETE FROM users` is a DELETE in MySQL and
  // reads as a SELECT here, which is the direction `operative-keyword.ts` otherwise
  // promises to avoid. Reporting it undeterminable would close that, at the price of
  // every PostgreSQL jsonb-operator CTE losing its bound: a certain cost against a
  // contrived one. So the reading stands, the gap is recorded rather than hidden
  // (`operative-keyword.ts`, and a test pins it), and `# note` - how comments are
  // actually written - is unaffected either way.
  if ((ch === "-" && sql[index + 1] === "-") || (ch === "#" && !isHashOperatorTail(sql[index + 1]))) {
    const newline = sql.indexOf("\n", index);
    // The newline belongs to the comment: it is what closes it.
    return { kind: "line-comment", end: newline === -1 ? sql.length : newline + 1, terminated: true };
  }

  if (ch === "/" && sql[index + 1] === "*") {
    const close = sql.indexOf("*/", index + 2);
    if (close === -1) return { kind: "block-comment", end: sql.length, terminated: false };
    return { kind: "block-comment", end: close + 2, terminated: true };
  }

  if (ch === "'") return readQuoted(sql, index, "'", "string", true);
  // `"` is a quoted identifier in every dialect this project supports except
  // MySQL with its default settings, where it is a string - and therefore takes
  // backslash escapes. Either way it is an opaque literal and the doubling rule is
  // the same, so one reading serves both.
  if (ch === '"') return readQuoted(sql, index, '"', "quoted-identifier", true);
  // Backticks are MySQL's identifier quotes. Without them a backtick-quoted CTE
  // name would read as undeterminable input and cost that statement its bound. No
  // dialect gives a backslash meaning inside them, so one before the closing
  // delimiter is simply part of the name.
  if (ch === "`") return readQuoted(sql, index, "`", "quoted-identifier", false);

  if (ch === "$") {
    const tagLength = measureDollarTag(sql, index);
    if (tagLength === 0) return null;

    const tag = sql.slice(index, index + tagLength);
    const close = sql.indexOf(tag, index + tagLength);
    if (close === -1) return { kind: "dollar-string", end: sql.length, terminated: false };
    return { kind: "dollar-string", end: close + tagLength, terminated: true };
  }

  return null;
}
