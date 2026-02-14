import { describe, test, expect } from 'bun:test';
import {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryError,
  TimeoutError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from '@/lib/db/errors';

// ============================================================================
// Error Classes
// ============================================================================

describe('DatabaseError', () => {
  test('sets name to "DatabaseError"', () => {
    const err = new DatabaseError('test message');
    expect(err.name).toBe('DatabaseError');
  });

  test('stores message, provider, code, and query', () => {
    const err = new DatabaseError('msg', 'postgres', 'ERR01', 'SELECT 1');
    expect(err.message).toBe('msg');
    expect(err.provider).toBe('postgres');
    expect(err.code).toBe('ERR01');
    expect(err.query).toBe('SELECT 1');
  });

  test('is instanceof Error', () => {
    const err = new DatabaseError('test');
    expect(err).toBeInstanceOf(Error);
  });

  test('toJSON() returns structured object', () => {
    const err = new DatabaseError('test', 'mysql', 'CODE1', 'SELECT 1');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'DatabaseError',
      message: 'test',
      provider: 'mysql',
      code: 'CODE1',
      query: 'SELECT 1...',
    });
  });

  test('toJSON() truncates query to 100 chars', () => {
    const longQuery = 'A'.repeat(200);
    const err = new DatabaseError('msg', 'postgres', undefined, longQuery);
    const json = err.toJSON();
    expect((json.query as string).length).toBe(103); // substring(0,100) + '...'
    expect((json.query as string).endsWith('...')).toBe(true);
  });

  test('toJSON() returns undefined query when no query provided', () => {
    const err = new DatabaseError('msg');
    const json = err.toJSON();
    expect(json.query).toBeUndefined();
  });
});

describe('DatabaseConfigError', () => {
  test('sets name to "DatabaseConfigError"', () => {
    const err = new DatabaseConfigError('bad config');
    expect(err.name).toBe('DatabaseConfigError');
  });

  test('sets code to CONFIG_ERROR', () => {
    const err = new DatabaseConfigError('bad config', 'postgres');
    expect(err.code).toBe('CONFIG_ERROR');
  });

  test('is instanceof DatabaseError and Error', () => {
    const err = new DatabaseConfigError('bad config');
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ConnectionError', () => {
  test('sets name to "ConnectionError"', () => {
    const err = new ConnectionError('conn fail');
    expect(err.name).toBe('ConnectionError');
  });

  test('stores host and port', () => {
    const err = new ConnectionError('fail', 'postgres', 'localhost', 5432);
    expect(err.host).toBe('localhost');
    expect(err.port).toBe(5432);
    expect(err.code).toBe('CONNECTION_ERROR');
  });

  test('is instanceof DatabaseError', () => {
    const err = new ConnectionError('fail');
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe('AuthenticationError', () => {
  test('sets name to "AuthenticationError"', () => {
    const err = new AuthenticationError('auth fail');
    expect(err.name).toBe('AuthenticationError');
  });

  test('sets code to AUTH_ERROR', () => {
    const err = new AuthenticationError('auth fail', 'mysql');
    expect(err.code).toBe('AUTH_ERROR');
    expect(err.provider).toBe('mysql');
  });

  test('is instanceof DatabaseError', () => {
    const err = new AuthenticationError('fail');
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe('PoolExhaustedError', () => {
  test('sets name to "PoolExhaustedError"', () => {
    const err = new PoolExhaustedError('pool full');
    expect(err.name).toBe('PoolExhaustedError');
  });

  test('stores poolSize', () => {
    const err = new PoolExhaustedError('pool full', 'postgres', 10);
    expect(err.poolSize).toBe(10);
    expect(err.code).toBe('POOL_EXHAUSTED');
  });

  test('is instanceof DatabaseError', () => {
    const err = new PoolExhaustedError('fail');
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe('QueryError', () => {
  test('sets name to "QueryError"', () => {
    const err = new QueryError('syntax error');
    expect(err.name).toBe('QueryError');
  });

  test('stores position and detail', () => {
    const err = new QueryError('fail', 'postgres', 'SELECT * FORM', 12, 'near FORM');
    expect(err.position).toBe(12);
    expect(err.detail).toBe('near FORM');
    expect(err.query).toBe('SELECT * FORM');
    expect(err.code).toBe('QUERY_ERROR');
  });

  test('is instanceof DatabaseError', () => {
    const err = new QueryError('fail');
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe('TimeoutError', () => {
  test('sets name to "TimeoutError"', () => {
    const err = new TimeoutError('timed out');
    expect(err.name).toBe('TimeoutError');
  });

  test('stores timeout and query', () => {
    const err = new TimeoutError('timed out', 'postgres', 30000, 'SELECT pg_sleep(60)');
    expect(err.timeout).toBe(30000);
    expect(err.query).toBe('SELECT pg_sleep(60)');
    expect(err.code).toBe('TIMEOUT_ERROR');
  });

  test('is instanceof DatabaseError', () => {
    const err = new TimeoutError('fail');
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

// ============================================================================
// Type Guards
// ============================================================================

describe('isDatabaseError', () => {
  test('returns true for DatabaseError instances', () => {
    expect(isDatabaseError(new DatabaseError('err'))).toBe(true);
  });

  test('returns true for subclass instances', () => {
    expect(isDatabaseError(new ConnectionError('err'))).toBe(true);
    expect(isDatabaseError(new QueryError('err'))).toBe(true);
  });

  test('returns false for plain Error', () => {
    expect(isDatabaseError(new Error('plain'))).toBe(false);
  });

  test('returns false for non-error values', () => {
    expect(isDatabaseError('string')).toBe(false);
    expect(isDatabaseError(null)).toBe(false);
    expect(isDatabaseError(undefined)).toBe(false);
  });
});

describe('isConnectionError', () => {
  test('returns true for ConnectionError', () => {
    expect(isConnectionError(new ConnectionError('err'))).toBe(true);
  });

  test('returns false for other DatabaseError subclasses', () => {
    expect(isConnectionError(new QueryError('err'))).toBe(false);
    expect(isConnectionError(new DatabaseError('err'))).toBe(false);
  });
});

describe('isQueryError', () => {
  test('returns true for QueryError', () => {
    expect(isQueryError(new QueryError('err'))).toBe(true);
  });

  test('returns false for non-QueryError', () => {
    expect(isQueryError(new ConnectionError('err'))).toBe(false);
  });
});

describe('isTimeoutError', () => {
  test('returns true for TimeoutError', () => {
    expect(isTimeoutError(new TimeoutError('err'))).toBe(true);
  });

  test('returns false for non-TimeoutError', () => {
    expect(isTimeoutError(new ConnectionError('err'))).toBe(false);
  });
});

describe('isAuthenticationError', () => {
  test('returns true for AuthenticationError', () => {
    expect(isAuthenticationError(new AuthenticationError('err'))).toBe(true);
  });

  test('returns false for non-AuthenticationError', () => {
    expect(isAuthenticationError(new DatabaseError('err'))).toBe(false);
  });
});

// ============================================================================
// isRetryableError
// ============================================================================

describe('isRetryableError', () => {
  test('ConnectionError is retryable', () => {
    expect(isRetryableError(new ConnectionError('fail'))).toBe(true);
  });

  test('TimeoutError is retryable', () => {
    expect(isRetryableError(new TimeoutError('timed out'))).toBe(true);
  });

  test('AuthenticationError is NOT retryable', () => {
    expect(isRetryableError(new AuthenticationError('bad creds'))).toBe(false);
  });

  test('DatabaseConfigError is NOT retryable', () => {
    expect(isRetryableError(new DatabaseConfigError('bad config'))).toBe(false);
  });

  test('QueryError with position is NOT retryable', () => {
    expect(isRetryableError(new QueryError('syntax', 'postgres', 'q', 5))).toBe(false);
  });

  test('plain Error is NOT retryable', () => {
    expect(isRetryableError(new Error('generic'))).toBe(false);
  });

  test('TypeError with "fetch" IS retryable (network error)', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });

  test('PoolExhaustedError is retryable (inherits from DatabaseError)', () => {
    expect(isRetryableError(new PoolExhaustedError('pool'))).toBe(true);
  });
});

// ============================================================================
// mapDatabaseError
// ============================================================================

describe('mapDatabaseError', () => {
  test('returns existing DatabaseError as-is', () => {
    const original = new ConnectionError('already mapped');
    const result = mapDatabaseError(original, 'postgres');
    expect(result).toBe(original);
  });

  test('non-Error input is converted to DatabaseError with String()', () => {
    const result = mapDatabaseError('raw string error', 'postgres');
    expect(result).toBeInstanceOf(DatabaseError);
    expect(result.message).toBe('raw string error');
    expect(result.provider).toBe('postgres');
  });

  test('ECONNREFUSED maps to ConnectionError', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const result = mapDatabaseError(err, 'postgres');
    expect(result).toBeInstanceOf(ConnectionError);
    expect(result.message).toContain('Failed to connect');
  });

  test('"password" in message maps to AuthenticationError', () => {
    const err = new Error('password authentication failed for user "test"');
    const result = mapDatabaseError(err, 'postgres');
    expect(result).toBeInstanceOf(AuthenticationError);
    expect(result.message).toContain('Authentication failed');
  });

  test('"timeout" in message maps to TimeoutError', () => {
    const err = new Error('query timeout exceeded');
    const result = mapDatabaseError(err, 'mysql', 'SELECT SLEEP(100)');
    const result2 = result as TimeoutError;
    expect(result2).toBeInstanceOf(TimeoutError);
    expect(result2.query).toBe('SELECT SLEEP(100)');
  });

  test('Oracle ORA-01017 maps to AuthenticationError', () => {
    const err = new Error('ORA-01017: invalid username/password; logon denied');
    const result = mapDatabaseError(err, 'oracle');
    expect(result).toBeInstanceOf(AuthenticationError);
  });

  test('Oracle ORA-12541 maps to ConnectionError', () => {
    const err = new Error('ORA-12541: TNS:no listener');
    const result = mapDatabaseError(err, 'oracle');
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test('Oracle ORA-12154 maps to ConnectionError', () => {
    const err = new Error('ORA-12154: TNS:could not resolve the connect identifier');
    const result = mapDatabaseError(err, 'oracle');
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test('Oracle ORA-00942 maps to QueryError', () => {
    const err = new Error('ORA-00942: table or view does not exist');
    const query = 'SELECT * FROM nonexistent';
    const result = mapDatabaseError(err, 'oracle', query);
    expect(result).toBeInstanceOf(QueryError);
  });

  test('MSSQL "login failed" maps to AuthenticationError', () => {
    const err = new Error('Login failed for user "sa"');
    const result = mapDatabaseError(err, 'mssql');
    expect(result).toBeInstanceOf(AuthenticationError);
  });

  test('MSSQL "cannot open database" maps to ConnectionError', () => {
    const err = new Error('Cannot open database "testdb" requested by the login');
    const result = mapDatabaseError(err, 'mssql');
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test('"syntax error" maps to QueryError', () => {
    const err = new Error('syntax error at or near "FORM"');
    const result = mapDatabaseError(err, 'postgres', 'SELECT * FORM users');
    expect(result).toBeInstanceOf(QueryError);
  });

  test('"pool" in message maps to PoolExhaustedError', () => {
    const err = new Error('pool is full, cannot allocate connection');
    const result = mapDatabaseError(err, 'postgres');
    expect(result).toBeInstanceOf(PoolExhaustedError);
  });

  test('generic error maps to base DatabaseError', () => {
    const err = new Error('something unexpected happened');
    const result = mapDatabaseError(err, 'sqlite', 'SELECT 1');
    expect(result).toBeInstanceOf(DatabaseError);
    expect(result.message).toBe('something unexpected happened');
    expect(result.provider).toBe('sqlite');
    expect(result.query).toBe('SELECT 1');
  });

  test('"connection refused" maps to ConnectionError', () => {
    const err = new Error('connection refused to host');
    const result = mapDatabaseError(err, 'mysql');
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test('"access denied" maps to AuthenticationError', () => {
    const err = new Error('Access denied for user');
    const result = mapDatabaseError(err, 'mysql');
    expect(result).toBeInstanceOf(AuthenticationError);
  });
});
