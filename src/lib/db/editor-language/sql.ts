import { format } from "sql-formatter";
import { registerSQLCompletionProvider } from "@/lib/editor/sql-completions";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import type { EditorLanguageCode } from "./types";

/**
 * The SQL formatter's options, unchanged since `QueryEditor` called it directly, except the language: the
 * grammar's `formatterLanguage`, else `postgresql`, which every dialect used before one declared its own (SF-041).
 */
const formatSql = (text: string, grammar?: SqlGrammar): string =>
  format(text, {
    language: grammar?.formatterLanguage ?? "postgresql",
    keywordCase: "upper",
    dataTypeCase: "upper",
    indentStyle: "tabularLeft",
    logicalOperatorNewline: "before",
    expressionWidth: 100,
    tabWidth: 2,
    linesBetweenQueries: 2,
  });

/**
 * SQL, the language every SQL-dialect engine's tab renders in: Monaco ships it, the shared SQL layer completes it from
 * the schema context on the connected engine's grammar, and its accent, which the declarations state in
 * `editor.language.accent`, is blue.
 */
export const SQL_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "sql",
  format: formatSql,
  completions: (monaco, context) => registerSQLCompletionProvider(monaco, context.schemaCache, context.databaseType),
});
