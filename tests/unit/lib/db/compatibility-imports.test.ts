/**
 * `compatibility.ts` never loads the type-id module (FND-1).
 *
 * `type-id.ts` builds its set from `SHIPPED_DATABASE_TYPES` as it loads, so a value import of it from
 * `compatibility.ts` is a cycle in which whichever module loads first reads the other half-built: with the
 * compatibility module first, the set is built before `SHIPPED_DATABASE_TYPES` is initialised. So no checked accessor
 * can live in `compatibility.ts`: its tables are checked where they are read, through `typeIdRow`.
 *
 * This file imports neither module and reads `compatibility.ts` as text. A test file that imports either one cannot
 * hold this rule by name: once the import is used, that file throws the load-order `ReferenceError` as it loads and
 * registers no test at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../../../../src/lib/db/compatibility.ts"), "utf8");
const TYPE_ID_MODULE = new Set(["./type-id", "@/lib/db/type-id"]);

/** The specifiers a text loads as a value: imports and re-exports that are not type-only, bare and dynamic imports. */
const valueSpecifiers = (text: string): readonly string[] =>
  [
    ...text.matchAll(/^(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm),
    ...text.matchAll(/^import\s+"([^"]+)"/gm),
    ...text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
  ].map((match) => match[1]);

describe("the compatibility module never loads the type-id module", () => {
  test("compatibility.ts has no value import of the type-id module", () => {
    expect(
      valueSpecifiers(source).filter((specifier) => TYPE_ID_MODULE.has(specifier)),
      "compatibility.ts must not import the type-id module: loading compatibility.ts first would throw " +
        "ReferenceError: Cannot access 'SHIPPED_DATABASE_TYPES' before initialization",
    ).toEqual([]);
  });

  test("the scan sees the import shapes it refuses", () => {
    // Vacuity: the same patterns find each shape of a value import of the module, and pass over a type-only one.
    const shapes = [
      'import { isDatabaseType } from "./type-id";',
      'export { typeIdRow } from "@/lib/db/type-id";',
      'import "./type-id";',
      'const late = await import("./type-id");',
      'import type { TypeIdRefusal } from "./type-id";',
    ].join("\n");
    expect(valueSpecifiers(shapes)).toEqual(["./type-id", "@/lib/db/type-id", "./type-id", "./type-id"]);
  });
});
