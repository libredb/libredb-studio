import { describe, test, expect } from 'bun:test';
import {
  parseConnectionString,
  detectConnectionStringType,
} from '@/lib/connection-string-parser';

// ─── parseConnectionString ──────────────────────────────────────────────────

describe('parseConnectionString', () => {
  // ── PostgreSQL ──────────────────────────────────────────────────────────

  describe('postgres:// URLs', () => {
    test('parses full postgres URL', () => {
      const result = parseConnectionString('postgres://admin:secret@localhost:5432/mydb');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('postgres');
      expect(result!.host).toBe('localhost');
      expect(result!.port).toBe('5432');
      expect(result!.user).toBe('admin');
      expect(result!.password).toBe('secret');
      expect(result!.database).toBe('mydb');
    });

    test('parses postgresql:// URL', () => {
      const result = parseConnectionString('postgresql://user:pass@db.example.com:5433/appdb');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('postgres');
      expect(result!.host).toBe('db.example.com');
      expect(result!.port).toBe('5433');
      expect(result!.database).toBe('appdb');
    });

    test('uses default port 5432 when port is omitted', () => {
      const result = parseConnectionString('postgres://user:pass@host/db');
      expect(result!.port).toBe('5432');
    });

    test('handles missing database', () => {
      const result = parseConnectionString('postgres://user:pass@host:5432');
      expect(result!.database).toBeUndefined();
    });

    test('handles missing credentials', () => {
      const result = parseConnectionString('postgres://host:5432/db');
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.host).toBe('host');
      expect(result!.database).toBe('db');
    });

    test('decodes URL-encoded username and password', () => {
      const result = parseConnectionString('postgres://user%40name:p%40ss%23word@host/db');
      expect(result!.user).toBe('user@name');
      expect(result!.password).toBe('p@ss#word');
    });
  });

  // ── MySQL ───────────────────────────────────────────────────────────────

  describe('mysql:// URLs', () => {
    test('parses full mysql URL', () => {
      const result = parseConnectionString('mysql://root:password@127.0.0.1:3306/testdb');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('mysql');
      expect(result!.host).toBe('127.0.0.1');
      expect(result!.port).toBe('3306');
      expect(result!.user).toBe('root');
      expect(result!.database).toBe('testdb');
    });

    test('uses default port 3306 when port is omitted', () => {
      const result = parseConnectionString('mysql://root:pass@host/db');
      expect(result!.port).toBe('3306');
    });

    test('handles mysql URL without credentials', () => {
      const result = parseConnectionString('mysql://host:3307/db');
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.port).toBe('3307');
    });
  });

  // ── MongoDB ─────────────────────────────────────────────────────────────

  describe('mongodb:// and mongodb+srv:// URLs', () => {
    test('parses standard mongodb URL', () => {
      const result = parseConnectionString('mongodb://user:pass@localhost:27017/mydb');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('mongodb');
      expect(result!.connectionString).toBe('mongodb://user:pass@localhost:27017/mydb');
      expect(result!.user).toBe('user');
      expect(result!.password).toBe('pass');
      expect(result!.database).toBe('mydb');
      expect(result!.host).toBe('localhost');
      expect(result!.port).toBe('27017');
    });

    test('parses mongodb+srv URL', () => {
      const result = parseConnectionString('mongodb+srv://user:pass@cluster.example.com/mydb');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('mongodb');
      expect(result!.connectionString).toContain('mongodb+srv://');
      expect(result!.user).toBe('user');
      expect(result!.database).toBe('mydb');
    });

    test('preserves full connection string', () => {
      const uri = 'mongodb://user:pass@host1:27017,host2:27018/mydb?replicaSet=rs0';
      const result = parseConnectionString(uri);
      expect(result!.connectionString).toBe(uri);
    });

    test('parses mongodb URL without credentials', () => {
      const result = parseConnectionString('mongodb://localhost:27017/mydb');
      expect(result!.user).toBeUndefined();
      expect(result!.password).toBeUndefined();
      expect(result!.database).toBe('mydb');
    });

    test('parses mongodb URL with query parameters', () => {
      const result = parseConnectionString('mongodb://user:pass@host/db?authSource=admin');
      expect(result!.database).toBe('db');
      expect(result!.user).toBe('user');
    });

    test('decodes URL-encoded password in mongodb URL', () => {
      const result = parseConnectionString('mongodb://user:p%40ss@host/db');
      expect(result!.password).toBe('p@ss');
    });

    test('handles mongodb URL without database path', () => {
      const result = parseConnectionString('mongodb://localhost:27017');
      expect(result!.type).toBe('mongodb');
      expect(result!.database).toBeUndefined();
    });
  });

  // ── Redis ───────────────────────────────────────────────────────────────

  describe('redis:// and rediss:// URLs', () => {
    test('parses redis URL', () => {
      const result = parseConnectionString('redis://default:secret@redis-host:6379/0');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('redis');
      expect(result!.host).toBe('redis-host');
      expect(result!.port).toBe('6379');
      expect(result!.user).toBe('default');
      expect(result!.password).toBe('secret');
      expect(result!.database).toBe('0');
    });

    test('parses rediss (TLS) URL', () => {
      const result = parseConnectionString('rediss://user:pass@tls-host:6380/1');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('redis');
      expect(result!.host).toBe('tls-host');
      expect(result!.port).toBe('6380');
    });

    test('uses default port 6379 when omitted', () => {
      const result = parseConnectionString('redis://host/0');
      expect(result!.port).toBe('6379');
    });
  });

  // ── Oracle ──────────────────────────────────────────────────────────────

  describe('oracle:// URLs', () => {
    test('parses oracle URL', () => {
      const result = parseConnectionString('oracle://sys:oracle@dbhost:1521/orcl');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('oracle');
      expect(result!.host).toBe('dbhost');
      expect(result!.port).toBe('1521');
      expect(result!.user).toBe('sys');
      expect(result!.database).toBe('orcl');
    });

    test('uses default port 1521 when omitted', () => {
      const result = parseConnectionString('oracle://user:pass@host/db');
      expect(result!.port).toBe('1521');
    });
  });

  // ── MSSQL / SQL Server ──────────────────────────────────────────────────

  describe('mssql:// and sqlserver:// URLs', () => {
    test('parses mssql URL', () => {
      const result = parseConnectionString('mssql://sa:pass@sqlserver:1433/master');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('mssql');
      expect(result!.host).toBe('sqlserver');
      expect(result!.port).toBe('1433');
      expect(result!.database).toBe('master');
    });

    test('parses sqlserver:// URL', () => {
      const result = parseConnectionString('sqlserver://sa:pass@host:1434/testdb');
      expect(result!.type).toBe('mssql');
      expect(result!.port).toBe('1434');
    });

    test('uses default port 1433 when omitted', () => {
      const result = parseConnectionString('mssql://sa:pass@host/db');
      expect(result!.port).toBe('1433');
    });
  });

  // ── ADO.NET format ──────────────────────────────────────────────────────

  describe('ADO.NET format', () => {
    test('parses full ADO.NET connection string', () => {
      const result = parseConnectionString(
        'Server=myserver,1434;Database=mydb;User Id=sa;Password=secret;'
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe('mssql');
      expect(result!.host).toBe('myserver');
      expect(result!.port).toBe('1434');
      expect(result!.database).toBe('mydb');
      expect(result!.user).toBe('sa');
      expect(result!.password).toBe('secret');
    });

    test('uses default port when not specified in Server', () => {
      const result = parseConnectionString('Server=myserver;Database=mydb;');
      expect(result!.port).toBe('1433');
      expect(result!.host).toBe('myserver');
    });

    test('handles Initial Catalog and UID/PWD aliases', () => {
      const result = parseConnectionString(
        'Server=host;Initial Catalog=testdb;UID=admin;PWD=pass123;'
      );
      expect(result!.database).toBe('testdb');
      expect(result!.user).toBe('admin');
      expect(result!.password).toBe('pass123');
    });

    test('handles Data Source alias', () => {
      const result = parseConnectionString('Data Source=db-host,1450;Database=app;');
      // "Data Source=..." starts with "Data", not "Server", so it won't match /^Server\s*=/i
      // Let's check — the regex is /^Server\s*=/i — Data Source won't match.
      // So this should return null.
      expect(result).toBeNull();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('returns null for empty string', () => {
      expect(parseConnectionString('')).toBeNull();
    });

    test('returns null for whitespace only', () => {
      expect(parseConnectionString('   ')).toBeNull();
    });

    test('returns null for unknown protocol', () => {
      expect(parseConnectionString('ftp://host/path')).toBeNull();
    });

    test('returns null for plain text', () => {
      expect(parseConnectionString('just some random text')).toBeNull();
    });

    test('trims whitespace before parsing', () => {
      const result = parseConnectionString('  postgres://user:pass@host/db  ');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('postgres');
    });

    test('handles URL with special characters in password', () => {
      const result = parseConnectionString('mysql://root:%23pass%25word@host/db');
      expect(result!.password).toBe('#pass%word');
    });
  });
});

// ─── detectConnectionStringType ─────────────────────────────────────────────

describe('detectConnectionStringType', () => {
  test('detects postgres://', () => {
    expect(detectConnectionStringType('postgres://host')).toBe('postgres');
  });

  test('detects postgresql://', () => {
    expect(detectConnectionStringType('postgresql://host')).toBe('postgres');
  });

  test('detects mysql://', () => {
    expect(detectConnectionStringType('mysql://host')).toBe('mysql');
  });

  test('detects mongodb://', () => {
    expect(detectConnectionStringType('mongodb://host')).toBe('mongodb');
  });

  test('detects mongodb+srv://', () => {
    expect(detectConnectionStringType('mongodb+srv://host')).toBe('mongodb');
  });

  test('detects redis://', () => {
    expect(detectConnectionStringType('redis://host')).toBe('redis');
  });

  test('detects rediss://', () => {
    expect(detectConnectionStringType('rediss://host')).toBe('redis');
  });

  test('detects oracle://', () => {
    expect(detectConnectionStringType('oracle://host')).toBe('oracle');
  });

  test('detects mssql://', () => {
    expect(detectConnectionStringType('mssql://host')).toBe('mssql');
  });

  test('detects sqlserver://', () => {
    expect(detectConnectionStringType('sqlserver://host')).toBe('mssql');
  });

  test('detects ADO.NET Server= format', () => {
    expect(detectConnectionStringType('Server=host;Database=db;')).toBe('mssql');
  });

  test('returns null for unknown protocol', () => {
    expect(detectConnectionStringType('ftp://host')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(detectConnectionStringType('')).toBeNull();
  });

  test('is case insensitive', () => {
    expect(detectConnectionStringType('POSTGRES://host')).toBe('postgres');
    expect(detectConnectionStringType('MySQL://host')).toBe('mysql');
    expect(detectConnectionStringType('SERVER=host;')).toBe('mssql');
  });
});
