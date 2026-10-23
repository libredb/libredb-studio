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

import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "./grammar";
import { readLeadingKeyword, type LeadingKeyword } from "./leading-keyword";
import { readSqlSpan } from "./spans";
import { readSqlWord } from "./words";

/**
 * The next index at which the statement's own code resumes, or `-1` when it never
 * does - the input ended, or ended inside a comment, so there is nothing further
 * to read and no honest way to guess what it would have been.
 */
function skipTrivia(sql: string, from: number, grammar: SqlGrammar): number {
  let i = from;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
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
function skipParenthesised(sql: string, open: number, grammar: SqlGrammar): number {
  let depth = 0;
  let i = open;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
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

// A `[…]` run used to be scanned here, because a bracket is a quoted identifier in a
// name position and array subscripting elsewhere. `readSqlSpan` reads it now: the
// statement-end reader needed the same run to be opaque, and leaving two scanners
// for one delimiter is what this folder exists to stop. Both callers below reach it
// through the span branch, so both get the reading the DIALECT gives those
// characters (#295): a quoted name whose only escape is a doubled `]` in SQL Server
// and SQLite, or a nestable array or subscript whose contents are code in ClickHouse
// - where a `]` written inside a subscript key no longer ends the run and
// `WITH m['a]'] AS v SELECT v` keeps its bound. Only the name reading can BE a name,
// so a subscript reaches `skipCteName` as "not a name", which is what sends the
// element to the expression shape it actually is.

/** The index past a CTE's name - a bare word or a quoted identifier - or `-1`. */
function skipCteName(sql: string, index: number, grammar: SqlGrammar): number {
  const span = readSqlSpan(sql, index, grammar);
  if (span !== null) {
    // A quoted identifier is a name; a string or dollar-quoted body is not, and
    // trivia has already been skipped by the caller.
    if (span.kind === "quoted-identifier" && span.terminated) return span.end;
    return -1;
  }

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
type StandardElement = { kind: "element"; body: number; end: number } | { kind: "other-shape" } | { kind: "malformed" };

function readStandardElement(sql: string, index: number, grammar: SqlGrammar): StandardElement {
  const afterName = skipCteName(sql, index, grammar);
  if (afterName < 0) return { kind: "other-shape" };

  let i = skipTrivia(sql, afterName, grammar);
  if (i < 0) return { kind: "malformed" };

  // An optional column list: `WITH t (a, b) AS (…)`. It closes back to depth 0
  // exactly as the body does, which is why the two are told apart by position in
  // the grammar rather than by "the last paren that closed". A function call's
  // argument list (`now()`) is consumed here too and reaches the same index, so the
  // two need no telling apart: what follows the `AS` decides the shape.
  if (sql[i] === "(") {
    const afterColumns = skipParenthesised(sql, i, grammar);
    if (afterColumns < 0) return { kind: "malformed" };
    i = skipTrivia(sql, afterColumns, grammar);
    if (i < 0) return { kind: "malformed" };
  }

  const as = readSqlWord(sql, i);
  if (as?.text !== "AS") return { kind: "other-shape" };
  i = skipTrivia(sql, as.end, grammar);
  if (i < 0) return { kind: "malformed" };

  // PostgreSQL's inlining hints sit between `AS` and the body. Neither word exists
  // in the expression shape, so reading one COMMITS this element to the standard
  // one: from here a missing body is malformed input, not an alias.
  let hint = readSqlWord(sql, i);
  const committed = hint?.text === "NOT" || hint?.text === "MATERIALIZED";
  if (hint?.text === "NOT") {
    i = skipTrivia(sql, hint.end, grammar);
    if (i < 0) return { kind: "malformed" };
    hint = readSqlWord(sql, i);
    if (hint?.text !== "MATERIALIZED") return { kind: "malformed" };
  }
  if (hint?.text === "MATERIALIZED") {
    i = skipTrivia(sql, hint.end, grammar);
    if (i < 0) return { kind: "malformed" };
  }

  if (sql[i] !== "(") return { kind: committed ? "malformed" : "other-shape" };

  const afterBody = skipParenthesised(sql, i, grammar);
  if (afterBody < 0) return { kind: "malformed" };

  return { kind: "element", body: i, end: afterBody };
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
function skipExpressionElement(sql: string, index: number, grammar: SqlGrammar): number {
  let depth = 0;
  let i = index;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
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
    // A comma at depth 0 ends the element, and this one got there without an `AS`,
    // so there is no element here to read.
    if (ch === "," && depth === 0) return -1;

    const word = readSqlWord(sql, i);
    if (word === null) {
      i++;
      continue;
    }
    if (depth === 0 && word.text === "AS") {
      const aliasAt = skipTrivia(sql, word.end, grammar);
      if (aliasAt < 0) return -1;
      // The alias is a plain name. Anything else - a body, a literal - means this
      // is not the shape either, and `-1` reaches the caller as "cannot tell".
      return skipCteName(sql, aliasAt, grammar);
    }
    i = word.end;
  }

  return -1;
}

/**
 * One element of a CTE list: where it ends, and where its parenthesised body opens
 * when it has one. Only the standard shape has a body; an expression element is
 * `body: -1`, and it cannot carry a write.
 */
interface CteElement {
  body: number;
  end: number;
}

/**
 * One element of a CTE list, or `null` when it cannot be read.
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
function readCteElement(sql: string, index: number, grammar: SqlGrammar): CteElement | null {
  const standard = readStandardElement(sql, index, grammar);
  if (standard.kind === "element") return { body: standard.body, end: standard.end };
  if (standard.kind === "malformed") return null;

  const end = skipExpressionElement(sql, index, grammar);
  return end < 0 ? null : { body: -1, end };
}

/**
 * A `WITH` statement's CTE list, read: where each element's body opens, and where
 * the code after the list resumes.
 */
interface CteList {
  bodies: number[];
  after: number;
}

/**
 * The CTE list that starts after a `WITH`.
 *
 * Walks the list's real grammar - `[RECURSIVE] <element> [, …]` - rather than
 * searching the text, because every text search over a CTE can be answered by the
 * CTE's own body. Anything that does not match answers `null`: see the bias note
 * on `readOperativeKeyword`. A list with nothing after it is `null` as well.
 */
function readCteList(sql: string, afterWith: number, grammar: SqlGrammar): CteList | null {
  const bodies: number[] = [];
  let i = skipTrivia(sql, afterWith, grammar);
  if (i < 0) return null;

  const recursive = readSqlWord(sql, i);
  if (recursive?.text === "RECURSIVE") {
    i = skipTrivia(sql, recursive.end, grammar);
    if (i < 0) return null;
  }

  for (;;) {
    const element = readCteElement(sql, i, grammar);
    if (element === null) return null;
    if (element.body >= 0) bodies.push(element.body);
    i = skipTrivia(sql, element.end, grammar);
    if (i < 0) return null;

    if (sql[i] !== ",") break;
    i = skipTrivia(sql, i + 1, grammar);
    if (i < 0) return null;
  }

  return { bodies, after: i };
}

/** The keyword after a `WITH` statement's CTE list, or `null` when there is none to read. */
function readKeywordAfterCteList(sql: string, afterWith: number, grammar: SqlGrammar): LeadingKeyword | null {
  const list = readCteList(sql, afterWith, grammar);
  if (list === null) return null;

  const operative = readSqlWord(sql, list.after);
  if (operative === null) return null;

  return { keyword: operative.text, start: list.after, end: operative.end };
}

/**
 * The keywords that open a data-modifying statement a CTE body may hold.
 * `UPSERT` is CockroachDB's, which documents it as a CTE body; no other dialect
 * here has a statement by that name.
 */
const WRITE_KEYWORDS: ReadonlySet<string> = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT"]);

/**
 * The write a CTE list's bodies do, or `null` when every body reads.
 *
 * A body writes when its first word is a write keyword, or when it is a nested
 * `WITH` whose own list writes or whose operative keyword is one. Only the first
 * word of each body is read, so a write keyword the body merely mentions deeper in
 * its text - a table called `delete_queue`, a value `'delete'`, a subquery - never
 * counts, and neither does one in a literal or a comment.
 */
function readListWrite(sql: string, list: CteList, grammar: SqlGrammar): LeadingKeyword | null {
  for (const open of list.bodies) {
    const write = readBodyWrite(sql, open, grammar);
    if (write !== null) return write;
  }

  return null;
}

/** The write the parenthesised body opening at `open` does, or `null` when it reads. */
function readBodyWrite(sql: string, open: number, grammar: SqlGrammar): LeadingKeyword | null {
  // The body is closed, so code follows its `(`: at the least its `)`.
  const at = skipTrivia(sql, open + 1, grammar);
  const word = readSqlWord(sql, at);
  if (word === null) return null;

  const keyword = { keyword: word.text, start: at, end: word.end };
  if (WRITE_KEYWORDS.has(word.text)) return keyword;
  if (word.text !== "WITH") return null;

  // A nested list this reader cannot cross could hold anything, so it answers
  // the nested `WITH` itself rather than calling the body a read.
  const nested = readCteList(sql, word.end, grammar);
  if (nested === null) return keyword;
  const write = readListWrite(sql, nested, grammar);
  if (write !== null) return write;

  // The nested main query may be parenthesised, `WITH b AS (…) (SELECT …)`, and
  // is then read like a body.
  if (sql[nested.after] === "(") return readBodyWrite(sql, nested.after, grammar);

  const operative = readSqlWord(sql, nested.after);
  if (operative === null) return keyword;
  return WRITE_KEYWORDS.has(operative.text)
    ? { keyword: operative.text, start: nested.after, end: operative.end }
    : null;
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
 * - Oracle's alternate quoting (`q'{…}'`) is a literal only under a grammar that
 *   has the form, which is Oracle's alone (#292). Under any other - including the
 *   compatibility default - the body is walked as code, so a `)` or a keyword
 *   written inside one moves the reading. That is the honest answer there: no other
 *   dialect spells a literal that way, so those characters really are a name
 *   followed by an ordinary string - which is also how Oracle itself reads a name
 *   that merely ends in the tag's letters (`freq'x'`).
 * - A MySQL line comment whose first character makes a PostgreSQL operator (`#-`,
 *   `#>`) is code to a reader that was given NO dialect, so a paren inside such a
 *   comment can end a CTE body early. That is now only the dialect-less reading:
 *   pass MySQL's grammar and the comment is a comment, pass PostgreSQL's and the
 *   operator is an operator (#292). Every caller in this project passes one.
 */
export function readOperativeKeyword(sql: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): LeadingKeyword | null {
  const leading = readLeadingKeyword(sql, grammar);
  if (leading === null || leading.keyword !== "WITH") return leading;

  return readKeywordAfterCteList(sql, leading.end, grammar);
}

/**
 * The write keyword of the first CTE body that writes, or `null` when the statement
 * is not a `WITH`, its list cannot be read, or every body reads.
 *
 * `readOperativeKeyword` answers which statement runs AFTER the list, and a body
 * is not that statement - yet PostgreSQL runs a data-modifying body exactly once
 * and always to completion, however few of its rows the outer statement reads
 * (manual 7.8.4), and CockroachDB and YugabyteDB allow the same. So
 * `WITH d AS (DELETE … RETURNING *) SELECT * FROM d` is operated by a SELECT and
 * still deletes. The query limiter bounded it as a read, which made it pageable,
 * and every next page re-ran the DELETE in full. The limiter asks this reader as
 * well, and a statement that answers is not bounded.
 *
 * An unreadable list answers `null` here because `readOperativeKeyword` already
 * answers `null` for it, which the limiter never bounds.
 */
export function readCteBodyWrite(sql: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): LeadingKeyword | null {
  const leading = readLeadingKeyword(sql, grammar);
  if (leading === null || leading.keyword !== "WITH") return null;

  const list = readCteList(sql, leading.end, grammar);
  return list === null ? null : readListWrite(sql, list, grammar);
}
