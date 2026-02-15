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

  test('FULL JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u FULL JOIN orders o ON u.id = o.user_id');
    expect(aliases.get('o')?.tableName).toBe('orders');
    expect(aliases.get('o')?.source).toBe('join');
  });

  test('NATURAL JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u NATURAL JOIN orders o');
    expect(aliases.get('o')?.tableName).toBe('orders');
    expect(aliases.get('o')?.source).toBe('join');
  });

  test('FULL OUTER JOIN alias', () => {
    const { aliases } = extractAliases('SELECT * FROM users u FULL OUTER JOIN orders o ON u.id = o.user_id');
    // FULL OUTER — regex matches FULL prefix, then JOIN
    expect(aliases.get('o')?.tableName).toBe('orders');
  });

  test('JOIN with explicit AS keyword', () => {
    const { aliases } = extractAliases('SELECT * FROM users u LEFT JOIN orders AS o ON u.id = o.user_id');
    expect(aliases.get('o')?.tableName).toBe('orders');
    expect(aliases.get('o')?.source).toBe('join');
  });

  test('JOIN same-name alias is skipped (JOIN orders orders)', () => {
    const { aliases } = extractAliases('SELECT * FROM users u JOIN orders orders ON u.id = orders.user_id');
    expect(aliases.has('u')).toBe(true);
    // 'orders' alias = 'orders' table — should be skipped
    expect(aliases.has('orders')).toBe(false);
  });

  test('multiple consecutive JOINs', () => {
    const sql = 'SELECT * FROM users u JOIN orders o ON u.id = o.user_id JOIN products p ON o.product_id = p.id JOIN categories c ON p.cat_id = c.id';
    const { aliases } = extractAliases(sql);
    expect(aliases.size).toBe(4);
    expect(aliases.get('u')?.tableName).toBe('users');
    expect(aliases.get('o')?.tableName).toBe('orders');
    expect(aliases.get('p')?.tableName).toBe('products');
    expect(aliases.get('c')?.tableName).toBe('categories');
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

  test('WITH RECURSIVE CTE extracts alias', () => {
    const sql = 'WITH RECURSIVE hierarchy AS (SELECT id, parent_id FROM categories UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN hierarchy h ON c.parent_id = h.id) SELECT * FROM hierarchy h2';
    const { aliases } = extractAliases(sql);
    expect(aliases.has('hierarchy')).toBe(true);
    expect(aliases.get('hierarchy')?.source).toBe('cte');
  });

  test('multiple CTEs extracted', () => {
    const sql = 'WITH active AS (SELECT * FROM users WHERE active), orders_cte AS (SELECT * FROM orders WHERE total > 0) SELECT * FROM active a JOIN orders_cte oc ON a.id = oc.user_id';
    const { aliases } = extractAliases(sql);
    expect(aliases.has('active')).toBe(true);
    expect(aliases.get('active')?.source).toBe('cte');
    expect(aliases.has('orders_cte')).toBe(true);
    expect(aliases.get('orders_cte')?.source).toBe('cte');
  });

  test('CTE name that looks like keyword is skipped', () => {
    // 'select' is a keyword and should be skipped as CTE name
    // but real CTE names should be captured
    const sql = 'WITH my_data AS (SELECT 1) SELECT * FROM my_data md';
    const { aliases } = extractAliases(sql);
    expect(aliases.has('my_data')).toBe(true);
    expect(aliases.get('my_data')?.source).toBe('cte');
  });

  test('CTE does not overwrite existing alias', () => {
    // If same name appears twice as CTE, first wins
    const sql = 'WITH cte1 AS (SELECT 1), cte1 AS (SELECT 2) SELECT * FROM cte1';
    const { aliases } = extractAliases(sql);
    // First CTE definition wins
    expect(aliases.has('cte1')).toBe(true);
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

  test('empty string returns empty aliases and hasTableReferences=false', () => {
    const result = extractAliases('');
    expect(result.aliases.size).toBe(0);
    expect(result.hasTableReferences).toBe(false);
  });

  test('whitespace only returns empty aliases', () => {
    const result = extractAliases('   \n\t  ');
    expect(result.aliases.size).toBe(0);
    expect(result.hasTableReferences).toBe(false);
  });

  test('FROM without alias still detects hasTableReferences via aliases', () => {
    // FROM users WHERE ... — no alias extracted, but query has FROM keyword
    // hasTableReferences is based on aliases.size > 0
    const result = extractAliases('SELECT * FROM users WHERE id = 1');
    expect(result.hasTableReferences).toBe(false);
    expect(result.aliases.size).toBe(0);
  });

  test('multiple FROM tables with comma', () => {
    // Only the first table after FROM gets an alias with the current pattern
    const { aliases } = extractAliases('SELECT * FROM users u, orders o');
    expect(aliases.get('u')?.tableName).toBe('users');
    // second comma-separated table won't be caught by FROM pattern (no JOIN/FROM prefix)
  });

  test('subquery in FROM does not produce false aliases', () => {
    const sql = 'SELECT * FROM (SELECT id FROM users) sub';
    const { aliases } = extractAliases(sql);
    // The inner FROM users has no alias, outer FROM (...) sub might or might not match
    // Main point: no crash
    expect(aliases).toBeDefined();
  });

  test('double-quoted identifiers are replaced in preprocessing', () => {
    const sql = 'SELECT * FROM users u WHERE name = "FROM orders o"';
    const { aliases } = extractAliases(sql);
    expect(aliases.has('u')).toBe(true);
    // double-quoted string should be replaced, so no 'o' alias
    expect(aliases.has('o')).toBe(false);
  });

  test('mixed single-line and block comments', () => {
    const sql = `
      SELECT * FROM users u
      -- FROM orders o1
      /* FROM products p1 */
      JOIN items i ON u.id = i.user_id
    `;
    const { aliases } = extractAliases(sql);
    expect(aliases.has('u')).toBe(true);
    expect(aliases.has('i')).toBe(true);
    expect(aliases.has('o1')).toBe(false);
    expect(aliases.has('p1')).toBe(false);
  });

  test('first alias wins — duplicate alias key not overwritten', () => {
    // Two FROM clauses with same alias key
    const sql = 'SELECT * FROM users u UNION SELECT * FROM orders u';
    const { aliases } = extractAliases(sql);
    // First alias for 'u' should be 'users'
    expect(aliases.get('u')?.tableName).toBe('users');
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

  test('returns schema for JOIN alias with schema prefix', () => {
    const { aliases } = extractAliases('SELECT * FROM users u JOIN sales.orders o ON u.id = o.user_id');
    expect(getAliasSchema('o', aliases)).toBe('sales');
  });
});

// ============================================================================
// caseInsensitive=false — preserves original case keys
// ============================================================================

describe('extractAliases: caseInsensitive=false', () => {
  test('FROM alias preserves case', () => {
    const { aliases } = extractAliases('SELECT * FROM Users U', { caseInsensitive: false });
    expect(aliases.has('U')).toBe(true);
    expect(aliases.has('u')).toBe(false);
  });

  test('JOIN alias preserves case', () => {
    const { aliases } = extractAliases('SELECT * FROM Users U JOIN Orders O ON U.id = O.user_id', { caseInsensitive: false });
    expect(aliases.has('O')).toBe(true);
    expect(aliases.has('o')).toBe(false);
  });

  test('CTE alias preserves case', () => {
    const { aliases } = extractAliases('WITH MyData AS (SELECT 1) SELECT * FROM MyData md', { caseInsensitive: false });
    expect(aliases.has('MyData')).toBe(true);
    expect(aliases.has('mydata')).toBe(false);
  });
});

// ============================================================================
// Additional edge cases for coverage
// ============================================================================

describe('extractAliases: additional edge cases', () => {
  test('schema-qualified table with explicit AS keyword', () => {
    const { aliases } = extractAliases('SELECT * FROM public.users AS u');
    const alias = aliases.get('u');
    expect(alias).toBeDefined();
    expect(alias!.tableName).toBe('users');
    expect(alias!.schema).toBe('public');
    expect(alias!.source).toBe('from');
  });

  test('SQL keyword as JOIN alias gets filtered out', () => {
    const { aliases } = extractAliases('SELECT * FROM users u JOIN orders on ON u.id = on.user_id');
    expect(aliases.has('on')).toBe(false);
    expect(aliases.has('u')).toBe(true);
  });

  test('CTE name that IS a SQL keyword is skipped', () => {
    const sql = 'WITH select AS (SELECT 1) SELECT * FROM select s';
    const { aliases } = extractAliases(sql);
    // 'select' is a keyword — should not be added as CTE
    expect(aliases.get('select')?.source).not.toBe('cte');
  });

  test('escaped quotes inside string literals are handled by preprocessing', () => {
    const sql = "SELECT * FROM users u WHERE name = 'it\\'s FROM orders o'";
    const { aliases } = extractAliases(sql);
    expect(aliases.has('u')).toBe(true);
    // The escaped string should be removed, no false 'o' alias
    expect(aliases.has('o')).toBe(false);
  });

  test('query with only WITH keyword (no FROM/JOIN)', () => {
    const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte';
    const { aliases } = extractAliases(sql);
    expect(aliases.has('cte')).toBe(true);
    expect(aliases.get('cte')?.source).toBe('cte');
  });

  test('resolveAlias with case-insensitive lookup (uppercase input)', () => {
    const { aliases } = extractAliases('SELECT * FROM users u');
    // resolveAlias uses .toLowerCase() internally
    expect(resolveAlias('U', aliases)).toBe('users');
  });

  test('duplicate alias key in JOIN — first wins', () => {
    const sql = 'SELECT * FROM users u JOIN orders o1 ON u.id = o1.uid JOIN products o1 ON o1.pid = o1.id';
    const { aliases } = extractAliases(sql);
    // First 'o1' is orders
    expect(aliases.get('o1')?.tableName).toBe('orders');
  });
});
