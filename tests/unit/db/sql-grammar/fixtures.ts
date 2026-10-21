/**
 * The per-engine golden render of every surface the SQL grammar reaches: the resolved grammar
 * record, the span walk and statement split, the editable-result target, redaction and
 * completion quoting. Each line is one call to a public function and its JSON result, so a
 * diff of a golden file names the call whose output moved.
 */
import type * as Monaco from "monaco-editor";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { registerSQLCompletionProvider, type SchemaCompletionCache } from "@/lib/editor/sql-completions";
import { maskCredentials, redactStatement } from "@/lib/query-events/redact";
import { hashRunIsAmbiguous, readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { resolveUpdateTarget, selectsPlainColumn } from "@/lib/sql/update-target";
import type { DatabaseType } from "@/lib/types";

/** Every engine id, then the three lookups that are not one: no connection, a prototype key, an unknown id. */
export const GOLDEN_KEYS: readonly string[] = [
  ...EXTERNAL_DATABASE_TYPES,
  "libredb",
  "no-connection",
  "constructor",
  "not-an-engine",
];

export const SPAN_STATEMENTS: readonly string[] = [
  "SELECT 1 # c\nFROM t",
  "SELECT a[1], [x]]y] FROM t",
  "/* a /* b */ c */ SELECT 1",
  "SELECT q'[it's]' FROM dual",
  "SELECT 1 // c; DROP TABLE t",
  "SELECT 'a\\'b'; SELECT 2",
  'SELECT $$x;$$, "q""n", `b``t` FROM t',
  "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; SELECT 2",
  "SELECT 1\nGO\nSELECT 2",
  "BEGIN NULL; END;\n/\nSELECT 1",
  "SELECT 1 -- x\rDROP TABLE t",
];

export const UPDATE_TARGET_STATEMENTS: readonly string[] = [
  "SELECT id, note FROM products",
  "SELECT id FROM products --x",
  "SELECT id FROM products -- x",
  "SELECT id, (PIVOT orders ON k USING max(note)) FROM products",
  "SELECT id, coalesce(show, '') FROM products",
  "SELECT id FROM products MINUS SELECT id FROM orders",
  "SELECT id FROM a UNION SELECT id FROM b",
  "SELECT id FROM products WHERE qty <> 5-- zz UNION SELECT id FROM zord",
];

export const REDACTION_STATEMENTS: readonly string[] = [
  "SELECT * FROM \"Users\" WHERE name = 'bob' AND id = 42",
  "SELECT `a`, [b] FROM t WHERE x = 'y' -- note",
  '{"collection":"users","operation":"find","filter":{"name":"bob"}}',
  "GET user:1",
  'SET k "v"',
  "SELECT 'postgres://u:p@h/db' # x",
  "CREATE USER a IDENTIFIED BY secret",
];

const COMPLETION_LINES: readonly string[] = [
  "SELECT * FROM ",
  "SELECT * FROM public.se",
  'SELECT "Order""Items".',
  "SELECT users.",
];

/** A `RegExp` (the `trailingLimitClauses` rows) is written as its source literal, so the record is pinned field by field. */
function stringify(value: unknown): string {
  const text = JSON.stringify(value, (_key, field: unknown) => (field instanceof RegExp ? String(field) : field));
  return text === undefined ? "undefined" : text;
}

/** The span walk from 0: a span is `[kind, start, end]`, and where none starts the walk steps one character. */
function walkSpans(sql: string, grammar: ReturnType<typeof resolveSqlGrammar>): [string, number, number][] {
  const spans: [string, number, number][] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, grammar);
    if (span === null) {
      index += 1;
      continue;
    }
    spans.push([span.kind, index, span.end]);
    index = span.end;
  }
  return spans;
}

// The mock Monaco and model, the shape of `createMockMonaco`/`createMockModel` in tests/unit/sql-completions.test.ts.
type Provider = {
  provideCompletionItems: (
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
  ) => { suggestions: Monaco.languages.CompletionItem[] };
};

function createMockMonaco() {
  let registered: Provider | null = null;
  const mockMonaco = {
    languages: {
      registerCompletionItemProvider: (_lang: string, provider: Provider) => {
        registered = provider;
        return {
          dispose: () => {
            registered = null;
          },
        };
      },
      CompletionItemKind: { Keyword: 17, Function: 1, Snippet: 27, Class: 5, Field: 3, Variable: 4 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
    _getProvider: () => registered,
  };
  return mockMonaco as unknown as typeof Monaco & { _getProvider: () => Provider | null };
}

function createMockModel(lineContent: string) {
  return {
    getWordUntilPosition: (position: { column: number }) => {
      const before = lineContent.substring(0, position.column - 1);
      const match = before.match(/(\w+)$/);
      return {
        word: match ? match[1] : "",
        startColumn: match ? position.column - match[1].length : position.column,
        endColumn: position.column,
      };
    },
    getLineContent: () => lineContent,
    getValue: () => lineContent,
    getOffsetAt: (position: { column: number }) => position.column - 1,
    getVersionId: () => 1,
  } as unknown as Monaco.editor.ITextModel;
}

function column(label: string, tableName: string) {
  return { label, labelLower: label.toLowerCase(), type: "varchar", isPrimary: false, tableName };
}

function completionCache(extra?: Partial<SchemaCompletionCache>): SchemaCompletionCache {
  const columnMap = new Map([
    ['order"items', [column("qty", 'Order"Items')]],
    ["users", [column("id", "users"), column("email", "users")]],
  ]);
  const allColumns = new Map([...columnMap.values()].flat().map((col) => [col.label, col]));
  const tableItems: SchemaCompletionCache["tableItems"] = [
    { label: 'Order"Items', labelLower: 'order"items', columnNames: "qty" },
    { label: "public.select", labelLower: "public.select", columnNames: "" },
    { label: "users", labelLower: "users", columnNames: "id, email" },
  ];
  return { tableItems, columnMap, allColumns, ...extra };
}

const COMPLETION_CACHES: readonly [string, SchemaCompletionCache][] = [
  ["plain", completionCache()],
  [
    "quoted",
    completionCache({
      quoteSegment: (segment) => `<${segment}>`,
      tableItems: [
        ...completionCache().tableItems,
        { label: "t", labelLower: "t", columnNames: "", container: ["c0"], segment: 'Order"Items', qualify: true },
      ],
    }),
  ],
];

/** `[label, insertText]` of every table (Class) and column (Field) suggestion at the end of `line`, sorted. */
function completionRows(cache: SchemaCompletionCache, type: DatabaseType | undefined, line: string): string[][] {
  const monaco = createMockMonaco();
  const disposable = registerSQLCompletionProvider(monaco, cache, type);
  const provider = monaco._getProvider();
  if (provider === null) throw new Error("registerSQLCompletionProvider registered no provider");
  const position = { lineNumber: 1, column: line.length + 1 } as Monaco.Position;
  const { suggestions } = provider.provideCompletionItems(createMockModel(line), position);
  disposable.dispose();
  return suggestions
    .filter((item) => item.kind === 5 || item.kind === 3)
    .map((item) => [String(item.label), String(item.insertText)])
    .sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : a.join("\u0000") > b.join("\u0000") ? 1 : 0));
}

/**
 * The golden text of one key: one line per public call, `fn(args) => result`. `undefined` and
 * `"no-connection"` are the call without a connection; any other string goes in as it is.
 */
export function renderGolden(key: string | undefined): string {
  const type = (key === "no-connection" ? undefined : key) as DatabaseType | undefined;
  const grammar = resolveSqlGrammar(type);
  const lines: string[] = [
    `resolveSqlGrammar(${stringify(type)}) => ${stringify(grammar)}`,
    `readsSqlText(${stringify(type)}) => ${stringify(readsSqlText(type))}`,
    `hashRunIsAmbiguous(resolveSqlGrammar(${stringify(type)})) => ${stringify(hashRunIsAmbiguous(grammar))}`,
  ];
  for (const s of SPAN_STATEMENTS) {
    lines.push(`readSqlSpan walk(${stringify(s)}) => ${stringify(walkSpans(s, grammar))}`);
    lines.push(`splitStatements(${stringify(s)}) => ${stringify(splitStatements(s, grammar))}`);
  }
  for (const s of UPDATE_TARGET_STATEMENTS) {
    lines.push(
      `resolveUpdateTarget(${stringify(s)}, ${stringify(type)}) => ${stringify(resolveUpdateTarget(s, type))}`,
    );
  }
  const plain = "SELECT id, note FROM products";
  lines.push(
    `selectsPlainColumn(${stringify(plain)}, "note", ${stringify(type)}) => ${stringify(selectsPlainColumn(plain, "note", type))}`,
  );
  for (const s of REDACTION_STATEMENTS) {
    const engine = type as DatabaseType;
    lines.push(`redactStatement(${stringify(s)}, ${stringify(type)}) => ${stringify(redactStatement(s, engine))}`);
    lines.push(`maskCredentials(${stringify(s)}, ${stringify(type)}) => ${stringify(maskCredentials(s, engine))}`);
  }
  for (const [name, cache] of COMPLETION_CACHES) {
    for (const line of COMPLETION_LINES) {
      lines.push(`completions[${name}](${stringify(line)}) => ${stringify(completionRows(cache, type, line))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
