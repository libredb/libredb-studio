/**
 * Which keyword actually OPERATES a SQL statement.
 *
 * For every statement but one that leads with `WITH`, that is the leading keyword
 * and this module answers exactly what `leading-keyword.ts` does. A `WITH` is the
 * exception: its CTE list is a preamble, and the statement the server executes is
 * whatever follows the list. `WITH t AS (…) INSERT INTO … SELECT …` is an INSERT.
 *
 * A list element comes in two shapes across the dialects here - the standard
 * `name [(cols)] AS (body)` and ClickHouse's `<expr> AS <alias>` - and both are
 * read, because an element this walker cannot cross ends the reading and costs the
 * statement its bound. Recognising only the standard one is how ClickHouse's own
 * CTE idiom stopped being limited (#291).
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
import { readSqlSpan } from "./spans";
import { readSqlWord } from "./words";

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

/**
 * The index past a `[…]` run, or `-1` when it never closes.
 *
 * Brackets are read HERE and not in `readSqlSpan`: in a name position `[…]` can
 * only be a quoted identifier, while elsewhere `a[1]` is array subscripting in
 * PostgreSQL and ClickHouse, which a literal reader must not swallow. Two readers
 * below want the run skipped whole - a name may be written `[my cte]`, and a
 * ClickHouse expression may be the array literal `[1, 2, 3]`, whose commas would
 * otherwise look like the end of a CTE-list element.
 *
 * The run is scanned for its `]` without consulting `readSqlSpan`, so a `]` written
 * inside a string closes it early (`WITH map['a]'] AS v SELECT 1` reads as
 * undeterminable and loses its bound). That is the safe direction and it is what a
 * bracketed NAME already did before this reader existed; closing it needs a
 * bracket run that skips spans, which is a change of its own.
 */
function skipBracketed(sql: string, open: number): number {
  let i = open + 1;

  while (i < sql.length) {
    if (sql[i] === "]") {
      // MSSQL escapes a closing bracket by doubling it, the same rule the quoted
      // forms use.
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

/** The index past a CTE's name - a bare word or a quoted identifier - or `-1`. */
function skipCteName(sql: string, index: number): number {
  const span = readSqlSpan(sql, index);
  if (span !== null) {
    // A quoted identifier is a name; a string or dollar-quoted body is not, and
    // trivia has already been skipped by the caller.
    if (span.kind === "quoted-identifier" && span.terminated) return span.end;
    return -1;
  }

  if (sql[index] === "[") return skipBracketed(sql, index);

  return readSqlWord(sql, index)?.end ?? -1;
}

/**
 * How far one element of a CTE list reaches when read as the standard shape,
 * `name [(cols)] AS [[NOT] MATERIALIZED] (body)`.
 *
 * `other-shape` is what lets ClickHouse's `<expr> AS <alias>` element be read
 * instead, and it is reported at exactly the two places the shapes diverge: the
 * head is not a name (`1`, `[1, 2]`, `(SELECT …)`, `'x'`), or what follows the
 * element's `AS` is not a body. Everything else is `malformed` - the input opened
 * the standard shape and then broke, so re-reading it as an expression would be
 * guessing at the same input twice. The distinction is load-bearing:
 * `WITH t AS NOT LAZY (SELECT 1) SELECT 2` has to stay undeterminable rather than
 * read `NOT` as an alias and `LAZY` as the keyword that operates the statement.
 */
type StandardElement = { kind: "element"; end: number } | { kind: "other-shape" } | { kind: "malformed" };

function readStandardElement(sql: string, index: number): StandardElement {
  const afterName = skipCteName(sql, index);
  if (afterName < 0) return { kind: "other-shape" };

  let i = skipTrivia(sql, afterName);
  if (i < 0) return { kind: "malformed" };

  // An optional column list: `WITH t (a, b) AS (…)`. It closes back to depth 0
  // exactly as the body does, which is why the two are told apart by position in
  // the grammar rather than by "the last paren that closed". A function call's
  // argument list (`now()`) is consumed here too and reaches the same index, so the
  // two need no telling apart: what follows the `AS` decides the shape.
  if (sql[i] === "(") {
    const afterColumns = skipParenthesised(sql, i);
    if (afterColumns < 0) return { kind: "malformed" };
    i = skipTrivia(sql, afterColumns);
    if (i < 0) return { kind: "malformed" };
  }

  const as = readSqlWord(sql, i);
  if (as?.text !== "AS") return { kind: "other-shape" };
  i = skipTrivia(sql, as.end);
  if (i < 0) return { kind: "malformed" };

  // PostgreSQL's inlining hints sit between `AS` and the body. Neither word exists
  // in the expression shape, so reading one COMMITS this element to the standard
  // one: from here a missing body is malformed input, not an alias.
  let hint = readSqlWord(sql, i);
  const committed = hint?.text === "NOT" || hint?.text === "MATERIALIZED";
  if (hint?.text === "NOT") {
    i = skipTrivia(sql, hint.end);
    if (i < 0) return { kind: "malformed" };
    hint = readSqlWord(sql, i);
    if (hint?.text !== "MATERIALIZED") return { kind: "malformed" };
  }
  if (hint?.text === "MATERIALIZED") {
    i = skipTrivia(sql, hint.end);
    if (i < 0) return { kind: "malformed" };
  }

  if (sql[i] !== "(") return { kind: committed ? "malformed" : "other-shape" };

  const afterBody = skipParenthesised(sql, i);
  if (afterBody < 0) return { kind: "malformed" };

  return { kind: "element", end: afterBody };
}

/**
 * The index past a ClickHouse `<expr> AS <alias>` element, or `-1`.
 *
 * The expression is not parsed, only scanned for the `AS` that ends it: at paren
 * depth 0, outside every literal, comment and bracketed run. That is where the
 * element's own `AS` is and where an expression's internal one (`CAST(x AS Int32)`)
 * is not - which is all this module needs, since it never has to understand the
 * expression, only find where it stops.
 */
function skipExpressionElement(sql: string, index: number): number {
  let depth = 0;
  let i = index;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i);
    if (span !== null) {
      if (!span.terminated) return -1;
      i = span.end;
      continue;
    }

    const ch = sql[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      // More closing parens than opening ones: whatever this is, it is not one
      // expression, and a reader that carried on would read the statement after it
      // as part of the CTE list.
      if (depth < 0) return -1;
      i++;
      continue;
    }
    if (ch === "[") {
      const afterBracket = skipBracketed(sql, i);
      if (afterBracket < 0) return -1;
      i = afterBracket;
      continue;
    }
    // A comma at depth 0 ends the element, and this one got there without an `AS`,
    // so there is no element here to read.
    if (ch === "," && depth === 0) return -1;

    const word = readSqlWord(sql, i);
    if (word === null) {
      i++;
      continue;
    }
    if (depth === 0 && word.text === "AS") {
      const aliasAt = skipTrivia(sql, word.end);
      if (aliasAt < 0) return -1;
      // The alias is a plain name. Anything else - a body, a literal - means this
      // is not the shape either, and `-1` reaches the caller as "cannot tell".
      return skipCteName(sql, aliasAt);
    }
    i = word.end;
  }

  return -1;
}

/**
 * The index past one element of a CTE list, or `-1` when it cannot be read.
 *
 * Two shapes, tried in this order:
 *
 * - the standard `name [(cols)] AS [[NOT] MATERIALIZED] (body)`, which every
 *   dialect here has and the only one that can carry a WRITE;
 * - ClickHouse's `<expr> AS <alias>`, which puts an expression where the standard
 *   shape puts a name (#291). It is reached only where the standard read reports
 *   the element is not that shape at all, so adding it cannot retype a statement
 *   the standard shape already reads - which is what keeps #287's writing CTEs
 *   answering their own write keyword.
 */
function skipCteElement(sql: string, index: number): number {
  const standard = readStandardElement(sql, index);
  if (standard.kind === "element") return standard.end;
  if (standard.kind === "malformed") return -1;

  return skipExpressionElement(sql, index);
}

/**
 * The keyword after a `WITH` statement's CTE list.
 *
 * Walks the list's real grammar - `[RECURSIVE] <element> [, …]` - rather than
 * searching the text, because every text search over a CTE can be answered by the
 * CTE's own body. Anything that does not match answers `null`: see the bias note
 * on the exported function.
 */
function readKeywordAfterCteList(sql: string, afterWith: number): LeadingKeyword | null {
  let i = skipTrivia(sql, afterWith);
  if (i < 0) return null;

  const recursive = readSqlWord(sql, i);
  if (recursive?.text === "RECURSIVE") {
    i = skipTrivia(sql, recursive.end);
    if (i < 0) return null;
  }

  for (;;) {
    const afterElement = skipCteElement(sql, i);
    if (afterElement < 0) return null;
    i = skipTrivia(sql, afterElement);
    if (i < 0) return null;

    if (sql[i] !== ",") break;
    i = skipTrivia(sql, i + 1);
    if (i < 0) return null;
  }

  const operative = readSqlWord(sql, i);
  if (operative === null) return null;

  return { keyword: operative.text, start: i, end: operative.end };
}

/**
 * The keyword that operates this statement, or `null` when there is none to read.
 *
 * `null` covers both "no statement here" (empty, whitespace, comments only) and
 * "the statement's shape cannot be determined" - an unclosed CTE body, a CTE list
 * in which no element can be read, an unterminated comment or literal, or a `WITH`
 * with nothing after its list. Both answer `null` on purpose: callers use this to
 * decide whether to REWRITE a statement, and the two ways of being wrong are not
 * equally bad. Declining to bound a statement costs an over-large read the user can
 * re-run; bounding one that writes commits part of it. So input this reader cannot
 * cross is not reported as a read.
 *
 * Two known shapes are WELL FORMED and still answer not-`SELECT`, so they lose a
 * bound. Both are reads, so the cost is an over-large result set and neither can
 * bound a write; each is pinned by a test so the gap is a decision rather than a
 * surprise:
 *
 * - A recursive CTE's optional `SEARCH` / `CYCLE` clause sits between the list and
 *   the operative statement, and this reader stops at the first word after the
 *   list, so it reports `SEARCH` there.
 * - An expression element whose head reads as a NAME and whose alias is one of
 *   PostgreSQL's inlining hints (`WITH col AS materialized SELECT …`): the hint
 *   commits the element to the standard shape, which then wants a body. Accepting
 *   the hint as an alias instead is what would let `WITH t AS NOT LAZY (…)` report
 *   `LAZY` as the operative keyword, so the trade goes this way on purpose.
 *
 * Three more go the OTHER way, and are recorded here precisely because they are the
 * direction this function otherwise promises to avoid - each is pinned by a test:
 *
 * - Any element the standard read DECLINES - a head that is not a name, or an `AS`
 *   with no body after it - is re-read as an expression, and that read ends at the
 *   first `AS <name>` at paren depth 0 however far away it is. So
 *   `WITH 2 INSERT INTO users AS u SELECT 1` and
 *   `WITH x AS DELETE, foo AS (SELECT 1) SELECT 1` both answer `SELECT`. Reading an
 *   expression means knowing where it ends only by its `AS`, so this is the price of
 *   reading the shape at all. No dialect here accepts such text - a CTE element is a
 *   name or an expression, and neither is a statement - so the cost is a bound
 *   appended to text the server rejects either way, not a partially committed write.
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
