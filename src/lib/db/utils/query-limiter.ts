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
 */

import { readLeadingKeyword } from "@/lib/sql/leading-keyword";

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
/** Strip trailing semicolons and whitespace without regex to avoid ReDoS */
function stripTrailingSemicolon(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t" || s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  while (end > 0 && s[end - 1] === ";") end--;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t" || s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
  return s.slice(0, end);
}

export function analyzeQuery(sql: string): ParsedQueryInfo {
  // Strip trailing whitespace and semicolons upfront to avoid ReDoS-prone patterns
  const trimmed = stripTrailingSemicolon(sql.trim());

  // Query type detection - from the first keyword that is not whitespace or a comment
  const leading = readLeadingKeyword(trimmed);
  const keyword = leading?.keyword;
  // The statement from its own first keyword onward. Anything that searches the
  // statement's TEXT rather than just its leading keyword has to start here, or a
  // word written in the leading comment answers for the statement itself.
  const fromKeyword = leading === null ? trimmed : trimmed.slice(leading.start);
  // Whitespace-collapsed, upper-cased body for the probes that scan text. Built
  // from `fromKeyword`, NOT from `trimmed`: a leading comment reading
  // "switch to ROWNUM <= 10" once marked the statement already bounded, which
  // left the query unbounded - the very symptom #275 removed (PR #289 review).
  const normalized = fromKeyword.replace(/\s+/g, " ").toUpperCase();

  let type: ParsedQueryInfo["type"] = "OTHER";
  if (keyword === "SELECT") type = "SELECT";
  else if (keyword === "INSERT") type = "INSERT";
  else if (keyword === "UPDATE") type = "UPDATE";
  else if (keyword === "DELETE") type = "DELETE";
  else if (keyword !== undefined && DDL_KEYWORDS.has(keyword)) type = "DDL";
  // CTE (WITH clause) that leads to SELECT - searched from the keyword, so a
  // `SELECT` mentioned in the leading comment cannot make a writing CTE look like
  // one and earn it a LIMIT it would choke on
  else if (keyword === "WITH" && /\bSELECT\b/i.test(fromKeyword)) {
    type = "SELECT";
  }

  // LIMIT/OFFSET detection - en dıştaki sorgunun LIMIT'ini bul
  // Regex: Sorgunun sonundaki LIMIT [sayı] [OFFSET sayı] pattern'i
  const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$/i);

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
    const fetchMatch = trimmed.match(/\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\s*$/i);
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
  const offsetOnlyMatch = !hasLimit && trimmed.match(/\bOFFSET\s+(\d+)\s*$/i);
  const hasOffset = hasLimit ? existingOffset !== undefined : !!offsetOnlyMatch;

  if (offsetOnlyMatch && !hasLimit) {
    existingOffset = parseInt(offsetOnlyMatch[1]);
  }

  // UNION detection
  const isUnion = /\bUNION\b/i.test(normalized);

  // CTE detection (WITH clause) - from the same reading as the type above, so the
  // two cannot disagree about what the statement leads with
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

  // Check for trailing semicolon before stripping (string-based to avoid ReDoS)
  const trimmedInput = sql.trim();
  let modifiedSql = stripTrailingSemicolon(trimmedInput);
  const hasSemicolon = modifiedSql.length < trimmedInput.length && trimmedInput.includes(";");

  // Mevcut LIMIT/OFFSET'i kaldır (eğer forceLimit true ise)
  if (info.hasLimit && forceLimit) {
    // MySQL style: LIMIT offset, count
    modifiedSql = modifiedSql.replace(/\bLIMIT\s+\d+\s*,\s*\d+\s*$/i, "").trim();
    // Standard style: LIMIT count OFFSET offset
    modifiedSql = modifiedSql.replace(/\bLIMIT\s+\d+(?:\s+OFFSET\s+\d+)?\s*$/i, "").trim();
  }

  // LIMIT OFFSET clause'u ekle
  const limitClause = offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;

  modifiedSql = `${modifiedSql} ${limitClause}`;

  if (hasSemicolon) {
    modifiedSql += ";";
  }

  return {
    sql: modifiedSql,
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
