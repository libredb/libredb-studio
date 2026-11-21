import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";

/**
 * The refusal the DuckDB provider makes before the engine reads a statement, read under the DuckDB grammar row so the
 * statement DuckDB parses is the one Studio's confirmation gate and row limiter read. Pure: no I/O, no logger.
 */
export const DUCKDB_UNICODE_SPACE_SENTENCE =
  "This statement holds a non-breaking or other Unicode space outside a string. DuckDB reads it as a space and Studio's editor does not, so the confirmation prompt and the row limit could read the statement differently; replace it with an ordinary space.";

const DUCKDB_GRAMMAR = resolveSqlGrammar("duckdb");
/**
 * The characters DuckDB 1.5.5 reads as a space between two code words and Studio's span reader does not, measured one
 * by one: `SELECT<c>1` answers 1 and `INSERT<c>OR<c>REPLACE` replaced a row for each of them. With U+0085, U+1680,
 * U+180E, U+200C, U+200D, U+2028 or U+2029 there the statement is a Parser Error instead.
 */
const UNICODE_SPACE = /[\u00A0\u2000-\u200B\u202F\u205F\u2060\u3000\uFEFF]/;

/**
 * The Unicode-space refusal when one of those spaces stands at a code position: outside every string, dollar string,
 * quoted name and comment span of `readSqlSpan`; the contents of a subscript read as code. A `[` reads as code without
 * a call to `readSqlSpan`, the one character the walk does not hand it: under the DuckDB row a `[` opens a subscript
 * span, which `readSqlSpan` reads to the matching `]`, or to the end of the text when none closes it, and stepping
 * over that span would skip code, while stepping one character into it would read the rest of the text again at each
 * nested or unclosed `[`, quadratic in them. The Spark provider's `unicodeSpaceRefusal` is the same walk under the
 * Spark row.
 */
export function unicodeSpaceRefusal(sql: string): string | undefined {
  let index = 0;
  while (index < sql.length) {
    const span = sql[index] === "[" ? null : readSqlSpan(sql, index, DUCKDB_GRAMMAR);
    if (span === null) {
      if (UNICODE_SPACE.test(sql[index])) return DUCKDB_UNICODE_SPACE_SENTENCE;
      index += 1;
    } else {
      index = span.end;
    }
  }
  return undefined;
}
