import '../setup';
import { describe, test, expect } from 'bun:test';
import type * as Monaco from 'monaco-editor';
import {
  SQL_KEYWORDS,
  SQL_FUNCTIONS,
  SQL_SNIPPETS,
  KEYWORD_ITEMS,
  FUNCTION_ITEMS,
  SNIPPET_ITEMS,
  registerSQLCompletionProvider,
  type SchemaCompletionCache,
} from '@/lib/editor/sql-completions';

// ---------------------------------------------------------------------------
// Mock Monaco
// ---------------------------------------------------------------------------

function createMockMonaco() {
  let registeredProvider: {
    triggerCharacters: string[];
    provideCompletionItems: (
      model: Monaco.editor.ITextModel,
      position: Monaco.Position
    ) => { suggestions: Monaco.languages.CompletionItem[] };
  } | null = null;

  const mockMonaco = {
    languages: {
      registerCompletionItemProvider: (_lang: string, provider: typeof registeredProvider) => {
        registeredProvider = provider;
        return { dispose: () => { registeredProvider = null; } };
      },
      CompletionItemKind: {
        Keyword: 17,
        Function: 1,
        Snippet: 27,
        Class: 5,
        Field: 3,
      },
      CompletionItemInsertTextRule: {
        InsertAsSnippet: 4,
      },
    },
    _getProvider: () => registeredProvider,
  };

  return mockMonaco as unknown as typeof Monaco & { _getProvider: () => typeof registeredProvider };
}

function createMockModel(lineContent: string, fullText?: string) {
  return {
    getWordUntilPosition: (position: { column: number }) => {
      // Extract word at cursor
      const before = lineContent.substring(0, position.column - 1);
      const match = before.match(/(\w+)$/);
      return {
        word: match ? match[1] : '',
        startColumn: match ? position.column - match[1].length : position.column,
        endColumn: position.column,
      };
    },
    getLineContent: () => lineContent,
    getValueInRange: () => fullText || lineContent,
  } as unknown as Monaco.editor.ITextModel;
}

function createPosition(line: number, col: number) {
  return { lineNumber: line, column: col } as Monaco.Position;
}

function createSchemaCache(overrides?: Partial<SchemaCompletionCache>): SchemaCompletionCache {
  const columnMap = new Map<string, { label: string; labelLower: string; type: string; isPrimary: boolean; tableName: string }[]>();
  columnMap.set('users', [
    { label: 'id', labelLower: 'id', type: 'integer', isPrimary: true, tableName: 'users' },
    { label: 'name', labelLower: 'name', type: 'varchar', isPrimary: false, tableName: 'users' },
    { label: 'email', labelLower: 'email', type: 'varchar', isPrimary: false, tableName: 'users' },
  ]);
  columnMap.set('orders', [
    { label: 'id', labelLower: 'id', type: 'integer', isPrimary: true, tableName: 'orders' },
    { label: 'user_id', labelLower: 'user_id', type: 'integer', isPrimary: false, tableName: 'orders' },
    { label: 'total', labelLower: 'total', type: 'numeric', isPrimary: false, tableName: 'orders' },
  ]);
  columnMap.set('public.products', [
    { label: 'id', labelLower: 'id', type: 'integer', isPrimary: true, tableName: 'public.products' },
    { label: 'price', labelLower: 'price', type: 'numeric', isPrimary: false, tableName: 'public.products' },
  ]);

  const allColumns = new Map<string, { label: string; labelLower: string; type: string; isPrimary: boolean; tableName: string }>();
  for (const [, cols] of columnMap) {
    for (const col of cols) {
      allColumns.set(col.label, col);
    }
  }

  return {
    tableItems: [
      { label: 'users', labelLower: 'users', rowCount: 100, columnNames: 'id, name, email' },
      { label: 'orders', labelLower: 'orders', rowCount: 500, columnNames: 'id, user_id, total' },
      { label: 'public.products', labelLower: 'public.products', rowCount: 50, columnNames: 'id, price' },
    ],
    columnMap,
    allColumns,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Static constants
// ---------------------------------------------------------------------------

describe('SQL Completions – static constants', () => {
  test('SQL_KEYWORDS contains core keywords', () => {
    expect(SQL_KEYWORDS).toContain('SELECT');
    expect(SQL_KEYWORDS).toContain('FROM');
    expect(SQL_KEYWORDS).toContain('WHERE');
    expect(SQL_KEYWORDS).toContain('INNER JOIN');
    expect(SQL_KEYWORDS).toContain('ORDER BY');
  });

  test('SQL_FUNCTIONS contains aggregate and window functions', () => {
    expect(SQL_FUNCTIONS).toContain('COUNT');
    expect(SQL_FUNCTIONS).toContain('SUM');
    expect(SQL_FUNCTIONS).toContain('ROW_NUMBER');
    expect(SQL_FUNCTIONS).toContain('LEAD');
  });

  test('SQL_SNIPPETS has correct labels', () => {
    const labels = SQL_SNIPPETS.map(s => s.label);
    expect(labels).toContain('SELECT');
    expect(labels).toContain('INSERT');
    expect(labels).toContain('UPDATE');
    expect(labels).toContain('DELETE');
    expect(labels).toContain('JOIN');
    expect(labels).toContain('WITH');
  });

  test('SQL_SNIPPETS values contain template placeholders', () => {
    for (const snippet of SQL_SNIPPETS) {
      expect(snippet.value).toContain('${1:');
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-computed items
// ---------------------------------------------------------------------------

describe('SQL Completions – pre-computed items', () => {
  test('KEYWORD_ITEMS has same length as SQL_KEYWORDS', () => {
    expect(KEYWORD_ITEMS.length).toBe(SQL_KEYWORDS.length);
  });

  test('KEYWORD_ITEMS have correct kind and detail', () => {
    for (const item of KEYWORD_ITEMS) {
      expect(item.kind).toBe(17);
      expect(item.detail).toBe('SQL Keyword');
      expect(item.labelLower).toBe(item.label.toLowerCase());
    }
  });

  test('FUNCTION_ITEMS appends parentheses to insertText', () => {
    for (const item of FUNCTION_ITEMS) {
      expect(item.insertText).toBe(item.label + '($1)');
      expect(item.insertTextRules).toBe(4);
      expect(item.kind).toBe(1);
      expect(item.detail).toBe('SQL Function');
    }
  });

  test('SNIPPET_ITEMS have correct kind and rules', () => {
    for (const item of SNIPPET_ITEMS) {
      expect(item.kind).toBe(27);
      expect(item.insertTextRules).toBe(4);
      expect(item.detail).toBe('SQL Snippet');
    }
  });
});

// ---------------------------------------------------------------------------
// registerSQLCompletionProvider
// ---------------------------------------------------------------------------

describe('registerSQLCompletionProvider', () => {
  test('registers provider and returns disposable', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    const disposable = registerSQLCompletionProvider(monaco, cache);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe('function');
    expect(monaco._getProvider()).not.toBeNull();
  });

  test('dispose removes the provider', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    const disposable = registerSQLCompletionProvider(monaco, cache);
    disposable.dispose();
    expect(monaco._getProvider()).toBeNull();
  });

  test('sets trigger characters to dot and space', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;
    expect(provider.triggerCharacters).toEqual(['.', ' ']);
  });
});

// ---------------------------------------------------------------------------
// Dot-triggered completions (table.column)
// ---------------------------------------------------------------------------

describe('Dot-triggered completions', () => {
  test('shows columns for table after dot', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // "SELECT users." — cursor after the dot
    const model = createMockModel('SELECT users.', 'SELECT users.');
    const position = createPosition(1, 14); // after the dot

    const result = provider.provideCompletionItems(model, position);
    const labels = result.suggestions.map(s => s.label);

    expect(labels).toContain('id');
    expect(labels).toContain('name');
    expect(labels).toContain('email');
    expect(result.suggestions.length).toBe(3);
  });

  test('shows PK indicator in detail for primary key columns', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('SELECT users.', 'SELECT users.');
    const position = createPosition(1, 14);
    const result = provider.provideCompletionItems(model, position);

    const idSugg = result.suggestions.find(s => s.label === 'id');
    expect(idSugg?.detail).toBe('integer (PK)');

    const nameSugg = result.suggestions.find(s => s.label === 'name');
    expect(nameSugg?.detail).toBe('varchar');
  });

  test('resolves schema-prefixed tables (e.g. "products" matches "public.products")', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('SELECT products.', 'SELECT products.');
    const position = createPosition(1, 17);
    const result = provider.provideCompletionItems(model, position);
    const labels = result.suggestions.map(s => s.label);

    expect(labels).toContain('id');
    expect(labels).toContain('price');
  });

  test('resolves aliases to table names', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const fullText = 'SELECT u. FROM users u';
    const model = createMockModel('SELECT u.', fullText);
    const position = createPosition(1, 10);
    const result = provider.provideCompletionItems(model, position);
    const labels = result.suggestions.map(s => s.label);

    expect(labels).toContain('id');
    expect(labels).toContain('name');
    expect(labels).toContain('email');
  });

  test('returns empty suggestions for unknown table after dot', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('SELECT unknown_table.', 'SELECT unknown_table.');
    const position = createPosition(1, 22);
    const result = provider.provideCompletionItems(model, position);

    expect(result.suggestions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// General completions (keywords, functions, tables, snippets)
// ---------------------------------------------------------------------------

describe('General completions', () => {
  test('returns keywords, functions, tables, and snippets with short prefix', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Short prefix "S" — no filtering (prefix < 2)
    const model = createMockModel('S');
    const position = createPosition(1, 2);
    const result = provider.provideCompletionItems(model, position);

    // Should include all keywords + all functions + all tables + all snippets
    const totalStatic = KEYWORD_ITEMS.length + FUNCTION_ITEMS.length + SNIPPET_ITEMS.length + cache.tableItems.length;
    expect(result.suggestions.length).toBe(totalStatic);
  });

  test('filters by prefix when prefix >= 2 chars', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Prefix "se" — should match SELECT, SET + snippets/functions starting with "se"
    const model = createMockModel('SE');
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('SELECT');
    expect(labels).toContain('SET');
    // Should not contain unrelated keywords
    expect(labels).not.toContain('FROM');
    expect(labels).not.toContain('WHERE');
  });

  test('includes columns in column context (after SELECT)', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // "SELECT n" — column context
    const model = createMockModel('SELECT na');
    const position = createPosition(1, 10);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('name');
  });

  test('includes columns in WHERE context', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('SELECT * FROM users WHERE em');
    const position = createPosition(1, 29);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('email');
  });

  test('excludes columns outside column context (e.g. FROM)', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // "FROM us" — not a column context
    const model = createMockModel('FROM us');
    const position = createPosition(1, 8);
    const result = provider.provideCompletionItems(model, position);

    const kinds = result.suggestions.map(s => s.kind);
    // Should have table (Class=5) but no field (Field=3)
    expect(kinds).toContain(5); // table
    expect(kinds).not.toContain(3); // no columns
  });

  test('tables show row count in detail', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('u');
    const position = createPosition(1, 2);
    const result = provider.provideCompletionItems(model, position);

    const tableSugg = result.suggestions.find(s => s.label === 'users');
    expect(tableSugg?.detail).toBe('Table (100 rows)');
  });

  test('functions have snippet insert rules', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('CO');
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    const countSugg = result.suggestions.find(s => s.label === 'COUNT');
    expect(countSugg).toBeDefined();
    expect(countSugg?.insertText).toBe('COUNT($1)');
    expect(countSugg?.insertTextRules).toBe(4);
  });

  test('sort text orders: keywords(0) < functions(1) < tables(2) < snippets(3) < columns(4)', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Short prefix — all items, column context
    const model = createMockModel('SELECT x');
    const position = createPosition(1, 9);
    const result = provider.provideCompletionItems(model, position);

    const keywordSugg = result.suggestions.find(s => s.label === 'SELECT');
    const functionSugg = result.suggestions.find(s => s.label === 'COUNT');
    const tableSugg = result.suggestions.find(s => s.label === 'users');
    const snippetSugg = result.suggestions.find(s => (s as { detail: string }).detail === 'SQL Snippet');
    const columnSugg = result.suggestions.find(s => s.label === 'id' && (s as { detail: string }).detail?.startsWith('Column'));

    expect(keywordSugg?.sortText?.startsWith('0')).toBe(true);
    expect(functionSugg?.sortText?.startsWith('1')).toBe(true);
    expect(tableSugg?.sortText?.startsWith('2')).toBe(true);
    expect(snippetSugg?.sortText?.startsWith('3')).toBe(true);
    expect(columnSugg?.sortText?.startsWith('4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty schema cache
// ---------------------------------------------------------------------------

describe('Empty schema cache', () => {
  test('works with empty schema cache (no tables/columns)', () => {
    const monaco = createMockMonaco();
    const emptyCache: SchemaCompletionCache = {
      tableItems: [],
      columnMap: new Map(),
      allColumns: new Map(),
    };
    registerSQLCompletionProvider(monaco, emptyCache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('SE');
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    // Should still have keyword/function/snippet suggestions
    expect(result.suggestions.length).toBeGreaterThan(0);
    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('SELECT');
  });
});
