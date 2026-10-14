import "../setup";
import { describe, test, expect } from "bun:test";
import type * as Monaco from "monaco-editor";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import type { ProviderCapabilities } from "@/lib/db/types";
import { containerSpellingOf, quoteIdentifier } from "@/lib/query-generators";
import {
  SQL_KEYWORDS,
  SQL_FUNCTIONS,
  SQL_SNIPPETS,
  KEYWORD_ITEMS,
  FUNCTION_ITEMS,
  SNIPPET_ITEMS,
  registerSQLCompletionProvider,
  type SchemaCompletionCache,
} from "@/lib/editor/sql-completions";

// ---------------------------------------------------------------------------
// Mock Monaco
// ---------------------------------------------------------------------------

function createMockMonaco() {
  let registeredProvider: {
    triggerCharacters: string[];
    provideCompletionItems: (
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
    ) => { suggestions: Monaco.languages.CompletionItem[] };
  } | null = null;

  const mockMonaco = {
    languages: {
      registerCompletionItemProvider: (_lang: string, provider: typeof registeredProvider) => {
        registeredProvider = provider;
        return {
          dispose: () => {
            registeredProvider = null;
          },
        };
      },
      CompletionItemKind: {
        Keyword: 17,
        Function: 1,
        Snippet: 27,
        Class: 5,
        Field: 3,
        Variable: 4,
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
        word: match ? match[1] : "",
        startColumn: match ? position.column - match[1].length : position.column,
        endColumn: position.column,
      };
    },
    getLineContent: () => lineContent,
    // The whole document, with the cursor on its first line: every model here is one line long.
    getValue: () => fullText || lineContent,
    getOffsetAt: (position: { column: number }) => position.column - 1,
    getVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
}

function createPosition(line: number, col: number) {
  return { lineNumber: line, column: col } as Monaco.Position;
}

function createSchemaCache(overrides?: Partial<SchemaCompletionCache>): SchemaCompletionCache {
  const columnMap = new Map<
    string,
    { label: string; labelLower: string; type: string; isPrimary: boolean; tableName: string }[]
  >();
  columnMap.set("users", [
    { label: "id", labelLower: "id", type: "integer", isPrimary: true, tableName: "users" },
    { label: "name", labelLower: "name", type: "varchar", isPrimary: false, tableName: "users" },
    { label: "email", labelLower: "email", type: "varchar", isPrimary: false, tableName: "users" },
  ]);
  columnMap.set("orders", [
    { label: "id", labelLower: "id", type: "integer", isPrimary: true, tableName: "orders" },
    { label: "user_id", labelLower: "user_id", type: "integer", isPrimary: false, tableName: "orders" },
    { label: "total", labelLower: "total", type: "numeric", isPrimary: false, tableName: "orders" },
  ]);
  columnMap.set("public.products", [
    { label: "id", labelLower: "id", type: "integer", isPrimary: true, tableName: "public.products" },
    { label: "price", labelLower: "price", type: "numeric", isPrimary: false, tableName: "public.products" },
  ]);

  const allColumns = new Map<
    string,
    { label: string; labelLower: string; type: string; isPrimary: boolean; tableName: string }
  >();
  for (const [, cols] of columnMap) {
    for (const col of cols) {
      allColumns.set(col.label, col);
    }
  }

  return {
    tableItems: [
      { label: "users", labelLower: "users", rowCount: 100, columnNames: "id, name, email" },
      { label: "orders", labelLower: "orders", rowCount: 500, columnNames: "id, user_id, total" },
      { label: "public.products", labelLower: "public.products", rowCount: 50, columnNames: "id, price" },
    ],
    columnMap,
    allColumns,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Static constants
// ---------------------------------------------------------------------------

describe("SQL Completions – static constants", () => {
  test("SQL_KEYWORDS contains core keywords", () => {
    expect(SQL_KEYWORDS).toContain("SELECT");
    expect(SQL_KEYWORDS).toContain("FROM");
    expect(SQL_KEYWORDS).toContain("WHERE");
    expect(SQL_KEYWORDS).toContain("INNER JOIN");
    expect(SQL_KEYWORDS).toContain("ORDER BY");
  });

  test("SQL_FUNCTIONS contains aggregate and window functions", () => {
    expect(SQL_FUNCTIONS).toContain("COUNT");
    expect(SQL_FUNCTIONS).toContain("SUM");
    expect(SQL_FUNCTIONS).toContain("ROW_NUMBER");
    expect(SQL_FUNCTIONS).toContain("LEAD");
  });

  test("SQL_SNIPPETS has correct labels", () => {
    const labels = SQL_SNIPPETS.map((s) => s.label);
    expect(labels).toContain("SELECT");
    expect(labels).toContain("INSERT");
    expect(labels).toContain("UPDATE");
    expect(labels).toContain("DELETE");
    expect(labels).toContain("JOIN");
    expect(labels).toContain("WITH");
  });

  test("SQL_SNIPPETS values contain template placeholders", () => {
    for (const snippet of SQL_SNIPPETS) {
      expect(snippet.value).toContain("${1:");
    }
  });
});

// ---------------------------------------------------------------------------
// Pre-computed items
// ---------------------------------------------------------------------------

describe("SQL Completions – pre-computed items", () => {
  test("KEYWORD_ITEMS has same length as SQL_KEYWORDS", () => {
    expect(KEYWORD_ITEMS.length).toBe(SQL_KEYWORDS.length);
  });

  test("KEYWORD_ITEMS have correct kind and detail", () => {
    for (const item of KEYWORD_ITEMS) {
      expect(item.kind).toBe(17);
      expect(item.detail).toBe("SQL Keyword");
      expect(item.labelLower).toBe(item.label.toLowerCase());
    }
  });

  test("FUNCTION_ITEMS appends parentheses to insertText", () => {
    for (const item of FUNCTION_ITEMS) {
      expect(item.insertText).toBe(item.label + "($1)");
      expect(item.insertTextRules).toBe(4);
      expect(item.kind).toBe(1);
      expect(item.detail).toBe("SQL Function");
    }
  });

  test("SNIPPET_ITEMS have correct kind and rules", () => {
    for (const item of SNIPPET_ITEMS) {
      expect(item.kind).toBe(27);
      expect(item.insertTextRules).toBe(4);
      expect(item.detail).toBe("SQL Snippet");
    }
  });
});

// ---------------------------------------------------------------------------
// registerSQLCompletionProvider
// ---------------------------------------------------------------------------

describe("registerSQLCompletionProvider", () => {
  test("registers provider and returns disposable", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    const disposable = registerSQLCompletionProvider(monaco, cache);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe("function");
    expect(monaco._getProvider()).not.toBeNull();
  });

  test("dispose removes the provider", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    const disposable = registerSQLCompletionProvider(monaco, cache);
    disposable.dispose();
    expect(monaco._getProvider()).toBeNull();
  });

  test("sets trigger characters to dot and space", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;
    expect(provider.triggerCharacters).toEqual([".", " "]);
  });
});

// ---------------------------------------------------------------------------
// Dot-triggered completions (table.column)
// ---------------------------------------------------------------------------

describe("Dot-triggered completions", () => {
  test("shows columns for table after dot", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // "SELECT users." — cursor after the dot
    const model = createMockModel("SELECT users.", "SELECT users.");
    const position = createPosition(1, 14); // after the dot

    const result = provider.provideCompletionItems(model, position);
    const labels = result.suggestions.map((s) => s.label);

    expect(labels).toContain("id");
    expect(labels).toContain("name");
    expect(labels).toContain("email");
    expect(result.suggestions.length).toBe(3);
  });

  test("shows PK indicator in detail for primary key columns", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("SELECT users.", "SELECT users.");
    const position = createPosition(1, 14);
    const result = provider.provideCompletionItems(model, position);

    const idSugg = result.suggestions.find((s) => s.label === "id");
    expect(idSugg?.detail).toBe("integer (PK)");

    const nameSugg = result.suggestions.find((s) => s.label === "name");
    expect(nameSugg?.detail).toBe("varchar");
  });

  test('resolves schema-prefixed tables (e.g. "products" matches "public.products")', () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("SELECT products.", "SELECT products.");
    const position = createPosition(1, 17);
    const result = provider.provideCompletionItems(model, position);
    const labels = result.suggestions.map((s) => s.label);

    expect(labels).toContain("id");
    expect(labels).toContain("price");
  });

  test("resolves aliases to table names", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const fullText = "SELECT u. FROM users u";
    const model = createMockModel("SELECT u.", fullText);
    const position = createPosition(1, 10);
    const result = provider.provideCompletionItems(model, position);
    const labels = result.suggestions.map((s) => s.label);

    expect(labels).toContain("id");
    expect(labels).toContain("name");
    expect(labels).toContain("email");
  });

  test("returns empty suggestions for unknown table after dot", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("SELECT unknown_table.", "SELECT unknown_table.");
    const position = createPosition(1, 22);
    const result = provider.provideCompletionItems(model, position);

    expect(result.suggestions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// General completions (keywords, functions, tables, snippets)
// ---------------------------------------------------------------------------

describe("Schema-qualified table completion edits", () => {
  test.each([
    ["SELECT * FROM SAMPLE.dem", "SELECT * FROM sample.demo", "sample.demo"],
    ["SELECT * FROM catalog.sample.dem", "SELECT * FROM catalog.sample.demo", "catalog.sample.demo"],
    ["SELECT * FROM sam", "SELECT * FROM sample.demo", "sample.demo"],
    ["SELECT * FROM public.dem", "SELECT * FROM public.demo", "demo"],
    ["SELECT * FROM mydb.dem", "SELECT * FROM mydb.demo", "demo"],
  ])("applies the table edit to %s", (line, expected, label) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(
      monaco,
      createSchemaCache({ tableItems: [{ label, labelLower: label.toLowerCase(), rowCount: 1, columnNames: "id" }] }),
    );
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    const suggestion = result.suggestions.find((item) => item.label === label)!;
    expect(suggestion).toBeDefined();
    const range = suggestion.range as Monaco.IRange;
    expect(line.slice(0, range.startColumn - 1) + suggestion.insertText + line.slice(range.endColumn - 1)).toBe(
      expected,
    );
  });

  test("a table alias still provides columns when it shares a schema name", () => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(
      monaco,
      createSchemaCache({
        tableItems: [{ label: "sample.demo", labelLower: "sample.demo", rowCount: 1, columnNames: "id" }],
      }),
    );
    const line = "SELECT * FROM users sample WHERE sample.";
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    expect(result.suggestions.map((item) => item.label)).toEqual(["id", "name", "email"]);
    expect(result.suggestions.every((item) => item.kind === 3)).toBe(true);
  });

  test.each(["", "d", "de", "dem"])("completes sample.%s without duplicating the schema", (prefix) => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache({
      tableItems: [
        { label: "sample.demo", labelLower: "sample.demo", rowCount: 1, columnNames: "id, name" },
        { label: "other.demo", labelLower: "other.demo", rowCount: 1, columnNames: "id" },
      ],
    });
    registerSQLCompletionProvider(monaco, cache);
    const line = `SELECT * FROM sample.${prefix}`;
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    const suggestion = result.suggestions.find((item) => item.label === "sample.demo");
    expect(suggestion).toBeDefined();
    const range = suggestion!.range as Monaco.IRange;
    const accepted = line.slice(0, range.startColumn - 1) + suggestion!.insertText + line.slice(range.endColumn - 1);
    expect(accepted).toBe("SELECT * FROM sample.demo");
    expect(result.suggestions.some((item) => item.label === "other.demo")).toBe(false);
  });
});

describe("General completions", () => {
  test("returns keywords, functions, tables, and snippets with short prefix", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Short prefix "S" — no filtering (prefix < 2)
    const model = createMockModel("S");
    const position = createPosition(1, 2);
    const result = provider.provideCompletionItems(model, position);

    // Should include all keywords + all functions + all tables + all snippets
    const totalStatic = KEYWORD_ITEMS.length + FUNCTION_ITEMS.length + SNIPPET_ITEMS.length + cache.tableItems.length;
    expect(result.suggestions.length).toBe(totalStatic);
  });

  test("filters by prefix when prefix >= 2 chars", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Prefix "se" — should match SELECT, SET + snippets/functions starting with "se"
    const model = createMockModel("SE");
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain("SELECT");
    expect(labels).toContain("SET");
    // Should not contain unrelated keywords
    expect(labels).not.toContain("FROM");
    expect(labels).not.toContain("WHERE");
  });

  test("includes columns in column context (after SELECT)", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // "SELECT n" — column context
    const model = createMockModel("SELECT na");
    const position = createPosition(1, 10);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain("name");
  });

  test("includes columns in WHERE context", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("SELECT * FROM users WHERE em");
    const position = createPosition(1, 29);
    const result = provider.provideCompletionItems(model, position);

    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain("email");
  });

  test("excludes columns outside column context (e.g. FROM)", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // "FROM us" — not a column context
    const model = createMockModel("FROM us");
    const position = createPosition(1, 8);
    const result = provider.provideCompletionItems(model, position);

    const kinds = result.suggestions.map((s) => s.kind);
    // Should have table (Class=5) but no field (Field=3)
    expect(kinds).toContain(5); // table
    expect(kinds).not.toContain(3); // no columns
  });

  test("tables show row count in detail", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("u");
    const position = createPosition(1, 2);
    const result = provider.provideCompletionItems(model, position);

    // Tables are not offered where only a column can stand, so their rank is read at a FROM.
    const tableSugg = provider
      .provideCompletionItems(createMockModel("SELECT x FROM u"), createPosition(1, 16))
      .suggestions.find((s) => s.label === "users");
    expect(tableSugg?.detail).toBe("Table (100 rows)");
  });

  test("functions have snippet insert rules", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("CO");
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    const countSugg = result.suggestions.find((s) => s.label === "COUNT");
    expect(countSugg).toBeDefined();
    expect(countSugg?.insertText).toBe("COUNT($1)");
    expect(countSugg?.insertTextRules).toBe(4);
  });

  test("sort text orders: keywords(0) < functions(1) < tables(2) < snippets(3) < columns(4)", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    registerSQLCompletionProvider(monaco, cache);
    const provider = monaco._getProvider()!;

    // Short prefix — all items, column context
    const model = createMockModel("SELECT x");
    const position = createPosition(1, 9);
    const result = provider.provideCompletionItems(model, position);

    const keywordSugg = result.suggestions.find((s) => s.label === "SELECT");
    const functionSugg = result.suggestions.find((s) => s.label === "COUNT");
    // Tables are not offered where only a column can stand, so their rank is read at a FROM.
    const tableSugg = provider
      .provideCompletionItems(createMockModel("SELECT x FROM u"), createPosition(1, 16))
      .suggestions.find((s) => s.label === "users");
    const snippetSugg = result.suggestions.find((s) => (s as { detail: string }).detail === "SQL Snippet");
    const columnSugg = result.suggestions.find(
      (s) => s.label === "id" && (s as { detail: string }).detail?.startsWith("Column"),
    );

    expect(keywordSugg?.sortText?.startsWith("0")).toBe(true);
    expect(functionSugg?.sortText?.startsWith("1")).toBe(true);
    expect(tableSugg?.sortText?.startsWith("2")).toBe(true);
    expect(snippetSugg?.sortText?.startsWith("3")).toBe(true);
    expect(columnSugg?.sortText?.startsWith("4")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty schema cache
// ---------------------------------------------------------------------------

describe("Empty schema cache", () => {
  test("works with empty schema cache (no tables/columns)", () => {
    const monaco = createMockMonaco();
    const emptyCache: SchemaCompletionCache = {
      tableItems: [],
      columnMap: new Map(),
      allColumns: new Map(),
    };
    registerSQLCompletionProvider(monaco, emptyCache);
    const provider = monaco._getProvider()!;

    const model = createMockModel("SE");
    const position = createPosition(1, 3);
    const result = provider.provideCompletionItems(model, position);

    // Should still have keyword/function/snippet suggestions
    expect(result.suggestions.length).toBeGreaterThan(0);
    const labels = result.suggestions.map((s) => s.label);
    expect(labels).toContain("SELECT");
  });
});

describe("PostgreSQL table completion quoting", () => {
  test.each([
    [
      "SELECT * FROM ",
      "My_Schema_With_Caps.My_Table_With_Caps",
      'SELECT * FROM "My_Schema_With_Caps"."My_Table_With_Caps"',
    ],
    [
      "SELECT * FROM My_Schema_With_Caps.My_T",
      "My_Schema_With_Caps.My_Table_With_Caps",
      'SELECT * FROM "My_Schema_With_Caps"."My_Table_With_Caps"',
    ],
    [
      "SELECT * FROM My_Schema_With_Caps.",
      "My_Schema_With_Caps.My_Table_With_Caps",
      'SELECT * FROM "My_Schema_With_Caps"."My_Table_With_Caps"',
    ],
    ["SELECT * FROM public.My_T", "My_Table_With_Caps", 'SELECT * FROM public."My_Table_With_Caps"'],
    ["SELECT * FROM ", 'Odd"Schema.Order Details', 'SELECT * FROM "Odd""Schema"."Order Details"'],
    ["SELECT * FROM ", "select", 'SELECT * FROM "select"'],
    ["SELECT * FROM sample.dem", "sample.demo", "SELECT * FROM sample.demo"],
  ])("quotes the applied PostgreSQL edit for %s / %s", (line, label, expected) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(
      monaco,
      createSchemaCache({
        tableItems: [{ label, labelLower: label.toLowerCase(), rowCount: 1, columnNames: "id" }],
      }),
      "postgres",
    );
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    const suggestion = result.suggestions.find((item) => item.label === label)!;
    expect(suggestion).toBeDefined();
    const range = suggestion.range as Monaco.IRange;
    expect(line.slice(0, range.startColumn - 1) + suggestion.insertText + line.slice(range.endColumn - 1)).toBe(
      expected,
    );
  });

  test("leaves other dialects unchanged", () => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache(), "mysql");
    const line = "SELECT * FROM us";
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    expect(result.suggestions.find((item) => item.label === "users")!.insertText).toBe("users");
  });
});

describe("PostgreSQL selective identifier quoting", () => {
  test.each([
    ["user_authority", "user_authority"],
    ["authschema.users", "authschema.users"],
    ["public.orders", "public.orders"],
    ["authschema.UserAuthority", 'authschema."UserAuthority"'],
    ["AuthSchema.users", '"AuthSchema".users'],
    ["USER_AUTHORITY", '"USER_AUTHORITY"'],
    ["UserAuthority", '"UserAuthority"'],
    ["abort", "abort"],
    ["name$1", '"name$1"'],
    ["_items_2", "_items_2"],
    ["user", '"user"'],
    ["authorization", '"authorization"'],
    ["between", '"between"'],
    ["select", '"select"'],
    ["current_user", '"current_user"'],
    ["1st_table", '"1st_table"'],
    ["order details", '"order details"'],
    ['odd"name', '"odd""name"'],
    ["café", '"café"'],
  ])("formats %s following PostgreSQL quote_ident", (label, expected) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(
      monaco,
      createSchemaCache({
        tableItems: [{ label, labelLower: label.toLowerCase(), rowCount: 1, columnNames: "id" }],
      }),
      "postgres",
    );
    const line = "SELECT * FROM ";
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    const suggestion = result.suggestions.find((item) => item.label === label)!;
    expect(suggestion.label).toBe(label);
    const range = suggestion.range as Monaco.IRange;
    expect(line.slice(0, range.startColumn - 1) + suggestion.insertText).toBe("SELECT * FROM " + expected);
  });

  test("an uppercase typed prefix still matches an ordinary lowercase catalog name", () => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(
      monaco,
      createSchemaCache({
        tableItems: [
          {
            label: "authschema.user_authority",
            labelLower: "authschema.user_authority",
            rowCount: 1,
            columnNames: "id",
          },
        ],
      }),
      "postgres",
    );
    const line = "SELECT * FROM AUTHSCHEMA.USER_A";
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    const suggestion = result.suggestions.find((item) => item.label === "authschema.user_authority")!;
    const range = suggestion.range as Monaco.IRange;
    expect(line.slice(0, range.startColumn - 1) + suggestion.insertText).toBe(
      "SELECT * FROM authschema.user_authority",
    );
  });
});

describe("Quoted PostgreSQL table column lookup", () => {
  test.each(['SELECT "users".', 'SELECT "public"."users".'])("retains column suggestions after %s", (line) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache(), "postgres");
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    expect(result.suggestions.map((item) => item.label)).toEqual(["id", "name", "email"]);
  });
});

describe("Completion dialect compatibility", () => {
  // Include the legacy caller without a dialect as well as every non-Postgres
  // registration. This is provider behavior coverage, not live-engine coverage.
  const otherDialects = [...SHIPPED_DATABASE_TYPES.filter((type) => type !== "postgres"), undefined];

  test.each(otherDialects)("%s preserves table insertion and qualified replacement", (dialect) => {
    const monaco = createMockMonaco();
    const label = "Sales.OrderDetails";
    registerSQLCompletionProvider(
      monaco,
      createSchemaCache({ tableItems: [{ label, labelLower: label.toLowerCase(), rowCount: 1, columnNames: "id" }] }),
      dialect,
    );
    for (const line of ["SELECT * FROM ", "SELECT * FROM Sal", "SELECT * FROM Sales.", "SELECT * FROM Sales.Ord"]) {
      const result = monaco
        ._getProvider()!
        .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
      const suggestion = result.suggestions.find((item) => item.label === label)!;
      expect(suggestion.insertText).toBe(label);
      const range = suggestion.range as Monaco.IRange;
      expect(line.slice(0, range.startColumn - 1) + suggestion.insertText).toBe("SELECT * FROM Sales.OrderDetails");
    }
  });

  test.each(otherDialects)("%s retains bare column lookup and existing delimiter behavior", (dialect) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache(), dialect);
    for (const [line, fullText, expected] of [
      ["SELECT users.", "SELECT users.", ["id", "name", "email"]],
      ["SELECT u.", "SELECT u. FROM users u", ["id", "name", "email"]],
      ["SELECT public.products.", "SELECT public.products.", ["id", "price"]],
      ['SELECT "users".', 'SELECT "users".', []],
      ['SELECT "public"."users".', 'SELECT "public"."users".', []],
      ["SELECT `users`.", "SELECT `users`.", []],
      ["SELECT [users].", "SELECT [users].", []],
      ["SELECT missing.", "SELECT missing.", []],
    ] as const) {
      const result = monaco
        ._getProvider()!
        .provideCompletionItems(createMockModel(line, fullText), createPosition(1, line.length + 1));
      expect(result.suggestions.map((item) => item.label)).toEqual([...expected]);
    }
  });

  test("PostgreSQL keeps escaped quoted-name lookup", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache();
    cache.columnMap.set('odd"name', [
      { label: "marker", labelLower: "marker", type: "text", isPrimary: false, tableName: 'Odd"Name' },
    ]);
    registerSQLCompletionProvider(monaco, cache, "postgres");
    const line = 'SELECT "Odd""Name".';
    const result = monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1));
    expect(result.suggestions.map((item) => item.label)).toEqual(["marker"]);
  });
});

describe("Completion addresses outside the default container (#1397)", () => {
  /**
   * The measured fixture: PostgreSQL 18.6 with `public.orders` on the search path and
   * `sales.regions` off it, and a RisingWave-style table whose row count nobody measured.
   */
  function addressedCache(): SchemaCompletionCache {
    const cache = createSchemaCache({
      tableItems: [
        {
          label: "orders",
          labelLower: "orders",
          rowCount: 4,
          columnNames: "id",
          container: ["public"],
          segment: "orders",
          qualify: false,
        },
        {
          label: "regions",
          labelLower: "regions",
          columnNames: "id, name",
          container: ["sales"],
          segment: "regions",
          qualify: true,
        },
        {
          label: "Customers",
          labelLower: "customers",
          columnNames: "id",
          container: ["libredb_objects", "app"],
          segment: "Customers",
          qualify: true,
        },
      ],
    });
    return cache;
  }

  function complete(line: string, dialect?: Parameters<typeof registerSQLCompletionProvider>[2], fullText?: string) {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, addressedCache(), dialect);
    return monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line, fullText), createPosition(1, line.length + 1)).suggestions;
  }

  function applied(line: string, suggestion: Monaco.languages.CompletionItem): string {
    const range = suggestion.range as Monaco.IRange;
    return line.slice(0, range.startColumn - 1) + suggestion.insertText + line.slice(range.endColumn - 1);
  }

  test("a table off the search path inserts its schema, a table on it its bare name", () => {
    const line = "SELECT * FROM reg";
    const regions = complete(line, "postgres").find((item) => item.label === "regions")!;
    expect(applied(line, regions)).toBe("SELECT * FROM sales.regions");
    const orders = complete("SELECT * FROM ord", "postgres").find((item) => item.label === "orders")!;
    expect(orders.insertText).toBe("orders");
  });

  test("each segment of a qualified insert is quoted the PostgreSQL way", () => {
    const line = "SELECT * FROM Cus";
    const customers = complete(line, "postgres").find((item) => item.label === "Customers")!;
    expect(applied(line, customers)).toBe('SELECT * FROM libredb_objects.app."Customers"');
  });

  test("a schema qualifier and a dot offer that schema's tables, by their own name", () => {
    const line = "SELECT * FROM sales.";
    const suggestions = complete(line, "postgres");
    expect(suggestions.map((item) => item.label)).toEqual(["regions"]);
    expect(applied(line, suggestions[0])).toBe("SELECT * FROM sales.regions");
  });

  test("a database qualifier works the same on MySQL and ClickHouse", () => {
    for (const dialect of ["mysql", "clickhouse"] as const) {
      expect(complete("SELECT * FROM public.", dialect).map((item) => item.label)).toEqual(["orders"]);
    }
  });

  test("a partly typed name after the qualifier narrows the container's tables and keeps the qualifier", () => {
    const line = "SELECT * FROM SALES.re";
    const regions = complete(line, "postgres").find((item) => item.label === "regions")!;
    expect(applied(line, regions)).toBe("SELECT * FROM SALES.regions");
    expect(complete("SELECT * FROM sales.zz", "postgres").find((item) => item.label === "regions")).toBeUndefined();
  });

  test("a qualifier matches the trailing segments of a deeper container", () => {
    expect(complete("SELECT * FROM app.", "mssql").map((item) => item.label)).toEqual(["Customers"]);
    expect(complete("SELECT * FROM libredb_objects.app.", "mssql").map((item) => item.label)).toEqual(["Customers"]);
    // Longer than any container: nothing to offer, and no table of a shorter one.
    expect(complete("SELECT * FROM x.libredb_objects.app.", "mssql")).toEqual([]);
  });

  test("other dialects quote each segment through the connection's own quoting", () => {
    const monaco = createMockMonaco();
    const cache = createSchemaCache({
      tableItems: [
        {
          label: "ct_other",
          labelLower: "ct_other",
          columnNames: "id",
          container: ["e2e-other"],
          segment: "ct_other",
          qualify: true,
        },
        {
          label: "order lines",
          labelLower: "order lines",
          columnNames: "id",
          container: ["shop", "dbo"],
          segment: "order lines",
          qualify: false,
        },
      ],
      // A stand-in for `quoteIdentifier` with MySQL capabilities: quote what is not a bare word.
      quoteSegment: (segment) => (/^\w+$/.test(segment) ? segment : `\`${segment}\``),
    });
    registerSQLCompletionProvider(monaco, cache, "mysql");
    const provider = monaco._getProvider()!;
    const at = (line: string) =>
      provider.provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1)).suggestions;
    expect(at("SELECT * FROM ct").find((item) => item.label === "ct_other")!.insertText).toBe("`e2e-other`.ct_other");
    expect(at("SELECT * FROM dbo.").find((item) => item.label === "order lines")!.insertText).toBe("`order lines`");
  });

  test("the detail line states a row count only where one was measured", () => {
    const suggestions = complete("SELECT * FROM ", "postgres");
    expect(suggestions.find((item) => item.label === "orders")!.detail).toBe("Table (4 rows)");
    expect(suggestions.find((item) => item.label === "regions")!.detail).toBe("Table");
  });

  test("an alias defined after the cursor completes in the SELECT list", () => {
    const labels = complete("SELECT c.", "mysql", "SELECT c. FROM e2e.users c").map((item) => item.label);
    expect(labels).toEqual(["id", "name", "email"]);
  });

  test("the alias is read from the cursor's own statement, not the next one", () => {
    const labels = complete("SELECT c.", "mysql", "SELECT c. FROM orders c; SELECT * FROM users c").map(
      (item) => item.label,
    );
    expect(labels).toEqual(["id", "user_id", "total"]);
  });
});

// `containerNameSpelling: "engine"` (Apache Spark): a namespace is the engine's own spelling of one name or several, so
// `a.b` is the names `a` and `b`, and `` `x.y` `` the one name `x.y`. Completion writes and reads it as quoteObjectPath does.
describe("Completion of a container name the engine spells itself", () => {
  const LEVELS = [
    { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
    { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
  ] as const;

  function capabilities(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 15002,
      schemaRefreshPattern: "CREATE|ALTER|DROP",
      containerLevels: LEVELS,
      ...overrides,
    };
  }

  const SPARK = capabilities({ identifierQuoting: "backtick-always", containerNameSpelling: "engine" });

  /** The suggestions at the end of `line`, from the cache QueryEditor builds for `caps`, outside the default container. */
  function complete(caps: ProviderCapabilities, line: string, dialect?: DatabaseType) {
    const monaco = createMockMonaco();
    const tables = [
      { container: ["lake", "a.b"], segment: "trips" },
      { container: ["lake", "`x.y`"], segment: "events" },
    ];
    const cache = createSchemaCache({
      tableItems: tables.map(({ container, segment }) => ({
        label: segment,
        labelLower: segment,
        columnNames: "id",
        container,
        segment,
        qualify: true,
      })),
      quoteSegment: (segment) => quoteIdentifier(segment, caps),
      containerSpelling: containerSpellingOf(caps),
    });
    registerSQLCompletionProvider(monaco, cache, dialect);
    return monaco._getProvider()!.provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1))
      .suggestions;
  }

  function applied(line: string, suggestion: Monaco.languages.CompletionItem): string {
    const range = suggestion.range as Monaco.IRange;
    return line.slice(0, range.startColumn - 1) + suggestion.insertText + line.slice(range.endColumn - 1);
  }

  test("a table outside the default container inserts its namespace part by part", () => {
    const line = "SELECT * FROM tri";
    const trips = complete(SPARK, line, "spark").find((item) => item.label === "trips")!;
    expect(applied(line, trips)).toBe("SELECT * FROM `lake`.`a`.`b`.`trips`");
  });

  test("a quoted namespace part keeps its dot in the insert", () => {
    const line = "SELECT * FROM eve";
    const events = complete(SPARK, line, "spark").find((item) => item.label === "events")!;
    expect(applied(line, events)).toBe("SELECT * FROM `lake`.`x.y`.`events`");
  });

  test.each(["a.b.", "A.B.", "`a`.`b`.", "lake.a.b.", "`lake`.`a`.`b`.", "lake.`a`.b."])(
    "the typed qualifier %s names the namespace a.b and offers its table by its own name",
    (qualifier) => {
      const line = `SELECT * FROM ${qualifier}`;
      const suggestions = complete(SPARK, line, "spark");
      expect(suggestions.map((item) => item.label)).toStrictEqual(["trips"]);
      expect(applied(line, suggestions[0])).toBe(`${line}\`trips\``);
    },
  );

  test("a quoted namespace part is one name: `x.y`. reaches it and x.y. does not", () => {
    expect(complete(SPARK, "SELECT * FROM `x.y`.", "spark").map((item) => item.label)).toStrictEqual(["events"]);
    expect(complete(SPARK, "SELECT * FROM x.y.", "spark")).toStrictEqual([]);
  });

  test("a qualifier names whole segments: b. is not the namespace a.b", () => {
    expect(complete(SPARK, "SELECT * FROM b.", "spark")).toStrictEqual([]);
  });

  test("a double-quoting engine reads a typed part in its own quote character only", () => {
    const double = capabilities({ identifierQuoting: "double-always", containerNameSpelling: "engine" });
    const line = 'SELECT * FROM "a"."b".';
    const suggestions = complete(double, line);
    expect(suggestions.map((item) => item.label)).toStrictEqual(["trips"]);
    expect(applied(line, suggestions[0])).toBe('SELECT * FROM "a"."b"."trips"');
    expect(complete(double, "SELECT * FROM `a`.`b`.")).toStrictEqual([]);
  });

  test.each([
    ["backtick", "SELECT * FROM lake.`a.b`.trips"],
    ["backtick-always", "SELECT * FROM `lake`.`a.b`.`trips`"],
    ["double", 'SELECT * FROM lake."a.b".trips'],
    ["double-always", 'SELECT * FROM "lake"."a.b"."trips"'],
  ] as const)(
    "without the declaration a %s engine writes a dotted schema as one quoted name, as before",
    (quoting, expected) => {
      const plain = capabilities({ identifierQuoting: quoting });
      const line = "SELECT * FROM tri";
      expect(applied(line, complete(plain, line).find((item) => item.label === "trips")!)).toBe(expected);
      // There a typed a.b. is two segments, so it does not name the one-name schema `a.b`.
      expect(complete(plain, "SELECT * FROM a.b.")).toStrictEqual([]);
    },
  );
});

describe("Qualified table labels", () => {
  const tableItems = (labelQualified?: boolean) =>
    ["ds_a", "ds_b"].map((ds) => ({
      label: "products",
      labelLower: "products",
      columnNames: "id",
      container: [ds],
      segment: "products",
      qualify: true,
      ...(labelQualified === undefined ? {} : { labelQualified }),
    }));
  const tablesAt = (items: ReturnType<typeof tableItems>) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache({ tableItems: items }), "bigquery");
    const line = "SELECT * FROM prod";
    return monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line), createPosition(1, line.length + 1))
      .suggestions.filter((item) => item.insertText.endsWith("products"));
  };

  test("a qualified suggestion is labelled with its address and filters on its name", () => {
    const items = tablesAt(tableItems(true));
    expect(items.map((item) => item.label)).toEqual(["ds_a.products", "ds_b.products"]);
    expect(items.map((item) => item.filterText)).toEqual(["products", "products"]);
  });

  test("without the flag the label stays the bare name", () => {
    const items = tablesAt(tableItems());
    expect(items.map((item) => item.label)).toEqual(["products", "products"]);
    expect(items.every((item) => item.filterText === undefined)).toBe(true);
  });
});

describe("Clause-aware suggestions", () => {
  const at = (text: string) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache());
    const model = createMockModel(text);
    return monaco._getProvider()!.provideCompletionItems(model, createPosition(1, text.length + 1)).suggestions;
  };
  const isTable = (s: { detail?: string }) => s.detail?.startsWith("Table") === true;
  const isColumn = (s: { detail?: string }) => s.detail?.startsWith("Column") === true;

  test("a SELECT list offers columns, and tables only until the statement names a source", () => {
    const suggestions = at("SELECT ");
    expect(suggestions.some(isColumn)).toBe(true);
    expect(suggestions.some(isTable)).toBe(true);
    expect(at("SELECT id FROM users WHERE id IN (SELECT ").some(isTable)).toBe(false);
  });

  test("a FROM or JOIN position offers tables and no columns", () => {
    for (const text of ["SELECT id FROM ", "SELECT id FROM users u JOIN ", "SELECT id FROM a, "]) {
      const suggestions = at(text);
      expect(suggestions.some(isTable)).toBe(true);
      expect(suggestions.some(isColumn)).toBe(false);
    }
  });

  test("WHERE and ON go back to columns", () => {
    for (const text of [
      "SELECT id FROM users WHERE ",
      "SELECT 1 FROM a JOIN b ON ",
      "SELECT 1 FROM a JOIN b x ON ",
      "SELECT 1 FROM a JOIN (SELECT id FROM b) x ON ",
      "MERGE INTO a USING b ON ",
      "INSERT INTO users (id) VALUES (1) ON DUPLICATE KEY UPDATE id = ",
    ]) {
      expect(at(text).some(isTable)).toBe(false);
    }
  });

  test("an ON that names an object offers tables", () => {
    for (const text of [
      "CREATE INDEX i ON ",
      "GRANT SELECT ON ",
      "CREATE TRIGGER trg BEFORE INSERT ON ",
      "CREATE POLICY p ON ",
      "CREATE TRIGGER trg AFTER UPDATE ON us",
    ]) {
      const suggestions = at(text);
      expect(suggestions.some(isTable)).toBe(true);
      expect(suggestions.some(isColumn)).toBe(false);
    }
    const indexed = columnsAt("CREATE INDEX i ON users (");
    expect(indexed).toContain("email");
    expect(indexed).not.toContain("total");
  });

  test("DISTINCT ON, a qualified keyword-named column and a partly typed ON word are no table position", () => {
    for (const [text, cursor] of [
      ["SELECT DISTINCT ON  FROM users", "SELECT DISTINCT ON ".length],
      ["SELECT t.table,  FROM users t", "SELECT t.table, ".length],
      ["INSERT INTO users (id) VALUES (1) ON CONFL", undefined],
      ["CREATE TABLE t (a int REFERENCES users (id) ON DEL", undefined],
      ["ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES users (id) ON DEL", undefined],
    ] as const) {
      expect(labelsAt(text, cursor).some((s) => s.table)).toBe(false);
    }
  });

  test("a model's blanked text is reused for the same version", () => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache());
    const model = createMockModel("SELECT * FROM users WHERE ");
    const provider = monaco._getProvider()!;
    const first = provider.provideCompletionItems(model, createPosition(1, 27)).suggestions.length;
    expect(provider.provideCompletionItems(model, createPosition(1, 27)).suggestions.length).toBe(first);
  });

  test("an open column or definition list after INTO/TABLE offers columns, not tables", () => {
    for (const text of ["INSERT INTO users (a, ", "CREATE TABLE t (id int, "]) {
      const suggestions = at(text);
      expect(suggestions.some(isColumn)).toBe(true);
      expect(suggestions.some(isTable)).toBe(false);
    }
  });

  test("INTO, UPDATE and a closed list still name tables", () => {
    for (const text of ["INSERT INTO ", "UPDATE ", "INSERT INTO t (a) "]) {
      const suggestions = at(text);
      expect(suggestions.some(isTable)).toBe(true);
      expect(suggestions.some(isColumn)).toBe(false);
    }
  });

  const labelsAt = (text: string, cursor = text.length, dialect?: DatabaseType) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache(), dialect);
    return monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(text, text), createPosition(1, cursor + 1))
      .suggestions.map((s) => ({ label: s.label as string, table: isTable(s), column: isColumn(s) }));
  };
  const columnsAt = (text: string, cursor?: number, dialect?: DatabaseType) =>
    labelsAt(text, cursor, dialect)
      .filter((s) => s.column)
      .map((s) => s.label);

  test("a clause inside a subquery that closed before the cursor governs nothing", () => {
    const suggestions = at("SELECT * FROM users WHERE id IN (SELECT id FROM orders) AND ");
    expect(suggestions.some(isColumn)).toBe(true);
    expect(suggestions.some(isTable)).toBe(false);
  });

  test("a keyword inside a string or a comment is no clause", () => {
    for (const text of [
      "SELECT * FROM users WHERE name = 'from' ",
      "SELECT * FROM users WHERE id /* from */ ",
      "SELECT * FROM users WHERE id -- from x\n",
    ]) {
      const suggestions = labelsAt(text);
      expect(suggestions.some((s) => s.column)).toBe(true);
      expect(suggestions.some((s) => s.table)).toBe(false);
    }
  });

  test("a dollar-quoted keyword is no clause on PostgreSQL", () => {
    expect(labelsAt("SELECT * FROM users WHERE $$from$$ ", undefined, "postgres").some((s) => s.table)).toBe(false);
    expect(labelsAt("SELECT * FROM users WHERE $$from$$ ", undefined, "postgres").some((s) => s.column)).toBe(true);
  });

  test("a `;` inside a string does not end the statement", () => {
    const columns = columnsAt("SELECT * FROM orders WHERE note = ';' AND ");
    expect(columns).toContain("user_id");
    expect(columns).not.toContain("email");
  });

  test("a paren inside a string does not close a definition list", () => {
    const suggestions = labelsAt("CREATE TABLE t (note text default ')', ");
    expect(suggestions.some((s) => s.column)).toBe(true);
    expect(suggestions.some((s) => s.table)).toBe(false);
  });

  test("an open column list right after INTO offers columns", () => {
    const suggestions = at("INSERT INTO users (");
    expect(suggestions.some(isColumn)).toBe(true);
    expect(suggestions.some(isTable)).toBe(false);
  });

  test("a source the schema cannot shape (a table function) widens the columns to every known one", () => {
    const text = "SELECT  FROM generate_series(1, 3) g JOIN orders";
    const columns = columnsAt(text, "SELECT ".length);
    expect(columns).toContain("email");
    expect(columns).toContain("total");
  });

  test("a qualified reference does not fall back to another container's bare name", () => {
    const columns = columnsAt("SELECT * FROM other_ds.users WHERE ");
    expect(columns).toContain("total");
    expect(columns).toContain("email");
  });

  test("known references still scope the columns, on every dialect", () => {
    for (const dialect of [undefined, "postgres", "mysql"] as const) {
      const users = columnsAt("SELECT * FROM users WHERE ", undefined, dialect);
      expect(users).toContain("email");
      expect(users).not.toContain("total");
      const products = columnsAt("SELECT * FROM public.products WHERE ", undefined, dialect);
      expect(products).toContain("price");
      expect(products).not.toContain("email");
    }
  });

  describe.each(["postgres", "mysql"] as const)("on %s", (dialect) => {
    const tables = (text: string) => labelsAt(text, undefined, dialect).filter((s) => s.table);

    test("a SELECT list offers tables until a source is named, and a table name typed there completes its columns after the dot", () => {
      expect(tables("SELECT us").map((s) => s.label)).toContain("users");
      const named = labelsAt("SELECT  FROM users", "SELECT ".length, dialect);
      expect(named.filter((s) => s.table)).toEqual([]);
      expect(named.some((s) => s.label === "users")).toBe(true);
      expect(labelsAt("SELECT users.", undefined, dialect).map((s) => s.label)).toEqual(["id", "name", "email"]);
    });

    test("FROM and JOIN offer tables and no columns", () => {
      for (const text of ["SELECT * FROM ", "SELECT * FROM users u JOIN "]) {
        expect(tables(text).length).toBeGreaterThan(0);
        expect(columnsAt(text, undefined, dialect)).toEqual([]);
      }
    });

    test("columns are scoped to the FROM and JOIN tables", () => {
      const columns = columnsAt("SELECT * FROM users u JOIN orders o ON ", undefined, dialect);
      expect(columns).toEqual(expect.arrayContaining(["id", "name", "email", "user_id", "total"]));
      expect(columns).not.toContain("price");
    });

    test("an unclosed column list after INSERT INTO offers the columns, and no table", () => {
      for (const text of ["INSERT INTO users (", "INSERT INTO users (id, "]) {
        expect(columnsAt(text, undefined, dialect).length).toBeGreaterThan(0);
        expect(tables(text)).toEqual([]);
      }
    });
  });
});

describe("Statement scope in completion", () => {
  const at = (text: string, cursor = text.length, dialect?: DatabaseType) => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache(), dialect);
    const line = text.slice(0, cursor);
    return monaco
      ._getProvider()!
      .provideCompletionItems(createMockModel(line, text), createPosition(1, cursor + 1))
      .suggestions.map((s) => ({
        label: s.label as string,
        kind: s.kind,
        detail: (s as { detail?: string }).detail ?? "",
      }));
  };
  const columns = (text: string, cursor?: number) =>
    at(text, cursor)
      .filter((s) => s.detail.startsWith("Column"))
      .map((s) => s.label);
  const cursorAfter = (text: string, marker: string) => text.lastIndexOf(marker) + marker.length;

  test("an INSERT column list and an UPDATE SET offer only the target's columns", () => {
    expect(columns("INSERT INTO orders (")).toEqual(expect.arrayContaining(["user_id", "total"]));
    expect(columns("INSERT INTO orders (")).not.toContain("email");
    expect(columns("UPDATE users SET ")).toContain("email");
    expect(columns("UPDATE users SET ")).not.toContain("total");
  });

  test("a column position offers the statement's aliases and unaliased table names", () => {
    const text = "SELECT  FROM users u JOIN orders";
    const qualifiers = at(text, "SELECT ".length).filter((s) => s.kind === 4);
    expect(qualifiers.map((s) => [s.label, s.detail])).toEqual([
      ["u", "Alias of users"],
      ["orders", "Source orders"],
    ]);
  });

  test("a qualifier names a CTE or a subquery too, and its dot completes the derived columns", () => {
    const sub = "SELECT s. FROM (SELECT id, total AS t FROM orders) s";
    expect(at(sub, "SELECT s.".length).map((s) => s.label)).toEqual(["id", "t"]);
    const cte = "WITH c AS (SELECT email FROM users) SELECT c. FROM c";
    expect(at(cte, cursorAfter(cte, "SELECT c.")).map((s) => s.label)).toEqual(["email"]);
    expect(
      at(cte.replace("c.", "  "), cursorAfter(cte, "SELECT ")).some((s) => s.label === "c" && s.detail === "CTE"),
    ).toBe(true);
  });

  test("an alias's dot reads the qualified table it stands for", () => {
    const text = "SELECT p. FROM public.products p";
    expect(at(text, "SELECT p.".length).map((s) => s.label)).toEqual(["id", "price"]);
  });

  test("a column shared by several sources lists them all", () => {
    const id = at("SELECT * FROM users JOIN orders ON ").find((s) => s.label === "id")!;
    expect(id.detail).toBe("Column (integer) · users, orders");
  });

  test("a CTE is offered where a table is, and its columns where a column is", () => {
    const from = at("WITH c AS (SELECT 1 AS n) SELECT * FROM ");
    expect(from.find((s) => s.label === "c")?.detail).toBe("CTE");
    expect(columns("WITH c AS (SELECT email AS mail FROM users) SELECT * FROM c WHERE ")).toEqual(["mail"]);
  });

  test("a subquery's tables are out of scope outside it, and in scope with the enclosing ones inside it", () => {
    const text = "SELECT  FROM users WHERE id IN (SELECT user_id FROM orders WHERE )";
    const outer = columns(text, "SELECT ".length);
    expect(outer).toContain("email");
    expect(outer).not.toContain("total");
    const inner = columns(text, text.length - 1);
    expect(inner).toEqual(expect.arrayContaining(["total", "email"]));
  });

  test("a JOIN ... USING list offers the columns the joined sources share", () => {
    expect(columns("SELECT * FROM users JOIN orders USING (")).toEqual(["id"]);
  });

  test("right after FROM only tables are offered; after a table name keywords return, functions do not", () => {
    const slot = at("SELECT * FROM ");
    expect(slot.some((s) => s.detail === "SQL Keyword" || s.detail === "SQL Snippet")).toBe(false);
    expect(slot.some((s) => s.kind === 1)).toBe(false);
    const after = at("SELECT * FROM users ");
    expect(after.some((s) => s.label === "WHERE")).toBe(true);
    expect(after.some((s) => s.kind === 1)).toBe(false);
  });

  test("UPDATE after ON, FOR or KEY is no table position", () => {
    for (const text of [
      "INSERT INTO orders (id) VALUES (1) ON DUPLICATE KEY UPDATE total = 1, ",
      "CREATE TABLE t (id int, updated_at timestamp ON UPDATE ",
    ]) {
      const suggestions = at(text);
      expect(suggestions.some((s) => s.detail.startsWith("Column"))).toBe(true);
      expect(suggestions.some((s) => s.detail.startsWith("Table"))).toBe(false);
    }
  });

  test("a FROM inside a function call, and a table function's arguments, are no table position", () => {
    for (const text of ["SELECT * FROM users WHERE EXTRACT(YEAR FROM ", "SELECT * FROM generate_series(1, "]) {
      const suggestions = at(text);
      expect(suggestions.some((s) => s.detail.startsWith("Column"))).toBe(true);
      expect(suggestions.some((s) => s.label === "COUNT")).toBe(true);
      expect(suggestions.some((s) => s.detail.startsWith("Table"))).toBe(false);
    }
  });

  test("a derived source whose select list names nothing widens the columns", () => {
    const text = "SELECT  FROM (SELECT total * 2 FROM orders) s";
    expect(columns(text, "SELECT ".length)).toEqual(expect.arrayContaining(["email", "total"]));
  });

  test("a quoted CTE or alias name is inserted quoted", () => {
    const monaco = createMockMonaco();
    registerSQLCompletionProvider(monaco, createSchemaCache(), "postgres");
    const provider = monaco._getProvider()!;
    const insertsAt = (text: string, cursor = text.length) =>
      provider
        .provideCompletionItems(createMockModel(text.slice(0, cursor), text), createPosition(1, cursor + 1))
        .suggestions.filter((s) => s.label === "my cte")
        .map((s) => s.insertText);
    expect(insertsAt('WITH "my cte" AS (SELECT id FROM users) SELECT * FROM ')).toEqual(['"my cte"']);
    const text = 'WITH "my cte" AS (SELECT id FROM users) SELECT  FROM "my cte"';
    expect(insertsAt(text, text.indexOf("SELECT  ") + "SELECT ".length)).toContain('"my cte"');
  });

  test("a name two sources spell in different case is one column with both owners", () => {
    const text = "SELECT  FROM (SELECT ID FROM users) a, (SELECT id FROM users) b";
    const hits = at(text, "SELECT ".length).filter(
      (s) => s.label.toLowerCase() === "id" && s.detail.startsWith("Column"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("a, b");
  });

  test("the dot path reads no alias from another statement, and a cursor at 0 is harmless", () => {
    expect(at("SELECT * FROM users x; SELECT x.")).toEqual([]);
    expect(at("SELECT * FROM users x WHERE x.").map((s) => s.label)).toContain("email");
    expect(() => at(";SELECT", 0)).not.toThrow();
  });

  test("a long chain of self-joining CTEs resolves in linear time", () => {
    // Doubling per link would never finish at 40; the loose bound only guards against that.
    const ctes = Array.from({ length: 40 }, (_, i) =>
      i === 0 ? "c0 AS (SELECT id FROM users)" : `c${i} AS (SELECT * FROM c${i - 1} a JOIN c${i - 1} b ON true)`,
    );
    const text = `WITH ${ctes.join(", ")} SELECT * FROM c39 WHERE `;
    const started = performance.now();
    expect(columns(text)).toContain("id");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a CTE after CREATE VIEW ... AS or inside a subquery scopes the columns like a leading one", () => {
    expect(columns("CREATE VIEW v AS WITH c AS (SELECT email FROM users) SELECT * FROM c WHERE ")).toEqual(["email"]);
    const text = "SELECT * FROM (WITH c AS (SELECT total FROM orders) SELECT * FROM c WHERE ) s";
    expect(columns(text, text.length - 3)).toEqual(["total"]);
    expect(at("CREATE VIEW v AS WITH c AS (SELECT 1 AS n) SELECT * FROM ").some((s) => s.label === "c")).toBe(true);
  });
});
