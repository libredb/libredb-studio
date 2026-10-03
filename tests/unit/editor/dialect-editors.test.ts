import { describe, expect, test } from "bun:test";
import { DIALECT_EDITORS, formatterForLanguage } from "@/lib/editor/dialect-editors";
import type { EditorLanguage } from "@/lib/editor/tab-language";

const EDITOR_LANGUAGES: readonly EditorLanguage[] = ["sql", "json", "libredb", "redis", "promql", "etcd"];

describe("DIALECT_EDITORS", () => {
  test("holds one record per tab type, the dialect-less ones included", () => {
    expect(Object.keys(DIALECT_EDITORS).sort()).toEqual([
      "etcd",
      "kafka",
      "libredb",
      "mongodb",
      "promql",
      "redis",
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
    });
  });

  test("only the SQL tab and the two JSON tabs have a formatter", () => {
    const formatted = Object.entries(DIALECT_EDITORS)
      .filter(([, editor]) => editor.format !== undefined)
      .map(([type]) => type)
      .sort();
    expect(formatted).toEqual(["kafka", "mongodb", "sql"]);
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
    for (const language of ["libredb", "redis", "promql", "etcd"] as const) {
      expect(formatterForLanguage(language)).toBeUndefined();
    }
  });
});
