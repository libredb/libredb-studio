/**
 * SQL Base Provider
 * Abstract class with shared logic for all SQL-based databases
 */

import { BaseDatabaseProvider } from '../../base-provider';
import {
  type DatabaseConnection,
  type ProviderOptions,
  type PreparedQuery,
  type QueryPrepareOptions,
} from '../../types';
import {
  analyzeQuery,
  applyQueryLimit,
  DEFAULT_QUERY_LIMIT,
  MAX_UNLIMITED_ROWS,
} from '../../utils/query-limiter';

// ============================================================================
// SQL Base Provider
// ============================================================================

export abstract class SQLBaseProvider extends BaseDatabaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  // ============================================================================
  // SQL-Specific Utilities
  // ============================================================================

  /**
   * Escape identifier based on SQL dialect
   * PostgreSQL/SQLite: "identifier"
   * MySQL: `identifier`
   */
  protected escapeIdentifier(identifier: string): string {
    if (this.type === 'mssql') {
      const escaped = identifier.replace(/\]/g, ']]');
      return `[${escaped}]`;
    }
    const quoteChar = this.type === 'mysql' ? '`' : '"';
    const escaped = identifier.replace(
      new RegExp(quoteChar, 'g'),
      quoteChar + quoteChar
    );
    return `${quoteChar}${escaped}${quoteChar}`;
  }

  /**
   * Escape string value for SQL
   */
  protected escapeString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Build LIMIT clause based on dialect
   */
  protected buildLimitClause(limit: number, offset?: number): string {
    if (offset !== undefined && offset > 0) {
      return `LIMIT ${limit} OFFSET ${offset}`;
    }
    return `LIMIT ${limit}`;
  }

  /**
   * Get placeholder style for parameterized queries
   * PostgreSQL: $1, $2, $3
   * MySQL/SQLite: ?, ?, ?
   */
  protected getPlaceholder(index: number): string {
    if (this.type === 'postgres') return `$${index}`;
    if (this.type === 'oracle') return `:${index}`;
    if (this.type === 'mssql') return `@p${index}`;
    return '?';
  }

  /**
   * Determine if SSL should be enabled based on host
   */
  protected shouldEnableSSL(): boolean {
    const host = this.config.host?.toLowerCase() || '';
    const cloudProviders = [
      'supabase',
      'render',
      'neon',
      'planetscale',
      'aws',
      'azure',
      'gcp',
      'cloud',
    ];
    return (
      this.options.ssl === true ||
      cloudProviders.some((provider) => host.includes(provider))
    );
  }

  /**
   * Get information schema name based on dialect
   */
  protected getInformationSchemaName(): string {
    return 'information_schema';
  }

  /**
   * Get default schema/database name for queries
   */
  protected getDefaultSchema(): string {
    switch (this.type) {
      case 'postgres':
        return 'public';
      case 'mysql':
        return this.config.database || '';
      case 'oracle':
        return this.config.user?.toUpperCase() || '';
      case 'mssql':
        return 'dbo';
      default:
        return '';
    }
  }

  /**
   * Check if query is read-only (SELECT, SHOW, DESCRIBE, EXPLAIN)
   */
  protected isReadOnlyQuery(sql: string): boolean {
    const trimmed = sql.trim().toLowerCase();
    return (
      trimmed.startsWith('select') ||
      trimmed.startsWith('show') ||
      trimmed.startsWith('describe') ||
      trimmed.startsWith('explain') ||
      trimmed.startsWith('pragma')
    );
  }

  /**
   * Check if query modifies schema (CREATE, DROP, ALTER, TRUNCATE)
   */
  protected isSchemaModifyingQuery(sql: string): boolean {
    const trimmed = sql.trim().toLowerCase();
    return (
      trimmed.startsWith('create') ||
      trimmed.startsWith('drop') ||
      trimmed.startsWith('alter') ||
      trimmed.startsWith('truncate')
    );
  }

  // ============================================================================
  // Query Preparation (applies LIMIT for SELECT queries)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query);

    if (queryInfo.type === 'SELECT') {
      const limitResult = applyQueryLimit(query, effectiveLimit, offset);
      return {
        query: limitResult.sql,
        wasLimited: limitResult.wasLimited,
        limit: effectiveLimit,
        offset,
      };
    }

    return { query, wasLimited: false, limit: effectiveLimit, offset };
  }
}
