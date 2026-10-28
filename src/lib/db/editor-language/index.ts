import type * as Monaco from "monaco-editor";
import { JSON_EDITOR_LANGUAGE } from "@/lib/db/providers/document/mongodb/editor-language";
import { FIRESTORE_EDITOR_LANGUAGE } from "@/lib/db/providers/document/firestore/editor-language";
import { LIBREDB_EDITOR_LANGUAGE } from "@/lib/db/providers/embedded/libredb-editor-language";
import { CYPHER_EDITOR_LANGUAGE } from "@/lib/db/providers/graph/neo4j/editor-language";
import { MTCONNECT_EDITOR_LANGUAGE } from "@/lib/db/providers/industrial/mtconnect/editor-language";
import { ETCD_EDITOR_LANGUAGE } from "@/lib/db/providers/keyvalue/etcd/editor-language";
import { OXIA_EDITOR_LANGUAGE } from "@/lib/db/providers/keyvalue/oxia/editor-language";
import { REDIS_EDITOR_LANGUAGE } from "@/lib/db/providers/keyvalue/redis-editor-language";
import { S3_EDITOR_LANGUAGE } from "@/lib/db/providers/objectstore/s3/editor-language";
import { KUBECTL_EDITOR_LANGUAGE } from "@/lib/db/providers/platform/kubernetes/editor-language";
import { INFLUXQL_EDITOR_LANGUAGE } from "@/lib/db/providers/timeseries/influxdb/influxql-editor-language";
import { PROMQL_EDITOR_LANGUAGE } from "@/lib/db/providers/timeseries/prometheus/editor-language";
import { MILVUS_EDITOR_LANGUAGE } from "@/lib/db/providers/vector/milvus/editor-language";
import { QDRANT_EDITOR_LANGUAGE } from "@/lib/db/providers/vector/qdrant/editor-language";
import { WEAVIATE_EDITOR_LANGUAGE } from "@/lib/db/providers/vector/weaviate/editor-language";
import { registerConsoleLanguage } from "@/lib/editor/console-language";
import { SQL_EDITOR_LANGUAGE } from "./sql";
import type { EditorCompletionContext, EditorLanguageContribution } from "./types";

/**
 * Every Monaco language a query tab renders in, each declared beside its owner, keyed by its Monaco id.
 *
 * The one list: `EditorLanguage` is its key set, a tab type's language in `DIALECT_EDITORS` must be one of its keys,
 * and the editor registers, completes, formats and tints from these rows alone, so a new language is one row here and
 * its contribution beside its provider. The order is the order the languages register in before an editor mounts:
 * the custom languages first, then the console dialects.
 */
export const EDITOR_LANGUAGES = Object.freeze({
  sql: SQL_EDITOR_LANGUAGE,
  json: JSON_EDITOR_LANGUAGE,
  libredb: LIBREDB_EDITOR_LANGUAGE,
  redis: REDIS_EDITOR_LANGUAGE,
  promql: PROMQL_EDITOR_LANGUAGE,
  etcd: ETCD_EDITOR_LANGUAGE,
  oxia: OXIA_EDITOR_LANGUAGE,
  s3: S3_EDITOR_LANGUAGE,
  kubectl: KUBECTL_EDITOR_LANGUAGE,
  firestore: FIRESTORE_EDITOR_LANGUAGE,
  "graph-cypher": CYPHER_EDITOR_LANGUAGE,
  influxql: INFLUXQL_EDITOR_LANGUAGE,
  milvus: MILVUS_EDITOR_LANGUAGE,
  qdrant: QDRANT_EDITOR_LANGUAGE,
  weaviate: WEAVIATE_EDITOR_LANGUAGE,
  mtconnect: MTCONNECT_EDITOR_LANGUAGE,
} satisfies Readonly<Record<string, EditorLanguageContribution>>);

/** The Monaco language ids a query tab renders in, `QueryEditor`'s `language` prop: the registry's keys. */
export type EditorLanguage = keyof typeof EDITOR_LANGUAGES;

/**
 * Register every language that Monaco does not ship, before an editor mounts (`QueryEditor`'s `handleBeforeMount`).
 * Each registration is idempotent, so every mount may call this; the rows are the only input, so nothing here names a
 * language.
 */
export function registerEditorLanguages(
  monaco: typeof Monaco,
  languages: Readonly<Record<string, EditorLanguageContribution>> = EDITOR_LANGUAGES,
): void {
  for (const language of Object.values(languages)) {
    language.register?.(monaco);
    if (language.console !== undefined) registerConsoleLanguage(monaco, language.console);
  }
}

/**
 * Register the completion source of an editor in `language`, or answer undefined where the language has none or the
 * context gives it nothing to complete. The caller disposes the answer when the language or the context changes.
 */
export function registerEditorCompletions(
  monaco: typeof Monaco,
  language: EditorLanguage,
  context: EditorCompletionContext,
): Monaco.IDisposable | undefined {
  return contributionOf(language)?.completions?.(monaco, context);
}

/** The formatter of `language`, or undefined where it has none: the tab then has no Format button. */
export function formatterForLanguage(language: EditorLanguage): EditorLanguageContribution["format"] {
  return contributionOf(language)?.format;
}

/**
 * The row of `language`, or undefined for an id that is not a key: a host of the published component can hand the
 * editor any string at run time, and an inherited key such as `toString` is no language either.
 */
function contributionOf(language: string): EditorLanguageContribution | undefined {
  return Object.hasOwn(EDITOR_LANGUAGES, language)
    ? (EDITOR_LANGUAGES as Readonly<Record<string, EditorLanguageContribution>>)[language]
    : undefined;
}
