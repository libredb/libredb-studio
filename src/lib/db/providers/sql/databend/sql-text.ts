/**
 * The Databend statement guard (design 5.3), which runs before any request.
 *
 * Pure: it reads the text under the Databend grammar row and answers one refusal sentence, or `null` when the text is
 * one statement Studio and Databend read the same way. No sentence echoes the text.
 *
 * Databend's `/v1/query` takes one statement per request, and when the first of several is an INSERT or REPLACE it
 * drops the rest without an error, so more than one code statement is refused, and so is none. Every other refusal is
 * a place where Databend's lexer ends a construct somewhere the span reader does not, so text that Studio reads as a
 * comment or literal is code to the server, and the confirmation gate would have read a different statement than the
 * one that runs:
 *
 * - a run that never closes, which hides whatever is written inside it;
 * - a form feed, which ends a `--` comment in Databend (`--[^\n\f]*`) and not in the span reader;
 * - a dollar run tagged other than `$$`: the span reader reads `$a$ ... $a$` as one dollar string, while Databend lexes
 *   `$a$` as a variable (`\$[_a-zA-Z][_$a-zA-Z0-9]*`) and reads what lies between two of them as code;
 * - a `$$` run straight after an identifier character: Databend's identifier tail takes `$` (`is_ident_continue`), so
 *   `a$$` is one name there and what the span reader reads as a dollar string is code;
 * - a code-level `@` stage token holding a backslash or a run the span reader opens: `@([^\s,`;'"()]|\\\s|\\'|\\"|\\\\)+`
 *   takes `\'`, `--`, `/*`, `$$` and `[` into the name, so `@s\'; DROP TABLE t; --'` and `@s--;DROP TABLE t` are a
 *   stage, a `;` and a DROP there and one statement here; an `@` that ends a `<@` operator opens no stage token;
 * - a `/*+` hint holding a `;`: Databend tokenizes a hint body where the span reader sees a block comment, and no hint
 *   needs a `;`;
 * - a `/*+` hint holding a token that can run past the closing star-slash the span reader stops at: wherever the
 *   prefix stands, Databend ends the hint at the first closing star-slash TOKEN, so a quote, a comment, a `$$` string,
 *   a stage name or a `~*` that takes it in moves the end to a later one, and no `;` is needed to hide a statement.
 *
 * The checks that say Studio's reading is not Databend's come before the count, which is only meaningful once the two
 * readings agree. An array literal's contents are code to both readers, so each check holds inside one too.
 */

import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasUnterminatedSpan, IDENTIFIER_PART, readSqlSpan } from "@/lib/sql/spans";
import { countCodeStatements } from "@/lib/sql/statement-splitter";

export const DATABEND_MULTIPLE_STATEMENTS =
  "Databend runs one statement per request, and when the first is an INSERT or REPLACE it drops the rest without an error. Run the statements one at a time.";

export const DATABEND_NO_STATEMENT = "There is no statement to run: the text holds only comments.";

export const DATABEND_UNTERMINATED_SPAN =
  "A quote or comment in this text never closes, so Studio cannot tell where the statement ends.";

export const DATABEND_FORM_FEED =
  "This text holds a form feed, which ends a -- comment in Databend but not in Studio's reading. Remove it and run again.";

export const DATABEND_TAGGED_DOLLAR =
  "A dollar-quoted run in this text is tagged ($name$), which Databend reads as a variable and not a quote, so the text between two tags is code there and Studio cannot tell where the statement ends. Use $$ quoting and run again.";

export const DATABEND_IDENTIFIER_DOLLAR =
  "A $$ run in this text follows a name with no space, which Databend reads as part of the name and not a quote, so Studio cannot tell where the statement ends. Put a space before the $$ and run again.";

export const DATABEND_STAGE_RUN_ON =
  "A stage name (@...) in this text holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, so Studio cannot tell where the statement ends. End the name with a space, or write the location quoted ('@stage/path') where the statement takes one, and run again.";

export const DATABEND_HINT_SEMICOLON =
  "An optimizer hint (/*+ ... */) in this text holds a semicolon, which Databend reads as code and Studio as a comment. Remove the semicolon from the hint and run again.";

export const DATABEND_HINT_TOKEN =
  "An optimizer hint (/*+ ... */) in this text holds a character that can make Databend end the hint at a later */ than Studio does, so Studio cannot tell which statement runs. Keep the hint to names, numbers and plain quoted values, and run again.";

const GRAMMAR = resolveSqlGrammar("databend");

/** Databend's only dollar literal; any other tag opens a variable token there. */
const DOLLAR_LITERAL_OPENER = "$$";

/**
 * The characters that end a stage token, from the lexer's `[^\s,`;'"()]`. That `\s` is Unicode White_Space, which
 * JavaScript's `\s` is not: measured on v1.2.951, U+0085 ends a stage name and U+FEFF does not.
 */
const STAGE_END = /[\p{White_Space},`;'"()]/u;

/**
 * Where the stage token whose `@` is at `index` ends, or `undefined` when the span reader reads part of it as other
 * than plain code: a backslash, which takes the quote or space after it into the name, or any run the span reader
 * opens there (`--`, `/*`, `$$`, `[`), which Databend reads as part of the name and the span reader can end past it.
 */
function plainStageEnd(sql: string, index: number): number | undefined {
  let i = index + 1;
  while (i < sql.length && !STAGE_END.test(sql[i])) {
    if (sql[i] === "\\" || readSqlSpan(sql, i, GRAMMAR) !== null) return undefined;
    i++;
  }
  return i;
}

/**
 * Whether the `@` at `index` ends a `<@` operator (`ArrowAt`), the one operator that starts with another character and
 * takes an `@` in. The lexer takes the longest token, so a run of `<` is read in pairs from its start, `<<` before
 * `<@`: an odd run ends in `<@`, and after an even one the `@` opens a stage token. The walk reaches an `@` only past
 * every span and stage token, so the run before it starts a token.
 */
function endsArrowAt(sql: string, index: number): boolean {
  let start = index;
  while (start > 0 && sql[start - 1] === "<") start--;
  return (index - start) % 2 === 1;
}

/** Whether the character before `index` continues a Databend identifier, which takes `$` into its tail. */
function continuesIdentifier(sql: string, index: number): boolean {
  return index > 0 && (IDENTIFIER_PART.test(sql[index - 1]) || sql[index - 1] === "$");
}

/** A quoted value with no backslash, which Databend's string token and a plain pairing of quotes end at the same place. */
const HINT_PLAIN_LITERAL = /'[^'\\]*'/g;

/**
 * What can start a token that runs past the star-slash the span reader ends a hint at, once plain quoted values are gone:
 * any other quote or backslash, `$` (a `$$` string or a name that runs into one), a stage name, `~` (`~*` and `!~*`
 * take the `*`) and the two comment forms.
 */
const HINT_RUN_ON = /['"`\\$@~]|--|\/\*/;

/** The first code-level construct Databend's lexer ends somewhere the span reader does not, as its refusal. */
function lexerDisagreement(sql: string): string | null {
  let i = 0;

  while (i < sql.length) {
    // A `[` is stepped into, not over, so an array literal's contents are walked as the rest of the code is.
    const span = sql[i] === "[" ? null : readSqlSpan(sql, i, GRAMMAR);
    if (span === null) {
      if (sql[i] !== "@" || endsArrowAt(sql, i)) {
        i++;
        continue;
      }
      // The whole stage token is code to both readers when it ends plainly, so the walk resumes after it.
      const end = plainStageEnd(sql, i);
      if (end === undefined) return DATABEND_STAGE_RUN_ON;
      i = end;
      continue;
    }
    if (span.kind === "dollar-string" && !sql.startsWith(DOLLAR_LITERAL_OPENER, i)) return DATABEND_TAGGED_DOLLAR;
    if (span.kind === "dollar-string" && continuesIdentifier(sql, i)) return DATABEND_IDENTIFIER_DOLLAR;
    if (span.kind === "block-comment" && sql.startsWith("/*+", i)) {
      if (sql.slice(i, span.end).includes(";")) return DATABEND_HINT_SEMICOLON;
      if (HINT_RUN_ON.test(sql.slice(i + 3, span.end - 2).replace(HINT_PLAIN_LITERAL, ""))) return DATABEND_HINT_TOKEN;
    }
    i = span.end;
  }

  return null;
}

/** The refusal for this statement text, or `null` when it may be sent. */
export function databendStatementRefusal(sql: string): string | null {
  if (sql.includes("\f")) return DATABEND_FORM_FEED;
  if (hasUnterminatedSpan(sql, GRAMMAR)) return DATABEND_UNTERMINATED_SPAN;

  const disagreement = lexerDisagreement(sql);
  if (disagreement !== null) return disagreement;

  const count = countCodeStatements(sql, GRAMMAR);
  if (count === 0) return DATABEND_NO_STATEMENT;
  if (count > 1) return DATABEND_MULTIPLE_STATEMENTS;
  return null;
}
