/**
 * The `influxdb3` read policy (SPEC 5.4, E10, E17).
 *
 * One SQL statement per request, only one that leads with a read keyword, and none that holds a
 * writing word, a `$` or a character outside ASCII in its code (R35, R36). On InfluxDB 3 the engine is the boundary (3.12.0 Core refuses every
 * SQL write form on the query route) and the closed route table is the second; this policy is the
 * defence in depth before both, so a refused text is never sent.
 *
 * Every reader below runs under `resolveSqlGrammar("influxdb3")`, the measured DataFusion row of
 * `src/lib/sql/grammar.ts`, so this module, the statement splitter, the row limiter and the
 * confirmation gate cannot disagree about where a comment or a literal ends. It reads the leading
 * keyword itself rather than through `src/lib/explain/select-prefix.ts`, whose vocabulary is the
 * EXPLAIN wrapper's and not this type's.
 */

import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { hasUnterminatedSpan, readSqlSpan, type SqlSpanKind } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";

/** The keywords a statement may lead with; each one answers on 3.12.0 Core's `/api/v3/query_sql`. */
export type InfluxSqlKeyword = "SELECT" | "WITH" | "VALUES" | "SHOW" | "EXPLAIN" | "DESCRIBE";

export type InfluxSqlVerdict =
  | { readonly allowed: true; readonly keyword: InfluxSqlKeyword }
  | {
      readonly allowed: false;
      readonly reason:
        | "empty"
        | "multiple-statements"
        | "not-a-read"
        | "write-word"
        | "non-ascii"
        | "dollar"
        | "unterminated"
        | "too-long";
      readonly message: string;
    };

/** The statement text cap in UTF-8 bytes (E10), counted with `TextEncoder`. */
export const INFLUX_SQL_MAX_TEXT_BYTES = 1024 * 1024;

const READ_KEYWORDS: ReadonlySet<string> = new Set<InfluxSqlKeyword>([
  "SELECT",
  "WITH",
  "VALUES",
  "SHOW",
  "EXPLAIN",
  "DESCRIBE",
]);

/**
 * The words only a writing statement uses (R35). A statement that leads with a read keyword can still
 * carry one at depth: `WITH x AS (SELECT 1) DELETE FROM t` leads with WITH and `EXPLAIN ANALYZE INSERT
 * INTO t VALUES (1)` with EXPLAIN. The planner of 3.12.0 refuses both, and this policy does not rest on
 * that staying true.
 */
const WRITE_WORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "COPY",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "INTO",
] as const;

/**
 * A writing word at one position, with the boundary behind it: no ASCII letter, digit or `_` follows.
 * Sticky, so it reads at `lastIndex` and nowhere else. The fold is the `i` flag of a pattern without
 * the `u` flag, which never takes a letter outside ASCII for an ASCII one and never follows the host's
 * locale.
 */
const WRITE_WORD_AT = new RegExp(`(?:${WRITE_WORDS.join("|")})(?![A-Za-z0-9_])`, "iy");

/** The boundary before a writing word: no ASCII letter and no `_`. A digit is one (`1e5into` is `1e5 INTO` on 3.12.0). */
const JOINS_NEXT_WORD = /[A-Za-z_]/;

/**
 * A run of ASCII word characters at one position (sticky), and a writing word anywhere inside one
 * (R38). A run that starts with a digit is refused when it holds a writing word at all, because the
 * server's number reading decides where a word inside it begins: `0x` takes only hex digits, so
 * `0xinto` is `0x INTO` on 3.12.0. A hex literal never matches: each word holds a letter outside a-f.
 */
const WORD_RUN_AT = /[A-Za-z0-9_]+/y;
const WRITE_WORD_IN = new RegExp(WRITE_WORDS.join("|"), "i");
const WORD_CHARACTER = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const ASCII_LETTER = /[A-Za-z]/;
const LAST_ASCII_CODE_UNIT = 0x7f;

/** What the refusal names when a statement opens with something that is not a word (a literal, a number, a `)`). */
const NO_KEYWORD = "no keyword";

/**
 * How much of the leading word a refusal repeats. The word is the user's own text and has no length of
 * its own, so without the cut a megabyte of letters would come back as a megabyte of message. The
 * keywords a statement can lead with (INSERT, CREATE, DELETE and the like) are far shorter, so a real
 * one is always named whole.
 */
const MAX_NAMED_WORD_LENGTH = 32;

/** A byte count with its thousands grouped by commas, as the cap is written; never a locale-aware formatter, whose output follows the host's locale. */
function groupThousands(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+$)/g, ",");
}

/** Every fixed refusal sentence of this policy, so the provider-doc test reads them back from the code. */
export const INFLUX_SQL_POLICY_SENTENCES = {
  empty: "There is no statement to run.",
  unterminated: "The statement has a string, a quoted name or a comment that never closes.",
  multipleStatements: "InfluxDB 3 runs one SQL statement per request; remove the text after the first `;`.",
  notARead: (word: string): string =>
    `Only SELECT, WITH, VALUES, SHOW, EXPLAIN and DESCRIBE run on an InfluxDB 3 connection in Studio: this statement begins with ${word}.`,
  nonAscii: (line: number, column: number): string =>
    `This statement holds a character outside ASCII outside quotes (line ${line}, column ${column}); write names that need it in double quotes.`,
  dollar: (line: number, column: number): string =>
    `This statement holds a \`$\` outside quotes (line ${line}, column ${column}): Studio sends no bound parameters and reads no dollar-quoted string on an InfluxDB 3 connection; write the value as a '...' string, and a name holding \`$\` in double quotes.`,
  writeWord: (word: string): string =>
    `This statement holds the word ${word}, which only a writing statement uses, and an InfluxDB 3 connection in Studio is read-only; if ${word} is a column or table name, write it in double quotes.`,
  tooLong: (bytes: number): string =>
    `This statement is ${groupThousands(bytes)} bytes; an InfluxDB 3 connection in Studio sends at most ${groupThousands(INFLUX_SQL_MAX_TEXT_BYTES)}.`,
} as const;

function isTrivia(kind: SqlSpanKind): boolean {
  return kind === "whitespace" || kind === "line-comment" || kind === "block-comment";
}

/**
 * Where a statement's leading whitespace and comments end, and with `throughParentheses` its opening
 * parentheses too.
 *
 * One forward pass, one span or one character at a time, so a megabyte of `(` costs a megabyte of
 * steps. Trivia is read under the dialect's own grammar: a `#` is code here and stops the walk.
 */
function skipLeading(text: string, grammar: SqlGrammar, throughParentheses: boolean): number {
  let index = 0;
  while (index < text.length) {
    const span = readSqlSpan(text, index, grammar);
    if (span === null) {
      if (!throughParentheses || text[index] !== "(") break;
      index++;
      continue;
    }
    if (!isTrivia(span.kind)) break;
    index = span.end;
  }
  return index;
}

/**
 * The word a statement leads with, upper-cased, behind comments and opening parentheses
 * (`((SELECT 1))` answers on 3.12.0), or `undefined` when it leads with no word.
 *
 * A word is what `readLeadingKeyword` reads: ASCII. The caller has already refused a character outside
 * ASCII in the code, so no word here ends at one.
 */
function leadingWord(fragment: string, grammar: SqlGrammar): string | undefined {
  const lead =
    readLeadingKeyword(fragment, grammar) ??
    readLeadingKeyword(fragment.slice(skipLeading(fragment, grammar, true)), grammar);
  return lead?.keyword;
}

function isReadKeyword(word: string | undefined): word is InfluxSqlKeyword {
  return word !== undefined && READ_KEYWORDS.has(word);
}

/** What the walk over a statement's code refuses first, with the offset of a character the message places. */
type CodeRefusal =
  | { readonly reason: "write-word"; readonly word: string }
  | { readonly reason: "non-ascii" | "dollar"; readonly offset: number };

/**
 * The first thing in the statement's code this policy refuses on sight, in text order, or `undefined`
 * when the code holds none (R35, R36).
 *
 * Code is everything outside a string, a quoted name (double quotes or backticks) and a comment. An
 * array literal or subscript holds code, so its brackets are stepped into one character at a time
 * rather than handed to the span reader, which would read the whole nest again at every level.
 *
 * The policy does not mirror the server's tokenizer; it refuses the two places where the two readings
 * can part, measured on 3.12.0 Core:
 *
 * - a `$`. `SELECT 1 AS a$$ , 2 AS b --$$` answers `{"a$$":1,"b":2}`: a `$$` directly after a name
 *   character is part of the name there, while `readSqlSpan` opens a dollar string, which would hide
 *   the code behind it from this walk. So no `$` is asked of the span reader at all: a dollar string, a
 *   `$1` placeholder and a `$` in a bare name are all refused.
 * - a character outside ASCII. The server folds keywords with Unicode upper-casing: `ınsert ınto` with
 *   a dotless i is INSERT INTO and `ſelect` is SELECT, and no ASCII word scan sees either.
 *
 * And a writing word, matched with boundaries that fail closed: not behind an ASCII letter or `_`, and
 * not before an ASCII letter, a digit or `_`. So `created_at`, `updated`, `insert_time`, `date_trunc`
 * and `x_into` pass, and `1e5into`, which the server reads as `1e5 INTO`, does not. A run of word
 * characters that starts with a digit is refused when it holds a writing word anywhere (R38): `0xinto`
 * is `0x INTO` on 3.12.0. A name that is a writing word, or that these rules cut one out of, is written
 * in double quotes.
 *
 * One forward pass. The caller has already refused a run that never closes, so every span here ends.
 */
function findCodeRefusal(statement: string, grammar: SqlGrammar): CodeRefusal | undefined {
  let index = 0;
  while (index < statement.length) {
    const ch = statement[index];
    if (ch === "$") return { reason: "dollar", offset: index };
    if (statement.charCodeAt(index) > LAST_ASCII_CODE_UNIT) return { reason: "non-ascii", offset: index };
    if (ch === "[" && grammar.bracket === "subscript") {
      index++;
      continue;
    }
    const span = readSqlSpan(statement, index, grammar);
    if (span !== null) {
      index = span.end;
      continue;
    }
    if (DIGIT.test(ch) && !WORD_CHARACTER.test(statement[index - 1] ?? "")) {
      WORD_RUN_AT.lastIndex = index;
      const run = WORD_RUN_AT.exec(statement)?.[0] ?? ch;
      const word = WRITE_WORD_IN.exec(run)?.[0];
      if (word !== undefined) return { reason: "write-word", word: word.toUpperCase() };
    }
    if (ASCII_LETTER.test(ch) && !JOINS_NEXT_WORD.test(statement[index - 1] ?? "")) {
      WRITE_WORD_AT.lastIndex = index;
      const word = WRITE_WORD_AT.exec(statement)?.[0];
      if (word !== undefined) return { reason: "write-word", word: word.toUpperCase() };
    }
    index++;
  }
  return undefined;
}

/**
 * The 1-based line and column of an offset, as the editor counts them: a line ends at `\n`, at `\r\n`
 * or at a lone `\r`, and a column is a UTF-16 unit.
 */
function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    const ch = text[index];
    if (ch === "\n" || (ch === "\r" && text[index + 1] !== "\n")) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function refuse(reason: Extract<InfluxSqlVerdict, { allowed: false }>["reason"], message: string): InfluxSqlVerdict {
  return { allowed: false, reason, message };
}

/**
 * Whether Studio sends this text to an `influxdb3` connection.
 *
 * In order: the byte cap, a run that never closes, the statement count, the walk over the one
 * statement's code (a writing word, a `$`, a character outside ASCII: the first in text order decides),
 * the leading keyword. A `;` followed only by whitespace and comments is one statement (`SELECT 1 AS x;
 * -- c` answers on 3.12.0). A statement that leads with a writing word is refused by the walk, which
 * names the word as the leading-keyword rule would.
 */
export function evaluateInfluxSql(text: string): InfluxSqlVerdict {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > INFLUX_SQL_MAX_TEXT_BYTES) return refuse("too-long", INFLUX_SQL_POLICY_SENTENCES.tooLong(bytes));

  const grammar = resolveSqlGrammar("influxdb3");
  if (hasUnterminatedSpan(text, grammar)) return refuse("unterminated", INFLUX_SQL_POLICY_SENTENCES.unterminated);

  const statements = splitStatements(text, grammar).filter(
    // A fragment of whitespace and comments only is no statement.
    (statement) => skipLeading(statement.sql, grammar, false) < statement.sql.length,
  );
  if (statements.length === 0) return refuse("empty", INFLUX_SQL_POLICY_SENTENCES.empty);
  if (statements.length > 1) return refuse("multiple-statements", INFLUX_SQL_POLICY_SENTENCES.multipleStatements);

  const statement = statements[0];
  const found = findCodeRefusal(statement.sql, grammar);
  if (found?.reason === "write-word") return refuse("write-word", INFLUX_SQL_POLICY_SENTENCES.writeWord(found.word));
  if (found !== undefined) {
    const { line, column } = positionOf(text, statement.start + found.offset);
    const sentence =
      found.reason === "dollar" ? INFLUX_SQL_POLICY_SENTENCES.dollar : INFLUX_SQL_POLICY_SENTENCES.nonAscii;
    return refuse(found.reason, sentence(line, column));
  }

  const word = leadingWord(statement.sql, grammar);
  if (!isReadKeyword(word))
    return refuse(
      "not-a-read",
      INFLUX_SQL_POLICY_SENTENCES.notARead(word?.slice(0, MAX_NAMED_WORD_LENGTH) ?? NO_KEYWORD),
    );
  return { allowed: true, keyword: word };
}
