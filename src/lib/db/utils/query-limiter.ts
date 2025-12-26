/**
 * Query Limiter Utility
 * SELECT sorgularına otomatik LIMIT ekleyerek büyük result set'lerin
 * sistemi kilitlemesini önler.
 */

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_QUERY_LIMIT = 500;
export const MAX_UNLIMITED_ROWS = 100000;

// ============================================================================
// Types
// ============================================================================

export interface QueryLimitOptions {
  defaultLimit: number;
  maxUnlimited: number;
  forceLimit: boolean;
}

export interface ParsedQueryInfo {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'OTHER';
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
export function analyzeQuery(sql: string): ParsedQueryInfo {
  const trimmed = sql.trim();
  const normalized = trimmed.replace(/\s+/g, ' ').toUpperCase();

  // Query type detection
  let type: ParsedQueryInfo['type'] = 'OTHER';
  if (/^\s*SELECT\b/i.test(trimmed)) type = 'SELECT';
  else if (/^\s*INSERT\b/i.test(trimmed)) type = 'INSERT';
  else if (/^\s*UPDATE\b/i.test(trimmed)) type = 'UPDATE';
  else if (/^\s*DELETE\b/i.test(trimmed)) type = 'DELETE';
  else if (/^\s*(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(trimmed)) type = 'DDL';
  // CTE (WITH clause) that leads to SELECT
  else if (/^\s*WITH\b/i.test(trimmed) && /\bSELECT\b/i.test(trimmed)) {
    type = 'SELECT';
  }

  // LIMIT/OFFSET detection - en dıştaki sorgunun LIMIT'ini bul
  // Regex: Sorgunun sonundaki LIMIT [sayı] [OFFSET sayı] pattern'i
  const limitMatch = trimmed.match(
    /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*;?\s*$/i
  );

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

  // OFFSET without LIMIT (rare but possible in PostgreSQL)
  const offsetOnlyMatch = !hasLimit && trimmed.match(/\bOFFSET\s+(\d+)\s*;?\s*$/i);
  const hasOffset = hasLimit ? existingOffset !== undefined : !!offsetOnlyMatch;

  if (offsetOnlyMatch && !hasLimit) {
    existingOffset = parseInt(offsetOnlyMatch[1]);
  }

  // UNION detection
  const isUnion = /\bUNION\b/i.test(normalized);

  // CTE detection (WITH clause)
  const hasCTE = /^\s*WITH\b/i.test(trimmed);

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
  options: Partial<QueryLimitOptions> = {}
): LimitedQueryResult {
  const { forceLimit = false } = options;
  const info = analyzeQuery(sql);

  // SELECT değilse, limit ekleme
  if (info.type !== 'SELECT') {
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

  let modifiedSql = sql.trim();

  // Mevcut LIMIT/OFFSET'i kaldır (eğer forceLimit true ise)
  if (info.hasLimit && forceLimit) {
    // MySQL style: LIMIT offset, count
    modifiedSql = modifiedSql
      .replace(/\bLIMIT\s+\d+\s*,\s*\d+\s*;?\s*$/i, '')
      .trim();
    // Standard style: LIMIT count OFFSET offset
    modifiedSql = modifiedSql
      .replace(/\bLIMIT\s+\d+(?:\s+OFFSET\s+\d+)?\s*;?\s*$/i, '')
      .trim();
  }

  // Sondaki noktalı virgülü kaldır
  const hasSemicolon = modifiedSql.endsWith(';');
  if (hasSemicolon) {
    modifiedSql = modifiedSql.slice(0, -1).trim();
  }

  // LIMIT OFFSET clause'u ekle
  const limitClause =
    offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;

  modifiedSql = `${modifiedSql} ${limitClause}`;

  if (hasSemicolon) {
    modifiedSql += ';';
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
  return info.type === 'SELECT';
}
