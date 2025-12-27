/**
 * SQL Alias Extraction Types
 *
 * Type definitions for the SQL alias extraction module used by Monaco Editor
 * completion provider.
 */

/**
 * Represents a table alias mapping in a SQL query
 */
export interface TableAlias {
  /** The alias name (e.g., 'c' in 'customer AS c') */
  alias: string;
  /** The original table name (e.g., 'customer') */
  tableName: string;
  /** Optional schema prefix (e.g., 'public' in 'public.customer') */
  schema?: string;
  /** Source of the alias definition */
  source: 'from' | 'join' | 'cte';
}

/**
 * Result of alias extraction from a SQL query
 */
export interface AliasExtractionResult {
  /** Map of alias (lowercase) -> TableAlias */
  aliases: Map<string, TableAlias>;
  /** Whether the query contains extractable table references */
  hasTableReferences: boolean;
}

/**
 * Options for alias extraction
 */
export interface AliasExtractorOptions {
  /** Include CTE aliases (WITH clause) - default: true */
  includeCTEs?: boolean;
  /** Case-insensitive alias matching - default: true */
  caseInsensitive?: boolean;
}
