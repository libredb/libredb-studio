/**
 * SQL Base Provider
 * Abstract class with shared logic for all SQL-based databases
 */

import { BaseDatabaseProvider } from "../../base-provider";
import {
  type DatabaseConnection,
  type ProviderOptions,
  type PreparedQuery,
  type QueryPrepareOptions,
} from "../../types";
import { analyzeQuery, applyQueryLimit, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../utils/query-limiter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";

// ============================================================================
// Statement vocabularies
// ============================================================================

/**
 * Statements that only read. Wider than the query limiter's SELECT set on purpose:
 * `SHOW`, `DESCRIBE`, `EXPLAIN` and `PRAGMA` return rows without a `SELECT`, and the
 * SQLite provider needs all of them on its `all()` branch.
 */
const READ_ONLY_KEYWORDS = new Set(["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "PRAGMA"]);

/** Statements that change the schema rather than the data in it. */
const SCHEMA_MODIFYING_KEYWORDS = new Set(["CREATE", "DROP", "ALTER", "TRUNCATE"]);

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
    if (this.type === "mssql") {
      const escaped = identifier.replace(/\]/g, "]]");
      return `[${escaped}]`;
    }
    const quoteChar = this.type === "mysql" ? "`" : '"';
    const escaped = identifier.replace(new RegExp(quoteChar, "g"), quoteChar + quoteChar);
    return `${quoteChar}${escaped}${quoteChar}`;
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
   * Determine if SSL should be enabled based on host
   */
  protected shouldEnableSSL(): boolean {
    const host = this.config.host?.toLowerCase() || "";
    const cloudProviders = ["supabase", "render", "neon", "planetscale", "aws", "azure", "gcp", "cloud"];
    return this.options.ssl === true || cloudProviders.some((provider) => host.includes(provider));
  }

  /**
   * Get information schema name based on dialect
   */
  protected getInformationSchemaName(): string {
    return "information_schema";
  }

  /**
   * Get default schema/database name for queries
   */
  protected getDefaultSchema(): string {
    switch (this.type) {
      case "postgres":
        return "public";
      case "mysql":
        return this.config.database || "";
      case "oracle":
        return this.config.user?.toUpperCase() || "";
      case "mssql":
        return "dbo";
    }
    return "";
  }

  /**
   * Check if query is read-only (SELECT, SHOW, DESCRIBE, EXPLAIN)
   *
   * Both predicates below read the leading keyword through
   * `lib/sql/leading-keyword` rather than `trim().startsWith(...)`, for two
   * reasons. A comment is not whitespace, so an annotated SELECT used to answer
   * false here - and the SQLite provider routes on this predicate, so it took the
   * write branch and returned no rows for a query that has data (#275). And
   * `startsWith` has no word boundary, so a statement led by an identifier that
   * merely begins with a keyword answered true; reading the whole word ends that.
   *
   * Both pass `this.type`, so the leading comment is read the way THIS engine reads
   * it - which for a dialect that nests block comments is not where a flat reading
   * ends one (#300). No provider's answer changes today: `isReadOnlyQuery`'s only
   * caller is the SQLite provider's `all()`/`run()` routing and SQLite reads comments
   * flat, while `isSchemaModifyingQuery` has no caller in `src/` at all. The grammar is
   * threaded anyway, so that the day a nesting dialect routes on either predicate it
   * reads the statement the way its own server will - and so that no reader in this
   * class disagrees with the limiter one method below it.
   */
  protected isReadOnlyQuery(sql: string): boolean {
    const keyword = readLeadingKeyword(sql, resolveSqlGrammar(this.type))?.keyword;
    return keyword !== undefined && READ_ONLY_KEYWORDS.has(keyword);
  }

  /**
   * Check if query modifies schema (CREATE, DROP, ALTER, TRUNCATE)
   */
  protected isSchemaModifyingQuery(sql: string): boolean {
    const keyword = readLeadingKeyword(sql, resolveSqlGrammar(this.type))?.keyword;
    return keyword !== undefined && SCHEMA_MODIFYING_KEYWORDS.has(keyword);
  }

  // ============================================================================
  // Query Preparation (applies LIMIT for SELECT queries)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    // `this.type` is the dialect channel (#292): the shared readers resolve `#`
    // and the other characters the engines disagree about the way THIS engine
    // does, rather than taking one engine's side for all of them.
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT") {
      const limitResult = applyQueryLimit(query, effectiveLimit, offset, {}, this.type);
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
