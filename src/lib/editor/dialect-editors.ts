import type { EditorLanguage } from "@/lib/db/editor-language";
import type { QueryTab } from "@/lib/types";

/**
 * How a tab of each type is edited: the Monaco language it renders in. What that language registers, completes,
 * formats and tints is its contribution's, in the editor language registry (`src/lib/db/editor-language/`).
 *
 * Keyed by tab type rather than by dialect, because the tab type is the value a tab persists: a restored tab
 * resolves its language from this record without the connection's capabilities. It therefore holds the tab types
 * no dialect declares too (`sql`, `mongodb`, `promql`), beside the dialects' (`src/lib/db/query-dialects.ts`).
 */
export interface DialectEditor {
  /** The Monaco language id a tab of this type renders in, a key of the editor language registry. */
  readonly monacoId: EditorLanguage;
}

/**
 * Every tab type's language, as `editorLanguageForTabType` and `QueryEditor` read it. Kafka's read request, and every
 * other JSON read request, renders in Monaco's built-in `json` mode and registers no language of its own (#1088).
 * Tab types that render in one language share its formatter, since the formatter is the language's.
 */
export const DIALECT_EDITORS: Readonly<Record<QueryTab["type"], DialectEditor>> = Object.freeze({
  sql: Object.freeze({ monacoId: "sql" }),
  mongodb: Object.freeze({ monacoId: "json" }),
  libredb: Object.freeze({ monacoId: "libredb" }),
  redis: Object.freeze({ monacoId: "redis" }),
  promql: Object.freeze({ monacoId: "promql" }),
  kafka: Object.freeze({ monacoId: "json" }),
  etcd: Object.freeze({ monacoId: "etcd" }),
  // Cypher declares a language and no dialect, as PromQL does (Neo4j spec 6.5). `graph-cypher` and not `cypher`,
  // which Monaco's own bundle registers.
  cypher: Object.freeze({ monacoId: "graph-cypher" }),
  milvus: Object.freeze({ monacoId: "milvus" }),
  qdrant: Object.freeze({ monacoId: "qdrant" }),
  weaviate: Object.freeze({ monacoId: "weaviate" }),
  // InfluxQL declares a language and no dialect, as PromQL and Cypher do (InfluxDB spec I12).
  influxql: Object.freeze({ monacoId: "influxql" }),
  oxia: Object.freeze({ monacoId: "oxia" }),
  s3: Object.freeze({ monacoId: "s3" }),
  // MQTT has no console at all: `query()` throws, so nothing is ever typed in this tab. The entry exists because
  // the record is exhaustive over tab types, and it renders in `json` so Format answers as in every other JSON tab.
  mqtt: Object.freeze({ monacoId: "json" }),
  firestore: Object.freeze({ monacoId: "firestore" }),
  rabbitmq: Object.freeze({ monacoId: "json" }),
  kubectl: Object.freeze({ monacoId: "kubectl" }),
  opcua: Object.freeze({ monacoId: "json" }),
  mtconnect: Object.freeze({ monacoId: "mtconnect" }),
  modbus: Object.freeze({ monacoId: "json" }),
  // NETCONF's own language is XML, and a reader never types any, so no XML editor is registered here.
  netconf: Object.freeze({ monacoId: "json" }),
  snmp: Object.freeze({ monacoId: "json" }),
  // A Sparkplug read request names a group, an edge node and a window rather than a route, so there is no grammar or
  // route table to register (#1720).
  sparkplug: Object.freeze({ monacoId: "json" }),
});
