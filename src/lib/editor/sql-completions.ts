/**
 * SQL Completion Provider for Monaco Editor
 *
 * Pure utility module (no React) that registers SQL keyword, function, snippet,
 * and schema-aware column/table completions.
 */

import type * as Monaco from 'monaco-editor';
import { extractAliases, resolveAlias } from '@/lib/sql';

// ---------------------------------------------------------------------------
// Static constants
// ---------------------------------------------------------------------------

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'EXISTS', 'DISTINCT',
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'ON', 'USING',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'TRUNCATE', 'CREATE', 'ALTER', 'DROP',
  'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'FUNCTION', 'TRIGGER', 'PROCEDURE',
  'AS', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'COALESCE', 'NULLIF',
  'WINDOW', 'OVER', 'PARTITION BY', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED'
];

export const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'FIRST_VALUE', 'LAST_VALUE', 'LEAD', 'LAG',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'CONCAT', 'SUBSTR', 'LENGTH', 'LOWER', 'UPPER',
  'TRIM', 'LTRIM', 'RTRIM', 'REPLACE', 'ROUND', 'TRUNC', 'ABS', 'NOW', 'CURRENT_TIMESTAMP',
  'DATE_PART', 'DATE_TRUNC', 'EXTRACT', 'AGE', 'TO_CHAR', 'TO_DATE', 'TO_NUMBER', 'JSON_AGG', 'JSON_BUILD_OBJECT'
];

export const SQL_SNIPPETS = [
  { label: 'SELECT', value: 'SELECT * FROM ${1:table_name} LIMIT 10;' },
  { label: 'INSERT', value: 'INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values});' },
  { label: 'UPDATE', value: 'UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};' },
  { label: 'DELETE', value: 'DELETE FROM ${1:table_name}\nWHERE ${2:condition};' },
  { label: 'JOIN', value: 'SELECT ${1:*}\nFROM ${2:table1} t1\nJOIN ${3:table2} t2 ON t1.${4:id} = t2.${5:t1_id};' },
  { label: 'WITH', value: 'WITH ${1:cte_name} AS (\n  SELECT ${2:*}\n  FROM ${3:table_name}\n)\nSELECT * FROM ${1:cte_name};' },
];

// ---------------------------------------------------------------------------
// Pre-computed completion items
// ---------------------------------------------------------------------------

export interface PrecomputedItem {
  label: string;
  labelLower: string;
  kind: number;
  insertText: string;
  insertTextRules?: number;
  detail: string;
}

export const KEYWORD_ITEMS: PrecomputedItem[] = SQL_KEYWORDS.map(kw => ({
  label: kw,
  labelLower: kw.toLowerCase(),
  kind: 17, // CompletionItemKind.Keyword
  insertText: kw,
  detail: 'SQL Keyword'
}));

export const FUNCTION_ITEMS: PrecomputedItem[] = SQL_FUNCTIONS.map(f => ({
  label: f,
  labelLower: f.toLowerCase(),
  kind: 1, // CompletionItemKind.Function
  insertText: f + '($1)',
  insertTextRules: 4, // InsertAsSnippet
  detail: 'SQL Function'
}));

export const SNIPPET_ITEMS: PrecomputedItem[] = SQL_SNIPPETS.map(s => ({
  label: s.label,
  labelLower: s.label.toLowerCase(),
  kind: 27, // CompletionItemKind.Snippet
  insertText: s.value,
  insertTextRules: 4, // InsertAsSnippet
  detail: 'SQL Snippet'
}));

// ---------------------------------------------------------------------------
// Schema completion cache type (shared with MongoDB completions)
// ---------------------------------------------------------------------------

export interface SchemaTableItem {
  label: string;
  labelLower: string;
  rowCount: number;
  columnNames: string;
}

export interface SchemaColumnItem {
  label: string;
  labelLower: string;
  type: string;
  isPrimary: boolean;
  tableName: string;
}

export interface SchemaCompletionCache {
  tableItems: SchemaTableItem[];
  columnMap: Map<string, SchemaColumnItem[]>;
  allColumns: Map<string, SchemaColumnItem>;
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Registers the SQL completion item provider with Monaco.
 *
 * @param monaco  - The Monaco namespace (from `useMonaco()` or `beforeMount`)
 * @param schemaCompletionCache - Pre-computed schema data for table/column completions
 * @returns An `IDisposable` that should be called on cleanup.
 */
export function registerSQLCompletionProvider(
  monaco: typeof Monaco,
  schemaCompletionCache: SchemaCompletionCache,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const line = model.getLineContent(position.lineNumber);
      const lastChar = line[position.column - 2];
      const prefix = word.word.toLowerCase();

      const suggestions: Monaco.languages.CompletionItem[] = [];

      // Dot-triggered: Show columns for specific table or alias
      if (lastChar === '.') {
        const matches = line.substring(0, position.column - 1).match(/(\w+)\.$/);
        if (matches) {
          const identifier = matches[1].toLowerCase();

          // Helper to find columns by table name (handles schema.table format)
          const findColumns = (tableName: string) => {
            const tableNameLower = tableName.toLowerCase();
            // 1. Try exact match first
            const cols = schemaCompletionCache.columnMap.get(tableNameLower);
            if (cols) return cols;

            // 2. Try matching table name with any schema prefix
            for (const [key, value] of schemaCompletionCache.columnMap.entries()) {
              const parts = key.split('.');
              const justTableName = parts[parts.length - 1];
              if (justTableName === tableNameLower) {
                return value;
              }
            }
            return null;
          };

          // 1. First, try direct table lookup
          let columns = findColumns(identifier);

          // 2. If not found, try alias resolution
          if (!columns) {
            const textToCursor = model.getValueInRange({
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: position.lineNumber,
              endColumn: position.column - 1
            });

            const { aliases } = extractAliases(textToCursor);
            const resolvedTableName = resolveAlias(identifier, aliases);
            columns = findColumns(resolvedTableName);
          }

          // 3. Provide column suggestions
          if (columns) {
            columns.forEach(col => {
              suggestions.push({
                label: col.label,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.label,
                range,
                detail: `${col.type}${col.isPrimary ? ' (PK)' : ''}`,
                documentation: `Column of ${col.tableName}`
              });
            });
          }
        }
        return { suggestions };
      }

      // General completion with lazy filtering and context awareness
      const shouldFilter = prefix.length >= 2;

      // Detect context: Are we in a position where columns make sense?
      const textBeforeCursor = line.substring(0, position.column - 1).toUpperCase();
      const isColumnContext = /\b(SELECT|WHERE|AND|OR|ON|SET|HAVING|ORDER\s+BY|GROUP\s+BY|,)\s*\w*$/i.test(textBeforeCursor);

      // Keywords
      KEYWORD_ITEMS.forEach(item => {
        if (!shouldFilter || item.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: item.insertText,
            range,
            detail: item.detail,
            sortText: '0' + item.label
          });
        }
      });

      // Functions
      FUNCTION_ITEMS.forEach(item => {
        if (!shouldFilter || item.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: item.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: item.detail,
            sortText: '1' + item.label
          });
        }
      });

      // Tables
      schemaCompletionCache.tableItems.forEach(table => {
        if (!shouldFilter || table.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: table.label,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.label,
            range,
            detail: `Table (${table.rowCount} rows)`,
            documentation: table.columnNames,
            sortText: '2' + table.label
          });
        }
      });

      // Columns - only show in appropriate context
      if (isColumnContext) {
        schemaCompletionCache.allColumns.forEach((col, colName) => {
          if (!shouldFilter || col.labelLower.startsWith(prefix)) {
            suggestions.push({
              label: colName,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: colName,
              range,
              detail: `Column (${col.type})`,
              sortText: '4' + colName
            });
          }
        });
      }

      // Snippets
      SNIPPET_ITEMS.forEach(item => {
        if (!shouldFilter || item.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: item.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: item.detail,
            sortText: '3' + item.label
          });
        }
      });

      return { suggestions };
    },
  });
}
