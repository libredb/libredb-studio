import '../setup';
import { describe, test, expect } from 'bun:test';
import type * as Monaco from 'monaco-editor';
import { registerMongoDBCompletionProvider } from '@/lib/editor/mongodb-completions';
import type { SchemaCompletionCache } from '@/lib/editor/sql-completions';

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
        Enum: 14,
        Class: 5,
        Field: 3,
        Snippet: 27,
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
      const before = lineContent.substring(0, position.column - 1);
      const match = before.match(/(\w[$\w]*)$/);
      return {
        word: match ? match[1] : '',
        startColumn: match ? position.column - match[1].length : position.column,
        endColumn: position.column,
      };
    },
    getLineContent: () => lineContent,
    getValue: () => fullText ?? lineContent,
  } as unknown as Monaco.editor.ITextModel;
}

function createPosition(line: number, col: number) {
  return { lineNumber: line, column: col } as Monaco.Position;
}

function createSchemaCache(): SchemaCompletionCache {
  const columnMap = new Map();
  columnMap.set('users', [
    { label: '_id', labelLower: '_id', type: 'ObjectId', isPrimary: true, tableName: 'users' },
    { label: 'name', labelLower: 'name', type: 'string', isPrimary: false, tableName: 'users' },
    { label: 'email', labelLower: 'email', type: 'string', isPrimary: false, tableName: 'users' },
  ]);
  columnMap.set('orders', [
    { label: '_id', labelLower: '_id', type: 'ObjectId', isPrimary: true, tableName: 'orders' },
    { label: 'total', labelLower: 'total', type: 'number', isPrimary: false, tableName: 'orders' },
  ]);

  const allColumns = new Map();
  for (const [, cols] of columnMap) {
    for (const col of cols) {
      allColumns.set(col.label, col);
    }
  }

  return {
    tableItems: [
      { label: 'users', labelLower: 'users', rowCount: 100, columnNames: '_id, name, email' },
      { label: 'orders', labelLower: 'orders', rowCount: 500, columnNames: '_id, total' },
    ],
    columnMap,
    allColumns,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerMongoDBCompletionProvider', () => {
  test('registers provider for json language and returns disposable', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    const disposable = registerMongoDBCompletionProvider(monaco, cache);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe('function');
    expect(monaco._getProvider()).not.toBeNull();
  });

  test('dispose removes the provider', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    const disposable = registerMongoDBCompletionProvider(monaco, cache);
    disposable.dispose();
    expect(monaco._getProvider()).toBeNull();
  });

  test('sets trigger characters to quote, dollar, colon', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;
    expect(provider.triggerCharacters).toEqual(['"', '$', ':']);
  });
});

// ---------------------------------------------------------------------------
// MQL Operators (after "$")
// ---------------------------------------------------------------------------

describe('MQL operator completions', () => {
  test('suggests MQL operators when text contains $', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "$', '{ "filter": { "$" } }');
    const position = createPosition(1, 5);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('$match');
    expect(labels).toContain('$eq');
    expect(labels).toContain('$gt');
    expect(labels).toContain('$sum');
    expect(labels).toContain('$set');
  });

  test('MQL operators have Keyword kind and correct detail', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "$match', '{ "$match": {} }');
    const position = createPosition(1, 10);
    const result = provider.provideCompletionItems(model, position);

    const matchSugg = result.suggestions.find(s => s.label === '$match');
    expect(matchSugg).toBeDefined();
    expect(matchSugg!.kind).toBe(17); // Keyword
    expect((matchSugg as unknown as { detail: string }).detail).toBe('MQL Operator');
  });

  test('word starting with $ triggers MQL operators', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // getWordUntilPosition returns "$gr" — starts with $
    const model = {
      getWordUntilPosition: () => ({ word: '$gr', startColumn: 3, endColumn: 6 }),
      getLineContent: () => '  $gr',
      getValue: () => '  $gr',
    } as unknown as Monaco.editor.ITextModel;

    const position = createPosition(1, 6);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('$group');
    expect(labels).toContain('$gt');
    expect(labels).toContain('$gte');
  });
});

// ---------------------------------------------------------------------------
// Operation names (after "operation": ")
// ---------------------------------------------------------------------------

describe('Operation name completions', () => {
  test('suggests operations after "operation": "', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "operation": "fi', '{ "operation": "fi" }');
    const position = createPosition(1, 19);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('find');
    expect(labels).toContain('findOne');
    expect(labels).toContain('aggregate');
    expect(labels).toContain('insertOne');
    expect(labels).toContain('deleteMany');
  });

  test('operation suggestions have Enum kind', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "operation": "', '{ "operation": "" }');
    const position = createPosition(1, 17);
    const result = provider.provideCompletionItems(model, position);

    const findSugg = result.suggestions.find(s => s.label === 'find');
    expect(findSugg).toBeDefined();
    expect(findSugg!.kind).toBe(14); // Enum
    expect((findSugg as unknown as { detail: string }).detail).toBe('MongoDB Operation');
  });

  test('does not suggest operations without "operation" key context', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "filter": "', '{ "filter": "" }');
    const position = createPosition(1, 14);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).not.toContain('find');
    expect(labels).not.toContain('aggregate');
  });
});

// ---------------------------------------------------------------------------
// Collection names (after "collection": ")
// ---------------------------------------------------------------------------

describe('Collection name completions', () => {
  test('suggests collections after "collection": "', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "collection": "', '{ "collection": "" }');
    const position = createPosition(1, 18);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('users');
    expect(labels).toContain('orders');
  });

  test('collection suggestions show doc count and have Class kind', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "collection": "', '{ "collection": "" }');
    const position = createPosition(1, 18);
    const result = provider.provideCompletionItems(model, position);

    const usersSugg = result.suggestions.find(s => s.label === 'users');
    expect(usersSugg).toBeDefined();
    expect(usersSugg!.kind).toBe(5); // Class
    expect((usersSugg as unknown as { detail: string }).detail).toBe('Collection (100 docs)');
  });

  test('does not suggest collections outside "collection" key context', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "filter": "', '{ "filter": "" }');
    const position = createPosition(1, 14);
    const result = provider.provideCompletionItems(model, position);

    const kinds = result.suggestions.map(s => s.kind);
    // No Class items (collections)
    expect(kinds).not.toContain(5);
  });
});

// ---------------------------------------------------------------------------
// Field name completions
// ---------------------------------------------------------------------------

describe('Field name completions', () => {
  test('suggests field names inside quoted string context', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Inside filter: { "na
    const model = createMockModel('    "na', '{ "filter": { "na" } }');
    const position = createPosition(1, 8);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('_id');
    expect(labels).toContain('name');
    expect(labels).toContain('email');
    expect(labels).toContain('total');
  });

  test('field suggestions have Field kind and show type', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('    "na', '{ "filter": { "na" } }');
    const position = createPosition(1, 8);
    const result = provider.provideCompletionItems(model, position);

    const nameSugg = result.suggestions.find(s => s.label === 'name');
    expect(nameSugg).toBeDefined();
    expect(nameSugg!.kind).toBe(3); // Field
    expect((nameSugg as unknown as { detail: string }).detail).toBe('Field (string)');
  });

  test('does not suggest fields in "collection": context', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "collection": "us', '{ "collection": "us" }');
    const position = createPosition(1, 20);
    const result = provider.provideCompletionItems(model, position);

    const fieldSuggs = result.suggestions.filter(s => s.kind === 3);
    expect(fieldSuggs.length).toBe(0);
  });

  test('does not suggest fields in "operation": context', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "operation": "fi', '{ "operation": "fi" }');
    const position = createPosition(1, 19);
    const result = provider.provideCompletionItems(model, position);

    const fieldSuggs = result.suggestions.filter(s => s.kind === 3);
    expect(fieldSuggs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Snippet completions
// ---------------------------------------------------------------------------

describe('Snippet completions', () => {
  test('suggests snippets when editor is nearly empty', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('', '');
    const position = createPosition(1, 1);
    const result = provider.provideCompletionItems(model, position);

    const snippetSuggs = result.suggestions.filter(s => s.kind === 27);
    expect(snippetSuggs.length).toBe(7);

    const labels = snippetSuggs.map(s => s.label);
    expect(labels).toContain('find');
    expect(labels).toContain('findOne');
    expect(labels).toContain('aggregate');
    expect(labels).toContain('count');
    expect(labels).toContain('insertOne');
    expect(labels).toContain('updateOne');
    expect(labels).toContain('deleteMany');
  });

  test('suggests snippets when cursor at line start', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // textBefore is whitespace-only → matches /^\s*$/
    const model = createMockModel('  ', '{ "collection": "users" }\n  ');
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    const snippetSuggs = result.suggestions.filter(s => s.kind === 27);
    expect(snippetSuggs.length).toBe(7);
  });

  test('snippets have InsertAsSnippet rule and correct detail', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('', '');
    const position = createPosition(1, 1);
    const result = provider.provideCompletionItems(model, position);

    const findSnippet = result.suggestions.find(s => s.label === 'find' && s.kind === 27);
    expect(findSnippet).toBeDefined();
    expect(findSnippet!.insertTextRules).toBe(4); // InsertAsSnippet
    expect((findSnippet as unknown as { detail: string }).detail).toBe('Find documents');
  });

  test('snippets contain template placeholders', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('', '');
    const position = createPosition(1, 1);
    const result = provider.provideCompletionItems(model, position);

    const snippetSuggs = result.suggestions.filter(s => s.kind === 27);
    for (const snippet of snippetSuggs) {
      expect((snippet.insertText as string)).toContain('${1:collection}');
    }
  });

  test('does not suggest snippets when editor has substantial content', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // fullText > 5 chars and textBefore is not whitespace-only
    const model = createMockModel('  "filter": {', '{ "collection": "users", "operation": "find", "filter": { } }');
    const position = createPosition(1, 14);
    const result = provider.provideCompletionItems(model, position);

    const snippetSuggs = result.suggestions.filter(s => s.kind === 27);
    expect(snippetSuggs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe('Sort order', () => {
  test('operators and operations sort before fields', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerMongoDBCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Context that triggers both operators and fields: "$
    const model = createMockModel('    "$', '{ "filter": { "$" } }');
    const position = createPosition(1, 7);
    const result = provider.provideCompletionItems(model, position);

    const operatorSugg = result.suggestions.find(s => s.label === '$match');
    const fieldSugg = result.suggestions.find(s => s.label === 'name');
    expect(operatorSugg?.sortText?.startsWith('0')).toBe(true);
    expect(fieldSugg?.sortText?.startsWith('2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty schema cache
// ---------------------------------------------------------------------------

describe('Empty schema cache', () => {
  test('works with empty schema cache', () => {
    const monaco = createMockMonaco();
    const emptyCache: SchemaCompletionCache = {
      tableItems: [],
      columnMap: new Map(),
      allColumns: new Map(),
    };
    registerMongoDBCompletionProvider(monaco, emptyCache);
    const provider = monaco._getProvider()!;

    // Trigger $ operators — should still work
    const model = createMockModel('  "$', '{ "$" }');
    const position = createPosition(1, 5);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map(s => s.label);
    expect(labels).toContain('$match');
    expect(labels).toContain('$group');
  });

  test('collection context with empty cache returns no collections', () => {
    const monaco = createMockMonaco();
    const emptyCache: SchemaCompletionCache = {
      tableItems: [],
      columnMap: new Map(),
      allColumns: new Map(),
    };
    registerMongoDBCompletionProvider(monaco, emptyCache);
    const provider = monaco._getProvider()!;

    const model = createMockModel('  "collection": "', '{ "collection": "" }');
    const position = createPosition(1, 18);
    const result = provider.provideCompletionItems(model, position);

    const classSuggs = result.suggestions.filter(s => s.kind === 5);
    expect(classSuggs.length).toBe(0);
  });
});
