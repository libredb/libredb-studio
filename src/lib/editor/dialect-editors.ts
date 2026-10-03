import type * as Monaco from "monaco-editor";
import { format } from "sql-formatter";
import { type ConsoleLanguage, registerConsoleLanguage } from "@/lib/editor/console-language";
import type { EditorLanguage } from "@/lib/editor/tab-language";
import type { QueryTab } from "@/lib/types";

/**
 * How a tab of each type is edited: the Monaco language it renders in and the formatter behind its Format button.
 *
 * Keyed by tab type rather than by dialect, because the tab type is the value a tab persists: a restored tab
 * resolves its language from this record without the connection's capabilities. It therefore holds the tab types
 * no dialect declares too (`sql`, `mongodb`, `promql`), beside the four dialects' (`src/lib/db/query-dialects.ts`).
 */
export interface DialectEditor {
  /** The Monaco language id a tab of this type renders in. */
  readonly monacoId: EditorLanguage;
  /** What Format writes for the editor's text; absent, the tab has no Format button and the shortcut does nothing. */
  readonly format?: (text: string) => string;
  /**
   * The console language a console dialect's tab renders in: its grammar facts and its route table, which
   * `registerDialectConsoles` registers under the dialect's id before the editor mounts. Absent for every tab type
   * that is not a console.
   */
  readonly console?: ConsoleLanguage;
}

/** The SQL formatter's options, unchanged since `QueryEditor` called it directly. */
const formatSql = (text: string): string =>
  format(text, {
    language: "postgresql",
    keywordCase: "upper",
    dataTypeCase: "upper",
    indentStyle: "tabularLeft",
    logicalOperatorNewline: "before",
    expressionWidth: 100,
    tabWidth: 2,
    linesBetweenQueries: 2,
  });

/**
 * JSON formatting, for MongoDB queries and Kafka read requests alike. A read request is read from `JSON.parse`'s
 * value alone, so its formatted text reads as the typed one (#1088). Text that is not JSON throws, and the editor
 * leaves it as written.
 */
const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

/**
 * Every tab type's editor, as `editorLanguageForTabType` and `QueryEditor` read it. Kafka's read request renders in
 * Monaco's built-in `json` mode and registers no language of its own (#1088); PromQL, Redis, LibreDB and etcd have
 * no formatter, because the SQL formatter rewrites their text (`up == 0` became `up = = 0`, #1085).
 */
export const DIALECT_EDITORS: Readonly<Record<QueryTab["type"], DialectEditor>> = Object.freeze({
  sql: Object.freeze({ monacoId: "sql", format: formatSql }),
  mongodb: Object.freeze({ monacoId: "json", format: formatJson }),
  libredb: Object.freeze({ monacoId: "libredb" }),
  redis: Object.freeze({ monacoId: "redis" }),
  promql: Object.freeze({ monacoId: "promql" }),
  kafka: Object.freeze({ monacoId: "json", format: formatJson }),
  etcd: Object.freeze({ monacoId: "etcd" }),
  // Cypher declares a language and no dialect, as PromQL does, and has no formatter: no Format for a Cypher tab
  // (Neo4j spec 6.5). `graph-cypher` and not `cypher`, which Monaco's own bundle registers.
  cypher: Object.freeze({ monacoId: "graph-cypher" }),
});

/**
 * The formatter of the tab types that render in `language`, which is all `QueryEditor` is told.
 *
 * Tab types that share a Monaco id share its formatter (MongoDB and Kafka both format as JSON), and a test holds
 * every record to that, so the answer does not depend on which of them is asked about.
 */
export function formatterForLanguage(language: EditorLanguage): ((text: string) => string) | undefined {
  return Object.values(DIALECT_EDITORS).find((editor) => editor.monacoId === language && editor.format)?.format;
}

/**
 * Register the console language of every record that carries one, before an editor mounts (`QueryEditor`'s
 * `handleBeforeMount`). Each registration is idempotent, so every mount may call this; the records are the only
 * input, so no reader branches on a dialect to reach its console.
 */
export function registerDialectConsoles(
  monaco: typeof Monaco,
  editors: Readonly<Record<string, Pick<DialectEditor, "console">>> = DIALECT_EDITORS,
): void {
  for (const editor of Object.values(editors)) {
    if (editor.console !== undefined) registerConsoleLanguage(monaco, editor.console);
  }
}
