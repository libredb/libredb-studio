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
 * Where the statement ENDS comes from `lib/sql/statement-end`, and both the
 * "already bounded" probes and the injection use that one reading. They used to
 * disagree with each other by accident - each worked on the raw text - and a
 * trailing line comment then broke the limiter in both directions: the injected
 * bound landed inside the comment while the caller was told the statement was
 * limited, and a commented-out bound was read as a real one so nothing was
 * injected at all (#280).
 */

import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { readStatementEnd } from "@/lib/sql/statement-end";

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

/** The type this module reports for a statement operated by `keyword`. */
function classifyKeyword(keyword: string | undefined): ParsedQueryInfo["type"] {
  if (keyword === "SELECT") return "SELECT";
  if (keyword === "INSERT") return "INSERT";
  if (keyword === "UPDATE") return "UPDATE";
  if (keyword === "DELETE") return "DELETE";
  if (keyword !== undefined && DDL_KEYWORDS.has(keyword)) return "DDL";
  return "OTHER";
}

export function analyzeQuery(sql: string): ParsedQueryInfo {
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
  const statement = sql.slice(0, readStatementEnd(sql).end);

  // Query type detection - from the first keyword that is not whitespace or a comment
  const leading = readLeadingKeyword(statement);
  const keyword = leading?.keyword;
  // The statement from its own first keyword onward. Anything that searches the
  // statement's TEXT rather than just its leading keyword has to start here, or a
  // word written in the leading comment answers for the statement itself.
  const fromKeyword = leading === null ? statement : statement.slice(leading.start);
  // Whitespace-collapsed, upper-cased body for the probes that scan text. Built
  // from `fromKeyword`, NOT from `statement`: a leading comment reading
  // "switch to ROWNUM <= 10" once marked the statement already bounded, which
  // left the query unbounded - the very symptom #275 removed (PR #289 review).
  const normalized = fromKeyword.replace(/\s+/g, " ").toUpperCase();

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
  const typingKeyword = keyword === "WITH" ? readOperativeKeyword(statement)?.keyword : keyword;
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

  // Oracle legacy: ROWNUM in WHERE clause
  if (!hasLimit && /\bROWNUM\s*<=?\s*\d+/i.test(normalized)) {
    hasLimit = true;
  }

  // OFFSET without LIMIT (rare but possible in PostgreSQL)
  const offsetOnlyMatch = !hasLimit && statement.match(/\bOFFSET\s+(\d+)\s*$/i);
  const hasOffset = hasLimit ? existingOffset !== undefined : !!offsetOnlyMatch;

  if (offsetOnlyMatch && !hasLimit) {
    existingOffset = parseInt(offsetOnlyMatch[1]);
  }

  // UNION detection
  const isUnion = /\bUNION\b/i.test(normalized);

  // CTE detection (WITH clause) - this answers what the statement LEADS with,
  // which is a different question from what it operates: `WITH t AS (...) INSERT
  // ...` has a CTE and is typed INSERT. So this deliberately stays on the leading
  // keyword and is true for every `WITH`, whatever its type turned out to be.
  const hasCTE = keyword === "WITH";

  // Subquery detection (nested SELECT - birden fazla SELECT var mı)
  const selectCount = (normalized.match(/\bSELECT\b/g) || []).length;
  const hasSubquery = selectCount > 1;

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
): LimitedQueryResult {
  const { forceLimit = false } = options;
  const info = analyzeQuery(sql);

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
  // honest to put the clause, and `wasLimited: false` says so. The two shapes are
  // a literal MySQL and PostgreSQL would close in different places
  // (`… WHERE name = 'O\'Brien';`, where inserting on a guess puts the bound after
  // the `;`) and a trailing `#` run, which is a comment in MySQL and a temp table,
  // an identifier or an operator elsewhere.
  const source = sql.trim();
  const { end, rewritable } = readStatementEnd(source);

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
 */
export function isSelectQuery(sql: string): boolean {
  const info = analyzeQuery(sql);
  return info.type === "SELECT";
}
