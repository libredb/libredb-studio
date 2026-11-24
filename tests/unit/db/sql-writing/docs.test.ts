import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import * as EXPORT_SHARED from "@/lib/db/sql-writing/export-shared";
import * as SHARED from "@/lib/db/sql-writing/shared";
import type { DatabaseType } from "@/lib/types";
import { ENGINE_MODULES, ROOT, TYPED_LITERAL_MODULES } from "./engine-modules";

/**
 * Each provider doc says how a generated statement spells that engine's literals, names and
 * binds, so the doc and the engine's declaration cannot drift (the provider triad).
 *
 * The `SQL writing` subsection links the engine's declaration, where its `sqlWriting` is
 * stated, and names, by function name, the literal writer and reader, the identifier form
 * and the placeholder form Studio's SQL writing function table binds for it. A `null`
 * placeholder is named as "no placeholder", and a temporal form, where one exists, by its
 * field name.
 *
 * It also names `inlineEdit` and each of its key-column type name lists by field. A
 * `boundEdit`, where one exists, is named too, and so is an `insertDocuments`.
 *
 * And it names `export`: the binary literal form by function name, each data fact by its
 * field name, `insertForm` where the engine writes `INSERT ... SELECT`, every export hook
 * the engine defines by field name, each module beside the provider that holds one of the
 * engine's own functions, and the engine's `typed-literals` sibling by its path, where it
 * has one.
 */
const HEADING = /^(#{2,4}) (?:\d+(?:\.\d+)*\.? +)?SQL writing$/gm;

function subsection(doc: string): string | undefined {
  const matches = [...doc.matchAll(HEADING)];
  if (matches.length !== 1) return undefined;
  const [match] = matches as [RegExpExecArray];
  const level = (match[1] as string).length;
  const rest = doc.slice((match.index as number) + match[0].length);
  const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Each engine's SQL writing subsection, read once. */
const SECTIONS = new Map(
  (Object.keys(SQL_WRITING) as DatabaseType[]).map((type) => [
    type,
    subsection(readFileSync(join(ROOT, "docs", "providers", `${type}.md`), "utf8")),
  ]),
);

const modulePaths = (type: string): string[] =>
  ENGINE_MODULES.filter((engine) => engine.id === type).map(({ repoPath }) => repoPath);
const siblingPath = new Map(TYPED_LITERAL_MODULES.map((sibling) => [sibling.ownerId, sibling.repoPath]));
const DATA_FACTS = [
  "instantTypeNames",
  "exactDecimalTypeNames",
  "float64TypeNames",
  "ddlTypes",
  "standsAlone",
  "bareSpelling",
  "nonFinite",
] as const;
const EXPORT_HOOKS = [
  "typedLiteral",
  "rewriteDeclared",
  "declareFromSample",
  "columnWriters",
  "createTableKey",
] as const;

/**
 * A name a doc could cite as an SQL writing constant: an engine's row constant, or a name of the shape the shared
 * building blocks' tables and sets take.
 */
const CONSTANT_SHAPE =
  /^[A-Z][A-Z0-9_]*(?:_SQL_WRITING|_TYPE_NAMES|_NON_FINITE|_STAND_ALONE|_STANDS_ALONE|_FLOAT64|_SPELLING|_DDL_TYPES|_TYPE_VOCABULARY|_TYPE_FAMILY)$/;

/** The constants the shared building blocks and the engines' own function modules export. */
const EXPORTED = new Set([...Object.keys(SHARED), ...Object.keys(EXPORT_SHARED)]);

describe("provider docs name their SQL writing rules", () => {
  for (const type of Object.keys(SQL_WRITING) as DatabaseType[]) {
    const spec = SQL_WRITING[type];
    test(`${type}: one SQL writing subsection naming the declaration and the functions Studio binds`, () => {
      const section = SECTIONS.get(type);
      expect(section).toBeDefined();
      const text = section as string;
      expect(text).toContain(`../../src/lib/db/engine-declarations/${type}.json`);
      expect(text).toContain("`sqlWriting`");
      for (const path of modulePaths(type))
        expect({ type, path, linked: text.includes(`../../${path}`) }).toEqual({ type, path, linked: true });
      expect(text).toContain(`\`${spec.escapeLiteral.name}\``);
      expect(text).toContain(`\`${spec.unescapeLiteral.name}\``);
      expect(text).toContain(`\`${spec.quoteIdentifier.name}\``);
      if (spec.placeholder === null) {
        expect(text).toContain("no placeholder");
      } else {
        expect(text).toContain(`\`${spec.placeholder.name}\``);
      }
      if (spec.temporalLiteral !== null) expect(text).toContain("`temporalLiteral`");
      if (spec.insertDocuments !== undefined) expect(text).toContain("`insertDocuments`");
      expect(text).toContain("`inlineEdit`");
      if (spec.inlineEdit.boundEdit !== undefined) expect(text).toContain("`boundEdit`");

      expect(text).toContain("`export`");
      const facts = spec.export;
      expect(text).toContain(`\`${facts.binaryLiteral.name}\``);
      for (const field of DATA_FACTS)
        expect({ type, field, named: text.includes(`\`${field}\``) }).toEqual({ type, field, named: true });
      if (facts.insertForm === "select") expect(text).toContain("`insertForm`");
      for (const hook of EXPORT_HOOKS) {
        if (facts[hook] !== undefined) expect(text).toContain(`\`${hook}\``);
      }
      const sibling = siblingPath.get(type);
      if (sibling !== undefined) expect(text).toContain(`../../${sibling}`);
    });
  }

  test("every SQL writing module and constant a doc cites exists, so no doc cites one the declarations replaced", () => {
    const stale: string[] = [];
    for (const [type, section] of SECTIONS) {
      const text = section ?? "";
      for (const [, path] of text.matchAll(/\]\(\.\.\/\.\.\/(src\/lib\/db\/[^)#]+)\)/g)) {
        if (!existsSync(join(ROOT, path))) stale.push(`${type}: ${path}`);
      }
      const own = new Set(
        ENGINE_MODULES.filter((engine) => engine.id === type).flatMap(({ exportNames }) => exportNames),
      );
      for (const [, name] of text.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
        if (CONSTANT_SHAPE.test(name) && !EXPORTED.has(name) && !own.has(name)) stale.push(`${type}: ${name}`);
      }
    }
    expect(stale).toEqual([]);
    // Vacuity: the shape reads the names the docs cite, and the link reader reads the links.
    expect(CONSTANT_SHAPE.test("NULL_NON_FINITE")).toBe(true);
    expect(CONSTANT_SHAPE.test("POSTGRES_SQL_WRITING")).toBe(true);
    expect(CONSTANT_SHAPE.test("NO_INSTANT_TYPE_NAMES")).toBe(true);
    expect(EXPORTED.has("NO_INSTANT_TYPE_NAMES")).toBe(false);
  });
});
