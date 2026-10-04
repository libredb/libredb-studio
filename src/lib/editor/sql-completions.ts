/**
 * SQL Completion Provider for Monaco Editor
 *
 * Pure utility module (no React) that registers SQL keyword, function, snippet,
 * and schema-aware column/table completions.
 */

import type * as Monaco from "monaco-editor";
import { extractAliases, resolveAlias } from "@/lib/sql";
import { formatPostgresIdentifier } from "./postgres-identifiers";
import type { DatabaseType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Static constants
// ---------------------------------------------------------------------------

export const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "BETWEEN",
  "LIKE",
  "IS NULL",
  "IS NOT NULL",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "UNION",
  "ALL",
  "EXISTS",
  "DISTINCT",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "NATURAL JOIN",
  "ON",
  "USING",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "TRUNCATE",
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "VIEW",
  "INDEX",
  "SCHEMA",
  "DATABASE",
  "FUNCTION",
  "TRIGGER",
  "PROCEDURE",
  "AS",
  "WITH",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CAST",
  "COALESCE",
  "NULLIF",
  "WINDOW",
  "OVER",
  "PARTITION BY",
  "ROWS",
  "RANGE",
  "PRECEDING",
  "FOLLOWING",
  "UNBOUNDED",
];

export const SQL_FUNCTIONS = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "FIRST_VALUE",
  "LAST_VALUE",
  "LEAD",
  "LAG",
  "ROW_NUMBER",
  "RANK",
  "DENSE_RANK",
  "NTILE",
  "CONCAT",
  "SUBSTR",
  "LENGTH",
  "LOWER",
  "UPPER",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "REPLACE",
  "ROUND",
  "TRUNC",
  "ABS",
  "NOW",
  "CURRENT_TIMESTAMP",
  "DATE_PART",
  "DATE_TRUNC",
  "EXTRACT",
  "AGE",
  "TO_CHAR",
  "TO_DATE",
  "TO_NUMBER",
  "JSON_AGG",
  "JSON_BUILD_OBJECT",
];

export const SQL_SNIPPETS = [
  { label: "SELECT", value: "SELECT * FROM ${1:table_name} LIMIT 10;" },
  { label: "INSERT", value: "INSERT INTO ${1:table_name} (${2:columns})\nVALUES (${3:values});" },
  { label: "UPDATE", value: "UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};" },
  { label: "DELETE", value: "DELETE FROM ${1:table_name}\nWHERE ${2:condition};" },
  { label: "JOIN", value: "SELECT ${1:*}\nFROM ${2:table1} t1\nJOIN ${3:table2} t2 ON t1.${4:id} = t2.${5:t1_id};" },
  {
    label: "WITH",
    value: "WITH ${1:cte_name} AS (\n  SELECT ${2:*}\n  FROM ${3:table_name}\n)\nSELECT * FROM ${1:cte_name};",
  },
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

export const KEYWORD_ITEMS: PrecomputedItem[] = SQL_KEYWORDS.map((kw) => ({
  label: kw,
  labelLower: kw.toLowerCase(),
  kind: 17, // CompletionItemKind.Keyword
  insertText: kw,
  detail: "SQL Keyword",
}));

export const FUNCTION_ITEMS: PrecomputedItem[] = SQL_FUNCTIONS.map((f) => ({
  label: f,
  labelLower: f.toLowerCase(),
  kind: 1, // CompletionItemKind.Function
  insertText: f + "($1)",
  insertTextRules: 4, // InsertAsSnippet
  detail: "SQL Function",
}));

export const SNIPPET_ITEMS: PrecomputedItem[] = SQL_SNIPPETS.map((s) => ({
  label: s.label,
  labelLower: s.label.toLowerCase(),
  kind: 27, // CompletionItemKind.Snippet
  insertText: s.value,
  insertTextRules: 4, // InsertAsSnippet
  detail: "SQL Snippet",
}));

// ---------------------------------------------------------------------------
// Schema completion cache type (shared with MongoDB completions)
// ---------------------------------------------------------------------------

export interface SchemaTableItem {
  label: string;
  labelLower: string;
  /** Only where the engine counted: an unmeasured count is absent, never 0 (#1397). */
  rowCount?: number;
  columnNames: string;
  /** The container path the object sits in, where the schema carried its address. */
  container?: readonly string[];
  /** The object's own segment of that address. */
  segment?: string;
  /**
   * Whether accepting the table inserts its container too: true when the container is known
   * and is not the session's default one. A bare name outside it is a name the engine does not
   * resolve, measured on PostgreSQL 18.6 as `relation "regions" does not exist` for a table of
   * a schema off the search path (#1397).
   */
  qualify?: boolean;
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
  /**
   * The connection's own identifier quoting, for the segments of an address this module
   * writes. Absent before capabilities load, and then a segment is written as it is.
   */
  quoteSegment?: (segment: string) => string;
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
  databaseType?: DatabaseType,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " "],
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

      // Monaco replaces only the current word. A qualified table suggestion must
      // match and replace the already typed qualifier as well as that word.
      const typedQualifier = line.substring(0, word.startColumn - 1).match(/((?:[\w$]+\.)+)$/)?.[1] ?? "";
      // Preserve ordinary identifiers; quote catalog names only when needed
      // to preserve case, escape special characters, or avoid keywords.
      // PostgreSQL keeps its keyword-aware quoting; every other dialect quotes through the
      // connection's capabilities, so a MySQL `e2e-other` or a SQL Server segment with a space
      // is written in a form the engine parses.
      const quoteSegment = schemaCompletionCache.quoteSegment;
      const formatSegment = (segment: string) =>
        databaseType === "postgres"
          ? formatPostgresIdentifier(segment)
          : quoteSegment === undefined
            ? segment
            : quoteSegment(segment);
      const tableItem = (table: SchemaTableItem, insertText: string, tableRange: Monaco.IRange) => ({
        label: table.label,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText,
        range: tableRange,
        // The count only where the engine measured one: "(0 rows)" for a count nobody
        // took read as an empty table (#1397).
        detail: table.rowCount === undefined ? "Table" : `Table (${table.rowCount} rows)`,
        documentation: table.columnNames,
        sortText: "2" + table.label,
      });

      // A typed qualifier that names a CONTAINER (`sales.`, `e2e_other.`, `demo.`) offers that
      // container's tables, which are inserted by their own segment because the qualifier is
      // already in the text. It is matched against the trailing segments of each table's
      // container path, so `db.sales.` and `sales.` both reach a SQL Server `[db, sales]`.
      const qualifierSegments = typedQualifier.toLowerCase().split(".").slice(0, -1);
      const inTypedContainer = (table: SchemaTableItem) => {
        const container = table.container;
        if (!container || table.segment === undefined || qualifierSegments.length > container.length) return false;
        const tail = container.slice(container.length - qualifierSegments.length);
        return tail.every((segment, index) => segment.toLowerCase() === qualifierSegments[index]);
      };
      const containerTables =
        qualifierSegments.length > 0 ? schemaCompletionCache.tableItems.filter(inTypedContainer) : [];

      const qualifiedMatch = schemaCompletionCache.tableItems.some((table) =>
        table.labelLower.startsWith(typedQualifier.toLowerCase() + prefix),
      );
      const qualifier = typedQualifier && qualifiedMatch ? typedQualifier : "";
      const tablePrefix = qualifier.toLowerCase() + prefix;
      const tableSuggestions =
        containerTables.length > 0
          ? containerTables
              .filter((table) => table.segment!.toLowerCase().startsWith(prefix))
              .map((table) => tableItem(table, formatSegment(table.segment!), range))
          : schemaCompletionCache.tableItems
              .filter((table) => (!qualifier && prefix.length < 2) || table.labelLower.startsWith(tablePrefix))
              .map((table) =>
                tableItem(
                  table,
                  // Outside the session's default container the address is the name the
                  // engine resolves; inside it the label is, as it always was.
                  table.qualify && table.container && table.segment !== undefined
                    ? [...table.container, table.segment].map(formatSegment).join(".")
                    : databaseType === "postgres"
                      ? table.label.split(".").map(formatPostgresIdentifier).join(".")
                      : table.label,
                  { ...range, startColumn: range.startColumn - qualifier.length },
                ),
              );

      // Dot-triggered: Show columns for specific table or alias
      if (lastChar === ".") {
        const textToDot = line.substring(0, position.column - 1);
        // Only PostgreSQL completions introduce quoted table names in this PR.
        // Other dialects retain their existing bare-identifier lookup.
        const quotedIdentifier =
          databaseType === "postgres" ? textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"') : undefined;
        const identifier = (quotedIdentifier ?? textToDot.match(/(\w+)\.$/)?.[1])?.toLowerCase();
        if (identifier) {
          // Helper to find columns by table name (handles schema.table format)
          const findColumns = (tableName: string) => {
            const tableNameLower = tableName.toLowerCase();
            // 1. Try exact match first
            const cols = schemaCompletionCache.columnMap.get(tableNameLower);
            if (cols) return cols;

            // 2. Try matching table name with any schema prefix
            for (const [key, value] of schemaCompletionCache.columnMap.entries()) {
              const parts = key.split(".");
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
            // The whole statement around the cursor, not only the text before it: in
            // `SELECT c. FROM e2e.customers c` the alias is defined AFTER the cursor, and a
            // read that stopped at the cursor offered nothing there (#1397). The text before
            // is everything up to the dot, as it always was; the text after runs to the
            // statement's terminator, so a later statement's aliases are not read.
            const text = model.getValue();
            const offset = model.getOffsetAt(position);
            const after = text.slice(offset);
            const terminator = after.indexOf(";");
            const statement = `${text.slice(0, offset - 1)} ${terminator < 0 ? after : after.slice(0, terminator)}`;

            const { aliases } = extractAliases(statement);
            const resolvedTableName = resolveAlias(identifier, aliases);
            columns = findColumns(resolvedTableName);
          }

          // 3. Provide column suggestions
          if (columns) {
            columns.forEach((col) => {
              suggestions.push({
                label: col.label,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.label,
                range,
                detail: `${col.type}${col.isPrimary ? " (PK)" : ""}`,
                documentation: `Column of ${col.tableName}`,
              });
            });
          }
        }
        if ((qualifier || containerTables.length > 0) && suggestions.length === 0)
          suggestions.push(...tableSuggestions);
        return { suggestions };
      }

      // General completion with lazy filtering and context awareness
      const shouldFilter = prefix.length >= 2;

      // Detect context: Are we in a position where columns make sense?
      const textBeforeCursor = line.substring(0, position.column - 1).toUpperCase();
      const isColumnContext = /\b(SELECT|WHERE|AND|OR|ON|SET|HAVING|ORDER\s+BY|GROUP\s+BY|,)\s*\w*$/i.test(
        textBeforeCursor,
      );

      // Keywords
      KEYWORD_ITEMS.forEach((item) => {
        if (!shouldFilter || item.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: item.insertText,
            range,
            detail: item.detail,
            sortText: "0" + item.label,
          });
        }
      });

      // Functions
      FUNCTION_ITEMS.forEach((item) => {
        if (!shouldFilter || item.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: item.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: item.detail,
            sortText: "1" + item.label,
          });
        }
      });

      // Tables
      suggestions.push(...tableSuggestions);

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
              sortText: "4" + colName,
            });
          }
        });
      }

      // Snippets
      SNIPPET_ITEMS.forEach((item) => {
        if (!shouldFilter || item.labelLower.startsWith(prefix)) {
          suggestions.push({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: item.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: item.detail,
            sortText: "3" + item.label,
          });
        }
      });

      return { suggestions };
    },
  });
}
