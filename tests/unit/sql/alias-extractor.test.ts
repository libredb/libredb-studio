import { describe, test, expect } from 'bun:test';
import { extractAliases, resolveAlias, getAliasSchema } from '@/lib/sql/alias-extractor';

// ============================================================================
// extractAliases — FROM clause
// ============================================================================

describe('extractAliases: FROM clause', () => {
  test('FROM table alias (implicit)', () => {
    const { aliases } = extractAliases('SELECT * FROM users u');
    const alias = aliases.get('u');
    expect(alias).toBeDefined();
    expect(alias!.alias).toBe('u');
    expect(alias!.tableName).toBe('users');
    expect(alias!.source).toBe('from');
  });

  test('FROM table AS alias (explicit)', () => {
    const { aliases } = extractAliases('SELECT * FROM users AS u');
    const alias = aliases.get('u');
    expect(alias).toBeDefined();
    expect(alias!.tableName).toBe('users');
    expect(alias!.source).toBe('from');
  });

  test('schema.table alias extracts schema', () => {
    const { aliases } = extractAliases('SELECT * FROM public.users u');
    const alias = aliases.get('u');
    expect(alias).toBeDefined();
    expect(alias!.tableName).toBe('users');
    expect(alias!.schema).toBe('public');
    expect(alias!.source).toBe('from');
  });

  test('SQL keyword after table name is not treated as alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users WHERE id = 1');
    expect(aliases.has('where')).toBe(false);
    expect(aliases.size).toBe(0);
  });

  test('same-name alias is skipped (FROM users users)', () => {
    const { aliases } = extractAliases('SELECT * FROM users users');
    expect(aliases.size).toBe(0);
  });
});

// ============================================================================
// extractAliases — JOIN clause
// ============================================================================

describe('extractAliases: JOIN clause', () => {
  test('JOIN table alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u JOIN orders o ON u.id = o.user_id');
    const alias = aliases.get('o');
    expect(alias).toBeDefined();
    expect(alias!.tableName).toBe('orders');
    expect(alias!.source).toBe('join');
  });

  test('LEFT JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id');
    expect(aliases.get('o')?.source).toBe('join');
    expect(aliases.get('o')?.tableName).toBe('orders');
  });

  test('RIGHT JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u RIGHT JOIN orders o ON u.id = o.user_id');
    expect(aliases.get('o')?.tableName).toBe('orders');
  });

  test('INNER JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u INNER JOIN orders o ON u.id = o.user_id');
    expect(aliases.get('o')?.tableName).toBe('orders');
  });

  test('CROSS JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u CROSS JOIN products p');
    expect(aliases.get('p')?.tableName).toBe('products');
    expect(aliases.get('p')?.source).toBe('join');
  });

  test('JOIN with schema.table', () => {
    const { aliases } = extractAliases('SELECT * FROM users u JOIN sales.orders o ON u.id = o.user_id');
    const alias = aliases.get('o');
    expect(alias?.schema).toBe('sales');
    expect(alias?.tableName).toBe('orders');
  });
});

// ============================================================================
// extractAliases — CTE clause
// ============================================================================

describe('extractAliases: CTE clause', () => {
  test('WITH cte AS (...) extracts CTE alias', () => {
    const { aliases } = extractAliases('WITH active_users AS (SELECT * FROM users WHERE active = true) SELECT * FROM active_users au');
    const cte = aliases.get('active_users');
    expect(cte).toBeDefined();
    expect(cte!.source).toBe('cte');
    expect(cte!.tableName).toBe('active_users');
  });

  test('includeCTEs=false excludes CTE aliases', () => {
    const { aliases } = extractAliases(
      'WITH cte AS (SELECT 1) SELECT * FROM cte c',
      { includeCTEs: false }
    );
    expect(aliases.has('cte')).toBe(false);
    // FROM alias 'c' should still be found
    expect(aliases.has('c')).toBe(true);
  });
});

// ============================================================================
// extractAliases — Multiple aliases & edge cases
// ============================================================================

describe('extractAliases: multiple and edge cases', () => {
  test('multiple aliases in one query', () => {
    const { aliases } = extractAliases(
      'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id'
    );
    expect(aliases.size).toBe(2);
    expect(aliases.get('u')?.tableName).toBe('users');
    expect(aliases.get('o')?.tableName).toBe('orders');
  });

  test('no table references returns hasTableReferences=false', () => {
    const result = extractAliases('SELECT 1 + 2');
    expect(result.hasTableReferences).toBe(false);
    expect(result.aliases.size).toBe(0);
  });

  test('query with table refs returns hasTableReferences based on aliases found', () => {
    const result = extractAliases('SELECT * FROM users u');
    expect(result.hasTableReferences).toBe(true);
  });

  test('comments are removed before extraction', () => {
    const sql = `
      SELECT * FROM users u
      -- JOIN orders o ON u.id = o.user_id
    `;
    const { aliases } = extractAliases(sql);
    expect(aliases.has('u')).toBe(true);
    // The commented-out join should not be extracted
    expect(aliases.has('o')).toBe(false);
  });

  test('block comments are removed before extraction', () => {
    const sql = `
      SELECT * FROM users u
      /* JOIN orders o ON u.id = o.user_id */
    `;
    const { aliases } = extractAliases(sql);
    expect(aliases.has('u')).toBe(true);
    expect(aliases.has('o')).toBe(false);
  });

  test('string literals do not produce false aliases', () => {
    const sql = "SELECT * FROM users u WHERE name = 'FROM orders o'";
    const { aliases } = extractAliases(sql);
    expect(aliases.has('u')).toBe(true);
    // 'o' from inside string should NOT be extracted
    expect(aliases.has('o')).toBe(false);
  });

  test('case insensitive by default — uppercase alias found via lowercase key', () => {
    const { aliases } = extractAliases('SELECT * FROM Users U');
    expect(aliases.has('u')).toBe(true);
  });

  test('caseInsensitive=false preserves case', () => {
    const { aliases } = extractAliases('SELECT * FROM Users U', { caseInsensitive: false });
    expect(aliases.has('U')).toBe(true);
    expect(aliases.has('u')).toBe(false);
  });
});

// ============================================================================
// resolveAlias
// ============================================================================

describe('resolveAlias', () => {
  test('resolves known alias to table name', () => {
    const { aliases } = extractAliases('SELECT * FROM users u');
    expect(resolveAlias('u', aliases)).toBe('users');
  });

  test('returns input unchanged when alias not found', () => {
    const { aliases } = extractAliases('SELECT * FROM users u');
    expect(resolveAlias('unknown', aliases)).toBe('unknown');
  });

  test('resolves alias case-insensitively', () => {
    const { aliases } = extractAliases('SELECT * FROM users U');
    expect(resolveAlias('u', aliases)).toBe('users');
  });
});

// ============================================================================
// getAliasSchema
// ============================================================================

describe('getAliasSchema', () => {
  test('returns schema when alias has schema defined', () => {
    const { aliases } = extractAliases('SELECT * FROM public.users u');
    expect(getAliasSchema('u', aliases)).toBe('public');
  });

  test('returns undefined when alias has no schema', () => {
    const { aliases } = extractAliases('SELECT * FROM users u');
    expect(getAliasSchema('u', aliases)).toBeUndefined();
  });

  test('returns undefined when alias not found', () => {
    const { aliases } = extractAliases('SELECT * FROM users u');
    expect(getAliasSchema('unknown', aliases)).toBeUndefined();
  });
});
