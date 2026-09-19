/**
 * Which table an inline grid edit may write to.
 *
 * Inline editing turns a changed cell into `UPDATE <table> SET ... WHERE <pk> = ...`, so
 * something has to name `<table>`. The tab's TITLE did, and a title is free text: it
 * survives when the query in the tab is replaced, it is not tied to the rows on screen,
 * and renaming a tab is not a way anyone expects to choose a write target. Where the
 * title happened to name another real table carrying the same key column, the UPDATE
 * landed on that table and said nothing (#881).
 *
 * The query that produced the rows is the only thing in the tab that IS tied to them, so
 * it is the source here. It is read for one shape — a SELECT reading exactly one table —
 * and every other shape is REFUSED rather than guessed at:
 *
 *  - a join, or a comma-separated FROM, reads more than one table, and a cell in the
 *    result may belong to any of them;
 *  - a subquery or a CTE in FROM has no single base table to name;
 *  - a set operation (UNION and its relatives) is two statements' rows in one grid;
 *  - a statement that is not a SELECT at all — an UPDATE, a MongoDB document, a Redis
 *    command — has no base table this reader can speak for.
 *
 * Refusing is the point. The caller shows the reason and the user edits the SQL by hand,
 * which is the outcome the old code produced only when its guess failed to parse. The
 * direction of every doubt is the same: a shape this reader has not met must come back
 * refused, never resolved, because the cost of the two is not symmetric — an unnecessary
 * refusal costs a click, and a wrong table costs the wrong rows.
 *
 * It reads SPANS rather than matching text, which is this folder's standing rule and not
 * a preference: `spans.ts` owns the one scanner that knows where a statement's code is,
 * and it says so about itself — "a wrong literal boundary costs a bound on a write". This
 * is a write. The first draft of this module hand-rolled its own literal blanking and
 * paid for it twice over: `FROM "products" orders` resolved to `orders`, because blanking
 * the quoted name left the ALIAS as the first thing after FROM, and `SELECT EXTRACT(YEAR
 * FROM created_at) FROM orders` refused, because a bare text scan cannot tell a FROM
 * inside a function's arguments from the statement's own.
 *
 * The dialect comes from the caller for the same reason it does everywhere else in this
 * folder (#292): `#` opens a comment on MySQL and is an operator on PostgreSQL, and
 * `[users]` is a quoted name on SQL Server and a subscript elsewhere. The caller holds
 * the connection, so it holds the answer.
 */

import type { DatabaseType } from "@/lib/types";
import { resolveSqlGrammar } from "./grammar";
import { isBareIdentifier } from "./identifier";
import { IDENTIFIER_PART, IDENTIFIER_START, readSqlSpan } from "./spans";

export type UpdateTarget = { kind: "table"; table: string } | { kind: "refused"; reason: string };

/**
 * One piece of the statement's code, with the paren nesting it sits at.
 *
 * `name` is an identifier run, `quoted` is a quoted identifier — which can BE a table
 * name, so it is kept rather than skipped — and `other` is every remaining code
 * character plus the literals that can never be a name. Trivia is dropped: whitespace
 * and comments separate pieces and say nothing about structure.
 */
interface Piece {
  kind: "name" | "quoted" | "other";
  /** The piece's text for a `name` or an `other`; empty for a `quoted`, whose text is read by offset. */
  text: string;
  start: number;
  end: number;
  depth: number;
}

/**
 * Words that end the table reference, so what follows them is not the table or its alias.
 *
 * This list decides where the NAME stops. It deliberately decides nothing else: a word
 * here may still be an ordinary alias on some engine — measured on SQL Server 2022,
 * `limit`, `offset` and `window` all stand as bare aliases — and a reference truncated at
 * an alias hides whatever follows it. So the scans that look for a second table run over
 * everything after FROM instead, and this list cannot put a join or a comma out of sight.
 */
const CLAUSE_KEYWORDS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "WINDOW",
  "QUALIFY",
  "TABLESAMPLE",
  "FOR",
  "INTO",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "MINUS",
]);

/**
 * The clauses that legitimately carry a top-level comma.
 *
 * Deliberately only these two. Each is reserved in every engine that offers inline row
 * editing, so neither can be a bare alias — and that is the whole requirement, because
 * this set is what the comma scan trusts as an end. `WINDOW` is the near miss that is NOT
 * here: it does carry a comma between window definitions, and SQLite also accepts it as an
 * alias, so trusting it would put `FROM products window, orders` out of sight. A query with
 * two named windows refuses instead, which is the cheap half of that trade.
 *
 * `LIMIT` is the third, and it is not here because the word alone cannot earn it: it is
 * NON-RESERVED on Oracle, so `FROM products limit, orders` really is a table named
 * `products` aliased `limit` beside a second table. It is admitted by `endsTheCommaScan`
 * below on what follows it instead.
 */
const LIST_CLAUSES = new Set(["ORDER", "GROUP"]);

/**
 * Whether a piece ends the region the comma scan reads.
 *
 * `LIMIT 0, 50` is how MySQL and MariaDB spell a page, and SQLite and ClickHouse take the
 * same form. It reads ONE table, and scanning past it found that comma and refused — a
 * refusal on the everyday paging shape, which the tab-title reader this module replaces
 * got right.
 *
 * So `LIMIT` ends the scan, but only on what FOLLOWS it, because the word by itself is
 * not trustworthy the way `ORDER` and `GROUP` are (see `LIST_CLAUSES`). Both exclusions
 * are a shape that hides a table comma behind the word:
 *
 *  - a `,` — an alias called `limit` is followed by the FROM list's own comma, and a real
 *    LIMIT clause never is: `FROM products limit, orders` is two tables on every engine
 *    that lets `limit` stand as a bare alias;
 *  - a `(` — a derived column list (`FROM products limit (a, b), orders`) keeps its own
 *    commas below the top level, so the scan would see only the one after the `)`, and
 *    stopping at `limit` puts that one out of sight.
 *
 * Everything else after `LIMIT` is the clause's own argument, and the comma that may
 * follow it is the clause's own.
 */
function endsTheCommaScan(piece: Piece, next: Piece | undefined): boolean {
  if (piece.kind !== "name") return false;
  const word = piece.text.toUpperCase();
  if (LIST_CLAUSES.has(word)) return true;
  if (word !== "LIMIT") return false;
  return next !== undefined && !(next.kind === "other" && (next.text === "," || next.text === "("));
}

/**
 * Words that combine two results into one grid.
 *
 * `EXCEPT` earns a note, and the note is that the worry does not apply here: ClickHouse
 * spells a column exclusion `SELECT * EXCEPT (id) FROM t`, which reads one table — but
 * ClickHouse declares no inline row editing, so that statement never reaches this reader.
 * Measured on DuckDB 1.5.5, which does offer editing, the same text is a parser error; its
 * exclusion is spelled `EXCLUDE`. So on every engine that can get here, the word means one
 * thing.
 */
const SET_OPERATORS = new Set(["UNION", "INTERSECT", "EXCEPT"]);

/** Oracle's, and an ordinary column name on every other engine. */
const ORACLE_SET_OPERATORS = new Set(["MINUS"]);

/**
 * Words that are not the table even though they stand where the table stands.
 *
 * `ONLY` is the one that matters: PostgreSQL's `FROM ONLY products` reads as a table
 * named `ONLY` with `products` as its alias, which is the #881 failure exactly — a real
 * table named by the wrong word. It cannot be told apart from a table genuinely called
 * `only`, so both refuse.
 */
const NON_TABLE_LEADS = new Set(["ONLY", "LATERAL", "UNNEST", "TABLE", "VALUES", "ROWS"]);

function refuse(reason: string): UpdateTarget {
  return { kind: "refused", reason };
}

/**
 * The statement's code, in order, with trivia dropped and paren depth recorded — or why it
 * could not be read at all, which is a different answer from "no pieces".
 */
type PieceScan = Piece[] | "unterminated" | "executable-comment" | "split-comment" | "unopened-comment";

function readPieces(sql: string, type?: DatabaseType): PieceScan {
  const grammar = resolveSqlGrammar(type);
  const pieces: Piece[] = [];
  let depth = 0;
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span) {
      // An unterminated span means the input ends inside a quote or a comment, so there
      // is no "what follows it" to read. Undeterminable, not empty.
      if (!span.terminated) return "unterminated";
      // An executable comment is a comment to every reader and CODE to the engine, so a
      // reader that skips it is reading a different statement than the one that will run.
      // There are two spellings and both are live here:
      //
      //  - `/*! ... */` on MySQL and MariaDB. Measured on MySQL 8.4.11,
      //    `SELECT count(*) FROM products /*! , orders */` is a two-table read.
      //  - `/*M! ... */` on MariaDB only, which reaches this code through the `mysql` type
      //    id because that is the documented way to connect to a MariaDB server. Measured
      //    on MariaDB 13.0.2, the same statement written `/*M!` is a two-table read there
      //    and an ordinary comment on MySQL — and `mariadb-dump` emits the form itself, so
      //    a pasted dump carries it as a matter of course. Lowercase `/*m!` is a plain
      //    comment on both and is left alone.
      //
      // Refused for every dialect rather than only the two: a `/*!` written for PostgreSQL
      // is a comment that happens to start with an exclamation mark, and refusing it costs
      // a click.
      if (span.kind === "block-comment" && (sql.startsWith("/*!", i) || sql.startsWith("/*M!", i))) {
        return "executable-comment";
      }
      // PostgreSQL and SQL Server end a `--` comment at a bare carriage return; MySQL,
      // MariaDB, SQLite and DuckDB do not. Measured: `SELECT orders.note FROM products
      // -- x\r, orders` reads two tables on the first pair and one on the second, so the
      // span this reader was handed is not the span the engine will read.
      if (span.kind === "line-comment" && type === "mysql" && sql.startsWith("--", i)) {
        // The rule is about the DASH form only; `#` opens a comment on MySQL with nothing
        // after it required, and this reader already has that from the grammar.
        //
        // A space or a control character, and nothing else — deliberately NOT `\s`, which
        // is JavaScript's set and is wider than the engine's: it also matches U+00A0,
        // U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.
        // Measured on MariaDB 11.8.9, which reaches this reader through the same `mysql`
        // id, every one of those is an IDENTIFIER character rather than whitespace, so
        // `WHERE qty <> 5--\u00A0zz UNION SELECT … FROM zord` reads both tables while a
        // guard trusting `\s` called it a comment and answered the first.
        const after = sql[i + 2];
        if (after !== undefined && !/[ \u0000-\u001f]/.test(after)) return "unopened-comment";
      }
      if (span.kind === "line-comment" && /\r(?!\n)/.test(sql.slice(i, span.end))) {
        return "split-comment";
      }
      if (span.kind === "quoted-identifier") {
        pieces.push({ kind: "quoted", text: "", start: i, end: span.end, depth });
        i = span.end;
        continue;
      }
      if (span.kind === "subscript") {
        // Stepped INTO, not over. A string is opaque and a quoted name is a name, but a
        // subscript holds code — `spans.ts` says exactly that about itself — and jumping
        // to its end hid a whole query inside it. The `]` is read as ordinary code on the
        // way back out, so the depth closes itself.
        pieces.push({ kind: "other", text: "[", start: i, end: i + 1, depth });
        depth++;
        i++;
        continue;
      }
      if (span.kind === "string" || span.kind === "dollar-string") {
        pieces.push({ kind: "other", text: "", start: i, end: span.end, depth });
      }
      i = span.end;
      continue;
    }

    const ch = sql[i];
    // Both parens are recorded at the OUTER depth, so `FROM (` reads as a paren the
    // statement's own level owns rather than as the first piece of its body.
    if (ch === "(") {
      pieces.push({ kind: "other", text: "(", start: i, end: i + 1, depth });
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      // `]` closes what the subscript branch above stepped into. It can only be reached
      // under a grammar that reads brackets as subscripts; where they quote a name, the
      // whole run is one span and never gets here.
      depth = Math.max(0, depth - 1);
      pieces.push({ kind: "other", text: ch, start: i, end: i + 1, depth });
      i++;
      continue;
    }
    if (IDENTIFIER_START.test(ch)) {
      let end = i + 1;
      while (end < sql.length && (IDENTIFIER_PART.test(sql[end]) || sql[end] === "$")) end++;
      pieces.push({ kind: "name", text: sql.slice(i, end), start: i, end, depth });
      i = end;
      continue;
    }
    pieces.push({ kind: "other", text: ch, start: i, end: i + 1, depth });
    i++;
  }

  return pieces;
}

function isWord(piece: Piece | undefined, word: string): boolean {
  return piece?.kind === "name" && piece.text.toUpperCase() === word;
}

/**
 * The words a complete query can start with, on any engine that offers row editing.
 *
 * `PIVOT` and `UNPIVOT` are DuckDB's, and they are why this is a list rather than a test
 * for `SELECT`: measured on DuckDB 1.5.5, `(PIVOT orders ON k USING max(note))` is a
 * scalar subquery that answers with the other table's value. `SUMMARIZE`, `DESCRIBE`,
 * `SHOW` and `UNNEST` parse there as well and fail today only on shape, so they are here
 * before they land rather than after.
 */
const QUERY_OPENERS = new Set(["SELECT", "TABLE", "FROM", "VALUES", "WITH"]);

/**
 * DuckDB's own, which are not reserved anywhere else.
 *
 * Measured on DuckDB 1.5.5, `(PIVOT orders ON k USING max(note))` is a scalar subquery
 * that answers with another table's value. Asking about them everywhere cost PostgreSQL a
 * refusal for `coalesce(show, '')`, where `show` is an ordinary column name — so they are
 * asked about under the dialect that has them.
 */
const DUCKDB_QUERY_OPENERS = new Set(["PIVOT", "UNPIVOT", "UNNEST", "SUMMARIZE", "DESCRIBE", "SHOW"]);

/**
 * Whether a parenthesised group before `fromOffset` is a QUERY rather than an expression.
 *
 * The select list can carry a subquery, and that subquery supplies a column of its own,
 * from its own table, which then sits in the grid beside this statement's. Editing it
 * writes the other table's value into this one — measured on PostgreSQL 16, MySQL 8.4 and
 * DuckDB 1.5.
 *
 * What tells a subquery from `EXTRACT(YEAR FROM created_at)` is the first thing INSIDE the
 * group: a word a query can start with, or an expression. Reading it that way is also what
 * catches the forms that carry no `SELECT` at all — `(TABLE t)` is a complete query on
 * PostgreSQL and MySQL and `(FROM t)` is one on DuckDB, and a reader looking for the word
 * `SELECT` sees neither. Nested parens are stepped through, because `((TABLE t))` is the
 * same query wearing another layer.
 *
 * EVERY group is looked at, at any nesting. Only asking about the ones the statement opens
 * missed `COALESCE(p.note, (SELECT o.note FROM orders o LIMIT 1))`, which reads two tables
 * on every engine that offers row editing — measured — and put the orders value in the grid
 * under the products write. Where a group sits says nothing about whether it is a query;
 * being before the statement's own FROM is the whole question, and that is the bound the
 * loop already has.
 */
function opensASubquery(pieces: Piece[], fromOffset: number, type?: DatabaseType): boolean {
  const opens = (word: string) => QUERY_OPENERS.has(word) || (type === "duckdb" && DUCKDB_QUERY_OPENERS.has(word));
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece.start >= fromOffset) break;
    // `[` opens a group the same way `(` does on the engines that read it as a subscript,
    // and DuckDB spells a list literal with it.
    if (piece.kind !== "other" || (piece.text !== "(" && piece.text !== "[")) continue;
    // The first piece inside the group, stepping through any further openers.
    let inner = i + 1;
    while (pieces[inner]?.kind === "other" && (pieces[inner].text === "(" || pieces[inner].text === "[")) inner++;
    const first = pieces[inner];
    if (first?.kind !== "name" || !opens(first.text.toUpperCase())) continue;
    // `SELECT` and `FROM` can only start a query. The rest are ordinary column names on
    // some engine, so they count only where what follows them is what a query needs: a
    // name for `TABLE`/`WITH` and DuckDB's, a `(` for `VALUES`.
    const word = first.text.toUpperCase();
    if (word === "SELECT" || word === "FROM") return true;
    const next = pieces[inner + 1];
    if (word === "VALUES") {
      if (next?.kind === "other" && next.text === "(") return true;
      continue;
    }
    if (next?.kind === "name" || next?.kind === "quoted") return true;
  }
  return false;
}

/**
 * The single table `sql` reads from, or the reason it cannot be determined.
 *
 * The returned `table` is the reference AS THE QUERY SPELLS IT, quoting included: the
 * caller writes it into the UPDATE verbatim. That is what keeps a name the engine only
 * accepts quoted — a mixed-case PostgreSQL table, a lowercase Oracle one — working
 * without this module deciding to quote anything, which would break the opposite case.
 * An unquoted part is validated as a bare identifier first, so nothing but a name can
 * reach the statement.
 *
 * Only the shape is read. The statement is not executed and no part of it other than the
 * table reference is copied anywhere.
 */
/**
 * Whether `column` reaches the grid straight off the base table, rather than through an
 * expression or a rename.
 *
 * The key an inline edit writes against is picked by NAME off the result's field list, and
 * a name is not a provenance. `SELECT ROW_NUMBER() OVER (ORDER BY product_name) AS
 * product_id, product_name FROM products` puts 1, 2, 3 in a column called `product_id`;
 * `products` really has a `product_id`; and the `UPDATE ... WHERE product_id = 1` that
 * follows lands on whichever product that is, not on the row anybody was looking at.
 * Measured against PostgreSQL 16: two cells edited, two rows written, neither of them the
 * ones on screen, and the apply reported both as accepted. `SELECT sku AS product_id`
 * is the same defect spelled shorter.
 *
 * `*` is the safe case and the common one: every field is the table's own. Otherwise the
 * item that produces this name has to BE the column - one identifier, or a qualified one,
 * and any `AS` on it has to name the column it already names.
 *
 * Refusing when the shape cannot be read, like everything else here: a key this reader
 * cannot vouch for is one it should not let a write aim with.
 */
export function selectsPlainColumn(sql: string, column: string, type?: DatabaseType): boolean {
  const pieces = readPieces(sql, type);
  if (typeof pieces === "string") return false;
  const top = pieces.filter((piece) => piece.depth === 0);

  const select = top.findIndex((piece) => isWord(piece, "SELECT"));
  const from = top.findIndex((piece) => isWord(piece, "FROM"));
  if (select === -1 || from === -1 || from < select) return false;

  // `DISTINCT`, `ALL`, and DuckDB's and PostgreSQL's `DISTINCT ON (...)` sit between the
  // keyword and the list. They say how many rows come back, not where a field comes from.
  let start = select + 1;
  if (isWord(top[start], "ALL") || isWord(top[start], "DISTINCT")) {
    const distinct = isWord(top[start], "DISTINCT");
    start++;
    if (distinct && isWord(top[start], "ON")) {
      start++;
      // The parenthesised list is one `(` and one `)` at this level; its contents are deeper.
      if (top[start]?.kind === "other" && top[start].text === "(") {
        start++;
        while (start < from && !(top[start].kind === "other" && top[start].text === ")")) start++;
        start++;
      }
    }
  }

  // The select list, split on its own commas. A comma inside parens belongs to a function's
  // arguments, and those pieces are not at this depth to begin with.
  const items: Piece[][] = [[]];
  for (const piece of top.slice(start, from)) {
    if (piece.kind === "other" && piece.text === ",") items.push([]);
    else items[items.length - 1].push(piece);
  }

  const named = (piece: Piece) => (piece.kind === "quoted" ? sql.slice(piece.start + 1, piece.end - 1) : piece.text);
  const sameName = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();
  const isName = (piece: Piece | undefined) =>
    piece !== undefined && (piece.kind === "name" || piece.kind === "quoted");

  /**
   * `*` on its own, or `t.*`. Not any `*` anywhere in the item: `ROW_NUMBER() OVER (...) * 1`
   * multiplies, and reading that as a star let a computed field pass as the table's own -
   * measured, and it is the whole defect this function exists to stop.
   */
  const isStar = (item: Piece[]) => {
    const star = (piece: Piece | undefined) => piece?.kind === "other" && piece.text === "*";
    if (item.length === 1) return star(item[0]);
    return item.length === 3 && isName(item[0]) && item[1].kind === "other" && item[1].text === "." && star(item[2]);
  };

  // The LAST item that produces this name is the one the grid reads. Drivers build a row
  // object keyed by field name, so `SELECT product_id, sku AS product_id` hands over sku's
  // value under that name - measured on node-postgres - and deciding on the first match
  // would vouch for a column the user never sees.
  let answer = false;
  for (const item of items) {
    if (item.length === 0) continue;

    if (isStar(item)) {
      // Every one of the table's columns, this one included, unless a later item renames
      // over it.
      answer = true;
      continue;
    }

    // Strip a trailing alias, with or without the keyword.
    let body = item;
    let alias: string | null = null;
    const last = item[item.length - 1];
    if (item.length >= 2 && isName(last)) {
      if (isWord(item[item.length - 2], "AS")) {
        alias = named(last);
        body = item.slice(0, item.length - 2);
      } else if (isName(item[item.length - 2])) {
        // Two identifiers side by side is an alias with the keyword left out.
        alias = named(last);
        body = item.slice(0, item.length - 1);
      }
    }

    // A plain reference is a chain of identifiers joined by dots: `c`, `t.c`, `s.t.c`.
    const isReference =
      body.length > 0 &&
      body.length % 2 === 1 &&
      body.every((piece, index) => (index % 2 === 0 ? isName(piece) : piece.kind === "other" && piece.text === "."));

    const source = isReference ? named(body[body.length - 1]) : null;
    const output = alias ?? source;
    if (output === null || !sameName(output, column)) continue;
    // An alias that renames is a different column wearing this name.
    answer = source !== null && sameName(source, column);
  }
  return answer;
}

export function resolveUpdateTarget(sql: string, type?: DatabaseType): UpdateTarget {
  const pieces = readPieces(sql, type);
  if (pieces === "unterminated") {
    // Not always "unclosed": a `'a\'` literal is closed on PostgreSQL and open on MySQL,
    // and `spans.ts` reports the run as undeterminable rather than taking a side. What is
    // true of both is that this editor cannot find the end of it.
    return refuse("This editor cannot find where a quote or comment in this query ends");
  }
  if (pieces === "executable-comment") {
    return refuse("This query carries a comment that some databases run as code, so what it reads cannot be told");
  }
  if (pieces === "unopened-comment") {
    return refuse("A comment here is only a comment on some databases; on others it is code");
  }
  if (pieces === "split-comment") {
    return refuse("A comment here ends in a different place on different databases");
  }

  // Only the statement's own level is structure. A FROM inside parens belongs to a
  // subquery or to a function's arguments — `EXTRACT(YEAR FROM created_at)`,
  // `SUBSTRING(name FROM 1 FOR 3)`, `WHERE id IN (SELECT ... FROM ...)` — and reading
  // those as the statement's own FROM is how a single-table query gets refused.
  const top = pieces.filter((piece) => piece.depth === 0);

  const terminator = top.findIndex((piece) => piece.kind === "other" && piece.text === ";");
  if (terminator !== -1) {
    // Everything after the first terminator has to be more terminators. `SELECT 1;;` is
    // one statement and an empty one, not two, and telling its author otherwise is false.
    const after = top.slice(terminator + 1);
    if (after.some((piece) => !(piece.kind === "other" && piece.text === ";"))) {
      return refuse("This query holds more than one statement, so the rows' table cannot be told apart");
    }
    top.length = terminator;
  }

  if (top.length === 0) {
    return refuse("There is no statement here to read");
  }
  if (isWord(top[0], "WITH")) {
    return refuse("This query builds its own intermediate result, so its rows have no single base table");
  }
  if (isWord(top[0], "FROM")) {
    // DuckDB lets a query lead with FROM. It is a select statement, so saying it is not
    // one would be false; this reader simply does not read that shape.
    return refuse("This query is written FROM-first, which this editor cannot read");
  }
  if (!isWord(top[0], "SELECT")) {
    return refuse("Only the rows of a SELECT can be written back, and this is not one");
  }

  const setOp = top.findIndex(
    (piece) =>
      piece.kind === "name" &&
      (SET_OPERATORS.has(piece.text.toUpperCase()) ||
        (type === "oracle" && ORACLE_SET_OPERATORS.has(piece.text.toUpperCase()))),
  );
  if (setOp !== -1) {
    return refuse("This result combines more than one query, so there is no single table to write to");
  }

  const fromIndex = top.findIndex((piece) => isWord(piece, "FROM"));
  if (fromIndex === -1) {
    return refuse("This query reads no table, so there is nothing to write back to");
  }

  // A subquery in the SELECT LIST supplies a column of its own, from its own table, and
  // that column sits in the grid beside this statement's. Editing it writes the other
  // table's value into this one — measured on PostgreSQL 16 with
  // `SELECT p.id, (SELECT o.note FROM orders o WHERE …) AS note FROM products p`, where
  // `products.note` was overwritten with a value the user typed for `orders`. A subquery
  // in WHERE is a different thing: it filters, it does not supply a column, and it sits
  // AFTER the FROM, which is what tells the two apart.
  const fromOffset = top[fromIndex].start;
  if (opensASubquery(pieces, fromOffset, type)) {
    return refuse("Part of this query reads to this editor as a second query, so its rows may have no single table");
  }

  const afterFrom = top.slice(fromIndex + 1);
  if (afterFrom.some((piece) => isWord(piece, "FROM"))) {
    return refuse("This query reads from more than one place, so the row's table cannot be told apart");
  }

  const clauseIndex = afterFrom.findIndex(
    (piece) => piece.kind === "name" && CLAUSE_KEYWORDS.has(piece.text.toUpperCase()),
  );
  const region = clauseIndex === -1 ? afterFrom : afterFrom.slice(0, clauseIndex);

  // A join is looked for across EVERYTHING after FROM, not just the table reference, so
  // the answer does not depend on the truncation above having stopped in the right place —
  // which is what let a join hide behind a word that can also be an alias.
  //
  // It is not free: the test below matches an identifier ENDING in `_join`, so a column
  // named `last_join` in an ORDER BY refuses a query that reads one table. That is the
  // cheap half of the trade this module makes everywhere — an unnecessary refusal costs a
  // click, and a missed join costs the wrong rows.
  //
  // `STRAIGHT_JOIN` is MySQL's, and MySQL offers row editing, so the test is the word's
  // ENDING rather than the word: a text search for `JOIN` inside it finds no boundary and
  // would let a two-table read through as one.
  // `CROSS APPLY` and `OUTER APPLY` bring in a second table on SQL Server and Oracle, and
  // they carry neither a comma nor the word JOIN — so the two scans above would both miss
  // them. Measured on SQL Server 2022, `SELECT * FROM products limit CROSS APPLY orders o`
  // reads BOTH tables and answered `products`, and an edit to a cell the second table
  // supplied was written into the first.
  const joinPiece = afterFrom.findIndex(
    (piece) => piece.kind === "name" && (/(?:^|_)JOIN$/i.test(piece.text) || piece.text.toUpperCase() === "APPLY"),
  );
  if (joinPiece !== -1) {
    // One sentence, because the two cases differ only in where this reader stopped, which
    // is not a fact about the user's query. A real `JOIN` brings in a second table; a
    // column named `last_join` in an ORDER BY does not, and this reader cannot tell them
    // apart — so what it says is what it did, and that is true of both.
    return refuse("A word here reads to this editor as a second table, so the row's table is unclear");
  }
  // A comma between table references is the other way to read two tables, and it cannot
  // be looked for inside the truncated region: the truncation stops at a CLAUSE word, and
  // several of those stand perfectly well as a bare ALIAS. Measured on SQLite 3.51,
  // `SELECT product_id, orders.note FROM products for, orders` is a legal cross join whose
  // `note` column comes from `orders` — and reading `for` as the FOR clause put the comma
  // out of sight and answered `products`, so an edit to that cell overwrote the wrong
  // table. MySQL 8.4 does the same with `offset`.
  //
  // So the scan runs from FROM up to the first clause that legitimately CONTAINS a list,
  // which `endsTheCommaScan` decides. `ORDER` and `GROUP` are reserved in every engine
  // that offers row editing — neither can be an alias — which is what makes the boundary
  // trustworthy where the wider set was not; `LIMIT` earns the same place on what follows
  // it. A comma anywhere before that boundary is a second table reference.
  const listIndex = afterFrom.findIndex((piece, at) => endsTheCommaScan(piece, afterFrom[at + 1]));
  const beforeList = listIndex === -1 ? afterFrom : afterFrom.slice(0, listIndex);
  const commaPiece = beforeList.findIndex((piece) => piece.kind === "other" && piece.text === ",");
  if (commaPiece !== -1) {
    // One sentence, for the same reason as the join above: `FROM products for, orders`
    // really does put its comma inside the FROM list on SQLite, so calling it "outside"
    // was false about that query. "Could separate" is what is true of all of them.
    return refuse("A comma in this query could separate two tables, so the row's table cannot be told apart");
  }

  const lead = region[0];
  if (lead === undefined) {
    return refuse("This query names no table after FROM");
  }
  if (lead.kind === "other") {
    return refuse(
      lead.text === "("
        ? "This query reads from a subquery, so its rows have no single base table"
        : "What this query names after FROM is not a name this editor can write into an UPDATE",
    );
  }
  if (lead.kind === "name" && NON_TABLE_LEADS.has(lead.text.toUpperCase())) {
    return refuse(`"${lead.text}" stands where the table stands, so the real table cannot be settled`);
  }

  // A qualified name is parts joined by dots. Whatever follows it is the alias, which is
  // dropped — and anything longer than an alias is a shape this reader does not know.
  const parts: Piece[] = [];
  let index = 0;
  for (;;) {
    const part = region[index];
    if (part === undefined || part.kind === "other") {
      return refuse("This query does not name a plain table after FROM");
    }
    parts.push(part);
    index++;
    const dot = region[index];
    if (dot?.kind === "other" && dot.text === ".") {
      index++;
      continue;
    }
    break;
  }

  for (const part of parts) {
    // A quoted part is already delimited by the engine's own quoting, and `spans.ts`
    // reported it terminated, so it carries no closing character it did not escape.
    // An unquoted one is written into the statement as-is and has to be a name.
    if (part.kind === "name" && !isBareIdentifier(part.text)) {
      // The name is the engine's, not this reader's, so saying it "could not be read as a
      // table name" is false about a perfectly real table. What is true is that this
      // editor will not write it unquoted, and quoting it here would change its case.
      return refuse(`"${part.text}" is not a plain name this editor can write into an UPDATE`);
    }
  }

  const trailing = region.slice(index);
  const alias = trailing.length === 0 || (trailing.length === 1 && trailing[0].kind !== "other");
  const aliasWithAs = trailing.length === 2 && isWord(trailing[0], "AS") && trailing[1].kind !== "other";
  if (!alias && !aliasWithAs) {
    // The catch-all, and it says what is actually the case: the reference carries more
    // than a name and an alias, and this reader will not guess at the rest. Some of those
    // shapes name exactly one table — `TABLESAMPLE`, `QUALIFY`, an Oracle dblink — so
    // claiming they name none would be false about the query in front of the user.
    return refuse("This query describes its table in a way this editor cannot read, so it will not guess");
  }

  return { kind: "table", table: parts.map((part) => sql.slice(part.start, part.end)).join(".") };
}
