import '../setup';
import { describe, test, expect } from 'bun:test';
import {
  parseCSV,
  parseJSON,
  inferSqlType,
  escapeSQL,
  generateImportSQL,
  type ParsedData,
} from '@/components/DataImportModal';

// ---------------------------------------------------------------------------
// parseCSV
// ---------------------------------------------------------------------------

describe('parseCSV', () => {
  test('parses simple CSV', () => {
    const result = parseCSV('name,age\nAlice,30\nBob,25');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(result.totalRows).toBe(2);
  });

  test('returns empty for empty input', () => {
    const result = parseCSV('');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('returns empty for whitespace-only input', () => {
    const result = parseCSV('  \n  \n  ');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('handles headers-only CSV', () => {
    const result = parseCSV('name,age,email');
    expect(result.headers).toEqual(['name', 'age', 'email']);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('handles quoted fields', () => {
    const result = parseCSV('name,bio\nAlice,"Hello, World"\nBob,"Line1"');
    expect(result.headers).toEqual(['name', 'bio']);
    expect(result.rows[0]).toEqual(['Alice', 'Hello, World']);
    expect(result.rows[1]).toEqual(['Bob', 'Line1']);
  });

  test('handles escaped quotes (double-quote)', () => {
    const result = parseCSV('name,quote\nAlice,"She said ""hello"""\nBob,simple');
    expect(result.rows[0][1]).toBe('She said "hello"');
    expect(result.rows[1][1]).toBe('simple');
  });

  test('handles CRLF line endings', () => {
    const result = parseCSV('a,b\r\n1,2\r\n3,4');
    expect(result.headers).toEqual(['a', 'b']);
    expect(result.rows).toEqual([['1', '2'], ['3', '4']]);
  });

  test('trims values', () => {
    const result = parseCSV('name , age \n Alice , 30 ');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows[0]).toEqual(['Alice', '30']);
  });

  test('skips blank lines', () => {
    const result = parseCSV('a,b\n1,2\n\n3,4\n');
    expect(result.rows.length).toBe(2);
    expect(result.totalRows).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseJSON
// ---------------------------------------------------------------------------

describe('parseJSON', () => {
  test('parses array of objects', () => {
    const result = parseJSON('[{"name":"Alice","age":30},{"name":"Bob","age":25}]');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(result.totalRows).toBe(2);
  });

  test('parses single object (wraps in array)', () => {
    const result = parseJSON('{"name":"Alice","age":30}');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30']]);
    expect(result.totalRows).toBe(1);
  });

  test('returns empty for empty array', () => {
    const result = parseJSON('[]');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('handles null/undefined values as empty string', () => {
    const result = parseJSON('[{"a":null,"b":"hello"},{"a":"world","b":null}]');
    expect(result.rows[0]).toEqual(['', 'hello']);
    expect(result.rows[1]).toEqual(['world', '']);
  });

  test('handles nested objects by serializing to JSON', () => {
    const result = parseJSON('[{"name":"Alice","meta":{"role":"admin"}}]');
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[0][1]).toBe('{"role":"admin"}');
  });

  test('handles arrays as values by serializing', () => {
    const result = parseJSON('[{"tags":["a","b"]}]');
    expect(result.rows[0][0]).toBe('["a","b"]');
  });

  test('unions headers from all objects', () => {
    const result = parseJSON('[{"a":1},{"b":2},{"a":3,"c":4}]');
    expect(result.headers).toContain('a');
    expect(result.headers).toContain('b');
    expect(result.headers).toContain('c');
    // Missing fields become empty string
    expect(result.rows[0]).toEqual(['1', '', '']);
    expect(result.rows[1]).toEqual(['', '2', '']);
  });

  test('handles boolean values', () => {
    const result = parseJSON('[{"active":true,"deleted":false}]');
    expect(result.rows[0]).toEqual(['true', 'false']);
  });

  test('throws on invalid JSON', () => {
    expect(() => parseJSON('not json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// inferSqlType
// ---------------------------------------------------------------------------

describe('inferSqlType', () => {
  test('returns INTEGER for all integer values', () => {
    expect(inferSqlType(['1', '2', '100', '-5'])).toBe('INTEGER');
  });

  test('returns NUMERIC for decimal values', () => {
    expect(inferSqlType(['1.5', '2.3', '-0.1'])).toBe('NUMERIC');
  });

  test('returns NUMERIC for mixed integer and decimal', () => {
    expect(inferSqlType(['1', '2.5', '3'])).toBe('NUMERIC');
  });

  test('returns BOOLEAN for boolean-like values', () => {
    expect(inferSqlType(['true', 'false', 'TRUE', 'FALSE'])).toBe('BOOLEAN');
    expect(inferSqlType(['0', '1'])).toBe('INTEGER'); // 0,1 are integers first
  });

  test('returns TEXT for string values', () => {
    expect(inferSqlType(['hello', 'world'])).toBe('TEXT');
  });

  test('returns TEXT for mixed types', () => {
    expect(inferSqlType(['1', 'hello', '3'])).toBe('TEXT');
  });

  test('returns TEXT for all empty values', () => {
    expect(inferSqlType(['', '', ''])).toBe('TEXT');
  });

  test('returns TEXT for empty array', () => {
    expect(inferSqlType([])).toBe('TEXT');
  });

  test('ignores empty strings when inferring type', () => {
    expect(inferSqlType(['1', '', '2', ''])).toBe('INTEGER');
  });
});

// ---------------------------------------------------------------------------
// escapeSQL
// ---------------------------------------------------------------------------

describe('escapeSQL', () => {
  test('wraps string in single quotes', () => {
    expect(escapeSQL('hello')).toBe("'hello'");
  });

  test('escapes single quotes', () => {
    expect(escapeSQL("it's")).toBe("'it''s'");
  });

  test('escapes multiple single quotes', () => {
    expect(escapeSQL("it's a 'test'")).toBe("'it''s a ''test'''");
  });

  test('returns NULL for empty string', () => {
    expect(escapeSQL('')).toBe('NULL');
  });

  test('returns NULL for "null"', () => {
    expect(escapeSQL('null')).toBe('NULL');
  });

  test('returns NULL for "NULL"', () => {
    expect(escapeSQL('NULL')).toBe('NULL');
  });
});

// ---------------------------------------------------------------------------
// generateImportSQL
// ---------------------------------------------------------------------------

describe('generateImportSQL', () => {
  const sampleData: ParsedData = {
    headers: ['name', 'age', 'active'],
    rows: [
      ['Alice', '30', 'true'],
      ['Bob', '25', 'false'],
    ],
    totalRows: 2,
  };

  test('returns empty for null parsedData', () => {
    expect(generateImportSQL(null, 'users', false, '', {})).toBe('');
  });

  test('returns empty when no table name (existing table mode, empty target)', () => {
    expect(generateImportSQL(sampleData, '', false, '', {})).toBe('');
  });

  test('generates INSERT into existing table', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', { name: 'name', age: 'age', active: 'active' });
    expect(sql).toContain('INSERT INTO users');
    expect(sql).toContain('name, age, active');
    expect(sql).not.toContain('CREATE TABLE');
  });

  test('generates CREATE TABLE + INSERT for new table', () => {
    const sql = generateImportSQL(sampleData, '', true, 'my_table', { name: 'name', age: 'age', active: 'active' });
    expect(sql).toContain('CREATE TABLE my_table');
    expect(sql).toContain('INSERT INTO my_table');
  });

  test('uses "imported_data" as default new table name', () => {
    const sql = generateImportSQL(sampleData, '', true, '', { name: 'name', age: 'age', active: 'active' });
    expect(sql).toContain('CREATE TABLE imported_data');
    expect(sql).toContain('INSERT INTO imported_data');
  });

  test('infers column types in CREATE TABLE', () => {
    const sql = generateImportSQL(sampleData, '', true, 'test', { name: 'name', age: 'age', active: 'active' });
    // name is TEXT, age is INTEGER, active is BOOLEAN
    expect(sql).toContain('name TEXT');
    expect(sql).toContain('age INTEGER');
    expect(sql).toContain('active BOOLEAN');
  });

  test('uses column mapping for names', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', { name: 'full_name', age: 'user_age', active: 'is_active' });
    expect(sql).toContain('full_name, user_age, is_active');
  });

  test('uses column mapping in CREATE TABLE', () => {
    const sql = generateImportSQL(sampleData, '', true, 'test', { name: 'full_name', age: 'user_age', active: 'is_active' });
    expect(sql).toContain('full_name TEXT');
    expect(sql).toContain('user_age INTEGER');
  });

  test('formats boolean values as TRUE/FALSE', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', { name: 'name', age: 'age', active: 'active' });
    expect(sql).toContain('TRUE');
    expect(sql).toContain('FALSE');
  });

  test('outputs numeric values unquoted', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', { name: 'name', age: 'age', active: 'active' });
    // age values should be unquoted: 30, 25
    expect(sql).toMatch(/\b30\b/);
    expect(sql).toMatch(/\b25\b/);
  });

  test('escapes text values in INSERT', () => {
    const data: ParsedData = {
      headers: ['name'],
      rows: [["O'Brien"]],
      totalRows: 1,
    };
    const sql = generateImportSQL(data, 'users', false, '', { name: 'name' });
    expect(sql).toContain("'O''Brien'");
  });

  test('handles NULL values', () => {
    const data: ParsedData = {
      headers: ['name', 'bio'],
      rows: [['Alice', ''], ['Bob', 'NULL']],
      totalRows: 2,
    };
    const sql = generateImportSQL(data, 'users', false, '', { name: 'name', bio: 'bio' });
    expect(sql).toContain('NULL');
  });

  test('batches rows in groups of 100', () => {
    const rows = Array.from({ length: 250 }, (_, i) => [String(i)]);
    const data: ParsedData = { headers: ['id'], rows, totalRows: 250 };
    const sql = generateImportSQL(data, 'items', false, '', { id: 'id' });

    // Should have 3 INSERT statements (100 + 100 + 50)
    const insertCount = (sql.match(/INSERT INTO/g) || []).length;
    expect(insertCount).toBe(3);
  });

  test('falls back to header name when mapping is empty', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', {});
    expect(sql).toContain('name, age, active');
  });
});
