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
 *   counting it needs, and knows none of the dialect facts below: it treats `#`
 *   as ordinary code, so a MySQL hash comment containing a `;` still splits there;
 *   it has no alternate-quoting branch, so an Oracle `q'{a'b;c}'` body splits
 *   at that `;`; and it has no bracket branch of either kind, so a `;` inside a
 *   bracket-quoted NAME (`SELECT [a;b] FROM t`, verified) splits one statement into
 *   two while every reader over this module sees one name. The bracket fact's
 *   SUBSCRIPT half escapes it only where the key is STRING-quoted, and by luck
 *   rather than by design: the splitter reads `'…'` and `"…"` but not backticks, so
 *   `SELECT arr[\`a;b\`] FROM t` splits there exactly as the bracketed name does.
 *   All three divergences are safe in the same direction - the fragments lose a
 *   bound rather than gaining a misplaced one - and reusing this module would move
 *   statement boundaries: a separate bug with its own tests.
 * - `alias-extractor.ts:134-135` blanks literals with a regex that honours
 *   BACKSLASH escapes, which this module reports as undeterminable instead (see
 *   `readQuoted`). Its job is autocomplete, where a wrong alias costs a
 *   suggestion; here a wrong literal boundary costs a bound on a write.
 *
 * This module is what every NEW reader builds on, so the count does not grow.
 *
 * Where the dialects genuinely disagree about a character, the reading comes from
 * the caller's grammar record (`grammar.ts`) rather than from this file taking one
 * engine's side. A call that names no dialect keeps the reading this module had
 * before the record existed.
 */

import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "./grammar";

/**
 * What kind of non-code run a span is.
 *
 * Callers care about the distinction in two ways: trivia (`whitespace`,
 * `line-comment`, `block-comment`) can be skipped between tokens, while the rest
 * are the statement's own text - a quoted identifier can BE a name, so a reader
 * that skipped it as trivia would misread `WITH "my cte" AS (…)`, and a
 * `subscript` sits in the middle of an expression, so a reader that took it for
 * trivia would place the statement's end before it.
 */
export type SqlSpanKind =
  | "whitespace"
  | "line-comment"
  | "block-comment"
  | "string"
  | "quoted-identifier"
  | "dollar-string"
  | "subscript";

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
 * Whether a line comment opens at `index`.
 *
 * `--` opens one in every dialect here and needs no grammar. `#` is the one this
 * module could not answer on its own, so it asks the grammar record: MySQL and
 * ClickHouse open a comment on any `#`, PostgreSQL, Oracle, SQL Server and SQLite
 * open none, and a caller that named no dialect keeps the hybrid reading this
 * module used to apply to everyone (see `DEFAULT_SQL_GRAMMAR`).
 */
function opensLineComment(sql: string, index: number, grammar: SqlGrammar): boolean {
  const ch = sql[index];
  if (ch === "-") return sql[index + 1] === "-";
  if (ch !== "#") return false;
  if (grammar.hash === "code") return false;
  if (grammar.hash === "comment") return true;
  return !isHashOperatorTail(sql[index + 1]);
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
 * append a bound to a DELETE. The callers that REWRITE a statement decline to,
 * so the cost there is at most an unbounded read.
 *
 * Since #297 it costs one thing more, and this rule is where the cost is largest:
 * the confirmation gate asks about text it cannot resolve rather than staying
 * silent, and `\'` is MySQL's own escape for an apostrophe, so an everyday read
 * (`… WHERE name = 'O\'Brien'`) prompts on every execute. Naming the dialect does
 * not narrow it, because whether `\` escapes is deliberately not one of the facts
 * `grammar.ts` carries yet.
 */
/**
 * A `[…]` quoted identifier, whose closing bracket is escaped by doubling.
 *
 * Separate from `readQuoted` because that reader's delimiter opens and closes the
 * span, and reusing it would read `[` as the closer too. No dialect gives a
 * backslash meaning inside these, so one before the closing bracket is part of the
 * name.
 */
function readBracketed(sql: string, index: number): SqlSpan {
  let i = index + 1;

  while (i < sql.length) {
    if (sql[i] === "]") {
      // A doubled closing bracket is how SQL Server writes a `]` inside a name.
      if (sql[i + 1] === "]") {
        i += 2;
        continue;
      }
      return { kind: "quoted-identifier", end: i + 1, terminated: true };
    }
    i++;
  }

  return { kind: "quoted-identifier", end: sql.length, terminated: false };
}

/**
 * A `[…]` array literal or subscript, which NESTS and escapes nothing.
 *
 * The other reading of these characters (`readBracketed`) is a name, and the two
 * disagree about the same text in both directions, which is why the grammar record
 * picks between them rather than one scan trying to serve both: a `]` written
 * inside a string ends a NAME (that is the whole point of `[a--b]`) and does not
 * end a subscript, and a doubled `]` escapes inside a name and closes a nested
 * array. Reaching into `readSqlSpan` for what a run CONTAINS is safe here for the
 * same reason it would be wrong there - a subscript's contents are code, a name's
 * are characters of the name.
 *
 * Depth is counted rather than matched, and both brackets are consumed before the
 * span reader is asked, so the recursion is exactly one level deep and the scan
 * still advances one span or one character at a time - it cannot backtrack.
 */
function readSubscripted(sql: string, index: number, grammar: SqlGrammar): SqlSpan {
  let depth = 0;
  let i = index;

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "]") {
      depth--;
      i++;
      if (depth === 0) return { kind: "subscript", end: i, terminated: true };
      continue;
    }

    const inner = readSqlSpan(sql, i, grammar);
    if (inner !== null) {
      // A run cannot be more certain than what it contains: an unterminated literal
      // inside means the closing bracket cannot be found, only guessed at, and a
      // guess here puts the statement's end inside a literal. Every span kind in
      // this module currently ends an unterminated run at the input's end, so
      // falling through the loop would reach the same record - this says the reason
      // locally rather than resting on that coincidence, and it is what keeps the
      // answer right if a future span kind ever ends BEFORE the input does.
      if (!inner.terminated) return { kind: "subscript", end: sql.length, terminated: false };
      i = inner.end;
      continue;
    }
    i++;
  }

  return { kind: "subscript", end: sql.length, terminated: false };
}

/**
 * A block comment under a grammar that NESTS: `/* a /* b *\/ c *\/` is one run.
 *
 * Depth is counted rather than matched, and both characters of every delimiter are
 * consumed before the next look, so `/*\/` is one opener and no closer (the shared
 * slash belongs to the opener) and the scan cannot see a delimiter twice. It is a
 * single forward pass over the comment, so it stays linear on an adversarial nest -
 * the property `leading-keyword.ts` records three measured regex failures for.
 *
 * Nothing inside a comment is a literal, here or in the engines this reads for: a
 * `/*` written inside quotes in comment text is still an opener and a `*\/` inside
 * them still closes. Looking for literals in there is the plausible wrong fix - it
 * would make `/* it's /* deep *\/ still *\/` unterminated - so a fixture pins it.
 *
 * A run whose depth never returns to zero is reported undeterminable rather than
 * closed at the last delimiter it saw. That is the fail-safe direction this module
 * keeps everywhere: it costs the statement its bound (an over-large read) and, since
 * #297, a confirmation prompt - where the guess would hide a write behind text the
 * reader claimed to have read.
 */
function readNestedBlockComment(sql: string, index: number): SqlSpan {
  let depth = 0;
  let i = index;

  while (i + 1 < sql.length) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
      continue;
    }
    if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return { kind: "block-comment", end: i, terminated: true };
      continue;
    }
    i++;
  }

  return { kind: "block-comment", end: sql.length, terminated: false };
}

/**
 * The closer Oracle pairs with an alternate-quote opener, or the opener itself.
 *
 * From node-oracledb's own SQL tokenizer (`lib/thin/statement.js`,
 * `_parseQstring`): the four bracket forms close with their partner, and every
 * other delimiter closes with itself.
 */
const ALTERNATE_QUOTE_CLOSERS: Record<string, string> = { "[": "]", "{": "}", "(": ")", "<": ">" };

/**
 * The length of an alternate-quote tag at `index`, or 0 when none opens there.
 *
 * `q'` and `Q'` open one, and the same form spelled `nq'` / `NQ'` (any case
 * mixture) is the national-character-set literal - Oracle's SQL Language
 * Reference gives `nq'#…#'` as the NCHAR/NVARCHAR2 spelling. Both are read,
 * because the body rules are identical and reading only one of them would leave
 * the other's body walked as code, which is the defect this branch exists to fix.
 */
function measureAlternateQuoteTag(sql: string, index: number): number {
  let i = index;
  if (sql[i] === "n" || sql[i] === "N") i++;
  if (sql[i] !== "q" && sql[i] !== "Q") return 0;
  if (sql[i + 1] !== "'") return 0;
  return i + 2 - index;
}

/**
 * An Oracle alternate-quoted literal: `q'{it's}'`, `Q'<body>'`, `nq'!body!'`.
 *
 * The delimiter after the tag opens the body and the matching one FOLLOWED BY a
 * quote closes it, which is what lets the body carry apostrophes - and the
 * delimiter character itself (`q'{a}b}'` is one literal) - with nothing escaped.
 * So there is no doubling rule and no backslash question here: the search is for
 * the two characters that end it.
 *
 * Any character may be the delimiter, which needs no check of its own: Oracle
 * refuses a whitespace delimiter where this reads a literal - and an opaque span
 * moves the reading around it, so such a body can also swallow a `)` or a write
 * keyword - but only in text Oracle rejects outright, so nothing that reaches a
 * server depends on it. Half of a surrogate pair can never match its own closer, so
 * that body reads as unterminated: the answer that costs a bound rather than
 * misplacing one.
 */
function readAlternateQuoted(sql: string, index: number, tagLength: number): SqlSpan {
  const body = index + tagLength + 1;
  const opener = sql[index + tagLength];
  // The tag at the very end of the input: no delimiter, so nothing can close it.
  if (opener === undefined) return { kind: "string", end: sql.length, terminated: false };

  const close = sql.indexOf(`${ALTERNATE_QUOTE_CLOSERS[opener] ?? opener}'`, body);
  if (close === -1) return { kind: "string", end: sql.length, terminated: false };
  return { kind: "string", end: close + 2, terminated: true };
}

/**
 * Whether the character before `index` continues a word, i.e. `index` is inside
 * one.
 *
 * Only the alternate-quote tag needs this: it is the one span whose first
 * character is also an identifier character. Oracle's lexer reads a name greedily,
 * so `freq'x'` there is a name followed by an ordinary string, and without the
 * check the two kinds of reader in this folder would disagree about such text as
 * well - the ones that read whole words step over the name and never ask here,
 * while the ones that walk character by character would ask at its last letter.
 * Two readings of one construct is what this folder exists to stop.
 *
 * node-oracledb's tokenizer has no equivalent check (it parses a q-string at any
 * `'` preceded by `q`/`Q`), so this is deliberately stricter than the driver and
 * closer to the server. What it excludes is text no dialect here accepts, and it
 * excludes it in the safe direction: an ordinary string reading, as today.
 */
function continuesWord(sql: string, index: number): boolean {
  const before = index === 0 ? undefined : sql[index - 1];
  return before !== undefined && (IDENTIFIER_PART.test(before) || before === "$");
}

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
 *
 * `grammar` is the dialect's reading of the characters the engines disagree about.
 * Omitting it is a real answer, not a missing one: it means "no dialect was
 * named", and the compatibility default applies.
 *
 * Pass the whole statement, not a suffix of it: the alternate-quote branch looks at
 * the character BEFORE `index` to tell a tag from the tail of a name, so a slice
 * that cuts a name in half can answer differently than the same text in place. A
 * PREFIX slice is safe, which is what the callers here take (`sql.slice(0, end)`).
 */
export function readSqlSpan(sql: string, index: number, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): SqlSpan | null {
  const ch = sql[index];
  if (ch === undefined) return null;

  if (isWhitespace(ch)) {
    let end = index + 1;
    while (end < sql.length && isWhitespace(sql[end])) end++;
    return { kind: "whitespace", end, terminated: true };
  }

  // `#` is MySQL's, MariaDB's and ClickHouse's second line-comment marker, and it
  // is ordinary code in PostgreSQL, Oracle, SQL Server and SQLite - a jsonb or
  // geometric operator (`#>`, `#>>`, `#-`, `##`), an identifier character, a temp
  // table, a bind-variable prefix. Unlike `leading-keyword.ts`, which only ever
  // looks at a statement's LEADING trivia, this reader is asked about every
  // position, so mid-statement `#` is exactly where the disagreement bites.
  //
  // This used to be resolved here, by taking PostgreSQL's side: a `#` that opens
  // one of those operators is code. That kept `SELECT meta #> '{a}'` bounded and
  // cost the other direction - a MySQL comment written `#- note` read as SQL, so a
  // `)` inside it ended a CTE body early and `WITH t AS (\n #- note )\n SELECT 1)
  // DELETE FROM users` was typed a read and handed a bound, which MySQL applies to
  // the rows the DELETE removes. The grammar record answers it now (#292), and the
  // hybrid survives only as what a caller that named no dialect gets.
  if (opensLineComment(sql, index, grammar)) {
    const newline = sql.indexOf("\n", index);
    // The newline belongs to the comment: it is what closes it.
    return { kind: "line-comment", end: newline === -1 ? sql.length : newline + 1, terminated: true };
  }

  // A `/*` written INSIDE a block comment opens a second one in PostgreSQL, SQL
  // Server and ClickHouse and means nothing at all in MySQL, SQLite and Oracle, so
  // the two readings put the comment's end in different places - and everything
  // between the first `*\/` and the real end is either comment text or the
  // statement's own code depending on which one applies. Read flat where the
  // dialect nests, a `)` written in that region closed a CTE body that was still
  // open, so the statement was typed by a keyword the operator had commented out:
  // `WITH t AS (\n /* a /* b *\/ ) SELECT 1 *\/\n SELECT id FROM logs\n) INSERT …`
  // was typed a read and handed a bound, which on PostgreSQL commits part of the
  // insert. The grammar record answers it now (#300), and the flat reading survives
  // as MySQL's, SQLite's, Oracle's and what a caller that named no dialect gets.
  if (ch === "/" && sql[index + 1] === "*") {
    if (grammar.blockComment === "nesting") return readNestedBlockComment(sql, index);

    const close = sql.indexOf("*/", index + 2);
    if (close === -1) return { kind: "block-comment", end: sql.length, terminated: false };
    return { kind: "block-comment", end: close + 2, terminated: true };
  }

  // Oracle writes a literal that carries apostrophes as `q'{it's}'` (`nq'…'` for
  // the national character set), and it is the only dialect here with the form.
  // Read as code - all any reader here could do before it was told the dialect -
  // the first apostrophe INSIDE the body opens a string and everything after it is
  // read one construct out of step, which costs in both of this folder's
  // directions: a `)` in the body ended a CTE body early, so the statement was
  // typed by a keyword written inside the literal and lost its bound, and a `--` in
  // the body made the rest of the literal look like trailing trivia, so the bound
  // was inserted INSIDE the literal and the statement Oracle received was corrupt
  // while the caller was told it was limited (#292).
  if (grammar.alternateQuoting) {
    const tagLength = measureAlternateQuoteTag(sql, index);
    if (tagLength > 0 && !continuesWord(sql, index)) return readAlternateQuoted(sql, index, tagLength);
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

  // `[…]` quotes an identifier in SQL Server and SQLite, and everything between the
  // brackets is the NAME - `SELECT [a--b] FROM t` selects a column called `a--b`.
  // Leaving it as code let `statement-end.ts` read that `--` as trailing trivia, and
  // the insert-before-trivia rewrite then spliced the bound INTO the name:
  // `SELECT [a LIMIT 500--b] FROM t`, reported as limited. Emitting a corrupted
  // statement is worse than any missed bound, which is why this is a span even
  // though it is the one delimiter pair here that opens and closes with different
  // characters. SQL Server's escape is a doubled closing bracket.
  //
  // ClickHouse spells an array with the same characters and nests them, and there
  // the name reading is wrong in both of its rules at once: `m['a]b']` is a
  // subscript whose key carries a close bracket (the name reading ends the run at
  // that bracket, and the CTE element around it can then not be crossed), and
  // `[[1,2],[3,4]]` ends with a doubled bracket that the name reading takes for an
  // escape, so the run never closes at all. Both cost the statement its bound. The
  // grammar record answers it (#295): the two readings are mutually exclusive, so
  // the dialect picks, and a caller that named none keeps the name reading - which
  // is where the corrupted-statement shape `SELECT [a LIMIT 500--b] FROM t` lives,
  // and it is the more expensive mistake of the two.
  if (ch === "[") {
    return grammar.bracket === "subscript" ? readSubscripted(sql, index, grammar) : readBracketed(sql, index);
  }

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

/**
 * Whether this text carries a run that never closes - i.e. whether part of it is
 * text no reader over this module can resolve.
 *
 * Every OTHER reader here consumes `terminated: false` and then throws it away:
 * `statement-end.ts` refuses the cut, `words.ts` reports the word it could not see
 * as absent, `readSubscripted` above gives up on the bracket. Each is answering a
 * question where declining to act is the safe direction, because their mistake
 * would be a row bound appended to a write.
 *
 * The confirmation gate's costs run the other way - silence there is an
 * unconfirmed destructive statement, while asking costs a click - so it needs the
 * signal itself rather than a reader's response to it (#297). Hence a predicate
 * over spans rather than a fourth reader that re-derives it: an unterminated run
 * hides whatever is written INSIDE it, and the whole answer is whether one exists.
 *
 * A scanner for the same reason as the rest of this module: it advances one span
 * or one character at a time and cannot backtrack, so it stays linear on the
 * pasted-script sizes the execute path sees.
 */
export function hasUnterminatedSpan(sql: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): boolean {
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span === null) {
      i++;
      continue;
    }
    if (!span.terminated) return true;
    i = span.end;
  }

  return false;
}
