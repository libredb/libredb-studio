/**
 * Query Limiter Utility
 * SELECT sorgularına otomatik LIMIT ekleyerek büyük result set'lerin
 * sistemi kilitlemesini önler.
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
 * SQL sorgusunu analiz eder ve türünü, LIMIT/OFFSET durumunu belirler.
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

  // LIMIT/OFFSET detection - en dıştaki sorgunun LIMIT'ini bul
  // Regex: Sorgunun sonundaki LIMIT [sayı] [OFFSET sayı] pattern'i
  const limitMatch = statement.match(/\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$/i);

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
      existingLimit = parseInt(limitMatch[1]);
      existingOffset = limitMatch[3] ? parseInt(limitMatch[3]) : undefined;
    }
  }

  // Oracle/MSSQL: FETCH FIRST N ROWS ONLY / FETCH NEXT N ROWS ONLY
  if (!hasLimit) {
    const fetchMatch = statement.match(/\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\s*$/i);
    if (fetchMatch) {
      hasLimit = true;
      existingLimit = parseInt(fetchMatch[1]);
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

  // OFFSET without LIMIT (rare but possible in PostgreSQL)
  const offsetOnlyMatch = !hasLimit && statement.match(/\bOFFSET\s+(\d+)\s*$/i);
  const hasOffset = hasLimit ? existingOffset !== undefined : !!offsetOnlyMatch;

  if (offsetOnlyMatch && !hasLimit) {
    existingOffset = parseInt(offsetOnlyMatch[1]);
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
 * SELECT sorgusuna LIMIT ekler veya mevcut LIMIT'i günceller.
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

  // SELECT değilse, limit ekleme
  if (info.type !== "SELECT") {
    return {
      sql,
      wasLimited: false,
      appliedLimit: 0,
      appliedOffset: 0,
    };
  }

  // Mevcut LIMIT varsa ve forceLimit false ise, mevcut limiti koru
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

  // Mevcut LIMIT/OFFSET'i kaldır (eğer forceLimit true ise). These are anchored
  // at the end of the STATEMENT, so a trailing comment neither hides the bound
  // from them nor gets torn apart by them.
  if (info.hasLimit && forceLimit) {
    // MySQL style: LIMIT offset, count
    statement = statement.replace(/\bLIMIT\s+\d+\s*,\s*\d+\s*$/i, "").trim();
    // Standard style: LIMIT count OFFSET offset
    statement = statement.replace(/\bLIMIT\s+\d+(?:\s+OFFSET\s+\d+)?\s*$/i, "").trim();
  }

  // LIMIT OFFSET clause'u ekle
  const limitClause = offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;

  return {
    sql: `${statement} ${limitClause}${trailing}`,
    wasLimited: true,
    originalLimit: info.existingLimit,
    appliedLimit: limit,
    appliedOffset: offset,
  };
}

/**
 * Sorgunun LIMIT'li olup olmadığını hızlıca kontrol eder.
 */
export function hasQueryLimit(sql: string): boolean {
  const info = analyzeQuery(sql);
  return info.hasLimit;
}

/**
 * Sorgunun SELECT türünde olup olmadığını kontrol eder.
 *
 * `type` is the dialect, as on `analyzeQuery`. The multi-statement route passes
 * its resolved connection's, so the route and the provider that runs the
 * statement cannot disagree about what the statement is.
 */
export function isSelectQuery(sql: string, type?: DatabaseType): boolean {
  const info = analyzeQuery(sql, type);
  return info.type === "SELECT";
}
