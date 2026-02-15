import { describe, test, expect } from 'bun:test';
import {
  parseCSV,
  parseJSON,
  inferSqlType,
  escapeSQL,
  generateImportSQL,
} from '@/components/DataImportModal';
import type { ParsedData } from '@/components/DataImportModal';

// =============================================================================
// parseCSV
// =============================================================================

describe('parseCSV', () => {
  test('parses simple CSV with headers and rows', () => {
    const result = parseCSV('name,age\nAlice,30\nBob,25');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(result.totalRows).toBe(2);
  });

  test('returns empty data for empty input', () => {
    const result = parseCSV('');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('returns empty data for whitespace-only input', () => {
    const result = parseCSV('   \n  \n  ');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('handles quoted fields', () => {
    const result = parseCSV('name,bio\nAlice,"Hello, World"\nBob,"Test"');
    expect(result.headers).toEqual(['name', 'bio']);
    expect(result.rows[0]).toEqual(['Alice', 'Hello, World']);
    expect(result.rows[1]).toEqual(['Bob', 'Test']);
  });

  test('handles escaped double quotes inside quoted fields', () => {
    const result = parseCSV('name,quote\nAlice,"She said ""hello"""\nBob,"Test"');
    expect(result.rows[0]).toEqual(['Alice', 'She said "hello"']);
  });

  test('handles Windows-style line endings (\\r\\n)', () => {
    const result = parseCSV('name,age\r\nAlice,30\r\nBob,25');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.totalRows).toBe(2);
  });

  test('handles header-only CSV', () => {
    const result = parseCSV('name,age,email');
    expect(result.headers).toEqual(['name', 'age', 'email']);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('trims whitespace from values', () => {
    const result = parseCSV('name , age \n Alice , 30 ');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows[0]).toEqual(['Alice', '30']);
  });

  test('handles single column CSV', () => {
    const result = parseCSV('name\nAlice\nBob');
    expect(result.headers).toEqual(['name']);
    expect(result.rows).toEqual([['Alice'], ['Bob']]);
  });

  test('handles comma inside quotes without splitting', () => {
    const result = parseCSV('city,address\nNY,"123 Main St, Apt 4"');
    expect(result.rows[0]).toEqual(['NY', '123 Main St, Apt 4']);
  });

  test('handles quote at end of field without escaped quote after', () => {
    // When closing quote is followed by comma
    const result = parseCSV('a,b\n"x",y');
    expect(result.rows[0]).toEqual(['x', 'y']);
  });
});

// =============================================================================
// parseJSON
// =============================================================================

describe('parseJSON', () => {
  test('parses JSON array of objects', () => {
    const result = parseJSON('[{"name":"Alice","age":30},{"name":"Bob","age":25}]');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(result.totalRows).toBe(2);
  });

  test('parses single JSON object (wraps in array)', () => {
    const result = parseJSON('{"name":"Alice","age":30}');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30']]);
    expect(result.totalRows).toBe(1);
  });

  test('returns empty data for empty array', () => {
    const result = parseJSON('[]');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  test('handles null values', () => {
    const result = parseJSON('[{"name":"Alice","bio":null}]');
    expect(result.rows[0]).toEqual(['Alice', '']);
  });

  test('handles undefined values (missing keys)', () => {
    const result = parseJSON('[{"name":"Alice","age":30},{"name":"Bob"}]');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows[1]).toEqual(['Bob', '']);
  });

  test('stringifies nested objects', () => {
    const result = parseJSON('[{"name":"Alice","meta":{"role":"admin"}}]');
    expect(result.headers).toEqual(['name', 'meta']);
    expect(result.rows[0][1]).toBe('{"role":"admin"}');
  });

  test('collects all unique headers from all objects', () => {
    const result = parseJSON('[{"a":1},{"b":2},{"c":3}]');
    expect(result.headers).toEqual(['a', 'b', 'c']);
    expect(result.totalRows).toBe(3);
  });

  test('converts number values to string', () => {
    const result = parseJSON('[{"count":42,"price":9.99}]');
    expect(result.rows[0]).toEqual(['42', '9.99']);
  });

  test('converts boolean values to string', () => {
    const result = parseJSON('[{"active":true,"deleted":false}]');
    expect(result.rows[0]).toEqual(['true', 'false']);
  });

  test('stringifies arrays', () => {
    const result = parseJSON('[{"tags":[1,2,3]}]');
    expect(result.rows[0][0]).toBe('[1,2,3]');
  });
});

// =============================================================================
// inferSqlType
// =============================================================================

describe('inferSqlType', () => {
  test('returns INTEGER for all integer values', () => {
    expect(inferSqlType(['1', '2', '3', '100'])).toBe('INTEGER');
  });

  test('returns INTEGER for negative integers', () => {
    expect(inferSqlType(['-1', '0', '42'])).toBe('INTEGER');
  });

  test('returns NUMERIC for decimal values', () => {
    expect(inferSqlType(['1.5', '2.0', '3.14'])).toBe('NUMERIC');
  });

  test('returns NUMERIC for mixed integer and decimal values', () => {
    expect(inferSqlType(['1', '2.5', '3'])).toBe('NUMERIC');
  });

  test('returns BOOLEAN for boolean-like values', () => {
    expect(inferSqlType(['true', 'false', 'true'])).toBe('BOOLEAN');
  });

  test('returns INTEGER for 0/1 values (integer check runs first)', () => {
    // 0 and 1 match the integer regex before boolean check
    expect(inferSqlType(['0', '1', '1', '0'])).toBe('INTEGER');
  });

  test('returns BOOLEAN for mixed case booleans', () => {
    expect(inferSqlType(['TRUE', 'False', 'true'])).toBe('BOOLEAN');
  });

  test('returns TEXT for string values', () => {
    expect(inferSqlType(['hello', 'world'])).toBe('TEXT');
  });

  test('returns TEXT for empty values array', () => {
    expect(inferSqlType([])).toBe('TEXT');
  });

  test('returns TEXT when all values are empty strings', () => {
    expect(inferSqlType(['', '', ''])).toBe('TEXT');
  });

  test('ignores empty strings when inferring type', () => {
    expect(inferSqlType(['', '1', '', '2'])).toBe('INTEGER');
  });

  test('returns TEXT for mixed types', () => {
    expect(inferSqlType(['hello', '42', 'true'])).toBe('TEXT');
  });

  test('returns NUMERIC for negative decimals', () => {
    expect(inferSqlType(['-1.5', '-2.3'])).toBe('NUMERIC');
  });

  test('ignores null values alongside empty strings', () => {
    // null cast to string would be 'null' but the filter checks v !== null
    // In practice values are always strings, but the filter also checks v !== null
    expect(inferSqlType([null as unknown as string, '42'])).toBe('INTEGER');
  });
});

// =============================================================================
// escapeSQL
// =============================================================================

describe('escapeSQL', () => {
  test('returns NULL for empty string', () => {
    expect(escapeSQL('')).toBe('NULL');
  });

  test('returns NULL for "null"', () => {
    expect(escapeSQL('null')).toBe('NULL');
  });

  test('returns NULL for "NULL"', () => {
    expect(escapeSQL('NULL')).toBe('NULL');
  });

  test('wraps regular string in single quotes', () => {
    expect(escapeSQL('hello')).toBe("'hello'");
  });

  test('escapes single quotes by doubling them', () => {
    expect(escapeSQL("O'Brien")).toBe("'O''Brien'");
  });

  test('escapes multiple single quotes', () => {
    expect(escapeSQL("it's a 'test'")).toBe("'it''s a ''test'''");
  });

  test('handles strings with special characters', () => {
    expect(escapeSQL('hello\nworld')).toBe("'hello\nworld'");
  });
});

// =============================================================================
// generateImportSQL
// =============================================================================

describe('generateImportSQL', () => {
  const sampleData: ParsedData = {
    headers: ['name', 'age', 'active'],
    rows: [
      ['Alice', '30', 'true'],
      ['Bob', '25', 'false'],
    ],
    totalRows: 2,
  };

  test('returns empty string for null parsedData', () => {
    expect(generateImportSQL(null, 'users', false, '', {})).toBe('');
  });

  test('returns empty string when no target table selected', () => {
    expect(generateImportSQL(sampleData, '', false, '', {})).toBe('');
  });

  test('generates INSERT for existing table', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', { name: 'name', age: 'age', active: 'active' });
    expect(sql).toContain('INSERT INTO users');
    expect(sql).toContain('name, age, active');
    expect(sql).toContain("'Alice'");
    expect(sql).toContain('30');
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
    expect(sql).toContain('name TEXT');
    expect(sql).toContain('age INTEGER');
    expect(sql).toContain('active BOOLEAN');
  });

  test('uses column mapping for renamed columns', () => {
    const mapping = { name: 'full_name', age: 'user_age', active: 'is_active' };
    const sql = generateImportSQL(sampleData, 'users', false, '', mapping);
    expect(sql).toContain('full_name, user_age, is_active');
  });

  test('uses column mapping in CREATE TABLE column definitions', () => {
    const mapping = { name: 'full_name', age: 'user_age', active: 'is_active' };
    const sql = generateImportSQL(sampleData, '', true, 'test', mapping);
    expect(sql).toContain('full_name TEXT');
    expect(sql).toContain('user_age INTEGER');
    expect(sql).toContain('is_active BOOLEAN');
  });

  test('generates TRUE/FALSE for boolean values', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', { name: 'name', age: 'age', active: 'active' });
    expect(sql).toContain('TRUE');
    expect(sql).toContain('FALSE');
  });

  test('handles NULL values in rows', () => {
    const dataWithNulls: ParsedData = {
      headers: ['name', 'bio'],
      rows: [['Alice', ''], ['Bob', 'NULL']],
      totalRows: 2,
    };
    const sql = generateImportSQL(dataWithNulls, 'users', false, '', { name: 'name', bio: 'bio' });
    expect(sql).toContain('NULL');
  });

  test('handles numeric values without quoting', () => {
    const numericData: ParsedData = {
      headers: ['id', 'price'],
      rows: [['1', '9.99'], ['2', '19.99']],
      totalRows: 2,
    };
    const sql = generateImportSQL(numericData, 'products', false, '', { id: 'id', price: 'price' });
    expect(sql).toContain('(1, 9.99)');
    expect(sql).toContain('(2, 19.99)');
  });

  test('escapes single quotes in text values', () => {
    const dataWithQuotes: ParsedData = {
      headers: ['name'],
      rows: [["O'Brien"]],
      totalRows: 1,
    };
    const sql = generateImportSQL(dataWithQuotes, 'users', false, '', { name: 'name' });
    expect(sql).toContain("'O''Brien'");
  });

  test('batches inserts in groups of 100', () => {
    const manyRows = Array.from({ length: 150 }, (_, i) => [`name${i}`]);
    const bigData: ParsedData = {
      headers: ['name'],
      rows: manyRows,
      totalRows: 150,
    };
    const sql = generateImportSQL(bigData, 'users', false, '', { name: 'name' });
    const insertCount = (sql.match(/INSERT INTO/g) || []).length;
    expect(insertCount).toBe(2); // 100 + 50
  });

  test('falls back to original header when mapping is empty', () => {
    const sql = generateImportSQL(sampleData, 'users', false, '', {});
    expect(sql).toContain('name, age, active');
  });

  test('handles "null" (lowercase) in values', () => {
    const data: ParsedData = {
      headers: ['val'],
      rows: [['null']],
      totalRows: 1,
    };
    const sql = generateImportSQL(data, 't', false, '', { val: 'val' });
    expect(sql).toContain('NULL');
  });

  test('boolean true/false values generate TRUE/FALSE in SQL', () => {
    const data: ParsedData = {
      headers: ['flag'],
      rows: [['true'], ['false'], ['True'], ['FALSE']],
      totalRows: 4,
    };
    const sql = generateImportSQL(data, 't', false, '', { flag: 'flag' });
    expect(sql).toContain('TRUE');
    expect(sql).toContain('FALSE');
  });

  test('NUMERIC column values are not quoted', () => {
    const data: ParsedData = {
      headers: ['amount'],
      rows: [['1.5'], ['2.3'], ['0.99']],
      totalRows: 3,
    };
    const sql = generateImportSQL(data, 't', false, '', { amount: 'amount' });
    expect(sql).toContain('1.5');
    expect(sql).not.toContain("'1.5'");
  });

  test('INTEGER column values are not quoted', () => {
    const data: ParsedData = {
      headers: ['count'],
      rows: [['10'], ['20']],
      totalRows: 2,
    };
    const sql = generateImportSQL(data, 't', false, '', { count: 'count' });
    expect(sql).toContain('(10)');
    expect(sql).not.toContain("'10'");
  });

  test('empty value in INTEGER column becomes NULL', () => {
    const data: ParsedData = {
      headers: ['id'],
      rows: [['1'], ['']],
      totalRows: 2,
    };
    const sql = generateImportSQL(data, 't', false, '', { id: 'id' });
    expect(sql).toContain('NULL');
  });

  test('generates valid SQL structure with VALUES keyword', () => {
    const data: ParsedData = {
      headers: ['x'],
      rows: [['a']],
      totalRows: 1,
    };
    const sql = generateImportSQL(data, 'tbl', false, '', { x: 'x' });
    expect(sql).toContain('INSERT INTO tbl (x)\nVALUES\n');
  });

  test('CREATE TABLE has semicolon and proper formatting', () => {
    const data: ParsedData = {
      headers: ['a', 'b'],
      rows: [['1', 'x']],
      totalRows: 1,
    };
    const sql = generateImportSQL(data, '', true, 'new_tbl', { a: 'a', b: 'b' });
    expect(sql).toContain('CREATE TABLE new_tbl (\n');
    expect(sql).toContain('\n);');
  });
});
