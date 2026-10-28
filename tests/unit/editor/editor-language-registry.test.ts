/**
 * The editor language registry: every language a query tab renders in, each a contribution its owner declares, and
 * what the editor registers, completes, formats and tints from them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as Monaco from "monaco-editor";
import { formatConsole } from "@/lib/db/console/format";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import {
  EDITOR_LANGUAGES,
  type EditorLanguage,
  formatterForLanguage,
  registerEditorCompletions,
  registerEditorLanguages,
} from "@/lib/db/editor-language";
import type { EditorCompletionContext, EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { MTC_CONSOLE_DIALECT, MTC_CONSOLE_ROUTES } from "@/lib/db/providers/industrial/mtconnect/routes";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";
import { QDRANT_CONSOLE, QDRANT_ROUTES as QDRANT_ROUTES_REAL } from "@/lib/db/providers/vector/qdrant/routes";
import { WEAVIATE_CONSOLE, WEAVIATE_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { EditorLanguage as TabEditorLanguage } from "@/lib/editor/tab-language";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { QDRANT_ROUTES, QDRANT_STAND_IN } from "../../helpers/console-stand-ins";

/** True only where the two types are the same type, checked by the compiler in `bun run typecheck`. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A Monaco that records each language id it registers and each language a completion source registers for. */
function recordingMonaco() {
  const registered: { id: string }[] = [];
  const completions: string[] = [];
  const languages = {
    getLanguages: () => registered,
    register: (language: { id: string }) => registered.push(language),
    setTokensProvider: () => ({ dispose: () => {} }),
    setMonarchTokensProvider: () => ({ dispose: () => {} }),
    setLanguageConfiguration: () => ({ dispose: () => {} }),
    registerCompletionItemProvider: (language: string) => {
      completions.push(language);
      return { dispose: () => {} };
    },
    CompletionItemKind: new Proxy({}, { get: () => 1 }),
    CompletionItemInsertTextRule: new Proxy({}, { get: () => 4 }),
  };
  return { monaco: { languages } as unknown as typeof Monaco, registered, completions };
}

const EMPTY_CONTEXT: EditorCompletionContext = {
  schemaCache: { tableItems: [], columnMap: new Map(), allColumns: new Map() },
  schemaObjects: [],
};

describe("EDITOR_LANGUAGES", () => {
  test("the derived language types are the registry's key set", () => {
    const fromRegistry: Equal<EditorLanguage, keyof typeof EDITOR_LANGUAGES> = true;
    const fromTabLanguage: Equal<TabEditorLanguage, keyof typeof EDITOR_LANGUAGES> = true;
    expect([fromRegistry, fromTabLanguage]).toEqual([true, true]);
  });

  test("holds the sixteen languages a tab renders in, each keyed by its own Monaco id", () => {
    expect(Object.keys(EDITOR_LANGUAGES)).toEqual([
      "sql",
      "json",
      "libredb",
      "redis",
      "promql",
      "etcd",
      "oxia",
      "s3",
      "kubectl",
      "firestore",
      "graph-cypher",
      "influxql",
      "milvus",
      "qdrant",
      "weaviate",
      "mtconnect",
    ]);
    for (const [key, language] of Object.entries(EDITOR_LANGUAGES)) expect(language.monacoId).toBe(key);
  });

  test("is frozen, and so is every row", () => {
    expect(Object.isFrozen(EDITOR_LANGUAGES)).toBe(true);
    for (const [key, language] of Object.entries(EDITOR_LANGUAGES)) {
      expect(Object.isFrozen(language), `the ${key} row is mutable`).toBe(true);
    }
  });

  test("each language takes an accent of its own, and none is a status hue", () => {
    const accents = Object.values(EDITOR_LANGUAGES).map((language) => language.accent);
    expect(new Set(accents).size).toBe(accents.length);
    for (const accent of accents) {
      expect(accent).toMatch(/^border-hue-[a-z]+(-alt)?\/40$/);
      expect(accent).not.toMatch(/amber|rose|emerald/);
    }
  });

  test("each language keeps the accent it had before the registry", () => {
    expect(Object.fromEntries(Object.entries(EDITOR_LANGUAGES).map(([key, row]) => [key, row.accent]))).toEqual({
      sql: "border-hue-blue/40",
      json: "border-hue-cyan/40",
      redis: "border-hue-fuchsia/40",
      libredb: "border-hue-violet/40",
      promql: "border-hue-indigo/40",
      etcd: "border-hue-sky/40",
      "graph-cypher": "border-hue-purple/40",
      milvus: "border-hue-teal/40",
      qdrant: "border-hue-pink/40",
      weaviate: "border-hue-lime-alt/40",
      influxql: "border-hue-green/40",
      oxia: "border-hue-purple-alt/40",
      s3: "border-hue-indigo-alt/40",
      kubectl: "border-hue-teal-alt/40",
      firestore: "border-hue-pink-alt/40",
      mtconnect: "border-hue-slate-alt/40",
    });
  });
});

describe("the formatters", () => {
  test("only SQL, JSON and the Milvus, Qdrant and Weaviate consoles have a formatter", () => {
    const formatted = Object.entries(EDITOR_LANGUAGES)
      .filter(([, language]) => language.format !== undefined)
      .map(([key]) => key);
    expect(formatted).toEqual(["sql", "json", "milvus", "qdrant", "weaviate"]);
  });

  test("SQL formats with the options QueryEditor always passed sql-formatter", () => {
    expect(formatterForLanguage("sql")?.("select id, name from users where id = 1 and name = 'a'")).toBe(
      "SELECT    id,\n          name\nFROM      users\nWHERE     id = 1\nAND       name = 'a'",
    );
  });

  // SF-041: formatted as PostgreSQL, QUALIFY was lower-cased and joined to the GROUP BY list.
  test("SQL on Snowflake's grammar formats QUALIFY as a clause of its own", () => {
    const typed =
      "select p.pid,p.name,count(*) from d_parent p join d_child c on c.pid=p.pid where p.pid>1 group by 1,2 qualify row_number() over (order by p.pid)<=5 order by 1";
    const formatted = formatterForLanguage("sql")?.(typed, resolveSqlGrammar("snowflake")) ?? "";
    expect(formatted).toContain("GROUP BY  1,\n          2\nQUALIFY   row_number()");
    expect(formatted).not.toContain(" qualify ");
    // A stage reference the PostgreSQL language broke into `@ stage` is refused instead, so the text stays as written.
    expect(() => formatterForLanguage("sql")?.("SELECT $1 FROM @stage t", resolveSqlGrammar("snowflake"))).toThrow();
  });

  test("every dialect but Snowflake formats SQL exactly as before", () => {
    const typed = "select a, b from t where a = 1 group by 1 qualify x = 1 order by 2";
    const sql = formatterForLanguage("sql");
    const before = sql?.(typed);
    for (const type of SHIPPED_DATABASE_TYPES.filter((t) => t !== "snowflake")) {
      expect(sql?.(typed, resolveSqlGrammar(type)), type).toBe(before);
    }
  });

  test("a MongoDB query and a JSON read request format as two-space JSON", () => {
    const typed = '{"topic":"orders","partition":0,"from":"earliest","limit":50}';
    const expected = '{\n  "topic": "orders",\n  "partition": 0,\n  "from": "earliest",\n  "limit": 50\n}';
    expect(formatterForLanguage("json")?.(typed)).toBe(expected);
  });

  test("text that is not JSON throws, so the editor leaves it as written", () => {
    expect(() => formatterForLanguage("json")?.("{ not json")).toThrow(SyntaxError);
  });

  test("a console request formats through formatConsole bound to its own dialect", () => {
    const weaviate = 'POST /v1/search/Article/bm25\n{"query":"vector","limit":5}';
    expect(formatterForLanguage("weaviate")?.(weaviate)).toBe(formatConsole(WEAVIATE_CONSOLE, weaviate));
    const milvus = 'POST /v2/vectordb/entities/query\n{"collectionName":"docs_int64","limit":10}';
    expect(formatterForLanguage("milvus")?.(milvus)).toBe(formatConsole(MILVUS_CONSOLE, milvus));
    const qdrant = 'POST /collections/docs/points/scroll\n{"limit":1,"with_payload":true}';
    expect(formatterForLanguage("qdrant")?.(qdrant)).toBe(formatConsole(QDRANT_CONSOLE, qdrant));
  });

  test("answers none for a language without one, and for an id that is no key", () => {
    for (const language of ["libredb", "redis", "promql", "etcd", "graph-cypher", "influxql", "mtconnect"] as const) {
      expect(formatterForLanguage(language)).toBeUndefined();
    }
    expect(formatterForLanguage("not-a-language" as EditorLanguage)).toBeUndefined();
    expect(formatterForLanguage("toString" as EditorLanguage)).toBeUndefined();
  });
});

describe("the console field", () => {
  test("the four console rows carry their console languages, and no other row carries one", () => {
    const carrying = Object.entries(EDITOR_LANGUAGES)
      .filter(([, language]) => language.console !== undefined)
      .map(([key]) => key);
    expect(carrying).toEqual(["milvus", "qdrant", "weaviate", "mtconnect"]);
    // MTConnect's routes are DERIVED from the table its guard runs, so the identity checked here is
    // that the row carries that derived table and not a second hand-written one (#1722).
    expect(EDITOR_LANGUAGES.mtconnect.console?.spec).toBe(MTC_CONSOLE_DIALECT);
    expect(EDITOR_LANGUAGES.mtconnect.console?.routes).toBe(MTC_CONSOLE_ROUTES);
    expect(EDITOR_LANGUAGES.milvus.console?.spec).toBe(MILVUS_CONSOLE);
    expect(EDITOR_LANGUAGES.milvus.console?.routes).toBe(MILVUS_ROUTES);
    expect(EDITOR_LANGUAGES.qdrant.console?.spec).toBe(QDRANT_CONSOLE);
    expect(EDITOR_LANGUAGES.qdrant.console?.routes).toBe(QDRANT_ROUTES_REAL);
    expect(EDITOR_LANGUAGES.weaviate.console?.spec).toBe(WEAVIATE_CONSOLE);
    expect(EDITOR_LANGUAGES.weaviate.console?.routes).toBe(WEAVIATE_ROUTES);
  });
});

describe("registerEditorLanguages", () => {
  test("registers each row's language and console once, and skips a row that carries neither", () => {
    const { monaco, registered } = recordingMonaco();
    const rows: Record<string, EditorLanguageContribution> = {
      first: {
        monacoId: "first",
        console: { spec: { ...QDRANT_STAND_IN, id: "first-console" }, routes: QDRANT_ROUTES },
        accent: "a",
      },
      plain: { monacoId: "plain", accent: "b" },
      custom: {
        monacoId: "custom",
        register: (m) => {
          if (!m.languages.getLanguages().some((language) => language.id === "custom")) {
            m.languages.register({ id: "custom" });
          }
        },
        accent: "c",
      },
    };
    registerEditorLanguages(monaco, rows);
    registerEditorLanguages(monaco, rows);
    expect(registered.map((language) => language.id)).toEqual(["first-console", "custom"]);
  });

  test("registers the shipped languages Monaco does not ship, in the registry's order, once each", () => {
    const { monaco, registered } = recordingMonaco();
    registerEditorLanguages(monaco);
    registerEditorLanguages(monaco);
    expect(registered.map((language) => language.id)).toEqual([
      "libredb",
      "redis",
      "promql",
      "etcd",
      "oxia",
      "s3",
      "kubectl",
      "firestore",
      "graph-cypher",
      "influxql",
      "milvus",
      "qdrant",
      "weaviate",
      "mtconnect",
    ]);
  });
});

describe("the json row", () => {
  test("is declared in the shared layer, and MongoDB contributes its completion source alone", async () => {
    const { JSON_EDITOR_LANGUAGE } = await import("@/lib/db/editor-language/json");
    const { MONGODB_JSON_COMPLETIONS } = await import("@/lib/db/providers/document/mongodb/editor-language");
    // Format and the accent are the shared row's: every JSON read request (Kafka's, MQTT's, the industrial engines')
    // formats through it, so no engine's module may change them.
    expect(EDITOR_LANGUAGES.json.format).toBe(JSON_EDITOR_LANGUAGE.format);
    expect(EDITOR_LANGUAGES.json.accent).toBe(JSON_EDITOR_LANGUAGE.accent);
    expect(JSON_EDITOR_LANGUAGE.completions).toBeUndefined();
    expect(EDITOR_LANGUAGES.json.completions).toBe(MONGODB_JSON_COMPLETIONS);
  });

  test("the shared json row imports no provider module", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "..", "src/lib/db/editor-language/json.ts"), "utf8");
    expect(text).not.toMatch(/providers\//);
  });
});

describe("registerEditorCompletions", () => {
  const MONGO: ProviderCapabilities = { queryLanguage: "json" } as ProviderCapabilities;
  const KAFKA: ProviderCapabilities = { queryLanguage: "json", queryDialect: "kafka" } as ProviderCapabilities;

  test("registers each completing language's source for that language alone", () => {
    for (const language of ["sql", "graph-cypher", "influxql", "s3", "firestore"] as const) {
      const { monaco, completions } = recordingMonaco();
      const disposable = registerEditorCompletions(monaco, language, { ...EMPTY_CONTEXT, databaseType: "neo4j" });
      expect(disposable, language).toBeDefined();
      expect(completions).toEqual([language]);
    }
  });

  test("registers MongoDB's JSON source where no dialect is declared, and none for a JSON read request", () => {
    const mongo = recordingMonaco();
    expect(registerEditorCompletions(mongo.monaco, "json", { ...EMPTY_CONTEXT, capabilities: MONGO })).toBeDefined();
    expect(mongo.completions).toEqual(["json"]);

    const bare = recordingMonaco();
    expect(registerEditorCompletions(bare.monaco, "json", EMPTY_CONTEXT)).toBeDefined();
    expect(bare.completions).toEqual(["json"]);

    const kafka = recordingMonaco();
    expect(registerEditorCompletions(kafka.monaco, "json", { ...EMPTY_CONTEXT, capabilities: KAFKA })).toBeUndefined();
    expect(kafka.completions).toEqual([]);
  });

  test("registers nothing for a language without a source, nor for an id that is no key", () => {
    const { monaco, completions } = recordingMonaco();
    for (const language of ["libredb", "redis", "promql", "etcd", "oxia", "kubectl", "milvus", "mtconnect"] as const) {
      expect(registerEditorCompletions(monaco, language, EMPTY_CONTEXT)).toBeUndefined();
    }
    expect(registerEditorCompletions(monaco, "toString" as EditorLanguage, EMPTY_CONTEXT)).toBeUndefined();
    expect(completions).toEqual([]);
  });
});
