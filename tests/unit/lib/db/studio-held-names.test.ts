/**
 * The names Studio holds (src/lib/db/studio-held-names.ts), the tables admission and the declaration generator hold a
 * declared explain format, query dialect, query language, Monaco language and formatter language to: each is read from
 * the table of Studio's that gives the name its meaning, and every name a committed legacy declaration states is held.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { supportedDialects } from "sql-formatter";
import { EDITOR_LANGUAGES } from "@/lib/db/editor-language";
import { QUERY_LANGUAGE_TAB_TYPES } from "@/lib/db/engine-catalog/projection";
import { BUNDLED_DIALECT_EDITORS, BUNDLED_EDITOR_LANGUAGES } from "@/lib/db/engine-catalog/query-editor.generated";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import { STUDIO_HELD_NAMES } from "@/lib/db/studio-held-names";
import { EXPLAIN_FORMATS, getExplainStrategy } from "@/lib/explain";
import { type NamingEngine, unheldNamePointers } from "@/lib/provider-host/held-names";

const DECLARATIONS = path.join(import.meta.dir, "../../../../src/lib/db/engine-declarations");

const sorted = (names: Iterable<string>): string[] => [...names].sort();

describe("STUDIO_HELD_NAMES", () => {
  test("Studio's held names are its dialect rows, its editor languages, the formatter languages its declarations state, its explain strategies and its query languages' tab types", () => {
    const stated = new Set(Object.values(BUNDLED_SQL_TEXT).map((entry) => entry.grammar.formatterLanguage));
    const tabTypes: Readonly<Record<string, string>> = QUERY_LANGUAGE_TAB_TYPES;

    expect(STUDIO_HELD_NAMES.queryDialects).toEqual(Object.keys(QUERY_DIALECTS));
    expect(STUDIO_HELD_NAMES.monacoLanguages).toEqual(Object.keys(BUNDLED_EDITOR_LANGUAGES));
    expect(sorted(STUDIO_HELD_NAMES.monacoLanguages)).toEqual(sorted(Object.keys(EDITOR_LANGUAGES)));
    expect(STUDIO_HELD_NAMES.formatterLanguages).toEqual(sorted(stated));
    expect(STUDIO_HELD_NAMES.formatterLanguages.filter((name) => !supportedDialects.includes(name))).toEqual([]);
    expect(STUDIO_HELD_NAMES.explainFormats).toEqual(EXPLAIN_FORMATS);
    expect(EXPLAIN_FORMATS.length).toBeGreaterThan(0);
    expect(EXPLAIN_FORMATS.filter((format) => getExplainStrategy(format)?.format !== format)).toEqual([]);
    expect(STUDIO_HELD_NAMES.queryLanguages).toEqual(Object.keys(QUERY_LANGUAGE_TAB_TYPES));
    expect(
      STUDIO_HELD_NAMES.queryLanguages.filter((name) => !Object.hasOwn(BUNDLED_DIALECT_EDITORS, tabTypes[name] ?? "")),
    ).toEqual([]);
    expect(Object.isFrozen(STUDIO_HELD_NAMES)).toBe(true);
    for (const names of Object.values(STUDIO_HELD_NAMES)) expect(Object.isFrozen(names)).toBe(true);
  });

  test("every name a committed declaration states is one Studio holds", () => {
    const files = readdirSync(DECLARATIONS).filter((file) => file.endsWith(".json"));
    const unheld = files.flatMap((file) => {
      const declaration: NamingEngine = JSON.parse(readFileSync(path.join(DECLARATIONS, file), "utf8"));
      return unheldNamePointers(declaration, STUDIO_HELD_NAMES).map((pointer) => `${file}${pointer}`);
    });

    expect(files.length).toBeGreaterThan(40);
    expect(unheld).toEqual([]);
  });
});
