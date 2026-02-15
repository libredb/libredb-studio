import { describe, test, expect } from 'bun:test';
import {
  analyzeQuery,
  applyQueryLimit,
  hasQueryLimit,
  isSelectQuery,
} from '@/lib/db/utils/query-limiter';

// ─── analyzeQuery ───────────────────────────────────────────────────────────

describe('analyzeQuery', () => {
  // ── Query type detection ────────────────────────────────────────────────

  describe('type detection', () => {
    test('detects SELECT', () => {
      expect(analyzeQuery('SELECT * FROM users').type).toBe('SELECT');
    });

    test('detects SELECT (lowercase)', () => {
      expect(analyzeQuery('select id from t').type).toBe('SELECT');
    });

    test('detects INSERT', () => {
      expect(analyzeQuery("INSERT INTO users VALUES (1, 'a')").type).toBe('INSERT');
    });

    test('detects UPDATE', () => {
      expect(analyzeQuery("UPDATE users SET name = 'x' WHERE id = 1").type).toBe('UPDATE');
    });

    test('detects DELETE', () => {
      expect(analyzeQuery('DELETE FROM users WHERE id = 1').type).toBe('DELETE');
    });

    test('detects CREATE as DDL', () => {
      expect(analyzeQuery('CREATE TABLE foo (id int)').type).toBe('DDL');
    });

    test('detects ALTER as DDL', () => {
      expect(analyzeQuery('ALTER TABLE foo ADD col int').type).toBe('DDL');
    });

    test('detects DROP as DDL', () => {
      expect(analyzeQuery('DROP TABLE foo').type).toBe('DDL');
    });

    test('detects TRUNCATE as DDL', () => {
      expect(analyzeQuery('TRUNCATE TABLE foo').type).toBe('DDL');
    });

    test('detects WITH...SELECT (CTE) as SELECT', () => {
      const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte';
      const info = analyzeQuery(sql);
      expect(info.type).toBe('SELECT');
      expect(info.hasCTE).toBe(true);
    });

    test('detects unknown statement as OTHER', () => {
      expect(analyzeQuery('EXPLAIN SELECT * FROM t').type).toBe('OTHER');
    });

    test('detects GRANT as OTHER', () => {
      expect(analyzeQuery('GRANT SELECT ON t TO user').type).toBe('OTHER');
    });
  });

  // ── LIMIT detection ─────────────────────────────────────────────────────

  describe('LIMIT detection', () => {
    test('detects no LIMIT', () => {
      const info = analyzeQuery('SELECT * FROM users');
      expect(info.hasLimit).toBe(false);
      expect(info.existingLimit).toBeUndefined();
    });

    test('detects LIMIT N', () => {
      const info = analyzeQuery('SELECT * FROM users LIMIT 100');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(100);
    });

    test('detects LIMIT N OFFSET M', () => {
      const info = analyzeQuery('SELECT * FROM users LIMIT 50 OFFSET 10');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(50);
      expect(info.hasOffset).toBe(true);
      expect(info.existingOffset).toBe(10);
    });

    test('detects MySQL LIMIT offset, count style', () => {
      const info = analyzeQuery('SELECT * FROM users LIMIT 20, 50');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(50);
      expect(info.existingOffset).toBe(20);
    });

    test('detects Oracle FETCH FIRST N ROWS ONLY', () => {
      const info = analyzeQuery('SELECT * FROM users FETCH FIRST 25 ROWS ONLY');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(25);
    });

    test('detects Oracle FETCH NEXT N ROWS ONLY', () => {
      const info = analyzeQuery('SELECT * FROM users OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(20);
    });

    test('detects MSSQL SELECT TOP N', () => {
      const info = analyzeQuery('SELECT TOP 10 * FROM users');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(10);
    });

    test('detects Oracle ROWNUM', () => {
      const info = analyzeQuery('SELECT * FROM users WHERE ROWNUM <= 100');
      expect(info.hasLimit).toBe(true);
    });

    test('detects LIMIT with trailing semicolon', () => {
      const info = analyzeQuery('SELECT * FROM users LIMIT 100;');
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(100);
    });
  });

  // ── OFFSET detection ────────────────────────────────────────────────────

  describe('OFFSET detection', () => {
    test('no offset by default', () => {
      const info = analyzeQuery('SELECT * FROM users');
      expect(info.hasOffset).toBe(false);
    });

    test('detects standalone OFFSET (no LIMIT)', () => {
      const info = analyzeQuery('SELECT * FROM users OFFSET 20');
      expect(info.hasOffset).toBe(true);
      expect(info.existingOffset).toBe(20);
      expect(info.hasLimit).toBe(false);
    });
  });

  // ── Flags ───────────────────────────────────────────────────────────────

  describe('flags', () => {
    test('detects UNION', () => {
      const sql = 'SELECT * FROM a UNION SELECT * FROM b';
      expect(analyzeQuery(sql).isUnion).toBe(true);
    });

    test('detects UNION ALL', () => {
      const sql = 'SELECT * FROM a UNION ALL SELECT * FROM b';
      expect(analyzeQuery(sql).isUnion).toBe(true);
    });

    test('no UNION when not present', () => {
      expect(analyzeQuery('SELECT * FROM t').isUnion).toBe(false);
    });

    test('detects CTE (WITH clause)', () => {
      expect(analyzeQuery('WITH cte AS (SELECT 1) SELECT * FROM cte').hasCTE).toBe(true);
    });

    test('no CTE for regular queries', () => {
      expect(analyzeQuery('SELECT * FROM t').hasCTE).toBe(false);
    });

    test('detects subquery (nested SELECT)', () => {
      const sql = 'SELECT * FROM (SELECT id FROM users) sub';
      expect(analyzeQuery(sql).hasSubquery).toBe(true);
    });

    test('no subquery for single SELECT', () => {
      expect(analyzeQuery('SELECT * FROM users').hasSubquery).toBe(false);
    });

    test('CTE with subquery has both flags', () => {
      const sql = 'WITH cte AS (SELECT * FROM users) SELECT * FROM cte';
      const info = analyzeQuery(sql);
      expect(info.hasCTE).toBe(true);
      expect(info.hasSubquery).toBe(true); // CTE body + outer SELECT = 2 SELECTs
    });
  });
});

// ─── applyQueryLimit ────────────────────────────────────────────────────────

describe('applyQueryLimit', () => {
  // ── Adding LIMIT ────────────────────────────────────────────────────────

  describe('adding LIMIT to SELECT', () => {
    test('adds LIMIT to bare SELECT', () => {
      const result = applyQueryLimit('SELECT * FROM users', 100);
      expect(result.sql).toBe('SELECT * FROM users LIMIT 100');
      expect(result.wasLimited).toBe(true);
      expect(result.appliedLimit).toBe(100);
    });

    test('adds LIMIT and OFFSET', () => {
      const result = applyQueryLimit('SELECT * FROM users', 50, 20);
      expect(result.sql).toBe('SELECT * FROM users LIMIT 50 OFFSET 20');
      expect(result.wasLimited).toBe(true);
      expect(result.appliedLimit).toBe(50);
      expect(result.appliedOffset).toBe(20);
    });

    test('handles trailing semicolon', () => {
      const result = applyQueryLimit('SELECT * FROM users;', 100);
      expect(result.sql).toBe('SELECT * FROM users LIMIT 100;');
      expect(result.wasLimited).toBe(true);
    });

    test('trims whitespace before adding LIMIT', () => {
      const result = applyQueryLimit('  SELECT * FROM users  ', 100);
      expect(result.sql).toBe('SELECT * FROM users LIMIT 100');
    });
  });

  // ── Preserving existing LIMIT ───────────────────────────────────────────

  describe('preserving existing LIMIT', () => {
    test('preserves existing LIMIT when forceLimit is false (default)', () => {
      const result = applyQueryLimit('SELECT * FROM users LIMIT 50', 100);
      expect(result.sql).toBe('SELECT * FROM users LIMIT 50');
      expect(result.wasLimited).toBe(false);
      expect(result.originalLimit).toBe(50);
      expect(result.appliedLimit).toBe(50);
    });

    test('preserves existing LIMIT OFFSET', () => {
      const result = applyQueryLimit('SELECT * FROM users LIMIT 50 OFFSET 10', 100);
      expect(result.wasLimited).toBe(false);
      expect(result.appliedLimit).toBe(50);
      expect(result.appliedOffset).toBe(10);
    });
  });

  // ── Force LIMIT ─────────────────────────────────────────────────────────

  describe('forceLimit', () => {
    test('replaces existing LIMIT when forceLimit is true', () => {
      const result = applyQueryLimit('SELECT * FROM users LIMIT 50', 200, 0, {
        forceLimit: true,
      });
      expect(result.sql).toBe('SELECT * FROM users LIMIT 200');
      expect(result.wasLimited).toBe(true);
      expect(result.originalLimit).toBe(50);
      expect(result.appliedLimit).toBe(200);
    });

    test('replaces existing LIMIT OFFSET when forceLimit is true', () => {
      const result = applyQueryLimit('SELECT * FROM users LIMIT 50 OFFSET 10', 100, 5, {
        forceLimit: true,
      });
      expect(result.sql).toBe('SELECT * FROM users LIMIT 100 OFFSET 5');
      expect(result.wasLimited).toBe(true);
    });
  });

  // ── Non-SELECT queries ──────────────────────────────────────────────────

  describe('non-SELECT queries', () => {
    test('INSERT returns unmodified', () => {
      const sql = "INSERT INTO users VALUES (1, 'a')";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
      expect(result.appliedLimit).toBe(0);
    });

    test('UPDATE returns unmodified', () => {
      const sql = "UPDATE users SET name = 'x'";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test('DELETE returns unmodified', () => {
      const sql = 'DELETE FROM users WHERE id = 1';
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test('DDL (CREATE TABLE) returns unmodified', () => {
      const sql = 'CREATE TABLE foo (id int)';
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // ── CTE and complex queries ─────────────────────────────────────────────

  describe('CTE and complex queries', () => {
    test('adds LIMIT to CTE query', () => {
      const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte';
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe('WITH cte AS (SELECT 1) SELECT * FROM cte LIMIT 100');
      expect(result.wasLimited).toBe(true);
    });

    test('adds LIMIT to UNION query', () => {
      const sql = 'SELECT * FROM a UNION SELECT * FROM b';
      // analyzeQuery detects type=SELECT from first word, so it will add LIMIT
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toContain('LIMIT 100');
      expect(result.wasLimited).toBe(true);
    });
  });

  // ── Offset behavior ────────────────────────────────────────────────────

  describe('offset behavior', () => {
    test('offset=0 does not add OFFSET clause', () => {
      const result = applyQueryLimit('SELECT * FROM t', 100, 0);
      expect(result.sql).toBe('SELECT * FROM t LIMIT 100');
      expect(result.appliedOffset).toBe(0);
    });

    test('positive offset adds OFFSET clause', () => {
      const result = applyQueryLimit('SELECT * FROM t', 100, 50);
      expect(result.sql).toBe('SELECT * FROM t LIMIT 100 OFFSET 50');
      expect(result.appliedOffset).toBe(50);
    });
  });
});

// ─── hasQueryLimit ──────────────────────────────────────────────────────────

describe('hasQueryLimit', () => {
  test('returns false for query without LIMIT', () => {
    expect(hasQueryLimit('SELECT * FROM users')).toBe(false);
  });

  test('returns true for query with LIMIT', () => {
    expect(hasQueryLimit('SELECT * FROM users LIMIT 100')).toBe(true);
  });

  test('returns true for query with TOP', () => {
    expect(hasQueryLimit('SELECT TOP 10 * FROM users')).toBe(true);
  });

  test('returns true for query with FETCH FIRST', () => {
    expect(hasQueryLimit('SELECT * FROM users FETCH FIRST 10 ROWS ONLY')).toBe(true);
  });

  test('returns false for INSERT', () => {
    expect(hasQueryLimit("INSERT INTO t VALUES (1)")).toBe(false);
  });
});

// ─── isSelectQuery ──────────────────────────────────────────────────────────

describe('isSelectQuery', () => {
  test('returns true for SELECT', () => {
    expect(isSelectQuery('SELECT * FROM users')).toBe(true);
  });

  test('returns true for lowercase select', () => {
    expect(isSelectQuery('select 1')).toBe(true);
  });

  test('returns true for WITH...SELECT (CTE)', () => {
    expect(isSelectQuery('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true);
  });

  test('returns false for INSERT', () => {
    expect(isSelectQuery("INSERT INTO t VALUES (1)")).toBe(false);
  });

  test('returns false for UPDATE', () => {
    expect(isSelectQuery("UPDATE t SET x = 1")).toBe(false);
  });

  test('returns false for DELETE', () => {
    expect(isSelectQuery('DELETE FROM t')).toBe(false);
  });

  test('returns false for DDL', () => {
    expect(isSelectQuery('CREATE TABLE t (id int)')).toBe(false);
  });

  test('returns false for EXPLAIN', () => {
    expect(isSelectQuery('EXPLAIN SELECT * FROM t')).toBe(false);
  });
});
