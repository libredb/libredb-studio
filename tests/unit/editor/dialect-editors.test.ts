import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import type { ConsoleLanguage } from "@/lib/editor/console-language";
import { formatConsole } from "@/lib/db/console/format";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";
import { QDRANT_CONSOLE, QDRANT_ROUTES as QDRANT_ROUTES_REAL } from "@/lib/db/providers/vector/qdrant/routes";
import { DIALECT_EDITORS, formatterForLanguage, registerDialectConsoles } from "@/lib/editor/dialect-editors";
import type { EditorLanguage } from "@/lib/editor/tab-language";
import { QDRANT_ROUTES, QDRANT_STAND_IN } from "../../helpers/console-stand-ins";

const EDITOR_LANGUAGES: readonly EditorLanguage[] = [
  "sql",
  "json",
  "libredb",
  "redis",
  "promql",
  "etcd",
  "graph-cypher",
  "milvus",
  "qdrant",
  "influxql",
  "oxia",
  "s3",
];

describe("DIALECT_EDITORS", () => {
  test("holds one record per tab type, the dialect-less ones included", () => {
    expect(Object.keys(DIALECT_EDITORS).sort()).toEqual([
      "cypher",
      "etcd",
      "influxql",
      "kafka",
      "libredb",
      "milvus",
      "mongodb",
      "oxia",
      "promql",
      "qdrant",
      "redis",
      "s3",
      "sql",
    ]);
  });

  test("each tab type renders in the Monaco language it rendered in before the registry", () => {
    const monacoIds = Object.fromEntries(
      Object.entries(DIALECT_EDITORS).map(([type, editor]) => [type, editor.monacoId]),
    );
    expect(monacoIds).toEqual({
      sql: "sql",
      mongodb: "json",
      libredb: "libredb",
      redis: "redis",
      promql: "promql",
      kafka: "json",
      etcd: "etcd",
      cypher: "graph-cypher",
      milvus: "milvus",
      qdrant: "qdrant",
      influxql: "influxql",
      oxia: "oxia",
      s3: "s3",
    });
  });

  test("only the SQL tab, the two JSON tabs and the Milvus and Qdrant consoles have a formatter", () => {
    const formatted = Object.entries(DIALECT_EDITORS)
      .filter(([, editor]) => editor.format !== undefined)
      .map(([type]) => type)
      .sort();
    expect(formatted).toEqual(["kafka", "milvus", "mongodb", "qdrant", "sql"]);
  });

  test("tab types that render in one Monaco language share one formatter, or all have none", () => {
    // formatterForLanguage answers by Monaco id, which is all QueryEditor is told, so two tab types in one id
    // with different formatters would make the Format button's answer depend on which record is found first.
    for (const language of EDITOR_LANGUAGES) {
      const formats = new Set(
        Object.values(DIALECT_EDITORS)
          .filter((editor) => editor.monacoId === language)
          .map((editor) => editor.format),
      );
      expect(formats.size, `the tab types rendering in ${language} disagree about their formatter`).toBe(1);
    }
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DIALECT_EDITORS)).toBe(true);
  });

  test("freezes every record too, so no reader can change a tab type's language or formatter at run time", () => {
    for (const [tabType, editor] of Object.entries(DIALECT_EDITORS)) {
      expect(Object.isFrozen(editor), `the ${tabType} record is mutable`).toBe(true);
    }
  });
});

describe("the formatters", () => {
  test("SQL formats with the options QueryEditor always passed sql-formatter", () => {
    expect(DIALECT_EDITORS.sql.format?.("select id, name from users where id = 1 and name = 'a'")).toBe(
      "SELECT    id,\n          name\nFROM      users\nWHERE     id = 1\nAND       name = 'a'",
    );
  });

  test("a MongoDB query and a Kafka read request format as two-space JSON", () => {
    const typed = '{"topic":"orders","partition":0,"from":"earliest","limit":50}';
    const expected = '{\n  "topic": "orders",\n  "partition": 0,\n  "from": "earliest",\n  "limit": 50\n}';
    expect(DIALECT_EDITORS.kafka.format?.(typed)).toBe(expected);
    expect(DIALECT_EDITORS.mongodb.format?.(typed)).toBe(expected);
  });

  test("text that is not JSON throws, so the editor leaves it as written", () => {
    expect(() => DIALECT_EDITORS.mongodb.format?.("{ not json")).toThrow(SyntaxError);
  });
});

describe("formatterForLanguage", () => {
  test("answers each Monaco language's formatter, and none for a language without one", () => {
    expect(formatterForLanguage("sql")).toBe(DIALECT_EDITORS.sql.format);
    expect(formatterForLanguage("json")).toBe(DIALECT_EDITORS.mongodb.format);
    for (const language of ["libredb", "redis", "promql", "etcd", "graph-cypher", "influxql"] as const) {
      expect(formatterForLanguage(language)).toBeUndefined();
    }
  });
});

describe("the console field", () => {
  test("the Milvus and Qdrant records carry their console languages, and no other record carries one", () => {
    const carrying = Object.entries(DIALECT_EDITORS)
      .filter(([, editor]) => editor.console !== undefined)
      .map(([tabType]) => tabType);
    expect(carrying).toEqual(["milvus", "qdrant"]);
    expect(DIALECT_EDITORS.milvus.console?.spec).toBe(MILVUS_CONSOLE);
    expect(DIALECT_EDITORS.milvus.console?.routes).toBe(MILVUS_ROUTES);
    expect(DIALECT_EDITORS.qdrant.console?.spec).toBe(QDRANT_CONSOLE);
    expect(DIALECT_EDITORS.qdrant.console?.routes).toBe(QDRANT_ROUTES_REAL);
  });

  test("a milvus tab formats through formatConsole bound to MILVUS_CONSOLE", () => {
    const text = 'POST /v2/vectordb/entities/query\n{"collectionName":"docs_int64","limit":10}';
    expect(DIALECT_EDITORS.milvus.format?.(text)).toBe(formatConsole(MILVUS_CONSOLE, text));
    expect(formatterForLanguage("milvus")?.(text)).toBe(formatConsole(MILVUS_CONSOLE, text));
  });

  test("a qdrant tab formats through formatConsole bound to QDRANT_CONSOLE", () => {
    const text = 'POST /collections/docs/points/scroll\n{"limit":1,"with_payload":true}';
    expect(DIALECT_EDITORS.qdrant.format?.(text)).toBe(formatConsole(QDRANT_CONSOLE, text));
    expect(formatterForLanguage("qdrant")?.(text)).toBe(formatConsole(QDRANT_CONSOLE, text));
  });
});

describe("registerDialectConsoles", () => {
  /** A Monaco that records the ids it registers, answering the registered ones back as `getLanguages` does. */
  function recordingMonaco() {
    const registered: { id: string }[] = [];
    const monaco = {
      languages: {
        getLanguages: () => registered,
        register: (language: { id: string }) => registered.push(language),
        setTokensProvider: () => ({ dispose: () => {} }),
        setLanguageConfiguration: () => ({ dispose: () => {} }),
        registerCompletionItemProvider: () => ({ dispose: () => {} }),
        CompletionItemKind: { Value: 13 },
      },
    } as unknown as typeof Monaco;
    return { monaco, registered };
  }

  const synthetic = (id: string): ConsoleLanguage => ({ spec: { ...QDRANT_STAND_IN, id }, routes: QDRANT_ROUTES });

  test("registers each record's console language once, and skips the records that carry none", () => {
    const { monaco, registered } = recordingMonaco();
    const editors = {
      first: { console: synthetic("first-console") },
      plain: {},
      second: { console: synthetic("second-console") },
    };
    registerDialectConsoles(monaco, editors);
    registerDialectConsoles(monaco, editors);
    expect(registered.map((language) => language.id)).toEqual(["first-console", "second-console"]);
  });

  test("registers the Milvus and Qdrant console languages for the shipped records, once each", () => {
    const { monaco, registered } = recordingMonaco();
    registerDialectConsoles(monaco);
    registerDialectConsoles(monaco);
    expect(registered.map((language) => language.id)).toEqual(["milvus", "qdrant"]);
  });
});
