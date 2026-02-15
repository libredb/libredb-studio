import { describe, test, expect } from 'bun:test';
import { splitStatements, isMultiStatement } from '@/lib/sql/statement-splitter';
import type { SplitStatement } from '@/lib/sql/statement-splitter';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sqlsOf(result: SplitStatement[]): string[] {
  return result.map((s) => s.sql);
}

function linesOf(result: SplitStatement[]): number[] {
  return result.map((s) => s.startLine);
}

// ─── splitStatements ────────────────────────────────────────────────────────

describe('splitStatements', () => {
  // ── Single statement ────────────────────────────────────────────────────

  describe('single statement', () => {
    test('returns a single statement without semicolon', () => {
      const result = splitStatements('SELECT 1');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT 1');
      expect(result[0].startLine).toBe(0);
    });

    test('returns a single statement with semicolon', () => {
      const result = splitStatements('SELECT 1;');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT 1');
    });

    test('trims leading and trailing whitespace from statement', () => {
      const result = splitStatements('  SELECT 1  ;');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT 1');
    });

    test('handles trailing whitespace after semicolon', () => {
      const result = splitStatements('SELECT 1;   ');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT 1');
    });
  });

  // ── Multiple statements ─────────────────────────────────────────────────

  describe('multiple statements', () => {
    test('splits two statements on one line', () => {
      const result = splitStatements('SELECT 1; SELECT 2');
      expect(sqlsOf(result)).toEqual(['SELECT 1', 'SELECT 2']);
    });

    test('splits three statements', () => {
      const result = splitStatements('SELECT 1; SELECT 2; SELECT 3;');
      expect(result).toHaveLength(3);
      expect(sqlsOf(result)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    });

    test('splits statements separated by newlines', () => {
      const result = splitStatements('SELECT 1;\nSELECT 2;\nSELECT 3;');
      expect(result).toHaveLength(3);
    });

    test('handles consecutive semicolons (empty statements ignored)', () => {
      const result = splitStatements('SELECT 1;; ;SELECT 2;');
      expect(sqlsOf(result)).toEqual(['SELECT 1', 'SELECT 2']);
    });
  });

  // ── String literals ─────────────────────────────────────────────────────

  describe('single-quoted string literals', () => {
    test('does not split on semicolon inside single-quoted string', () => {
      const result = splitStatements("SELECT 'hello; world'");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT 'hello; world'");
    });

    test('handles escaped single quotes (double single-quote)', () => {
      const result = splitStatements("SELECT 'it''s'; SELECT 2");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT 'it''s'");
    });

    test('handles multiline string literal', () => {
      const result = splitStatements("SELECT 'line1\nline2'; SELECT 2");
      expect(result).toHaveLength(2);
    });

    test('handles unterminated single-quoted string (consumes rest)', () => {
      const result = splitStatements("SELECT 'unterminated; more");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toContain("'unterminated; more");
    });
  });

  // ── Double-quoted identifiers ───────────────────────────────────────────

  describe('double-quoted identifiers', () => {
    test('does not split on semicolon inside double-quoted identifier', () => {
      const result = splitStatements('SELECT "col;name"');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT "col;name"');
    });

    test('handles escaped double quotes (doubled)', () => {
      const result = splitStatements('SELECT "col""name"; SELECT 2');
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe('SELECT "col""name"');
    });

    test('handles unterminated double-quoted identifier', () => {
      const result = splitStatements('SELECT "unterminated; stuff');
      expect(result).toHaveLength(1);
    });
  });

  // ── Single-line comments ────────────────────────────────────────────────

  describe('single-line comments (--)', () => {
    test('ignores semicolons in single-line comment', () => {
      const result = splitStatements('SELECT 1 -- comment;\nSELECT 2');
      // The comment is part of the first statement text,
      // the newline ends the comment, and SELECT 2 continues as same or next stmt.
      // Since there's no ; before the newline, both are one statement? No:
      // after --, it consumes to newline INCLUDING the newline, then 'SELECT 2'
      // is the remaining text which is a new block appended to current.
      // But there was no semicolon, so it's ONE statement containing the comment.
      // Actually re-reading: current += comment text including newline,
      // then continues reading SELECT 2 which appends to current.
      // No semicolons anywhere, so it's one big statement.
      expect(result).toHaveLength(1);
    });

    test('comment at end of statement before semicolon', () => {
      const result = splitStatements('SELECT 1; -- comment\nSELECT 2');
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe('SELECT 1');
    });

    test('handles comment as the only content (line-only)', () => {
      const result = splitStatements('-- just a comment');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('-- just a comment');
    });

    test('comment between statements', () => {
      const result = splitStatements('SELECT 1;\n-- comment\nSELECT 2;');
      expect(result).toHaveLength(2);
    });
  });

  // ── Multi-line comments ─────────────────────────────────────────────────

  describe('multi-line comments (/* */)', () => {
    test('ignores semicolons in multi-line comment', () => {
      const result = splitStatements('SELECT /* ; */ 1');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT /* ; */ 1');
    });

    test('multi-line comment spanning multiple lines', () => {
      const result = splitStatements('SELECT 1;\n/* this is\na multi\nline comment */\nSELECT 2;');
      expect(result).toHaveLength(2);
    });

    test('unterminated multi-line comment consumes rest', () => {
      const result = splitStatements('SELECT 1; /* unterminated');
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe('SELECT 1');
      expect(result[1].sql).toBe('/* unterminated');
    });

    test('comment before a statement', () => {
      const result = splitStatements('/* setup */ SELECT 1');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('/* setup */ SELECT 1');
    });
  });

  // ── Dollar-quoted strings ───────────────────────────────────────────────

  describe('dollar-quoted strings', () => {
    test('does not split on semicolon inside $$...$$', () => {
      const result = splitStatements("SELECT $$hello; world$$");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT $$hello; world$$");
    });

    test('handles $func$...$func$ tag', () => {
      const body = 'BEGIN\n  RETURN x + 1;\nEND';
      const sql = `CREATE FUNCTION foo() RETURNS int AS $func$${body}$func$ LANGUAGE plpgsql; SELECT 1`;
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[0].sql).toContain('$func$');
      expect(result[1].sql).toBe('SELECT 1');
    });

    test('handles $body$...$body$ with semicolons inside', () => {
      const sql = "SELECT $body$INSERT INTO t VALUES (1);$body$; SELECT 2";
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[0].sql).toContain('$body$');
    });

    test('unterminated dollar-quoted string consumes rest', () => {
      const result = splitStatements('SELECT $$not closed; more text');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toContain('$$not closed');
    });

    test('plain $ without matching tag is treated as regular char', () => {
      const result = splitStatements('SELECT $100; SELECT 2');
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe('SELECT $100');
    });
  });

  // ── Empty / whitespace ──────────────────────────────────────────────────

  describe('empty and whitespace input', () => {
    test('empty string returns empty array', () => {
      expect(splitStatements('')).toEqual([]);
    });

    test('whitespace only returns empty array', () => {
      expect(splitStatements('   \n\t\n  ')).toEqual([]);
    });

    test('semicolons only returns empty array', () => {
      expect(splitStatements(';;;')).toEqual([]);
    });
  });

  // ── Line number tracking ────────────────────────────────────────────────

  describe('startLine tracking', () => {
    test('first statement starts at line 0', () => {
      const result = splitStatements('SELECT 1;');
      expect(result[0].startLine).toBe(0);
    });

    test('second statement on next line starts at correct line', () => {
      const result = splitStatements('SELECT 1;\nSELECT 2;');
      expect(linesOf(result)).toEqual([0, 1]);
    });

    test('tracks lines with blank lines between statements', () => {
      const result = splitStatements('SELECT 1;\n\n\nSELECT 2;');
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(3);
    });

    test('tracks lines across multiline statement', () => {
      const result = splitStatements('SELECT\n  1\n  FROM t;\nSELECT 2;');
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(3);
    });

    test('tracks lines with comments spanning multiple lines', () => {
      // After "SELECT 1;", whitespace skip crosses the \n (line 1),
      // then the comment block starts — statementStartLine is set to 1.
      const result = splitStatements('SELECT 1;\n/* comment\nspanning\nlines */\nSELECT 2;');
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
    });

    test('tracks lines with single-line comments', () => {
      // After "SELECT 1;", whitespace skip crosses the \n (line 1),
      // then "-- skip" starts — statementStartLine is set to 1.
      const result = splitStatements('SELECT 1;\n-- skip\nSELECT 2;');
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
    });
  });

  // ── Mixed scenarios ─────────────────────────────────────────────────────

  describe('mixed comments, strings, and semicolons', () => {
    test('string with comment-like content', () => {
      const result = splitStatements("SELECT '-- not a comment'; SELECT 2");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT '-- not a comment'");
    });

    test('string with block comment-like content', () => {
      const result = splitStatements("SELECT '/* not */ a comment'; SELECT 2");
      expect(result).toHaveLength(2);
    });

    test('comment with string-like content', () => {
      const result = splitStatements("SELECT 1; -- 'not a string\nSELECT 2;");
      expect(result).toHaveLength(2);
    });

    test('complex real-world PL/pgSQL function', () => {
      const sql = [
        'CREATE OR REPLACE FUNCTION test() RETURNS void AS $$',
        'BEGIN',
        "  INSERT INTO log VALUES ('test; value');",
        '  -- comment with ;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        'SELECT test();',
      ].join('\n');
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[1].sql).toBe('SELECT test()');
    });

    test('mix of double and single quotes with semicolons', () => {
      const sql = `SELECT "col;1", 'val;2'; SELECT 3`;
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe(`SELECT "col;1", 'val;2'`);
    });
  });
});

// ─── isMultiStatement ────────────────────────────────────────────────────────

describe('isMultiStatement', () => {
  test('returns false for single statement', () => {
    expect(isMultiStatement('SELECT 1')).toBe(false);
  });

  test('returns false for single statement with semicolon', () => {
    expect(isMultiStatement('SELECT 1;')).toBe(false);
  });

  test('returns true for two statements', () => {
    expect(isMultiStatement('SELECT 1; SELECT 2')).toBe(true);
  });

  test('returns false for empty input', () => {
    expect(isMultiStatement('')).toBe(false);
  });

  test('returns false for semicolons inside quotes', () => {
    expect(isMultiStatement("SELECT 'a;b'")).toBe(false);
  });

  test('returns true for statements separated by newlines', () => {
    expect(isMultiStatement('SELECT 1;\nSELECT 2;')).toBe(true);
  });
});
