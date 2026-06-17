import { describe, test, expect } from 'bun:test';
import { generateTableQuery, generateSelectQuery, shouldRefreshSchema, quoteIdentifier } from '@/lib/query-generators';
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
    // Oracle folds unquoted identifiers to UPPERCASE, so a lowercase name is
    // quoted to preserve it.
    expect(result).toContain('SELECT * FROM "users"');
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
// quoteIdentifier (dialect-aware, quote-only-when-needed)
// ============================================================================

describe('quoteIdentifier', () => {
  test('PostgreSQL: leaves plain lowercase names unquoted', () => {
    expect(quoteIdentifier('users', makeCaps({ defaultPort: 5432 }))).toBe('users');
  });

  test('PostgreSQL: double-quotes mixed-case names (the reported bug)', () => {
    expect(quoteIdentifier('Customer', makeCaps({ defaultPort: 5432 }))).toBe('"Customer"');
    expect(quoteIdentifier('ContractExtractionPromptTemplate', makeCaps({ defaultPort: 5432 })))
      .toBe('"ContractExtractionPromptTemplate"');
  });

  test('SQLite (defaultPort null): double-quotes mixed-case names', () => {
    expect(quoteIdentifier('users', makeCaps({ defaultPort: null }))).toBe('users');
    expect(quoteIdentifier('Customer', makeCaps({ defaultPort: null }))).toBe('"Customer"');
  });

  test('Oracle: leaves plain UPPERCASE unquoted, quotes anything else', () => {
    expect(quoteIdentifier('USERS', makeCaps({ defaultPort: 1521 }))).toBe('USERS');
    // lowercase/mixed must be quoted because Oracle folds unquoted to UPPER
    expect(quoteIdentifier('customer', makeCaps({ defaultPort: 1521 }))).toBe('"customer"');
    expect(quoteIdentifier('Customer', makeCaps({ defaultPort: 1521 }))).toBe('"Customer"');
  });

  test('MySQL: preserves case unquoted, backticks only special names', () => {
    expect(quoteIdentifier('Customer', makeCaps({ defaultPort: 3306 }))).toBe('Customer');
    expect(quoteIdentifier('weird-name', makeCaps({ defaultPort: 3306 }))).toBe('`weird-name`');
  });

  test('SQL Server: preserves case unquoted, bracket-quotes special names', () => {
    expect(quoteIdentifier('Customer', makeCaps({ defaultPort: 1433 }))).toBe('Customer');
    expect(quoteIdentifier('weird name', makeCaps({ defaultPort: 1433 }))).toBe('[weird name]');
  });

  test('MongoDB (json): never quotes (collection name used as-is)', () => {
    expect(quoteIdentifier('Customer', makeCaps({ queryLanguage: 'json', defaultPort: null }))).toBe('Customer');
  });

  test('escapes embedded quote characters per dialect', () => {
    // Postgres/SQLite: embedded double-quote is doubled
    expect(quoteIdentifier('we"ird', makeCaps({ defaultPort: 5432 }))).toBe('"we""ird"');
    // MySQL: embedded backtick is doubled
    expect(quoteIdentifier('we`ird', makeCaps({ defaultPort: 3306 }))).toBe('`we``ird`');
    // SQL Server: embedded closing bracket is doubled
    expect(quoteIdentifier('we]ird', makeCaps({ defaultPort: 1433 }))).toBe('[we]]ird]');
    // Oracle: embedded double-quote is doubled
    expect(quoteIdentifier('we"ird', makeCaps({ defaultPort: 1521 }))).toBe('"we""ird"');
  });

  test('generateTableQuery quotes a mixed-case Postgres table', () => {
    expect(generateTableQuery('Customer', makeCaps({ defaultPort: 5432 })))
      .toBe('SELECT * FROM "Customer" LIMIT 50;');
  });

  test('generateSelectQuery quotes mixed-case table and columns (Postgres)', () => {
    const cols: ColumnSchema[] = [
      { name: 'Id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'full_name', type: 'text', nullable: true, isPrimary: false },
    ];
    const result = generateSelectQuery('Customer', cols, makeCaps({ defaultPort: 5432 }));
    expect(result).toContain('FROM "Customer"');
    expect(result).toContain('"Id"');
    expect(result).toContain('full_name'); // lowercase stays unquoted
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
