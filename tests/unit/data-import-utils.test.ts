import '../setup';
import { describe, expect, test } from 'bun:test';

// We test the pure utility functions from DataImportModal by extracting their logic
// Since they're not exported, we replicate them here for unit testing

function parseCSV(text: string): { headers: string[]; rows: string[][]; totalRows: number } {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return { headers: [], rows: [], totalRows: 0 };

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inQuotes) { inQuotes = true; }
      else if (ch === '"' && inQuotes) {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(line => parseLine(line));
  return { headers, rows, totalRows: rows.length };
}

function parseJSON(text: string): { headers: string[]; rows: string[][]; totalRows: number } {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) return { headers: [], rows: [], totalRows: 0 };
  const headers = [...new Set(arr.flatMap((obj: Record<string, unknown>) => Object.keys(obj)))];
  const rows = arr.map((obj: Record<string, unknown>) => headers.map(h => {
    const val = obj[h];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }));
  return { headers, rows, totalRows: rows.length };
}

function inferSqlType(values: string[]): string {
  const nonEmpty = values.filter(v => v !== '' && v !== null);
  if (nonEmpty.length === 0) return 'TEXT';
  if (nonEmpty.every(v => /^-?\d+$/.test(v))) return 'INTEGER';
  if (nonEmpty.every(v => /^-?\d+(\.\d+)?$/.test(v))) return 'NUMERIC';
  if (nonEmpty.every(v => /^(true|false|0|1)$/i.test(v))) return 'BOOLEAN';
  return 'TEXT';
}

function escapeSQL(value: string): string {
  if (value === '' || value === 'null' || value === 'NULL') return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

describe('parseCSV', () => {
  test('parses simple CSV', () => {
    const result = parseCSV('name,age\nAlice,30\nBob,25');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(result.totalRows).toBe(2);
  });

  test('handles quoted fields with commas', () => {
    const result = parseCSV('name,address\nAlice,"123 Main, St"\nBob,"456 Oak, Ave"');
    expect(result.rows[0][1]).toBe('123 Main, St');
  });

  test('handles escaped quotes', () => {
    const result = parseCSV('name,value\ntest,"He said ""hello"""');
    expect(result.rows[0][1]).toBe('He said "hello"');
  });

  test('returns empty for empty input', () => {
    const result = parseCSV('');
    expect(result.headers).toEqual([]);
    expect(result.totalRows).toBe(0);
  });
});

describe('parseJSON', () => {
  test('parses JSON array', () => {
    const result = parseJSON('[{"name":"Alice","age":30},{"name":"Bob","age":25}]');
    expect(result.headers).toEqual(['name', 'age']);
    expect(result.rows[0]).toEqual(['Alice', '30']);
    expect(result.totalRows).toBe(2);
  });

  test('wraps single object', () => {
    const result = parseJSON('{"name":"Alice"}');
    expect(result.headers).toEqual(['name']);
    expect(result.totalRows).toBe(1);
  });

  test('handles null values', () => {
    const result = parseJSON('[{"a":null,"b":1}]');
    expect(result.rows[0][0]).toBe('');
    expect(result.rows[0][1]).toBe('1');
  });

  test('stringifies nested objects', () => {
    const result = parseJSON('[{"data":{"x":1}}]');
    expect(result.rows[0][0]).toBe('{"x":1}');
  });
});

describe('inferSqlType', () => {
  test('infers INTEGER', () => { expect(inferSqlType(['1', '2', '-3'])).toBe('INTEGER'); });
  test('infers NUMERIC', () => { expect(inferSqlType(['1.5', '2.0', '-3.14'])).toBe('NUMERIC'); });
  test('infers BOOLEAN', () => { expect(inferSqlType(['true', 'false', '1', '0'])).toBe('BOOLEAN'); });
  test('defaults to TEXT', () => { expect(inferSqlType(['hello', 'world'])).toBe('TEXT'); });
  test('empty returns TEXT', () => { expect(inferSqlType([])).toBe('TEXT'); });
});

describe('escapeSQL', () => {
  test('wraps in quotes', () => { expect(escapeSQL('hello')).toBe("'hello'"); });
  test('escapes single quotes', () => { expect(escapeSQL("it's")).toBe("'it''s'"); });
  test('returns NULL for empty', () => { expect(escapeSQL('')).toBe('NULL'); });
  test('returns NULL for null string', () => { expect(escapeSQL('null')).toBe('NULL'); });
});
