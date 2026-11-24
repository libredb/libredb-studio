import type * as Monaco from "monaco-editor";
import { MONGODB_JSON_COMPLETIONS } from "@/lib/db/providers/document/mongodb/editor-language";
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
import { BUNDLED_EDITOR_LANGUAGES } from "@/lib/db/engine-catalog/query-editor.generated";
import type { EditorLanguageEntry } from "@/lib/db/engine-catalog/projection";
import { registerConsoleLanguage } from "@/lib/editor/console-language";
import { JSON_EDITOR_LANGUAGE } from "./json";
import { SQL_EDITOR_LANGUAGE } from "./sql";
import type { EditorCompletionContext, EditorLanguageCode, EditorLanguageContribution } from "./types";

/**
 * Studio's code of every Monaco language a query tab renders in, each declared beside its owner, keyed by its Monaco
 * id: how the editor registers, completes and formats it, and a console dialect's grammar and routes.
 *
 * `EditorLanguage` is its key set, and the editor registers, completes and formats from these rows alone, so a new
 * language is one row here and its code beside its provider. `sql` and `json`, which Monaco ships and no one engine
 * owns, are declared in this directory, and an engine's completion source joins the shared row here. The order is the
 * order the languages register in before an editor mounts, the custom languages first, then the console dialects,
 * which no registration depends on.
 */
const EDITOR_LANGUAGE_CODE = Object.freeze({
  sql: SQL_EDITOR_LANGUAGE,
  json: Object.freeze<EditorLanguageCode>({ ...JSON_EDITOR_LANGUAGE, completions: MONGODB_JSON_COMPLETIONS }),
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
} satisfies Readonly<Record<string, EditorLanguageCode>>);

/** The Monaco language ids a query tab renders in, `QueryEditor`'s `language` prop: the keys of Studio's code. */
export type EditorLanguage = keyof typeof EDITOR_LANGUAGE_CODE;

/** Throws an error naming the first Monaco id `facts` states that `code` holds no row for. */
function refuseStatedWithoutCode(
  facts: Readonly<Record<string, EditorLanguageEntry>>,
  code: Readonly<Record<string, EditorLanguageCode>>,
): void {
  for (const monacoId of Object.keys(facts)) {
    if (!Object.hasOwn(code, monacoId)) {
      throw new Error(
        `The editor language ${JSON.stringify(monacoId)} is stated by an admitted declaration, and Studio holds no code for it.`,
      );
    }
  }
}

/** Throws an error naming `key` when its code row names another Monaco id, or its console registers under another. */
function refuseOtherIds(key: string, row: EditorLanguageCode): void {
  if (row.monacoId !== key) {
    throw new Error(
      `Studio's code for the editor language ${JSON.stringify(key)} names the Monaco id ${JSON.stringify(row.monacoId)}.`,
    );
  }
  if (row.console !== undefined && row.console.spec.id !== key) {
    throw new Error(
      `Studio's console for the editor language ${JSON.stringify(key)} registers under ${JSON.stringify(row.console.spec.id)}, not its Monaco id.`,
    );
  }
}

/**
 * The facts `facts` states for the language `key`, refusing by name a language no declaration states and a console
 * that `facts` and the code row disagree on.
 */
function statedFactsOf(
  facts: Readonly<Record<string, EditorLanguageEntry>>,
  key: string,
  row: EditorLanguageCode,
): EditorLanguageEntry {
  if (!Object.hasOwn(facts, key)) {
    throw new Error(
      `Studio holds the editor language ${JSON.stringify(key)}, and no admitted declaration states its accent.`,
    );
  }
  const stated = facts[key];
  if (stated.console && row.console === undefined) {
    throw new Error(
      `The editor language ${JSON.stringify(key)} is stated as a console dialect, and Studio's code for it registers none.`,
    );
  }
  if (!stated.console && row.console !== undefined) {
    throw new Error(
      `The editor language ${JSON.stringify(key)} is stated as no console dialect, and Studio's code for it registers one.`,
    );
  }
  return stated;
}

/**
 * Each language of Studio's `code`, in the code's order, composed with the accent the admitted declarations state for
 * it in `facts` (docs/providers/CONTRACT.md, clause M-77): each row frozen, the code's own functions and console as
 * they are. There is no default: every language must have both its code and its stated facts.
 *
 * @throws {Error} Before answering, naming the language: for a language `facts` states that `code` holds no row for, a
 * code row whose Monaco id is not its key, a console registering under another id than its key, a code row no
 * declaration states, and a console the declarations state that the code does not register, or the reverse.
 */
export function composeEditorLanguages<Id extends string>(
  facts: Readonly<Record<string, EditorLanguageEntry>>,
  code: Readonly<Record<Id, EditorLanguageCode>>,
): Readonly<Record<Id, Readonly<EditorLanguageContribution>>> {
  refuseStatedWithoutCode(facts, code);
  const rows = Object.entries<EditorLanguageCode>(code).map(([key, row]) => {
    refuseOtherIds(key, row);
    const { accent } = statedFactsOf(facts, key, row);
    return [key, Object.freeze<EditorLanguageContribution>({ ...row, accent })] as const;
  });
  return Object.freeze(Object.fromEntries(rows)) as Readonly<Record<Id, Readonly<EditorLanguageContribution>>>;
}

/**
 * Every Monaco language a query tab renders in, keyed by its Monaco id: Studio's code of each, composed when this module
 * loads with the accent and console the admitted declarations state, projected into the generated query editor module.
 * A language either side lacks, or a console they disagree on, stops this module from loading, naming it.
 */
export const EDITOR_LANGUAGES: Readonly<Record<EditorLanguage, Readonly<EditorLanguageContribution>>> =
  composeEditorLanguages(BUNDLED_EDITOR_LANGUAGES, EDITOR_LANGUAGE_CODE);

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
