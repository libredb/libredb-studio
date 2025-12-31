/**
 * SQL Alias Extractor
 *
 * Lightweight SQL alias extraction for Monaco Editor completion.
 * Extracts table aliases from SQL queries without full parsing.
 * Designed for performance on every keystroke.
 *
 * @example
 * const result = extractAliases('SELECT * FROM customer AS c JOIN orders o ON c.id = o.customer_id');
 * // result.aliases.get('c') => { alias: 'c', tableName: 'customer', source: 'from' }
 * // result.aliases.get('o') => { alias: 'o', tableName: 'orders', source: 'join' }
 */

import type { TableAlias, AliasExtractionResult, AliasExtractorOptions } from './types';

/**
 * SQL keywords that should not be treated as aliases
 */
const SQL_KEYWORDS = new Set([
  'on', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'between',
  'set', 'values', 'select', 'from', 'join', 'using', 'as',
  'left', 'right', 'inner', 'outer', 'cross', 'full', 'natural', 'lateral',
  'group', 'order', 'by', 'having', 'limit', 'offset', 'fetch', 'first', 'next',
  'union', 'except', 'intersect', 'all', 'distinct', 'with', 'recursive',
  'case', 'when', 'then', 'else', 'end', 'cast', 'over', 'partition',
  'asc', 'desc', 'nulls', 'rows', 'range', 'preceding', 'following', 'current',
  'into', 'insert', 'update', 'delete', 'truncate', 'create', 'alter', 'drop',
  'table', 'view', 'index', 'schema', 'database', 'function', 'trigger', 'procedure',
  'primary', 'key', 'foreign', 'references', 'unique', 'check', 'default', 'constraint',
  'true', 'false', 'exists', 'any', 'some'
]);

/**
 * Check if identifier is a SQL keyword (to avoid false positives)
 */
function isSqlKeyword(identifier: string): boolean {
  return SQL_KEYWORDS.has(identifier.toLowerCase());
}

/**
 * Quick check for table keywords to enable early exit
 */
function hasTableKeywords(sql: string): boolean {
  const upper = sql.toUpperCase();
  return upper.includes('FROM') || upper.includes('JOIN') || upper.includes('WITH');
}

/**
 * Remove SQL comments and string literals to prevent false matches
 */
function preprocessSql(sql: string): string {
  return sql
    // Remove multi-line comments /* ... */
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Remove single-line comments -- ...
    .replace(/--[^\n]*/g, ' ')
    // Replace string literals with placeholder to preserve structure
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Extract aliases from WITH clause (CTEs)
 * Pattern: WITH cte_name AS (...)
 */
function extractCTEAliases(
  sql: string,
  aliases: Map<string, TableAlias>,
  caseInsensitive: boolean
): void {
  // First, check if there's a WITH clause
  const withMatch = sql.match(/\bWITH\s+(?:RECURSIVE\s+)?/i);
  if (!withMatch) return;

  // Find the CTE definitions between WITH and the main query
  // CTEs are: name AS (...), name2 AS (...)
  // We need to carefully match the CTE name before AS (
  const ctePattern = /\b(\w+)\s+AS\s*\(/gi;

  let match;
  while ((match = ctePattern.exec(sql)) !== null) {
    const cteName = match[1];

    // Skip if it's a SQL keyword
    if (isSqlKeyword(cteName)) continue;

    const key = caseInsensitive ? cteName.toLowerCase() : cteName;

    // Don't overwrite existing aliases (CTEs should be defined before use)
    if (!aliases.has(key)) {
      aliases.set(key, {
        alias: cteName,
        tableName: cteName, // CTE name is both alias and "table"
        source: 'cte'
      });
    }
  }
}

/**
 * Extract aliases from FROM clause
 * Patterns:
 *   FROM table AS alias
 *   FROM table alias
 *   FROM schema.table AS alias
 *   FROM schema.table alias
 */
function extractFromAliases(
  sql: string,
  aliases: Map<string, TableAlias>,
  caseInsensitive: boolean
): void {
  // Pattern explanation:
  // \bFROM\s+ - FROM keyword followed by whitespace
  // (?:(\w+)\.)? - Optional schema prefix (captured group 1)
  // (\w+) - Table name (required, captured group 2)
  // \s+ - Required whitespace
  // (?:AS\s+)? - Optional AS keyword
  // (\w+) - Alias (required, captured group 3)
  // (?=\s|,|$) - Followed by whitespace, comma, or end (lookahead to ensure complete match)
  const fromPattern = /\bFROM\s+(?:(\w+)\.)?(\w+)\s+(?:AS\s+)?(\w+)(?=\s|,|$)/gi;

  let match;
  while ((match = fromPattern.exec(sql)) !== null) {
    const [, schema, tableName, alias] = match;

    // Skip if alias is a SQL keyword
    if (isSqlKeyword(alias)) continue;

    // Skip if alias equals table name (not actually an alias)
    if (alias.toLowerCase() === tableName.toLowerCase()) continue;

    const key = caseInsensitive ? alias.toLowerCase() : alias;

    // Don't overwrite existing aliases
    if (!aliases.has(key)) {
      aliases.set(key, {
        alias,
        tableName,
        schema,
        source: 'from'
      });
    }
  }
}

/**
 * Extract aliases from JOIN clauses
 * Patterns:
 *   JOIN table AS alias
 *   LEFT JOIN table alias
 *   INNER JOIN schema.table AS alias
 */
function extractJoinAliases(
  sql: string,
  aliases: Map<string, TableAlias>,
  caseInsensitive: boolean
): void {
  // Pattern for all JOIN types
  // Optional join type prefix: LEFT, RIGHT, INNER, OUTER, CROSS, FULL, NATURAL
  const joinPattern = /\b(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL)?\s*JOIN\s+(?:(\w+)\.)?(\w+)\s+(?:AS\s+)?(\w+)(?=\s|$)/gi;

  let match;
  while ((match = joinPattern.exec(sql)) !== null) {
    const [, schema, tableName, alias] = match;

    // Skip if alias is a SQL keyword
    if (isSqlKeyword(alias)) continue;

    // Skip if alias equals table name (not actually an alias)
    if (alias.toLowerCase() === tableName.toLowerCase()) continue;

    const key = caseInsensitive ? alias.toLowerCase() : alias;

    // Don't overwrite existing aliases
    if (!aliases.has(key)) {
      aliases.set(key, {
        alias,
        tableName,
        schema,
        source: 'join'
      });
    }
  }
}

/**
 * Main entry point: Extract all table aliases from a SQL query
 *
 * @param sql - The SQL query string to parse
 * @param options - Extraction options
 * @returns AliasExtractionResult containing the alias map
 *
 * @example
 * const { aliases } = extractAliases('SELECT * FROM customer c WHERE c.id = 1');
 * aliases.get('c'); // { alias: 'c', tableName: 'customer', source: 'from' }
 */
export function extractAliases(
  sql: string,
  options: AliasExtractorOptions = {}
): AliasExtractionResult {
  const { includeCTEs = true, caseInsensitive = true } = options;

  const aliases = new Map<string, TableAlias>();

  // Early exit: no table references
  if (!hasTableKeywords(sql)) {
    return { aliases, hasTableReferences: false };
  }

  // Step 1: Preprocess - remove comments and strings
  const cleanedSql = preprocessSql(sql);

  // Step 2: Extract CTEs first (they can be referenced in FROM/JOIN)
  if (includeCTEs) {
    extractCTEAliases(cleanedSql, aliases, caseInsensitive);
  }

  // Step 3: Extract FROM clause aliases
  extractFromAliases(cleanedSql, aliases, caseInsensitive);

  // Step 4: Extract JOIN clause aliases
  extractJoinAliases(cleanedSql, aliases, caseInsensitive);

  return { aliases, hasTableReferences: aliases.size > 0 };
}

/**
 * Resolve an alias to its table name
 *
 * Returns the table name if alias exists in the map,
 * otherwise returns the input unchanged (for backward compatibility
 * with direct table.column completion)
 *
 * @param aliasOrTable - The identifier to resolve
 * @param aliases - The alias map from extractAliases()
 * @returns The resolved table name or the input if not found
 *
 * @example
 * const { aliases } = extractAliases('SELECT * FROM customer c');
 * resolveAlias('c', aliases);       // 'customer'
 * resolveAlias('customer', aliases); // 'customer' (passthrough)
 * resolveAlias('unknown', aliases);  // 'unknown' (passthrough)
 */
export function resolveAlias(
  aliasOrTable: string,
  aliases: Map<string, TableAlias>
): string {
  const key = aliasOrTable.toLowerCase();
  const tableAlias = aliases.get(key);
  return tableAlias?.tableName ?? aliasOrTable;
}

/**
 * Get the schema for an alias if it was specified
 *
 * @param aliasOrTable - The identifier to look up
 * @param aliases - The alias map from extractAliases()
 * @returns The schema name or undefined
 */
export function getAliasSchema(
  aliasOrTable: string,
  aliases: Map<string, TableAlias>
): string | undefined {
  const key = aliasOrTable.toLowerCase();
  return aliases.get(key)?.schema;
}
