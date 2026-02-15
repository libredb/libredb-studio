/**
 * Database Error Classes
 * Custom error types for database operations
 */

import type { DatabaseType } from './types';

// ============================================================================
// Base Database Error
// ============================================================================

/**
 * Base error class for all database-related errors
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly provider?: DatabaseType,
    public readonly code?: string,
    public readonly query?: string
  ) {
    super(message);
    this.name = 'DatabaseError';
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      code: this.code,
      // Don't expose full query in production for security
      query: this.query ? this.query.substring(0, 100) + '...' : undefined,
    };
  }
}

// ============================================================================
// Configuration Errors
// ============================================================================

/**
 * Configuration error - missing or invalid configuration
 */
export class DatabaseConfigError extends DatabaseError {
  constructor(message: string, provider?: DatabaseType) {
    super(message, provider, 'CONFIG_ERROR');
    this.name = 'DatabaseConfigError';
    Object.setPrototypeOf(this, DatabaseConfigError.prototype);
  }
}

// ============================================================================
// Connection Errors
// ============================================================================

/**
 * Connection error - failed to connect to database
 */
export class ConnectionError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly host?: string,
    public readonly port?: number
  ) {
    super(message, provider, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * Authentication error - invalid credentials
 */
export class AuthenticationError extends DatabaseError {
  constructor(message: string, provider?: DatabaseType) {
    super(message, provider, 'AUTH_ERROR');
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Pool exhausted error - no available connections in pool
 */
export class PoolExhaustedError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly poolSize?: number
  ) {
    super(message, provider, 'POOL_EXHAUSTED');
    this.name = 'PoolExhaustedError';
    Object.setPrototypeOf(this, PoolExhaustedError.prototype);
  }
}

// ============================================================================
// Query Errors
// ============================================================================

/**
 * Query error - SQL syntax or execution error
 */
export class QueryError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    query?: string,
    public readonly position?: number,
    public readonly detail?: string
  ) {
    super(message, provider, 'QUERY_ERROR', query);
    this.name = 'QueryError';
    Object.setPrototypeOf(this, QueryError.prototype);
  }
}

/**
 * Timeout error - query or connection timeout
 */
export class TimeoutError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly timeout?: number,
    query?: string
  ) {
    super(message, provider, 'TIMEOUT_ERROR', query);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

// ============================================================================
// Type Guards
// ============================================================================

export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}

export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError;
}

export function isQueryError(error: unknown): error is QueryError {
  return error instanceof QueryError;
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export function isAuthenticationError(error: unknown): error is AuthenticationError {
  return error instanceof AuthenticationError;
}

// ============================================================================
// Error Mapping Utilities
// ============================================================================

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!isDatabaseError(error)) {
    // Network errors are typically retryable
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return true;
    }
    return false;
  }

  // Auth and config errors are not retryable
  if (error instanceof AuthenticationError || error instanceof DatabaseConfigError) {
    return false;
  }

  // Query syntax errors are not retryable
  if (error instanceof QueryError && error.position !== undefined) {
    return false;
  }

  // Connection and timeout errors may be retryable
  return true;
}

/**
 * Map native database errors to our error types
 */
export function mapDatabaseError(
  error: unknown,
  provider: DatabaseType,
  query?: string
): DatabaseError {
  if (isDatabaseError(error)) {
    return error;
  }

  if (!(error instanceof Error)) {
    return new DatabaseError(String(error), provider);
  }

  const message = error.message.toLowerCase();

  // Connection errors
  if (
    message.includes('econnrefused') ||
    message.includes('connection refused') ||
    message.includes('connect etimedout') ||
    message.includes('getaddrinfo')
  ) {
    return new ConnectionError(
      `Failed to connect to ${provider} database: ${error.message}`,
      provider
    );
  }

  // Authentication errors
  if (
    message.includes('password') ||
    message.includes('authentication') ||
    message.includes('access denied') ||
    message.includes('permission denied')
  ) {
    return new AuthenticationError(
      `Authentication failed: ${error.message}`,
      provider
    );
  }

  // Timeout errors
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('canceling statement')
  ) {
    return new TimeoutError(
      `Query timeout: ${error.message}`,
      provider,
      undefined,
      query
    );
  }

  // Oracle errors
  if (message.includes('ora-01017') || message.includes('invalid username/password')) {
    return new AuthenticationError(`Authentication failed: ${error.message}`, provider);
  }
  if (message.includes('ora-12541') || message.includes('ora-12154') || message.includes('tns:')) {
    return new ConnectionError(`Failed to connect to Oracle: ${error.message}`, provider);
  }
  if (message.includes('ora-00942')) {
    return new QueryError(`Table or view does not exist: ${error.message}`, provider, query);
  }

  // MSSQL errors
  if (message.includes('login failed')) {
    return new AuthenticationError(`Authentication failed: ${error.message}`, provider);
  }
  if (message.includes('cannot open database')) {
    return new ConnectionError(`Database not found: ${error.message}`, provider);
  }

  // Query errors (PostgreSQL specific)
  if (message.includes('syntax error') || message.includes('column') || message.includes('relation')) {
    return new QueryError(
      error.message,
      provider,
      query,
      (error as { position?: number }).position
    );
  }

  // Pool errors
  if (message.includes('pool') || message.includes('too many connections')) {
    return new PoolExhaustedError(
      `Connection pool error: ${error.message}`,
      provider
    );
  }

  // Generic database error
  return new DatabaseError(error.message, provider, undefined, query);
}
