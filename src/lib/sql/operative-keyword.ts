/**
 * Which keyword actually OPERATES a SQL statement.
 *
 * For every statement but one that leads with `WITH`, that is the leading keyword
 * and this module answers exactly what `leading-keyword.ts` does. A `WITH` is the
 * exception: its CTE list is a preamble, and the statement the server executes is
 * whatever follows the list. `WITH t AS (…) INSERT INTO … SELECT …` is an INSERT.
 *
 * The query limiter used to type a `WITH` by asking whether the word `SELECT`
 * appeared anywhere in its text. The `INSERT … SELECT` idiom supplies that word
 * itself, so an ordinary data-modifying CTE was typed `SELECT` and a bound was
 * appended to it. In PostgreSQL that bound applies to the rows the statement
 * WRITES: it committed at most the default limit of them while the UI reported a
 * truncated result set (#287). Every other failure in this family costs an
 * over-large read; this one costs a partially committed write, which re-running
 * the query cannot undo.
 *
 * The explain guard's `hasDataModifyingStatement` (`lib/explain/select-prefix.ts`)
 * answers a similar-looking question and is deliberately NOT reused here. It is a
 * whole-text `/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i` that over-refuses on purpose,
 * because its cost of being wrong is a disabled EXPLAIN button. Inverted into the
 * limiter the same over-detection costs a BOUND: a read-only CTE whose text merely
 * quotes a write keyword (`FROM "delete_queue"`, `WHERE action = 'delete'`) would
 * return every row, re-opening the unbounded read #275 closed. Explain needs a
 * SAFE answer, the limiter needs a PRECISE one, so this reads the grammar.
 */

import { readLeadingKeyword, type LeadingKeyword } from "./leading-keyword";
import { IDENTIFIER_PART, IDENTIFIER_START, readSqlSpan } from "./spans";

/** A word (identifier or keyword) and where it ends, or `null` if none starts here. */
interface Word {
  text: string;
  end: number;
}

/**
 * A word runs over the shared identifier alphabet, plus `$` after the first
 * character: it is legal inside a MySQL identifier and after the first character
 * in PostgreSQL. It stays out of the START position so a dollar-quoted string is
 * still read as the literal it is.
 */
function readWord(sql: string, index: number): Word | null {
  if (index >= sql.length || !IDENTIFIER_START.test(sql[index])) return null;

  let end = index + 1;
  while (end < sql.length && (IDENTIFIER_PART.test(sql[end]) || sql[end] === "$")) end++;

  // Upper-cased for the keyword comparisons below. Every keyword this module
  // tests for is ASCII, so the locale-independent mapping is all it needs.
  return { text: sql.slice(index, end).toUpperCase(), end };
}

/**
 * The next index at which the statement's own code resumes, or `-1` when it never
 * does - the input ended, or ended inside a comment, so there is nothing further
 * to read and no honest way to guess what it would have been.
 */
function skipTrivia(sql: string, from: number): number {
  let i = from;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i);
    if (span === null) return i;
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return i;
    if (!span.terminated) return -1;
    i = span.end;
  }

  return -1;
}

/**
 * The index past the `)` that closes the paren at `open`, or `-1` when it is never
 * closed.
 *
 * Literals and comments are skipped whole, so a paren inside a string, a quoted
 * identifier, a dollar-quoted body or a comment cannot close a CTE definition.
 * That is the case a naive scan gets wrong in the direction that matters: stopping
 * at the first `)` inside a definition would put the reader in the middle of the
 * CTE body and let a `SELECT` there answer for the whole statement.
 */
function skipParenthesised(sql: string, open: number): number {
  let depth = 0;
  let i = open;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i);
    if (span !== null) {
      if (!span.terminated) return -1;
      i = span.end;
      continue;
    }

    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }

  return -1;
}

/** The index past a CTE's name - a bare word or a quoted identifier - or `-1`. */
function skipCteName(sql: string, index: number): number {
  const span = readSqlSpan(sql, index);
  if (span !== null) {
    // A quoted identifier is a name; a string or dollar-quoted body is not, and
    // trivia has already been skipped by the caller.
    if (span.kind === "quoted-identifier" && span.terminated) return span.end;
    return -1;
  }

  // MSSQL brackets, accepted HERE and not in `readSqlSpan`: in a name position
  // `[…]` can only be a quoted identifier, while elsewhere `a[1]` is array
  // subscripting in PostgreSQL and ClickHouse, which a literal reader must not
  // swallow. Without this a bracketed CTE name would read as undeterminable and
  // the statement would silently lose its bound.
  if (sql[index] === "[") {
    let i = index + 1;
    while (i < sql.length) {
      if (sql[i] === "]") {
        // MSSQL escapes a closing bracket by doubling it, the same rule the
        // quoted forms use.
        if (sql[i + 1] === "]") {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i++;
    }
    return -1;
  }

  return readWord(sql, index)?.end ?? -1;
}

/**
 * The keyword after a `WITH` statement's CTE list.
 *
 * Walks the list's real grammar - `[RECURSIVE] name [(cols)] AS [[NOT]
 * MATERIALIZED] (body) [, …]` - rather than searching the text, because every
 * text search over a CTE can be answered by the CTE's own body. Anything that
 * does not match answers `null`: see the bias note on the exported function.
 */
function readKeywordAfterCteList(sql: string, afterWith: number): LeadingKeyword | null {
  let i = skipTrivia(sql, afterWith);
  if (i < 0) return null;

  const recursive = readWord(sql, i);
  if (recursive?.text === "RECURSIVE") {
    i = skipTrivia(sql, recursive.end);
    if (i < 0) return null;
  }

  for (;;) {
    const afterName = skipCteName(sql, i);
    if (afterName < 0) return null;
    i = skipTrivia(sql, afterName);
    if (i < 0) return null;

    // An optional column list: `WITH t (a, b) AS (…)`. It closes back to depth 0
    // exactly as the body does, which is why the two are told apart by position in
    // the grammar rather than by "the last paren that closed".
    if (sql[i] === "(") {
      const afterColumns = skipParenthesised(sql, i);
      if (afterColumns < 0) return null;
      i = skipTrivia(sql, afterColumns);
      if (i < 0) return null;
    }

    const as = readWord(sql, i);
    if (as?.text !== "AS") return null;
    i = skipTrivia(sql, as.end);
    if (i < 0) return null;

    // PostgreSQL's inlining hints sit between `AS` and the body.
    let hint = readWord(sql, i);
    if (hint?.text === "NOT") {
      i = skipTrivia(sql, hint.end);
      if (i < 0) return null;
      hint = readWord(sql, i);
      if (hint?.text !== "MATERIALIZED") return null;
    }
    if (hint?.text === "MATERIALIZED") {
      i = skipTrivia(sql, hint.end);
      if (i < 0) return null;
    }

    if (sql[i] !== "(") return null;
    const afterBody = skipParenthesised(sql, i);
    if (afterBody < 0) return null;
    i = skipTrivia(sql, afterBody);
    if (i < 0) return null;

    if (sql[i] !== ",") break;
    i = skipTrivia(sql, i + 1);
    if (i < 0) return null;
  }

  const operative = readWord(sql, i);
  if (operative === null) return null;

  return { keyword: operative.text, start: i, end: operative.end };
}

/**
 * The keyword that operates this statement, or `null` when there is none to read.
 *
 * `null` covers both "no statement here" (empty, whitespace, comments only) and
 * "the statement's shape cannot be determined" - an unclosed CTE body, a malformed
 * CTE list, an unterminated comment or literal, or a `WITH` with nothing after its
 * list. Both answer `null` on purpose: callers use this to decide whether to
 * REWRITE a statement, and the two ways of being wrong are not equally bad.
 * Declining to bound a statement costs an over-large read the user can re-run;
 * bounding one that writes commits part of it. So undeterminable input is never
 * reported as a read.
 *
 * Two known shapes are WELL FORMED and still answer not-`SELECT`, so they lose a
 * bound they used to get. Both are reads, so the cost is an over-large result set
 * and neither can bound a write; each is pinned by a test so the gap is a decision
 * rather than a surprise:
 *
 * - A recursive CTE's optional `SEARCH` / `CYCLE` clause sits between the list and
 *   the operative statement, and this reader stops at the first word after the
 *   list, so it reports `SEARCH` there.
 * - ClickHouse's `WITH <expr> AS <alias>` form puts an expression where the
 *   standard form puts a name; reading it needs an expression parser. That form is
 *   idiomatic there and this is a real regression for it, recorded for follow-up
 *   rather than papered over - ClickHouse has no data-modifying CTE, so nothing on
 *   that provider is made unsafe by it.
 *
 * Two more go the OTHER way, and are recorded here precisely because they are the
 * direction this function otherwise promises to avoid - both are pinned by tests:
 *
 * - Oracle's alternative quoting (`q'{…}'`) is not a literal to `readSqlSpan`, so
 *   its body is walked as code, and a `)` or a keyword written inside one moves the
 *   reading. Unreachable in Oracle itself, which has no `WITH … DELETE`, and no
 *   other dialect here has the form.
 * - A MySQL line comment whose first character makes a PostgreSQL operator (`#-`,
 *   `#>`) is code by the deliberate trade `spans.ts` documents, so a paren inside
 *   such a comment can end a CTE body early. Contrived, and paid for on purpose:
 *   closing it would cost every PostgreSQL jsonb-operator CTE its bound.
 */
export function readOperativeKeyword(sql: string): LeadingKeyword | null {
  const leading = readLeadingKeyword(sql);
  if (leading === null || leading.keyword !== "WITH") return leading;

  return readKeywordAfterCteList(sql, leading.end);
}
