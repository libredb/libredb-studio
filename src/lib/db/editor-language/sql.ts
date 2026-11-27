import { format, type SqlLanguage, supportedDialects } from "sql-formatter";
import { registerSQLCompletionProvider } from "@/lib/editor/sql-completions";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import type { EditorLanguageCode } from "./types";

/** Whether `language` is one sql-formatter formats, one of its `supportedDialects`. */
const isSqlLanguage = (language: string): language is SqlLanguage => supportedDialects.includes(language);

/**
 * The sql-formatter language of `grammar`: its `formatterLanguage`, else `postgresql`, which every dialect used before
 * one declared its own (SF-041).
 *
 * @throws {Error} Naming the language, when sql-formatter does not format it. Admission holds a package engine's
 * formatter language to the ones Studio's own engines state, so only a grammar no declaration states reaches this.
 */
function formatterLanguageOf(grammar: SqlGrammar | undefined): SqlLanguage {
  const language = grammar?.formatterLanguage ?? "postgresql";
  if (!isSqlLanguage(language)) {
    throw new Error(`The SQL formatter language ${JSON.stringify(language)} is not one sql-formatter formats.`);
  }
  return language;
}

/**
 * The SQL formatter's options, unchanged since `QueryEditor` called it directly, except the language,
 * `formatterLanguageOf` the grammar.
 */
const formatSql = (text: string, grammar?: SqlGrammar): string =>
  format(text, {
    language: formatterLanguageOf(grammar),
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
