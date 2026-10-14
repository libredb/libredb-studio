import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readSqlSpan } from "@/lib/sql/spans";

/**
 * The refusals made before any call to Spark, each read under the Spark grammar row so
 * the statement Spark parses is the one Studio's confirmation gate and row limiter read. Pure: no I/O, no logger.
 */
export const SPARK_STATEMENT_SENTENCES = Object.freeze({
  scriptBlock:
    "Spark SQL scripting blocks (BEGIN ... END) do not run in this version of Studio. Run the statements one at a time; temp views and SET values carry from one to the next within one run.",
  boundParameters: "Studio sends no bound parameters to Spark; write the value in the statement.",
  unicodeSpace:
    "This statement holds a non-breaking or other Unicode space outside a string. Spark reads it as a space and Studio's editor does not, so the confirmation prompt and the row limit could read the statement differently; replace it with an ordinary space.",
  uriForm:
    "This statement holds an address written without quotes, such as a://b, in which Studio's editor starts a comment or a raw string where Spark reads part of the address, so the confirmation prompt and the row limit could read the statement differently; put the address in backticks or quotes.",
});

const SPARK_GRAMMAR = resolveSqlGrammar("spark");
/** The Unicode spaces Spark 4.x reads as white space and Studio's span reader does not. */
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u202F\u205F\u3000]/;

/**
 * Spark's address form of IDENTIFIER (`SqlBaseLexer.g4` v4.2.0:655, v4.1.0:613): letters, `://`, then letters, ASCII
 * digits and `_ / - . ? = & # %`. Spark's lexer takes the longest token, so such a run is one token wherever a token
 * starts with it. A letter here is `\p{L}` or U+0345: Spark's lexer upper-cases each character before it matches one
 * (`UpperCaseCharStream.LA`, `parsers.scala` v4.2.0), and U+0345, a combining mark, upper-cases to U+0399, a letter.
 * The form is read in two runs, its letters and what follows `://`: `:` is no letter, so only the longest letter run
 * can be followed by `://`, and neither run is retried at a shorter length.
 */
const ADDRESS_LETTERS = /[\p{L}\u{345}]+/uy;
const ADDRESS_REST = /[\p{L}\u{345}0-9_/.?=&#%-]+/uy;
/**
 * A non-ASCII letter right after an ASCII letter or digit, the one place inside a word run where Spark's lexer can
 * start a token: it ends a decimal such as `1.5` (also `1.5D`, `1.5BD`, `1.5E3`) before any character but `A-Z`, `0-9`
 * and `_` (`isValidDecimal`, `SqlBaseLexer-v4.2.0.g4:42-50`; the number rules, `:627-646`), so in `1.5é://x--y` an
 * address starts at `é`. The rule also tries `é` in `x1é://y--z`, which Spark reads as one name: refusing that text is
 * the accepted cost of a rule that reads no number.
 */
const LATE_START = /(?<=[A-Za-z0-9])(?![\x00-\x7F])\p{L}/u;
/**
 * What a try that found no address steps over: the letters it started at, an address's letters U+0345 included, since
 * an address starting at any of them would need the same `://` right after them, then the rest of the word run
 * (Spark's other IDENTIFIER form: letters, ASCII digits and `_`) up to its next `LATE_START`, where the next try starts.
 * Empty at any other character, which the walk steps over by one. Each character is read a bounded number of times, so
 * the walk stays linear however many `LATE_START`s one word holds and however long a run of U+0345 is.
 */
const WORD_STEP = new RegExp(String.raw`[\p{L}\u{345}]*(?:(?!${LATE_START.source})[\p{L}0-9_])*`, "uy");

/**
 * The script-block refusal when the statement's leading keyword under the Spark grammar is BEGIN. Spark's lexer
 * upper-cases each character before it matches a token (`UpperCaseCharStream.LA`, `parsers.scala` v4.2.0), and U+0131,
 * the dotless i, upper-cases to I, so the keyword is read with each U+0131 as I. U+017F, the long s, is the one other
 * character that upper-cases into `A-Z`, to S, which BEGIN does not hold.
 */
export function scriptBlockRefusal(sql: string): string | undefined {
  return readLeadingKeyword(sql.replaceAll("\u0131", "I"), SPARK_GRAMMAR)?.keyword === "BEGIN"
    ? SPARK_STATEMENT_SENTENCES.scriptBlock
    : undefined;
}

/**
 * The Unicode-space refusal when one of those spaces stands at a code position: outside every string, raw string,
 * dollar string, quoted name and comment span of `readSqlSpan`; the contents of a subscript span read as code. A `[`
 * reads as code without a call to `readSqlSpan`, the one character the walk does not hand it: under the Spark row a
 * `[` opens no span but a subscript, which `readSqlSpan` reads to the matching `]`, or to the end of the text when
 * none closes it, and a walk that then stepped one character into it would read the rest of the text again at each
 * nested or unclosed `[`, quadratic in them.
 */
export function unicodeSpaceRefusal(sql: string): string | undefined {
  let index = 0;
  while (index < sql.length) {
    const span = sql[index] === "[" ? null : readSqlSpan(sql, index, SPARK_GRAMMAR);
    if (span === null || span.kind === "subscript") {
      if (UNICODE_SPACE.test(sql[index])) return SPARK_STATEMENT_SENTENCES.unicodeSpace;
      index += 1;
    } else {
      index = span.end;
    }
  }
  return undefined;
}

/** The address form that starts at `index` (`ADDRESS_LETTERS`, `://`, `ADDRESS_REST`), or undefined. */
function addressAt(sql: string, index: number): string | undefined {
  ADDRESS_LETTERS.lastIndex = index;
  if (!ADDRESS_LETTERS.test(sql) || !sql.startsWith("://", ADDRESS_LETTERS.lastIndex)) return undefined;
  ADDRESS_REST.lastIndex = ADDRESS_LETTERS.lastIndex + 3;
  return ADDRESS_REST.test(sql) ? sql.slice(index, ADDRESS_REST.lastIndex) : undefined;
}

/**
 * The address refusal when an address written without quotes stands at a code position in one of the three shapes
 * where Studio's span reader starts a comment or a raw string at a character Spark reads as part of the address: a
 * `--` inside it, a final `/` before `*`, a final `r` or `R` before `'` or `"`. Spans are stepped over as in
 * `unicodeSpaceRefusal` (a `[` and the contents of a subscript read as code), and code a word at a time
 * (`WORD_STEP`), so an address is tried where a token starts: after a code point that is not a letter, an ASCII digit
 * or `_`, and at `LATE_START`, a non-ASCII letter right after an ASCII letter or digit. An address in no such shape
 * reads alike in both and is stepped over.
 */
export function uriFormRefusal(sql: string): string | undefined {
  let index = 0;
  while (index < sql.length) {
    const span = sql[index] === "[" ? null : readSqlSpan(sql, index, SPARK_GRAMMAR);
    if (span !== null && span.kind !== "subscript") {
      index = span.end;
      continue;
    }
    const address = addressAt(sql, index);
    if (address === undefined) {
      // WORD_STEP matches here, empty at a character that is no part of a word, and leaves lastIndex at its end.
      WORD_STEP.lastIndex = index;
      index = Math.max(WORD_STEP.test(sql) ? WORD_STEP.lastIndex : index, index + 1);
      continue;
    }
    const next = sql[index + address.length];
    if (
      address.includes("--") ||
      (address.endsWith("/") && next === "*") ||
      (/[rR]$/.test(address) && (next === "'" || next === '"'))
    ) {
      return SPARK_STATEMENT_SENTENCES.uriForm;
    }
    index += address.length;
  }
  return undefined;
}
