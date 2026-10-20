/**
 * Query Limiter Utility
 * Adds an automatic LIMIT to SELECT statements so that a large result set
 * cannot lock up the system.
 *
 * The statement's type comes from `lib/sql/leading-keyword`, which skips comments
 * as well as whitespace. It used to come from `^\s*KEYWORD\b` tests here, and a
 * leading comment is not whitespace: an annotated SELECT fell through to `OTHER`,
 * so no LIMIT was injected and the entire result set came back while the UI badge
 * reported the query as unlimited (#275). Every dialect here accepts a comment
 * before a statement, so every dialect had the defect.
 *
 * For a statement leading with `WITH` the type comes from
 * `lib/sql/operative-keyword` instead: the CTE list is a preamble, so the keyword
 * that types the statement is the one AFTER it. Testing whether the text contained
 * `SELECT` let `INSERT INTO ... SELECT` type its own statement as a read, and the
 * appended LIMIT then bounded the rows that statement WROTE (#287).
 *
 * The three probes that read the statement's whole BODY - the Oracle `ROWNUM`
 * bound, the UNION test and the nested-SELECT count - read code words through
 * `lib/sql/words` for the same reason. Run over the text as characters, a word the
 * statement merely MENTIONS answered for it: `… WHERE note = 'ROWNUM <= 10'` and
 * `… /* ROWNUM <= 10 *\/ …` both read as already bounded, so no LIMIT was injected
 * and the whole result set came back, and a UNION or a SELECT written in a comment
 * mis-shaped the other two answers (S5). The leading comment was already excluded
 * by hand before that (#289 review); everything after the first keyword was not.
 *
 * Where the statement ENDS comes from `lib/sql/statement-end`, and both the
 * "already bounded" probes and the injection use that one reading. They used to
 * disagree with each other by accident - each worked on the raw text - and a
 * trailing line comment then broke the limiter in both directions: the injected
 * bound landed inside the comment while the caller was told the statement was
 * limited, and a commented-out bound was read as a real one so nothing was
 * injected at all (#280).
 */

import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { findCodeWord } from "@/lib/sql/words";
import type { DatabaseType } from "@/lib/types";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_QUERY_LIMIT = 500;
export const MAX_UNLIMITED_ROWS = 100000;

/** The four keywords this module reports as `DDL`, as `readLeadingKeyword` spells them. */
const DDL_KEYWORDS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE"]);

// ============================================================================
// Types
// ============================================================================

export interface QueryLimitOptions {
  defaultLimit: number;
  maxUnlimited: number;
  forceLimit: boolean;
}

export interface ParsedQueryInfo {
  type: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "DDL" | "OTHER";
  hasLimit: boolean;
  existingLimit?: number;
  hasOffset: boolean;
  existingOffset?: number;
  isUnion: boolean;
  hasCTE: boolean;
  hasSubquery: boolean;
}

export interface LimitedQueryResult {
  sql: string;
  wasLimited: boolean;
  originalLimit?: number;
  appliedLimit: number;
  appliedOffset: number;
}

// ============================================================================
// Query Analysis
// ============================================================================

/**
 * Analyzes a SQL statement and determines its type and its LIMIT/OFFSET state.
 */

/**
 * The first position at or after `index` that is not trivia.
 *
 * Only whitespace and comments are skipped. A literal, a quoted identifier and a
 * subscript are the statement's own text, so a reader that stepped over one would
 * let the characters after it answer for the characters inside it. Measured on
 * valid PostgreSQL: `… WHERE rownum[1] <= 10` reads a column named `rownum`
 * holding an array, which is not an Oracle row bound, and a reader that took the
 * subscript for trivia reported that statement already bounded - so no LIMIT was
 * injected and the whole table came back. Pinned in
 * `tests/unit/db/query-limiter.test.ts`. Skipping comments is what lets
 * `ROWNUM /* n *\/ <= 10` be read as the one bound it is.
 */
function skipTrivia(sql: string, index: number, grammar: SqlGrammar): number {
  let i = index;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span === null) return i;
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return i;
    i = span.end;
  }

  return i;
}

/**
 * Whether a `< n` / `<= n` comparison follows the word ending at `index`.
 *
 * The shape is the one the regex this replaced accepted, deliberately: `ROWNUM`
 * on the left, `<` or `<=`, a literal count. The mirrored form (`10 >= ROWNUM`)
 * was not read as a bound before and is not read as one now - reading it would be
 * a behaviour change rather than the span fix S5 asks for.
 */
function readsRownumBound(sql: string, index: number, grammar: SqlGrammar): boolean {
  let i = skipTrivia(sql, index, grammar);
  if (sql[i] !== "<") return false;
  i++;
  if (sql[i] === "=") i++;
  i = skipTrivia(sql, i, grammar);
  return i < sql.length && sql[i] >= "0" && sql[i] <= "9";
}

/** Whether the statement's CODE carries an Oracle `ROWNUM <= n` bound at or after `from`. */
function hasCodeRownumBound(sql: string, from: number, grammar: SqlGrammar): boolean {
  // Every occurrence is asked, not just the first: `SELECT ROWNUM AS rn FROM t
  // WHERE ROWNUM <= 10` is bounded by its second one, and the regex this replaced
  // found it.
  let found = findCodeWord(sql, "ROWNUM", from, grammar);

  while (found !== null) {
    if (readsRownumBound(sql, found.end, grammar)) return true;
    found = findCodeWord(sql, "ROWNUM", found.end, grammar);
  }

  return false;
}

/** Whether the statement's code contains `word` more than once at or after `from`. */
function hasRepeatedCodeWord(sql: string, word: string, from: number, grammar: SqlGrammar): boolean {
  const first = findCodeWord(sql, word, from, grammar);
  if (first === null) return false;
  return findCodeWord(sql, word, first.end, grammar) !== null;
}

/**
 * The statement with its trailing-clause run removed: the code, the trivia that
 * sat between the code and the clause, and the run itself (#1398).
 *
 * A dialect's grammar declares the clauses that must FOLLOW the row bound -
 * Materialize's `AS OF`, ScyllaDB's `BYPASS CACHE` and `USING TIMEOUT`, CQL's
 * `ALLOW FILTERING` - and both this module's halves need the same reading: the
 * end-anchored probes below must see an existing bound that a trailing clause
 * follows (it is not at the end they read otherwise, so `LIMIT 10 BYPASS CACHE`
 * was "unbounded" and a second bound was appended), and the rewrite must place
 * the bound BEFORE the run it re-attaches verbatim, writer's spacing included.
 *
 * The run is stripped one clause per pattern, from the end backward, so a
 * statement carrying two of them keeps them in the order they were written. Each
 * pattern is end-anchored and eats at least one word, so the index strictly
 * decreases and the loop terminates whatever the declaration says.
 *
 * The clause patterns match from `\s+`, which also takes the NEWLINE that closes
 * a `--` or `//` comment, so the body left behind can end inside one: a comment
 * the writer put between the code and the clause. That body is cut at its code
 * end - the same reading `applyQueryLimit` gives the statement's own trailing
 * trivia - so the comment is returned between the code and the clause rather
 * than swallowing the bound that is about to be written into it, and the
 * end-anchored probes read code only: `-- LIMIT 5\nALLOW FILTERING` is not a
 * statement already limited to 5.
 */
function stripTrailingClauses(
  statement: string,
  grammar: SqlGrammar,
): { code: string; midTrivia: string; clauseRun: string } {
  let body = statement;
  let clauseRun = "";

  for (let pass = 0; pass < grammar.trailingLimitClauses.length; pass++) {
    let stripped = false;
    for (const clause of grammar.trailingLimitClauses) {
      const match = body.match(clause);
      if (match === null || match.index === undefined) continue;
      clauseRun = match[0] + clauseRun;
      body = body.slice(0, match.index);
      stripped = true;
    }
    if (!stripped) break;
  }

  const end = readStatementEnd(body, grammar);
  return { code: body.slice(0, end.end), midTrivia: body.slice(end.end), clauseRun };
}

/**
 * A row-bound value as a pattern: a digit run, or one of the dialect's declared non-numeric values (SF-021). With no
 * declaration this is `\d+`, the exact pattern every probe below used before, so no other dialect reads differently.
 */
function rowBoundValue(grammar: SqlGrammar): string {
  const declared = grammar.nonNumericRowBounds ?? [];
  return ["\\d+", ...declared.map((value) => value.replace(/[$^.*+?()[\]{}|\\]/g, "\\$&"))].join("|");
}

/** A count as a number, or undefined for a declared non-numeric value, which means no limit. */
function boundCount(text: string): number | undefined {
  return /^\d+$/.test(text) ? parseInt(text) : undefined;
}

/** An offset as a number; a declared non-numeric value skips nothing. */
function boundOffset(text: string): number {
  return /^\d+$/.test(text) ? parseInt(text) : 0;
}

/**
 * Whether the bound word the end-anchored probe matched at `index` is code. Asked only when the match carries a
 * non-numeric value, whose quotes and `$` could otherwise be the tail of a literal or a comment.
 */
function isCodeWordAt(code: string, word: string, index: number, grammar: SqlGrammar): boolean {
  let found = findCodeWord(code, word, 0, grammar);
  while (found !== null && found.start < index) found = findCodeWord(code, word, found.end, grammar);
  return found !== null && found.start === index;
}

/** The type this module reports for a statement operated by `keyword`. */
function classifyKeyword(keyword: string | undefined): ParsedQueryInfo["type"] {
  if (keyword === "SELECT") return "SELECT";
  if (keyword === "INSERT") return "INSERT";
  if (keyword === "UPDATE") return "UPDATE";
  if (keyword === "DELETE") return "DELETE";
  if (keyword !== undefined && DDL_KEYWORDS.has(keyword)) return "DDL";
  return "OTHER";
}

/**
 * The statement's shape, read under a dialect's grammar.
 *
 * `type` names the engine the statement is about to run on, so the readers below
 * resolve the characters the dialects disagree about - today `#`, which is a
 * comment marker in MySQL and ClickHouse and ordinary code everywhere else - the
 * way that engine does. Omitting it means "no dialect named" and keeps the
 * reading these functions had before the channel existed (#292); every caller in
 * this project has one to pass.
 */
export function analyzeQuery(sql: string, type?: DatabaseType): ParsedQueryInfo {
  return analyzeUnderGrammar(sql, resolveSqlGrammar(type));
}

function analyzeUnderGrammar(sql: string, grammar: SqlGrammar): ParsedQueryInfo {
  // The statement's own text, with its trailing trivia and terminator removed.
  // Every end-anchored probe below reads THIS rather than the raw input: the
  // anchor is what keeps them off a statement that merely mentions a bound, and
  // a trailing comment used to sit between the anchor and the bound, so a real
  // `LIMIT 10 -- note` read as unbounded while `-- LIMIT 10` read as bounded.
  //
  // Only the END is read here. Whether that end may be CUT is a separate answer
  // and belongs to `applyQueryLimit` and to the providers that append their own
  // clause. Where the cut is refused this end is the terminator strip, which is
  // what these probes read before the reader existed, so none of them answers
  // differently than it used to.
  const statement = sql.slice(0, readStatementEnd(sql, grammar).end);
  // The statement's CODE with the trailing-clause run the dialect declared removed
  // (#1398). The end-anchored probes below read THIS: on a dialect with such a
  // clause an existing bound is never the last thing in the statement, and reading
  // the raw end made `LIMIT 10 BYPASS CACHE` look unbounded - so a second bound was
  // appended and the engine refused the pair. A comment the writer put between the
  // code and the clause is cut off here too, so a commented-out bound behind one
  // cannot answer for the statement. The whole-body probes keep the full
  // statement: the clause run cannot contain the words they ask about.
  const { code: clauseStripped } = stripTrailingClauses(statement, grammar);

  // Query type detection - from the first keyword that is not whitespace or a
  // comment, and where a comment ENDS is the dialect's answer: on a dialect that
  // nests block comments, a flat reading reports a word the operator commented out
  // (#300). The grammar is already resolved here, so it costs one argument to keep
  // this reader and `readStatementEnd` above reading the same comment.
  const leading = readLeadingKeyword(statement, grammar);
  const keyword = leading?.keyword;
  // The statement from its own first keyword onward. Anything that searches the
  // statement's TEXT rather than just its leading keyword has to start here, or a
  // word written in the leading comment answers for the statement itself.
  const fromKeyword = leading === null ? statement : statement.slice(leading.start);
  // Where the statement's own code starts. The body probes below take `statement`
  // plus this offset rather than the `fromKeyword` slice: `readSqlSpan` looks at
  // the character BEFORE the position it is asked about to tell an Oracle `q'…'`
  // tag from the tail of a name, so a suffix slice can answer differently than the
  // same text in place.
  const bodyStart = leading === null ? 0 : leading.start;
  // Whitespace-collapsed, upper-cased body, kept for the ONE case the span reader
  // cannot serve - see `unresolved` below. Built from `fromKeyword`, NOT from
  // `statement`: a leading comment reading "switch to ROWNUM <= 10" once marked the
  // statement already bounded, which left the query unbounded - the very symptom
  // #275 removed (PR #289 review).
  const normalized = fromKeyword.replace(/\s+/g, " ").toUpperCase();
  // Whether part of this statement is text no reader over `lib/sql/spans` can
  // resolve - a run that never closes, which on the `\'` shape is a genuine
  // dialect disagreement rather than a defect. What is written inside such a run is
  // unknowable, so the three body probes keep the whole-text reading they had here
  // instead: declining to SEE a bound is the direction that costs rows, and
  // `applyQueryLimit` refuses to rewrite such a statement anyway (`readStatementEnd`
  // reports it unrewritable), so the fallback can only widen what is REPORTED and
  // can never place a bound.
  const unresolved = hasUnterminatedSpan(fromKeyword, grammar);

  // A `WITH` statement is typed by the keyword its CTE list OPERATES, not by the
  // keyword it opens with and not by a `SELECT` found in its text. Asking whether
  // the text contained `SELECT` let the `INSERT INTO ... SELECT` idiom answer for
  // the whole statement, so a data-modifying CTE was typed SELECT and a LIMIT was
  // appended to it - and in PostgreSQL that LIMIT applies to the rows the
  // statement WRITES, committing at most `limit` of them while the UI reported a
  // truncated result set (#287). The operative keyword is reported as its own type
  // rather than as a blanket OTHER: all three consumers of `type` outside this
  // module - `sql-base.ts`, `oracle.ts` and `mssql.ts` - test `=== "SELECT"` and
  // nothing else, so the honest answer costs nothing.
  // `MERGE`, which the union cannot name, falls through to OTHER.
  const typingKeyword = keyword === "WITH" ? readOperativeKeyword(statement, grammar)?.keyword : keyword;
  const type = classifyKeyword(typingKeyword);

  // LIMIT/OFFSET detection: find the outermost query's LIMIT, the
  // LIMIT <count> [OFFSET <offset>] at the end of the statement.
  // A count or an offset is a digit run, or one of the values the dialect declares (Snowflake's `NULL`, `''` and
  // `$$$$`, SF-021); the MySQL `LIMIT x, y` form stays digits only.
  const value = rowBoundValue(grammar);
  const declaredValue = (text: string | undefined): boolean => text !== undefined && boundCount(text) === undefined;
  let limitMatch = clauseStripped.match(
    new RegExp(`\\bLIMIT\\s+(${value})(?:\\s*,\\s*(\\d+)|\\s+OFFSET\\s+(${value}))?\\s*$`, "i"),
  );
  if (
    limitMatch !== null &&
    (declaredValue(limitMatch[1]) || declaredValue(limitMatch[3])) &&
    !isCodeWordAt(clauseStripped, "LIMIT", limitMatch.index ?? 0, grammar)
  ) {
    limitMatch = null;
  }

  let hasLimit = false;
  let existingLimit: number | undefined;
  let existingOffset: number | undefined;

  if (limitMatch) {
    hasLimit = true;
    // LIMIT x, y format (MySQL style) veya LIMIT x OFFSET y
    if (limitMatch[2] !== undefined) {
      // LIMIT offset, count (MySQL style)
      existingOffset = parseInt(limitMatch[1]);
      existingLimit = parseInt(limitMatch[2]);
    } else {
      existingLimit = boundCount(limitMatch[1]);
      existingOffset = limitMatch[3] ? boundOffset(limitMatch[3]) : undefined;
    }
  }

  // Oracle/MSSQL: FETCH FIRST N ROWS ONLY / FETCH NEXT N ROWS ONLY
  if (!hasLimit) {
    const fetchMatch = clauseStripped.match(
      new RegExp(`\\bFETCH\\s+(?:FIRST|NEXT)\\s+(${value})\\s+ROWS?\\s+ONLY\\s*$`, "i"),
    );
    if (
      fetchMatch &&
      (!declaredValue(fetchMatch[1]) || isCodeWordAt(clauseStripped, "FETCH", fetchMatch.index ?? 0, grammar))
    ) {
      hasLimit = true;
      existingLimit = boundCount(fetchMatch[1]);
    }
  }

  // MSSQL: SELECT TOP N - anchored at the real SELECT rather than at the start of
  // the string, so an annotated `SELECT TOP 10` is still seen as bounded. Missing
  // it would inject a second TOP and hand the server invalid SQL.
  if (!hasLimit && keyword === "SELECT") {
    const topMatch = fromKeyword.match(/^SELECT\s+TOP\s+(\d+)\b/i);
    if (topMatch) {
      hasLimit = true;
      existingLimit = parseInt(topMatch[1]);
    }
  }

  // Oracle legacy: ROWNUM in WHERE clause. Read as code words, so a bound written
  // in a comment or inside a literal is not the statement's: read as characters,
  // `… WHERE note = 'ROWNUM <= 10'` said the statement was already bounded and the
  // limiter injected nothing (S5).
  if (
    !hasLimit &&
    (unresolved ? /\bROWNUM\s*<=?\s*\d+/.test(normalized) : hasCodeRownumBound(statement, bodyStart, grammar))
  ) {
    hasLimit = true;
  }

  // OFFSET without LIMIT (rare but possible in PostgreSQL). The value may also be one the dialect declares, read as
  // code only, as for LIMIT above.
  const offsetOnlyMatch = hasLimit ? null : clauseStripped.match(new RegExp(`\\bOFFSET\\s+(${value})\\s*$`, "i"));
  const offsetOnly =
    offsetOnlyMatch !== null &&
    (!declaredValue(offsetOnlyMatch[1]) || isCodeWordAt(clauseStripped, "OFFSET", offsetOnlyMatch.index ?? 0, grammar))
      ? offsetOnlyMatch
      : null;
  const hasOffset = hasLimit ? existingOffset !== undefined : offsetOnly !== null;

  if (offsetOnly !== null) {
    existingOffset = boundOffset(offsetOnly[1]);
    // A lone declared OFFSET (Snowflake's `OFFSET NULL`, SF-021) is the statement's own bound: Snowflake takes no
    // LIMIT after an OFFSET, so appending one only turned its own "unexpected '<EOF>'" into an error about Studio's
    // LIMIT. Nothing is appended and the engine answers the text as written.
    if (declaredValue(offsetOnly[1])) hasLimit = true;
  }

  // UNION detection - the code word, for the same reason: a comment reading
  // "UNION ALL with archive later" is not a union.
  const isUnion = unresolved
    ? /\bUNION\b/.test(normalized)
    : findCodeWord(statement, "UNION", bodyStart, grammar) !== null;

  // CTE detection (WITH clause) - this answers what the statement LEADS with,
  // which is a different question from what it operates: `WITH t AS (...) INSERT
  // ...` has a CTE and is typed INSERT. So this deliberately stays on the leading
  // keyword and is true for every `WITH`, whatever its type turned out to be.
  const hasCTE = keyword === "WITH";

  // Subquery detection: a SECOND SELECT in the statement's code. Counting the word
  // in the text made `… WHERE note = 'SELECT 1'` a subquery.
  const hasSubquery = unresolved
    ? (normalized.match(/\bSELECT\b/g) || []).length > 1
    : hasRepeatedCodeWord(statement, "SELECT", bodyStart, grammar);

  return {
    type,
    hasLimit,
    existingLimit,
    hasOffset,
    existingOffset,
    isUnion,
    hasCTE,
    hasSubquery,
  };
}

// ============================================================================
// Query Limiting
// ============================================================================

/**
 * Adds a LIMIT to a SELECT statement, or updates the LIMIT it already has.
 */
export function applyQueryLimit(
  sql: string,
  limit: number,
  offset: number = 0,
  options: Partial<QueryLimitOptions> = {},
  type?: DatabaseType,
): LimitedQueryResult {
  const { forceLimit = false } = options;
  // Resolved once and passed down, so the type it came from stops here: no reader
  // below this line ever sees a database type id.
  const grammar = resolveSqlGrammar(type);
  const info = analyzeUnderGrammar(sql, grammar);

  // Not a SELECT: add no limit.
  if (info.type !== "SELECT") {
    return {
      sql,
      wasLimited: false,
      appliedLimit: 0,
      appliedOffset: 0,
    };
  }

  // Keep an existing LIMIT unless forceLimit is set.
  if (info.hasLimit && !forceLimit) {
    return {
      sql,
      wasLimited: false,
      originalLimit: info.existingLimit,
      appliedLimit: info.existingLimit || 0,
      appliedOffset: info.existingOffset || 0,
    };
  }

  // The clause goes between the statement and its trailing trivia, and the
  // trivia is re-attached verbatim. Appending after the trivia instead is what
  // let a trailing line comment swallow the bound - together with the `;`, which
  // then sat inside the comment too. Splitting here rather than normalising the
  // tail also leaves the emitted SQL byte-identical for every statement that
  // carries no trailing trivia, which is nearly all of them.
  //
  // A statement whose end may not be cut is returned untouched: there is nowhere
  // honest to put the clause, and `wasLimited: false` says so. One shape always
  // reaches that - a literal MySQL and PostgreSQL would close in different places
  // (`… WHERE name = 'O\'Brien';`, where inserting on a guess puts the bound after
  // the `;`). A trailing `#` run reaches it only when NO dialect was named, since
  // it is a comment in MySQL and ClickHouse and a temp table, an identifier or an
  // operator in the rest, and a named dialect has already told them apart.
  const source = sql.trim();
  const { end, rewritable } = readStatementEnd(source, grammar);

  if (!rewritable) {
    return { sql, wasLimited: false, originalLimit: info.existingLimit, appliedLimit: 0, appliedOffset: 0 };
  }

  let statement = source.slice(0, end);
  const trailing = source.slice(end);

  // A dialect's trailing-clause run comes off the end first (#1398) and is
  // re-attached after the bound, so the clauses that must FOLLOW the row bound -
  // Materialize's `AS OF`, ScyllaDB's `BYPASS CACHE` and `USING TIMEOUT`, CQL's
  // `ALLOW FILTERING` - keep the place their grammar demands instead of refusing
  // the statement. A comment the writer put between the code and the clause is
  // re-attached between the bound and the clause, its own closing newline kept,
  // so the bound is written in code rather than inside the comment. The analysis
  // above read the same run off the same statement, so an existing bound followed
  // by one never reaches this rewrite.
  const { code, midTrivia, clauseRun } = stripTrailingClauses(statement, grammar);
  statement = code;

  // Remove the existing LIMIT/OFFSET when forceLimit is set. These are anchored
  // at the end of the STATEMENT, so a trailing comment neither hides the bound
  // from them nor gets torn apart by them.
  if (info.hasLimit && forceLimit) {
    const value = rowBoundValue(grammar);
    // MySQL style: LIMIT offset, count
    statement = statement.replace(/\bLIMIT\s+\d+\s*,\s*\d+\s*$/i, "").trim();
    // Standard style: LIMIT count OFFSET offset, either value one the dialect declares (SF-021)
    statement = statement
      .replace(new RegExp(`\\bLIMIT\\s+(?:${value})(?:\\s+OFFSET\\s+(?:${value}))?\\s*$`, "i"), "")
      .trim();
    // A lone declared OFFSET skips nothing, so it goes too and the bound written below is the whole bound; a digit
    // OFFSET stays where it stood, as it always did.
    statement = statement
      .replace(new RegExp(`\\bOFFSET\\s+(${value})\\s*$`, "i"), (match, bound: string, index: number) =>
        boundCount(bound) === undefined && isCodeWordAt(statement, "OFFSET", index, grammar) ? "" : match,
      )
      .trim();
  }

  // Add the LIMIT/OFFSET clause.
  const limitClause = offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;

  return {
    sql: `${statement} ${limitClause}${midTrivia}${clauseRun}${trailing}`,
    wasLimited: true,
    originalLimit: info.existingLimit,
    appliedLimit: limit,
    appliedOffset: offset,
  };
}

/**
 * Quickly checks whether the statement has a LIMIT.
 */
export function hasQueryLimit(sql: string): boolean {
  const info = analyzeQuery(sql);
  return info.hasLimit;
}

/**
 * Checks whether the statement is a SELECT.
 *
 * `type` is the dialect, as on `analyzeQuery`. The multi-statement route passes
 * its resolved connection's, so the route and the provider that runs the
 * statement cannot disagree about what the statement is.
 */
export function isSelectQuery(sql: string, type?: DatabaseType): boolean {
  const info = analyzeQuery(sql, type);
  return info.type === "SELECT";
}

// ============================================================================
// An error about the bound Studio added
// ============================================================================

/**
 * The note an engine error gets when it points into the row bound Studio added (SF-022). Plain words, no backticks:
 * the results panel, the toast and History show an error message as text, so a code span would show its backticks.
 */
export function appendedBoundNote(addition: string): string {
  return `Studio added the clause ${addition} to this statement to bound its rows, so a position or token this error names may be in that clause rather than in your text.`;
}

/**
 * The text `sent` carries that `written` does not: what lies between their longest common prefix and suffix,
 * trimmed. The limiter only ever inserts one clause (`LIMIT n [OFFSET m]` at the end, or `TOP n` where a dialect
 * writes it), so this is that clause; empty when nothing was added.
 */
function addedText(written: string, sent: string): string {
  let prefix = 0;
  while (prefix < written.length && prefix < sent.length && written[prefix] === sent[prefix]) prefix++;
  let suffix = 0;
  const room = Math.min(written.length, sent.length) - prefix;
  while (suffix < room && written[written.length - 1 - suffix] === sent[sent.length - 1 - suffix]) suffix++;
  return sent.slice(prefix, sent.length - suffix).trim();
}

/**
 * Whether an engine message is a syntax error that points at `token`, one word or number of the clause Studio added,
 * in a shape an engine uses to name the token it stopped at. The token must be the quoted token itself (or the first
 * word of a quoted rest of the statement), spelt as Studio wrote it, so a message that only contains the word or the
 * number is not taken: PostgreSQL's `column "limit" does not exist` or `invalid input syntax for type integer:
 * "foo 501"`, MySQL's `Unknown column 'limit'`, ClickHouse's "Expected one of: ... LIMIT, OFFSET" list, and a message
 * that quotes the whole statement sent. A message that points at the clause in another shape gets no note: a missing
 * note leaves the engine's own message as it was, a wrong one blames a clause that is not at fault.
 */
function pointsAt(message: string, token: string): boolean {
  const end = "(?![A-Za-z0-9_])";
  return [
    // PostgreSQL `syntax error at or near "LIMIT"`, MySQL `... to use near 'LIMIT 501' at line 1`, SQLite
    // `near "LIMIT": syntax error`, SQL Server `Incorrect syntax near 'TOP'.` or `near the keyword 'TOP'.`
    new RegExp(`\\bnear (?:the keyword )?['"]${token}${end}`),
    // Snowflake `syntax error line 1 at position 35 unexpected '501'.`
    new RegExp(`\\bunexpected '${token}'`),
    // ClickHouse `Syntax error: failed at position 38 (501): 501.`
    new RegExp(`\\bfailed at position \\d+ \\('?${token}'?\\)`),
  ].some((shape) => shape.test(message));
}

/**
 * Adds `appendedBoundNote` to an engine error that points into the bound Studio added to the user's statement, so a
 * syntax error "at position 35 unexpected '501'" or "near LIMIT" is not read as a fault in text the user never
 * wrote. The error is the same object, its class and category kept, with the note after its message, once. It is
 * left alone when nothing was added, when it is not an `Error`, or when its message is not a syntax error that
 * points at one of the addition's words or numbers (`pointsAt`).
 */
export function noteAppendedBound(error: unknown, written: string, sent: string): unknown {
  if (!(error instanceof Error)) return error;
  const addition = addedText(written, sent);
  if (addition === "") return error;
  const note = appendedBoundNote(addition);
  if (error.message.includes(note)) return error;
  const tokens = addition.match(/[A-Za-z_]+|\d+/g) ?? [];
  if (tokens.some((token) => pointsAt(error.message, token))) error.message = `${error.message} ${note}`;
  return error;
}
