import type * as Monaco from "monaco-editor";
import { format } from "sql-formatter";
import { formatConsole } from "@/lib/db/console/format";
import { MTC_CONSOLE_DIALECT, MTC_CONSOLE_ROUTES } from "@/lib/db/providers/industrial/mtconnect/routes";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";
import { WEAVIATE_CONSOLE, WEAVIATE_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import { type ConsoleLanguage, registerConsoleLanguage } from "@/lib/editor/console-language";
import type { EditorLanguage } from "@/lib/editor/tab-language";
import type { SqlGrammar } from "@/lib/sql/grammar";
import type { QueryTab } from "@/lib/types";

/**
 * How a tab of each type is edited: the Monaco language it renders in and the formatter behind its Format button.
 *
 * Keyed by tab type rather than by dialect, because the tab type is the value a tab persists: a restored tab
 * resolves its language from this record without the connection's capabilities. It therefore holds the tab types
 * no dialect declares too (`sql`, `mongodb`, `promql`), beside the seven dialects' (`src/lib/db/query-dialects.ts`).
 */
export interface DialectEditor {
  /** The Monaco language id a tab of this type renders in. */
  readonly monacoId: EditorLanguage;
  /**
   * What Format writes for the editor's text; absent, the tab has no Format button and the shortcut does nothing.
   * `grammar` is the connection's SQL grammar, which the SQL formatter reads its language from; the others ignore it.
   */
  readonly format?: (text: string, grammar?: SqlGrammar) => string;
  /**
   * The console language a console dialect's tab renders in: its grammar facts and its route table, which
   * `registerDialectConsoles` registers under the dialect's id before the editor mounts. Absent for every tab type
   * that is not a console.
   */
  readonly console?: ConsoleLanguage;
}

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
 * JSON formatting, for MongoDB queries and Kafka read requests alike. A read request is read from `JSON.parse`'s
 * value alone, so its formatted text reads as the typed one (#1088). Text that is not JSON throws, and the editor
 * leaves it as written.
 */
const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

/** The Milvus console: its dialect and its route table, which register the Monaco language `milvus` (3.5, 5.4). */
const MILVUS_CONSOLE_LANGUAGE: ConsoleLanguage = Object.freeze({ spec: MILVUS_CONSOLE, routes: MILVUS_ROUTES });

/** The Qdrant console: its dialect and its route table, which register the Monaco language `qdrant` (3.5, 6.4). */
const QDRANT_CONSOLE_LANGUAGE: ConsoleLanguage = Object.freeze({ spec: QDRANT_CONSOLE, routes: QDRANT_ROUTES });

/** The Weaviate console: its dialect and its route table, which register the Monaco language `weaviate` (#1566 3.4). */
const WEAVIATE_CONSOLE_LANGUAGE: ConsoleLanguage = Object.freeze({ spec: WEAVIATE_CONSOLE, routes: WEAVIATE_ROUTES });

/**
 * MTConnect's request line, drawn by the shared console over the route table the guard runs.
 *
 * `MTC_CONSOLE_ROUTES` is derived from that table rather than written again, so the editor cannot
 * offer a route or a query key the provider refuses (#1722).
 */
const MTCONNECT_CONSOLE_LANGUAGE: ConsoleLanguage = Object.freeze({
  spec: MTC_CONSOLE_DIALECT,
  routes: MTC_CONSOLE_ROUTES,
});

/**
 * Every tab type's editor, as `editorLanguageForTabType` and `QueryEditor` read it. Kafka's read request renders in
 * Monaco's built-in `json` mode and registers no language of its own (#1088); PromQL, Redis, LibreDB and etcd have
 * no formatter, because the SQL formatter rewrites their text (`up == 0` became `up = = 0`, #1085). Milvus and
 * Qdrant each render in their own console language and format through the console formatter (vector-family spec
 * 3.4, 5.7, 6.7). InfluxQL renders in its own language over the provider's lexer and has no formatter (InfluxDB spec
 * I12).
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
  // A Milvus request renders in its own console language, which `registerDialectConsoles` registers from this
  // record, and formats through the console formatter, which keeps every literal's bytes (vector-family spec 3.4, 5.7).
  milvus: Object.freeze({
    monacoId: "milvus",
    format: (text: string) => formatConsole(MILVUS_CONSOLE, text),
    console: MILVUS_CONSOLE_LANGUAGE,
  }),
  // A Qdrant request renders in its own console language, which `registerDialectConsoles` registers from this
  // record, and formats through the console formatter, which keeps every literal's bytes (vector-family spec 3.4, 6.7).
  qdrant: Object.freeze({
    monacoId: "qdrant",
    format: (text: string) => formatConsole(QDRANT_CONSOLE, text),
    console: QDRANT_CONSOLE_LANGUAGE,
  }),
  // A Weaviate request renders in its own console language and formats through the console formatter, as Qdrant's.
  weaviate: Object.freeze({
    monacoId: "weaviate",
    format: (text: string) => formatConsole(WEAVIATE_CONSOLE, text),
    console: WEAVIATE_CONSOLE_LANGUAGE,
  }),
  // InfluxQL declares a language and no dialect, as PromQL and Cypher do, and has no formatter: no Format for an
  // InfluxQL tab (InfluxDB spec I12).
  influxql: Object.freeze({ monacoId: "influxql" }),
  // An Oxia command line renders in the language `oxia-language.ts` registers over the provider's own lexer, and has
  // no formatter: the SQL formatter rewrites a command line, and the console formatter is the HTTP grammar's (SB2-4.5).
  oxia: Object.freeze({ monacoId: "oxia" }),
  // An S3 command line renders in the language `s3-language.ts` registers over the console's own lexer, and has no
  // formatter: the SQL formatter rewrites a command line, Oxia's reason.
  s3: Object.freeze({ monacoId: "s3" }),
  // MQTT has no console at all: `query()` throws, so nothing is ever typed in this tab. The entry exists because
  // the record is exhaustive over tab types, and it declares the shared `json` formatter rather than none because
  // the gate holds every tab type rendering in one language to one formatter: `json` is Kafka's language too, and
  // a reader pressing Format in two json tabs must not get two different answers.
  mqtt: Object.freeze({ monacoId: "json", format: formatJson }),
  // A Firestore statement renders in the `firestore` language `firestore-language.ts` registers, and has no formatter:
  // the JSON formatter refuses a call chain and the SQL formatter rewrites one.
  firestore: Object.freeze({ monacoId: "firestore" }),
  // A RabbitMQ read request is one JSON object, Kafka's language, so it takes the shared `json` formatter: the gate
  // holds every tab type rendering in one language to one formatter.
  rabbitmq: Object.freeze({ monacoId: "json", format: formatJson }),
  // A kubectl statement renders in the `kubectl` language the console's lexer registers, and has no formatter: the
  // SQL formatter rewrites a command line, and the console formatter is the HTTP grammar's.
  kubectl: Object.freeze({ monacoId: "kubectl" }),
  // An OPC UA read request is JSON, so the tab renders in `json` and takes the shared JSON formatter.
  // `json` is Kafka's language too, and the gate holds every tab type rendering in one language to one
  // formatter: a reader pressing Format in two json tabs must not get two different answers.
  opcua: Object.freeze({ monacoId: "json", format: formatJson }),
  // An MTConnect request line renders in its own console language, which `registerDialectConsoles` registers from
  // this record, and has NO FORMATTER: the console formatter is the HTTP grammar's, which writes a method, a route
  // and a JSON body, and this dialect has no body at all. The SQL and JSON formatters both rewrite a URL line.
  mtconnect: Object.freeze({ monacoId: "mtconnect", console: MTCONNECT_CONSOLE_LANGUAGE }),
  // One JSON read request, so Monaco's built-in `json` mode and the JSON formatter, as Kafka's.
  modbus: Object.freeze({ monacoId: "json", format: formatJson }),
  // language is XML, and a reader never types any, so no XML editor is registered here.
  netconf: Object.freeze({ monacoId: "json", format: formatJson }),
  snmp: Object.freeze({ monacoId: "json", format: formatJson }),
  // A Sparkplug read request is a JSON object, as MQTT's and OPC UA's are, so it renders in `json` and
  // Format is the JSON formatter. No console language of its own: the request names a group, an edge node and
  // a window rather than a route, so there is no grammar or route table to register (#1720).
  sparkplug: Object.freeze({ monacoId: "json", format: formatJson }),
});

/**
 * The formatter of the tab types that render in `language`, which is all `QueryEditor` is told.
 *
 * Tab types that share a Monaco id share its formatter (MongoDB and Kafka both format as JSON), and a test holds
 * every record to that, so the answer does not depend on which of them is asked about.
 */
export function formatterForLanguage(language: EditorLanguage): DialectEditor["format"] {
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
