import '../setup';
import { describe, test, expect } from 'bun:test';
import {
  DatabaseError,
  QueryCancelledError,
  isQueryCancelledError,
  mapDatabaseError,
  TimeoutError,
} from '@/lib/db/errors';

describe('QueryCancelledError', () => {
  test('has correct name, code, provider, and query', () => {
    const err = new QueryCancelledError('Query was cancelled', 'postgres', 'SELECT 1');
    expect(err.name).toBe('QueryCancelledError');
    expect(err.code).toBe('QUERY_CANCELLED');
    expect(err.provider).toBe('postgres');
    expect(err.query).toBe('SELECT 1');
    expect(err.message).toBe('Query was cancelled');
    expect(err).toBeInstanceOf(Error);
  });

  test('is an instance of DatabaseError', () => {
    const err = new QueryCancelledError('cancelled', 'mysql');
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe('isQueryCancelledError', () => {
  test('returns true for QueryCancelledError', () => {
    const err = new QueryCancelledError('cancelled', 'postgres');
    expect(isQueryCancelledError(err)).toBe(true);
  });

  test('returns false for a generic Error', () => {
    expect(isQueryCancelledError(new Error('not cancelled'))).toBe(false);
  });

  test('returns false for a non-Error', () => {
    expect(isQueryCancelledError('string')).toBe(false);
    expect(isQueryCancelledError(null)).toBe(false);
    expect(isQueryCancelledError(undefined)).toBe(false);
  });
});

describe('mapDatabaseError — cancellation patterns', () => {
  test('returns QueryCancelledError for "canceling statement" message', () => {
    const native = new Error('ERROR: canceling statement due to user request');
    const mapped = mapDatabaseError(native, 'postgres', 'SELECT pg_sleep(100)');
    expect(mapped).toBeInstanceOf(QueryCancelledError);
    expect(mapped.message).toBe('Query was cancelled');
    expect(mapped.provider).toBe('postgres');
  });

  test('returns QueryCancelledError for "Query execution was interrupted" message', () => {
    const native = new Error('Query execution was interrupted');
    const mapped = mapDatabaseError(native, 'mysql', 'SELECT SLEEP(100)');
    expect(mapped).toBeInstanceOf(QueryCancelledError);
    expect(mapped.message).toBe('Query was cancelled');
  });

  test('returns QueryCancelledError for "query was cancelled" message', () => {
    const native = new Error('The query was cancelled by the user');
    const mapped = mapDatabaseError(native, 'postgres');
    expect(mapped).toBeInstanceOf(QueryCancelledError);
  });

  test('returns TimeoutError for "timeout" (not cancelled)', () => {
    const native = new Error('Connection timeout expired');
    const mapped = mapDatabaseError(native, 'postgres');
    expect(mapped).toBeInstanceOf(TimeoutError);
    expect(mapped).not.toBeInstanceOf(QueryCancelledError);
    expect(mapped.message).toContain('timeout');
  });

  test('returns TimeoutError for "timed out" (not cancelled)', () => {
    const native = new Error('Query timed out after 30s');
    const mapped = mapDatabaseError(native, 'mysql');
    expect(mapped).toBeInstanceOf(TimeoutError);
    expect(mapped).not.toBeInstanceOf(QueryCancelledError);
  });
});
