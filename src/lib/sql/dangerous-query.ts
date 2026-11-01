// The editor's confirmation gate, out of `QuerySafetyDialog.tsx` so a caller that bundles no component can ask it:
// the VS Code extension's child answers `query/target` with its verdict.
import { isDestructiveNonSqlQuery, vocabularyDecidesAlone } from "@/lib/db/destructive-commands";
import {
  conditionalFormInCode,
  conditionalFormOperates,
  hasConfirmCodeForm,
  sequenceInCode,
  wordsFollow,
} from "@/lib/sql/confirm-forms";
import { readsSqlText, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import {
  hasLoneCarriageReturnInLineComment,
  hasUnterminatedSpan,
  IDENTIFIER_PART,
  IDENTIFIER_START,
  readSqlSpan,
} from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { findCodeWord, readSqlWord } from "@/lib/sql/words";
import type { DatabaseType } from "@/lib/types";

/**
 * Statements whose own keyword is enough to want a confirmation: they change or delete rows,
 * remove objects or change who may reach them.
 *
 * The same vocabulary the six anchored patterns here used to spell out, now tested
 * against one reading of the statement instead of re-derived per keyword. `MERGE` joined it
 * later: it updates, deletes or inserts rows on every engine that has it, whichever `WHEN`
 * branches it carries, so it is shared vocabulary rather than a form each grammar row declares.
 */
const DANGEROUS_KEYWORDS = new Set(["DELETE", "DROP", "TRUNCATE", "ALTER", "GRANT", "REVOKE", "UPDATE", "MERGE"]);

/**
 * The words that open a procedural block or a branch of one rather than a statement of
 * their own, in PL/SQL, T-SQL and SQLite trigger bodies. A statement read with one of
 * these as its keyword is the block, and what it does is written after it.
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  "BEGIN",
  "DECLARE",
  "IF",
  "ELSE",
  "ELSIF",
  "THEN",
  "WHILE",
  "LOOP",
  "FOR",
  "EXCEPTION",
  "WHEN",
]);

/**
 * The data-modifying words a CTE body can open with, besides `UPDATE`.
 *
 * The same set `DATA_MODIFYING` names in `src/lib/explain/select-prefix.ts`
 * (`INSERT`, `UPDATE`, `DELETE`, `MERGE`), minus `UPDATE`: that one stays the
 * `UPDATE … SET` pair below, because a bare `UPDATE` is a cursor lock as often
 * as it is a write. These three need no following word. Each is non-reserved in
 * PostgreSQL, so they count only as the first word of a CTE body.
 */
const CTE_DATA_MODIFYING = new Set(["INSERT", "DELETE", "MERGE"]);

/**
 * The words the legacy `EXPLAIN [ANALYZE | ANALYSE] [VERBOSE]` spelling takes, in either order.
 * `ANALYSE` is PostgreSQL's British spelling of the option that executes.
 */
const EXPLAIN_KEYWORD_OPTIONS = new Set(["ANALYZE", "ANALYSE", "VERBOSE"]);

/** The option names that execute the explained statement when they are enabled. */
const ANALYZE_OPTIONS = new Set(["ANALYZE", "ANALYSE"]);

/**
 * Whether `value` is a boolean false, by PostgreSQL's `parse_bool` (`src/backend/utils/adt/bool.c`).
 *
 * The whole string must be a spelling of `false`, `off`, `no` or `0`. Unique prefixes count (`f`, `fa`, `of`, `n`),
 * which is that function's rule, and the case does not. A longer word does not: `falsehood` and `note` are not
 * booleans, and neither is a bare `o`, which is not a unique prefix of `on` or `off`.
 */
function postgresBooleanIsFalse(value: string): boolean {
  const lower = value.toLowerCase();
  const head = lower[0];
  if (head === "f") return "false".startsWith(lower);
  if (head === "n") return "no".startsWith(lower);
  if (head === "o") return lower === "of" || lower === "off";
  if (head === "0") return lower.length === 1;
  return false;
}

/** A decimal digit run with a single underscore allowed between digits: PostgreSQL's `{decdigit}(_?{decdigit})*`. */
function scanDecInteger(text: string, start: number, limit: number): number {
  if (start >= limit || text[start] < "0" || text[start] > "9") return start;
  let end = start + 1;
  while (end < limit) {
    const ch = text[end];
    if (ch === "_" && end + 1 < limit && text[end + 1] >= "0" && text[end + 1] <= "9") {
      end += 2;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      end += 1;
      continue;
    }
    break;
  }
  return end;
}

/** Whether every digit in `text[from, to)` is `0`. A digit is required; underscores are separators and ignored. */
function digitsAreZero(text: string, from: number, to: number): boolean {
  let digit = false;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (ch === "_") continue;
    if (ch !== "0") return false;
    digit = true;
  }
  return digit;
}

function isHexDigit(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

/**
 * A `0x` / `0o` / `0b` integer, PostgreSQL's `{prefix}(_?{digit})+`. Returns `start` when the prefix is absent or no
 * digit follows it, so `0x` is not read as the integer 0.
 */
function scanRadixInteger(
  text: string,
  start: number,
  limit: number,
  mark: string,
  digit: (ch: string) => boolean,
): number {
  if (start + 1 >= limit || text[start] !== "0" || text[start + 1].toLowerCase() !== mark) return start;
  let end = start + 2;
  let any = false;
  while (end < limit) {
    if (text[end] === "_" && end + 1 < limit && digit(text[end + 1])) {
      end += 2;
      any = true;
      continue;
    }
    if (digit(text[end])) {
      end += 1;
      any = true;
      continue;
    }
    break;
  }
  return any ? end : start;
}

/** A fractional literal, `{decinteger}.{decinteger}?`. `1..` is not one: the scanner gives the `..` back. */
function scanNumericLiteral(text: string, start: number, limit: number): number {
  const dec = scanDecInteger(text, start, limit);
  if (dec === start || dec >= limit || text[dec] !== ".") return start;
  if (dec + 1 < limit && text[dec + 1] === ".") return start;
  return scanDecInteger(text, dec + 1, limit);
}

/** The end of a real literal `(decinteger|numeric)[Ee][-+]?{decinteger}`, or `start` when the exponent has no digits. */
function scanRealLiteral(text: string, start: number, limit: number): number {
  let end = scanNumericLiteral(text, start, limit);
  if (end === start) end = scanDecInteger(text, start, limit);
  if (end === start || end >= limit || (text[end] !== "e" && text[end] !== "E")) return start;
  let exp = end + 1;
  if (exp < limit && (text[exp] === "+" || text[exp] === "-")) exp += 1;
  const expEnd = scanDecInteger(text, exp, limit);
  return expEnd === exp ? start : expEnd;
}

/**
 * The token PostgreSQL rejects as trailing junk after an exponent sign (`0e+`, `1e-`), consumed whole so the leading
 * digits are not left behind as the integer 0.
 */
function scanRealFail(text: string, start: number, limit: number): number {
  let end = scanNumericLiteral(text, start, limit);
  if (end === start) end = scanDecInteger(text, start, limit);
  if (end === start || end >= limit || (text[end] !== "e" && text[end] !== "E")) return start;
  let exp = end + 1;
  if (exp < limit && (text[exp] === "+" || text[exp] === "-")) exp += 1;
  if (scanDecInteger(text, exp, limit) !== exp) return start;
  return exp;
}

/** Where an identifier glued to a literal ends, or `from` when none starts there. `$` continues one, as a word does. */
function identifierEnd(text: string, from: number, limit: number): number {
  if (from >= limit || !IDENTIFIER_START.test(text[from])) return from;
  let end = from + 1;
  while (end < limit && (IDENTIFIER_PART.test(text[end]) || text[end] === "$")) end += 1;
  return end;
}

/**
 * The numeric literal at `start`, and whether it is an integer whose value is 0.
 *
 * PostgreSQL's scanner takes the longest of the integer, hex, octal, binary, numeric and real forms, and an
 * identifier glued on is trailing junk rather than a second token (`scan.l`). Ties keep the earlier form, so `0x1`
 * is the integer 1 and not the decimal 0 followed by a name. Only an integer of value 0 is off: `0`, `00`, `0x0`,
 * `0b0`, `0o0` and `0_0`. `0x1`, `0b1`, `0o1` and `0_1` are 1. A float, an exponent and a rejected literal are not
 * the integer 0, so they are not off.
 */
function readNumericLiteral(text: string, start: number, limit: number): { end: number; zero: boolean } {
  let bestEnd = start;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestZero = false;
  const consider = (end: number, rank: number, zero: boolean): void => {
    if (end <= start) return;
    if (end > bestEnd || (end === bestEnd && rank < bestRank)) {
      bestEnd = end;
      bestRank = rank;
      bestZero = zero;
    }
  };

  const decEnd = scanDecInteger(text, start, limit);
  consider(decEnd, 0, digitsAreZero(text, start, decEnd));

  const hexEnd = scanRadixInteger(text, start, limit, "x", isHexDigit);
  consider(hexEnd, 1, digitsAreZero(text, start + 2, hexEnd));
  const octEnd = scanRadixInteger(text, start, limit, "o", (ch) => ch >= "0" && ch <= "7");
  consider(octEnd, 2, digitsAreZero(text, start + 2, octEnd));
  const binEnd = scanRadixInteger(text, start, limit, "b", (ch) => ch === "0" || ch === "1");
  consider(binEnd, 3, digitsAreZero(text, start + 2, binEnd));

  const numericEnd = scanNumericLiteral(text, start, limit);
  consider(numericEnd, 4, false);
  const realEnd = scanRealLiteral(text, start, limit);
  consider(realEnd, 5, false);
  consider(scanRealFail(text, start, limit), 6, false);

  if (decEnd > start) consider(identifierEnd(text, decEnd, limit), 7, false);
  if (numericEnd > start) consider(identifierEnd(text, numericEnd, limit), 8, false);
  if (realEnd > start) consider(identifierEnd(text, realEnd, limit), 9, false);

  return { end: bestEnd, zero: bestZero };
}

/** Whether a `confirmExemptForms` form led by `keyword` starts at the keyword that ends at `end`. */
function exemptFormAt(text: string, keyword: string, end: number, grammar: SqlGrammar): boolean {
  return (grammar.confirmExemptForms ?? []).some(
    (form) => form[0].toUpperCase() === keyword && wordsFollow(text, end, form.slice(1), grammar),
  );
}

/**
 * Whether a procedural block's code writes, as far as its words can say.
 *
 * Any dangerous keyword in the block's code counts, except two shapes that only look like
 * one: a T-SQL variable (`@alter`, `@delete`) and a cursor's `FOR UPDATE` lock clause.
 * Dynamic SQL counts whatever its text says, because the text is a literal the reader
 * cannot see into: `EXECUTE IMMEDIATE 'DROP TABLE t PURGE'` drops a table, and Oracle
 * used to refuse the block it sits in when the runner cut it at its first `;` (#1312).
 * A dialect's own `confirmForms` count the same way, anywhere in the block's code.
 */
function blockWrites(text: string, grammar: SqlGrammar): boolean {
  if ((grammar.confirmForms ?? []).some((form) => sequenceInCode(text, form, grammar))) return true;
  if ((grammar.confirmFormsWhen ?? []).some((form) => conditionalFormInCode(text, form, grammar))) return true;

  const execute = findCodeWord(text, "EXECUTE", 0, grammar);
  if (execute !== null && findCodeWord(text, "IMMEDIATE", execute.end, grammar) !== null) return true;
  if (findCodeWord(text, "DBMS_SQL", 0, grammar) !== null) return true;

  for (const word of DANGEROUS_KEYWORDS) {
    let found = findCodeWord(text, word, 0, grammar);
    while (found !== null) {
      const before = text.slice(0, found.start);
      const variable = before.endsWith("@");
      const lockClause = word === "UPDATE" && /\bFOR\s+$/i.test(before);
      if (!variable && !lockClause && !exemptFormAt(text, word, found.end, grammar)) return true;
      found = findCodeWord(text, word, found.end, grammar);
    }
  }
  return false;
}

/**
 * The first index at or after `from` past white space and comments, the text Spark's lexer hides from its parser.
 * White space is every character JavaScript's `\s` matches, which holds every one Spark's lexer counts (U+00A0 and
 * U+3000 among them), and every character at or below U+0020, which Spark's `String.trim` of an unquoted key removes.
 */
function pastHiddenText(text: string, from: number, grammar: SqlGrammar): number {
  let i = from;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (
      span !== null &&
      (span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment")
    ) {
      i = span.end;
    } else if (text[i] <= " " || /\s/.test(text[i])) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * The session key a SET or RESET names, read past white space and comments (`pastHiddenText`), and the index after
 * it; the key is `""` where none follows. A key in backticks, or in double quotes where Spark reads double quotes as
 * identifier quotes (`spark.sql.ansi.enabled` and `spark.sql.ansi.doubleQuotedIdentifiers` both on), is one token, as
 * Spark's `configKey` rule reads it: the inner text of the closed run, a doubled quote collapsed to one, and nothing
 * after the closing quote. Studio reads double quotes that way under every setting, so such a key asks whether or not
 * the session reads it as a key. Any other key is the code text up to `=`, white space, `;` or the end: Spark reads it
 * as the raw text up to `=`, trimmed by `String.trim`, which removes every character at or below U+0020, so each of
 * those ends the key here.
 */
function configKeyAfter(text: string, from: number, grammar: SqlGrammar): { key: string; end: number } {
  const start = pastHiddenText(text, from, grammar);
  const quote = text[start];
  const span = readSqlSpan(text, start, grammar);
  if (span?.kind === "quoted-identifier" && span.terminated && (quote === "`" || quote === '"')) {
    return { key: text.slice(start + 1, span.end - 1).replaceAll(quote + quote, quote), end: span.end };
  }
  let end = start;
  while (end < text.length && text[end] > " " && !/[=\s;]/.test(text[end])) end++;
  return { key: text.slice(start, end), end };
}

/**
 * Whether a SET or RESET names a key of `grammar.confirmConfigKeys`, or is a RESET of every key. A SET asks only when
 * `=` follows the key, past white space and comments: without it, the SET only shows the key's value.
 */
function configKeyAsks(
  text: string,
  reading: NonNullable<ReturnType<typeof readOperativeKeyword>>,
  grammar: SqlGrammar,
): boolean {
  const keys = grammar.confirmConfigKeys;
  if (keys === undefined || (reading.keyword !== "SET" && reading.keyword !== "RESET")) return false;
  const { key: named, end } = configKeyAfter(text, reading.end, grammar);
  if (named === "") return reading.keyword === "RESET";
  if (reading.keyword === "SET" && text[pastHiddenText(text, end, grammar)] !== "=") return false;
  const key = named.toLowerCase();
  return keys.some((entry) => {
    const wanted = entry.toLowerCase();
    return wanted.endsWith(".") ? key.startsWith(wanted) : key === wanted;
  });
}

/** One token of a parenthesised EXPLAIN option list. */
interface ExplainOptionToken {
  /** A word is upper-cased; a string is its contents; a number is the whole literal. */
  text: string;
  end: number;
  kind: "word" | "number" | "comma" | "string" | "other";
  /** For a number: the literal is an integer whose value is 0. A float, junk and a nonzero integer are not. */
  zero?: boolean;
}

/**
 * The next option-list token at or after `from` and before `limit`, or null at the closing paren.
 *
 * Strings and comments are spans, so a word written inside one is not an option: `EXPLAIN ('ANALYZE')` does not
 * execute, and `ANALYZE 'false'` is the off value rather than the word `false` somewhere later.
 */
function readExplainOptionToken(
  text: string,
  from: number,
  limit: number,
  grammar: SqlGrammar,
): ExplainOptionToken | null {
  const i = pastHiddenText(text, from, grammar);
  if (i >= limit) return null;
  if (text[i] === ",") return { text: ",", end: i + 1, kind: "comma" };
  const word = readSqlWord(text, i);
  if (word !== null) return { text: word.text, end: word.end, kind: "word" };
  if (text[i] >= "0" && text[i] <= "9") {
    const literal = readNumericLiteral(text, i, limit);
    // A digit always starts a decimal literal, so the scan advances. The max keeps a failed scan from looping.
    const end = Math.max(literal.end, i + 1);
    return { text: text.slice(i, end), end, kind: "number", zero: literal.end > i && literal.zero };
  }
  const span = readSqlSpan(text, i, grammar);
  if (span?.kind === "string") return { text: text.slice(i + 1, span.end - 1), end: span.end, kind: "string" };
  const end = span === null ? i + 1 : span.end;
  return { text: text.slice(i, end), end, kind: "other" };
}

/**
 * The index past the `)` that closes the paren at `open`, or `-1` when it never closes.
 *
 * Literals and comments are skipped whole, so a `)` inside `EXPLAIN (ANALYZE ')')` cannot end the option list.
 */
function endOfParenthesised(text: string, open: number, grammar: SqlGrammar): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span !== null) {
      i = span.end;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Whether one option value turns ANALYZE off.
 *
 * Off is only a boolean false (`false`, `off`, `no`, `0` and their accepted prefixes) or an integer literal of
 * value 0, including the signed forms `+0` and `-0`. No value is on, and so is anything else: a nonzero literal
 * (`0x1`, `0b1`, `0o1`, `0_1`), a float, a word that only starts like a boolean, and a literal the scanner rejects.
 * Reading the leading `0` of `0x1` as the whole value is how that `DELETE` used to run with no dialog (#1863).
 */
function analyzeValueIsOff(text: string, value: ExplainOptionToken, limit: number, grammar: SqlGrammar): boolean {
  if (value.kind === "word" || value.kind === "string") return postgresBooleanIsFalse(value.text);
  if (value.kind === "number") return value.zero === true;
  if (value.text !== "+" && value.text !== "-") return false;
  const number = readExplainOptionToken(text, value.end, limit, grammar);
  return number !== null && number.kind === "number" && number.zero === true;
}

/**
 * Whether a parenthesised option list enables ANALYZE.
 *
 * An option with no value is on. Any enabled `ANALYZE` executes, even when another is off, which asks rather than
 * missing a `DELETE`.
 */
function explainOptionsExecute(text: string, open: number, close: number, grammar: SqlGrammar): boolean {
  const limit = close - 1;
  let execute = false;
  let i = open + 1;
  while (i < limit) {
    const name = readExplainOptionToken(text, i, limit, grammar);
    if (name === null) break;
    i = name.end;
    if (name.kind !== "word") continue;
    const value = readExplainOptionToken(text, i, limit, grammar);
    if (value !== null && value.kind !== "comma") i = value.end;
    if (!ANALYZE_OPTIONS.has(name.text)) continue;
    if (value === null || value.kind === "comma" || !analyzeValueIsOff(text, value, limit, grammar)) execute = true;
  }
  return execute;
}

/**
 * The statement after `EXPLAIN`'s options when ANALYZE will execute it, or null when ANALYZE is absent or off.
 *
 * The legacy spelling is a run of `ANALYZE`/`ANALYSE`/`VERBOSE`. The parenthesised spelling is `EXPLAIN ( … )`.
 * Anything else — a plain `EXPLAIN`, `EXPLAIN VERBOSE`, `ANALYZE false` — only plans, and null is what tells the
 * caller not to ask.
 */
function stripExplainOptions(text: string, from: number, grammar: SqlGrammar): string | null {
  const start = pastHiddenText(text, from, grammar);
  if (text[start] === "(") {
    const close = endOfParenthesised(text, start, grammar);
    if (close < 0) return null;
    return explainOptionsExecute(text, start, close, grammar) ? text.slice(close) : null;
  }

  let at = start;
  let analyze = false;
  for (;;) {
    const wordAt = pastHiddenText(text, at, grammar);
    const word = readSqlWord(text, wordAt);
    if (word === null || !EXPLAIN_KEYWORD_OPTIONS.has(word.text)) break;
    if (ANALYZE_OPTIONS.has(word.text)) analyze = true;
    at = word.end;
  }
  return analyze ? text.slice(at) : null;
}

/**
 * Index of the first word of a CTE body after `AS [NOT] MATERIALIZED (`, or null when `afterAs` is not that shape.
 * Whitespace and comments between the words are not part of the shape; a string or any other token ends it.
 */
function cteBodyAt(text: string, afterAs: number, grammar: SqlGrammar): number | null {
  let at = pastHiddenText(text, afterAs, grammar);
  const hint = readSqlWord(text, at);
  if (hint?.text === "NOT") {
    at = pastHiddenText(text, hint.end, grammar);
    const materialized = readSqlWord(text, at);
    if (materialized?.text !== "MATERIALIZED") return null;
    at = materialized.end;
  } else if (hint?.text === "MATERIALIZED") {
    at = hint.end;
  }
  at = pastHiddenText(text, at, grammar);
  if (text[at] !== "(") return null;
  return pastHiddenText(text, at + 1, grammar);
}

/** Whether `INSERT`, `DELETE` or `MERGE` opens a CTE body, or operates one that itself opens with `WITH`. */
function cteBodyWrites(text: string, grammar: SqlGrammar): boolean {
  let i = 0;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span !== null) {
      i = span.end;
      continue;
    }
    const word = readSqlWord(text, i);
    if (word !== null && word.text === "AS" && cteBodyOpensWithWrite(text, word.end, grammar)) return true;
    i = word?.end ?? i + 1;
  }
  return false;
}

function cteBodyOpensWithWrite(text: string, afterAs: number, grammar: SqlGrammar): boolean {
  const bodyAt = cteBodyAt(text, afterAs, grammar);
  if (bodyAt === null) return false;
  const body = readSqlWord(text, bodyAt);
  if (body !== null && CTE_DATA_MODIFYING.has(body.text)) return true;
  // `WITH x AS (WITH y AS (…) DELETE …)` : the body is a statement, and the write is the
  // keyword that operates it, not the first word.
  if (body?.text !== "WITH") return false;
  const operative = readOperativeKeyword(text.slice(bodyAt), grammar);
  return operative !== null && CTE_DATA_MODIFYING.has(operative.keyword);
}

/**
 * Whether ONE statement's own code asks for a confirmation, read under `grammar`.
 *
 * Its own function because the caller below asks the question twice over different
 * text: the whole editor buffer, and then each fragment the multi-statement route
 * will run. Re-deriving the two keyword tests per call site is how the gate and the
 * runner drifted apart in the first place.
 *
 * Exported for the grammar-level tests in `tests/components/QuerySafetyDialog.test.tsx`, which read a row's forms
 * before any shipped row declares them; `isDangerousQuery` is the gate.
 */
export function writesUnderGrammar(text: string, grammar: SqlGrammar): boolean {
  const reading = readOperativeKeyword(text, grammar);
  const keyword = reading?.keyword;

  // PostgreSQL's EXPLAIN executes the explained statement only when ANALYZE is on
  // (`EXPLAIN ANALYZE DELETE`, `EXPLAIN (ANALYZE, BUFFERS) UPDATE`). The operative
  // keyword is EXPLAIN, which is not itself dangerous, so without this the DELETE
  // runs unconfirmed (#1863). A plain EXPLAIN, or ANALYZE set to a boolean false
  // or the integer 0, only plans: returning here, instead of falling through, is what keeps an
  // `UPDATE … SET` inside a plan from asking. The remaining text is read as its own
  // statement, so a data-modifying CTE under the EXPLAIN asks too. CockroachDB
  // shares this grammar.
  if (reading !== null && reading.keyword === "EXPLAIN" && grammar.explainExecutesWithAnalyze === true) {
    const inner = stripExplainOptions(text, reading.end, grammar);
    return inner !== null && writesUnderGrammar(inner, grammar);
  }

  if (
    reading !== null &&
    DANGEROUS_KEYWORDS.has(reading.keyword) &&
    !exemptFormAt(text, reading.keyword, reading.end, grammar)
  ) {
    return true;
  }

  // The dialect's own forms: a keyword sequence that operates the statement, and a form found anywhere in its code.
  // Both are absent on every row that does not declare them, so no other dialect's verdict moves.
  if (
    reading !== null &&
    (grammar.confirmForms ?? []).some(
      (form) => form[0].toUpperCase() === reading.keyword && wordsFollow(text, reading.end, form.slice(1), grammar),
    )
  ) {
    return true;
  }
  // A session key the dialect names: SET or RESET of it changes how every later statement of the session reads.
  if (reading !== null && configKeyAsks(text, reading, grammar)) return true;
  if (
    reading !== null &&
    (grammar.confirmFormsWhen ?? []).some((form) =>
      conditionalFormOperates(text, reading.keyword, reading.end, form, grammar),
    )
  ) {
    return true;
  }
  if (hasConfirmCodeForm(text, grammar)) return true;

  // A statement led by a control-flow word, or by a `<<label>>` no keyword reading
  // passes, does what the words AFTER it say: `BEGIN DELETE FROM emp; END;` is a PL/SQL
  // block that deletes, and `IF @@ROWCOUNT > 0 DELETE FROM t` a T-SQL statement that
  // does. Its own keyword is `BEGIN` or `IF`, so for these the dangerous words are looked
  // for anywhere in the statement's CODE (#1312). Before procedural bodies were a grammar
  // fact the runner cut such a block at its first `;` and Oracle refused the fragment, so
  // nothing ran unasked; now the whole block runs, and the gate has to read into it.
  const labelled = keyword === undefined && text.trimStart().startsWith("<<");
  if ((labelled || (keyword !== undefined && CONTROL_FLOW_KEYWORDS.has(keyword))) && blockWrites(text, grammar)) {
    return true;
  }

  // A data-modifying CTE is operated by the statement after its list, so the keyword
  // test above answers for the SELECT. INSERT, DELETE and MERGE are non-reserved in
  // PostgreSQL, so they count only as the first word of a CTE body — right after
  // `AS (` or `AS [NOT] MATERIALIZED (` — or as the keyword that operates a body
  // which itself opens with WITH. A column or CTE of those names does not ask, nor
  // does a word in a string or a comment. The statement need not lead with WITH:
  // a parenthesised query and `CREATE TABLE … AS WITH …` carry the same body.
  // An unclosed list that leads with WITH (`WITH t AS (DELETE FROM x`) stays silent.
  // UPDATE stays the pair below. CockroachDB connections are the postgres type-id
  // and share this grammar (#1862).
  const leadsWithWith = readLeadingKeyword(text, grammar)?.keyword === "WITH";
  if ((!leadsWithWith || reading !== null) && cteBodyWrites(text, grammar)) {
    return true;
  }
  const update = findCodeWord(text, "UPDATE", 0, grammar);
  return update !== null && findCodeWord(text, "SET", update.end, grammar) !== null;
}

/**
 * Detect if a query is potentially dangerous and should trigger safety analysis.
 *
 * This gates the confirmation dialog on BOTH execution paths - `use-query-execution`
 * standalone and the embedded `use-query-adapter` - so it is the last check before a
 * destructive statement runs.
 *
 * It used to re-derive the leading-keyword test with its own anchored patterns
 * (`/^\s*DROP\b/i`, …), which tolerate whitespace but not a comment, so
 * `-- cleanup\nDROP TABLE users` executed with no confirmation at all (#294) - the
 * same blindness this project has now removed from the query limiter (#275) and the
 * multi-statement route (#281). Reading the shared primitive instead means the
 * dialog and the limiter agree about where a statement starts, and a `WITH` whose CTE
 * list only precedes a write (`WITH x AS (…) DELETE FROM …`) is now recognised too.
 *
 * Text the reading cannot resolve ASKS (#297). A run that never closes hides
 * whatever is written inside it - `SELECT '\';` followed by a write is the case,
 * because the two dialect readings of `'\'` end the string in different places and
 * `spans.ts` declines to guess - so reading the code words finds nothing after it
 * and every keyword test above answers false. Every other reader in `src/lib/sql/`
 * errs toward not ACTING on such text, which is the safe direction for them (their
 * mistake is a row bound appended to a write). Here the costs are reversed: a false
 * prompt costs one click, silence costs an unconfirmed destructive statement. So
 * this predicate treats an unresolvable run as a reason to ask, and the dialog says
 * that is why it is asking rather than describing a risk it could not assess.
 *
 * The accepted cost, pinned by tests rather than left to be discovered: `spans.ts`
 * reports an undeterminable literal for any closing quote behind an ODD backslash
 * run, so a legitimate PostgreSQL literal ending in a backslash prompts every time.
 * A statement whose runs all resolve does NOT prompt merely for carrying a
 * backslash. Naming the dialect narrows this further where a dialect resolves the
 * text (#292, #295): Oracle's `q'{it's}'` and ClickHouse's `[[1,2],[3,4]]` are
 * closed runs under their own grammars and unresolvable under a reader without them.
 *
 * For MongoDB and Redis, whose text is not SQL, there is nothing here to read, and
 * this predicate answered false for them outright - so a Redis `FLUSHALL` or `DEL`
 * and a MongoDB `deleteMany` ran with no confirmation at all, on both execution
 * paths, while the same intent on every SQL engine asked (S8). Their vocabulary now
 * comes from `@/lib/db/destructive-commands`, one table per type read by one
 * function, and it names only what each provider can actually dispatch. PromQL's and
 * Kafka's rows in the same table name nothing and are the whole answer: neither has a
 * write path (#1085 and #1088, section 2), and read as SQL a metric named `update` or
 * `delete` was a write.
 *
 * `databaseType` is the connection the statement is about to run on, and both
 * call sites hold one (#292). It decides the characters the engines read
 * differently: a write written after a `#` is commented out in MySQL and the
 * statement's own code in PostgreSQL, and a `#` comment inside a CTE list used to
 * hide the `)` that closes it - so a `DELETE` after the list ran with no
 * confirmation at all. Omitting it keeps the dialect-less reading.
 */
export function isDangerousQuery(query: string, databaseType?: DatabaseType): boolean {
  const grammar = resolveSqlGrammar(databaseType);

  // Asked FIRST because it is the only question here whose answer does not depend
  // on reading the statement: where a run never closes, every keyword test below
  // is reading text that stops early, so their `false` is "not found" rather than
  // "not there".
  //
  // Only where the text IS SQL, though. Both execution paths ask about whatever is
  // in the editor, so this predicate is handed MongoDB documents, Redis commands, PromQL
  // expressions, Kafka read requests and etcdctl commands as well, and an escaped quote that a SQL
  // span reader cannot resolve closes perfectly in the grammar those are written in. For MongoDB and
  // Redis the keyword tests below still run: narrowing this rule is not switching the
  // gate off.
  if (readsSqlText(databaseType) && hasUnterminatedSpan(query, grammar)) return true;
  // The same reasoning for a line comment that holds a lone carriage return: engines that share a connection type end
  // it in different places, so either reading of the code after it may be wrong about what the server runs.
  if (readsSqlText(databaseType) && hasLoneCarriageReturnInLineComment(query, grammar)) return true;

  // A type whose own vocabulary is the whole answer is not read as SQL at all, and
  // PromQL, Kafka and etcd are those types. A PromQL expression can start with a metric name the
  // server's data chooses, `update`, `delete` and `drop` are legal names, and the keyword
  // test below read the tree's own selector for such a metric as a write, about text that
  // only ever reaches a query endpoint that cannot write (#1085, section 2); a Kafka read
  // request names a topic, which can carry those names too, and can only read it (#1088,
  // section 2); an etcd command names keys, which can be spelled like any SQL keyword, and the
  // etcd provider's guard.ts reads it with the parser the provider runs (#1089, section 5.5).
  // Which types decide alone is a fact of the same table, not a type test here.
  if (vocabularyDecidesAlone(databaseType)) return isDestructiveNonSqlQuery(query, databaseType);

  if (writesUnderGrammar(query, grammar)) return true;

  /*
    The editor text is not always what runs. A buffer holding more than one
    statement takes `/api/db/multi-query`, which SPLITS it and runs the fragments
    one by one, and this predicate read only the whole text - so a write in any
    fragment but the first was invisible to it: the operative keyword of
    `SELECT 1; DROP TABLE users` is SELECT.

    Measured on MySQL, where the entry's shape is not even hypothetical:
    `/* a /* b *\/ ; DROP TABLE s1.users; -- *\/ SELECT 1` really does drop the
    table there (MySQL reads block comments flat), and the whole-text reading found
    no operative keyword at all because the first code character is the `;`.

    So the gate asks about exactly what the runner will run: the same splitter,
    under the same grammar. Only for SQL text - the multi-statement route is a SQL
    route and a `;` in a Mongo document or a Redis command separates nothing, so
    splitting there could only invent fragments to prompt about (#427).
  */
  // Where the text is not SQL, its own vocabulary decides. This used to be a bare
  // `return false`, which is why a Redis `FLUSHALL` and a Mongo `deleteMany` ran with
  // no confirmation at all while a `DELETE FROM` on every SQL engine asked (S8). The
  // facts are a table in `@/lib/db/destructive-commands`, not a type test written
  // here: this file already learned that lesson for the span rule above.
  if (!readsSqlText(databaseType)) return isDestructiveNonSqlQuery(query, databaseType);
  // One exception to "exactly what the runner will run": a procedural body is ONE
  // statement to the runner (#1312), and its operative keyword is `BEGIN`, `DECLARE` or
  // `CREATE`, none of which asks. The writes inside it are still writes, so the gate keeps
  // reading the body's own `;`-separated statements, which is what it read before bodies
  // were a fact at all. The spans and the separator lines stay the dialect's.
  const statementsInsideBodies = { ...grammar, script: { ...grammar.script, blocks: "none" as const } };
  return splitStatements(query, statementsInsideBodies).some((statement) => writesUnderGrammar(statement.sql, grammar));
}
