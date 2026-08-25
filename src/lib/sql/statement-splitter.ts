/**
 * Where a multi-statement buffer's statements begin and end.
 *
 * The boundary is a `;` that is CODE, so the whole job is knowing which
 * characters are code - and that is `spans.ts`'s job, under the dialect facts
 * `grammar.ts` carries. This module used to inline its own scan of strings,
 * comments and dollar-quoting instead, wound together with the line counting it
 * needs, and it knew none of those facts: `#` was code, `q'…'` was a name
 * followed by a string, `[…]` and `` `…` `` were nothing at all, and a block
 * comment always ended at the first closer. So it disagreed with every other
 * reader in this folder about where a statement ends, and unlike them its
 * disagreement is not a missing bound: `/api/db/multi-query` RUNS each fragment
 * this returns.
 *
 * The sharp shape, and why S1 is a safety fix. Measured on postgres 18, the text
 *
 *     /* a /* b *\/ ; DROP TABLE users; -- *\/ SELECT 1
 *
 * is ONE read: PostgreSQL nests block comments, so everything up to the second
 * closer is comment text and the statement is `SELECT 1`. The flat, dialect-blind
 * reading cut it into three fragments whose SECOND is a bare `DROP TABLE users`,
 * the multi-statement route ran them in order, and the confirmation gate said
 * nothing because it reads the whole editor text - where there is no operative
 * keyword to find. The same family as #300, with the blast radius of an executed
 * statement rather than a missing row bound.
 *
 * S1 fixed the reading and left one fact still missing from the shared module, which
 * kept the same defect alive on three shipped engines: CQL and ClickHouse read `//`
 * to the end of the line, so
 *
 *     SELECT id FROM probe.customers // note; DROP TABLE probe.customers
 *
 * is ONE statement to Cassandra 5.0.9, ScyllaDB 2026.2.4 and ClickHouse 26.7.1
 * (measured 2026-08-25: the SELECT answers and the DROP does not run), and this
 * splitter returned two fragments whose second was a bare DROP. The confirmation gate
 * did prompt - the two readers agreed, which is what S1 bought - but confirming ran a
 * statement the operator's text never contained. `grammar.ts` carries the fact now
 * (`doubleSlashComment`), so this file needed no change of its own: reading through
 * `spans.ts` is what makes a new dialect fact arrive here for free.
 *
 * A caller that names no dialect gets `DEFAULT_SQL_GRAMMAR`, the same stated
 * default every other reader here applies to a dialect-less call, rather than the
 * ad-hoc reading this file used to have. It is a decision, not an absence: pinned
 * by its own tests.
 */

import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "./grammar";
import { readSqlSpan } from "./spans";

export interface SplitStatement {
  sql: string;
  /** 0-based line number where this statement starts in the original text */
  startLine: number;
  /**
   * Where this statement's TRIMMED text sits in the original input, as a
   * `[start, end)` offset pair.
   *
   * Carried because a caller that has a CURSOR needs to know which statement it is
   * in, and a line number cannot answer that for a multi-statement line. The editor's
   * "run the statement I am in" reader used to answer it with `lastIndexOf(";")` -
   * no spans, no dialect, not even a string-literal check - so it is the third reader
   * of this question and the one whose answer is what actually gets SENT.
   */
  start: number;
  end: number;
}

/** Newlines in `text[from, to)`, which is how a span's height reaches the line count. */
function countNewlines(text: string, from: number, to: number): number {
  let newlines = 0;
  for (let i = from; i < to; i++) {
    if (text[i] === "\n") newlines++;
  }
  return newlines;
}

export function splitStatements(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): SplitStatement[] {
  const statements: SplitStatement[] = [];
  let segmentStart = 0;
  let statementStartLine = 0;
  let currentLine = 0;
  let i = 0;

  const push = (end: number) => {
    const raw = input.slice(segmentStart, end);
    const sql = raw.trim();
    if (sql.length === 0) return;
    // The offsets describe the TRIMMED text, so a caller can slice the original and get
    // back exactly `sql`: the leading whitespace this trim drops is not part of the
    // statement, and a cursor sitting in it belongs to no statement in particular.
    const leading = raw.length - raw.trimStart().length;
    statements.push({
      sql,
      startLine: statementStartLine,
      start: segmentStart + leading,
      end: segmentStart + leading + sql.length,
    });
  };

  while (i < input.length) {
    const span = readSqlSpan(input, i, grammar);
    if (span !== null) {
      // An UNTERMINATED span reaches the end of the input, so this branch also
      // carries the fail-safe direction the rest of this folder keeps: text no
      // reader can resolve yields no boundary at all rather than a guessed one.
      // The buffer then takes the single-statement route, and the confirmation
      // gate already asks about an unresolvable run (#297).
      currentLine += countNewlines(input, i, span.end);
      i = span.end;
      continue;
    }

    if (input[i] !== ";") {
      i++;
      continue;
    }

    push(i);
    i++;
    // A statement's reported line is where its TEXT starts, so the run of
    // whitespace after the terminator belongs to neither statement. Comments are
    // deliberately not skipped: a note above a statement is part of it, which is
    // what keeps an annotated final SELECT recognisable to the route's limiter
    // (#281).
    const trivia = readSqlSpan(input, i, grammar);
    if (trivia !== null && trivia.kind === "whitespace") {
      currentLine += countNewlines(input, i, trivia.end);
      i = trivia.end;
    }
    segmentStart = i;
    statementStartLine = currentLine;
  }

  push(input.length);

  return statements;
}

/**
 * Check if input contains multiple statements
 */
export function isMultiStatement(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): boolean {
  return splitStatements(input, grammar).length > 1;
}
