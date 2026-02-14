import { describe, test, expect } from 'bun:test';
import { generateTableQuery, generateSelectQuery, shouldRefreshSchema } from '@/lib/query-generators';
import type { ProviderCapabilities } from '@/lib/db/types';
import type { ColumnSchema } from '@/lib/types';

// ============================================================================
// Helpers
// ============================================================================

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: 'sql',
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsMaintenance: true,
    maintenanceOperations: [],
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: 'CREATE|ALTER|DROP|TRUNCATE',
    ...overrides,
  };
}

const sampleColumns: ColumnSchema[] = [
  { name: 'id', type: 'integer', nullable: false, isPrimary: true },
  { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
];

// ============================================================================
// generateTableQuery
// ============================================================================

describe('generateTableQuery', () => {
  test('SQL (postgres/mysql/sqlite) uses LIMIT 50', () => {
    const result = generateTableQuery('users', makeCaps({ defaultPort: 5432 }));
    expect(result).toBe('SELECT * FROM users LIMIT 50;');
  });

  test('JSON (MongoDB) generates JSON find query', () => {
    const result = generateTableQuery('users', makeCaps({ queryLanguage: 'json', defaultPort: null }));
    const parsed = JSON.parse(result);
    expect(parsed.collection).toBe('users');
    expect(parsed.operation).toBe('find');
    expect(parsed.options.limit).toBe(50);
  });

  test('Oracle (port 1521) uses FETCH FIRST 50 ROWS ONLY', () => {
    const result = generateTableQuery('users', makeCaps({ defaultPort: 1521 }));
    expect(result).toContain('FETCH FIRST 50 ROWS ONLY');
    expect(result).toContain('SELECT * FROM users');
  });

  test('MSSQL (port 1433) uses TOP 50', () => {
    const result = generateTableQuery('users', makeCaps({ defaultPort: 1433 }));
    expect(result).toBe('SELECT TOP 50 * FROM users;');
  });
});

// ============================================================================
// generateSelectQuery
// ============================================================================

describe('generateSelectQuery', () => {
  test('SQL with columns generates column list and LIMIT 100', () => {
    const result = generateSelectQuery('users', sampleColumns, makeCaps({ defaultPort: 5432 }));
    expect(result).toContain('id');
    expect(result).toContain('name');
    expect(result).toContain('LIMIT 100');
    expect(result).toContain('WHERE 1=1');
  });

  test('JSON (MongoDB) generates projection', () => {
    const result = generateSelectQuery('users', sampleColumns, makeCaps({ queryLanguage: 'json', defaultPort: null }));
    const parsed = JSON.parse(result);
    expect(parsed.collection).toBe('users');
    expect(parsed.options.projection.id).toBe(1);
    expect(parsed.options.projection.name).toBe(1);
    expect(parsed.options.limit).toBe(100);
  });

  test('Oracle uses FETCH FIRST 100 ROWS ONLY', () => {
    const result = generateSelectQuery('users', sampleColumns, makeCaps({ defaultPort: 1521 }));
    expect(result).toContain('FETCH FIRST 100 ROWS ONLY');
    expect(result).toContain('id');
    expect(result).toContain('name');
  });

  test('MSSQL uses TOP 100', () => {
    const result = generateSelectQuery('users', sampleColumns, makeCaps({ defaultPort: 1433 }));
    expect(result).toContain('SELECT TOP 100');
    expect(result).toContain('id');
    expect(result).toContain('name');
  });
});

// ============================================================================
// shouldRefreshSchema
// ============================================================================

describe('shouldRefreshSchema', () => {
  const pattern = 'CREATE|ALTER|DROP|TRUNCATE';

  test('CREATE TABLE triggers refresh', () => {
    expect(shouldRefreshSchema('CREATE TABLE users (id INT)', pattern)).toBe(true);
  });

  test('ALTER TABLE triggers refresh', () => {
    expect(shouldRefreshSchema('ALTER TABLE users ADD COLUMN email TEXT', pattern)).toBe(true);
  });

  test('DROP TABLE triggers refresh', () => {
    expect(shouldRefreshSchema('DROP TABLE users', pattern)).toBe(true);
  });

  test('TRUNCATE triggers refresh', () => {
    expect(shouldRefreshSchema('TRUNCATE TABLE users', pattern)).toBe(true);
  });

  test('SELECT does NOT trigger refresh', () => {
    expect(shouldRefreshSchema('SELECT * FROM users', pattern)).toBe(false);
  });

  test('INSERT does NOT trigger refresh', () => {
    expect(shouldRefreshSchema('INSERT INTO users VALUES (1)', pattern)).toBe(false);
  });
});
