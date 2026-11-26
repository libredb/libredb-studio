/**
 * Governance keeps no list of type ids of its own (FND-1).
 *
 * Whether a row's engine, or an engine `GOVERNANCE_ALLOWED_ENGINES` names, names a provider is decided by the one
 * canonical check, `src/lib/db/type-id.ts`, and never by a copy of the type-id set: a copy is a second definition of
 * "a provider this Studio has", which drifts from the first the day the two are built differently.
 *
 * It reads every module under `src/lib/governance`, recursively, as text. `ALLOWED_ENGINES_DEFAULT` in `config.ts`
 * names six type ids as a policy default, which `tests/unit/lib/no-engine-branches.test.ts` lists among its
 * registries; it says which engines governance admits when the variable is unset, not which type ids name a provider.
 *
 * The scan matches names, so it sees a set built from either list `compatibility.ts` exports and a check declared
 * under the canonical name. A list built another way, such as from the keys of a per-engine table, is outside what a
 * name scan sees; the import assertion and review hold the rest.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const GOVERNANCE = "src/lib/governance";
const MODULES = readdirSync(join(ROOT, GOVERNANCE), { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts"))
  .sort()
  .map((name) => ({ path: `${GOVERNANCE}/${name}`, text: readFileSync(join(ROOT, GOVERNANCE, name), "utf8") }));

/** The two type-id lists `compatibility.ts` exports; a set built from either is a list of one's own. */
const TYPE_ID_LIST = /\b(?:SHIPPED_DATABASE_TYPES|EXTERNAL_DATABASE_TYPES)\b/g;
/** A declaration of the canonical check's name. */
const OWN_CHECK = /\b(?:const|let|var|function)\s+isDatabaseType\b/g;
const TYPE_ID_MODULE = new Set(["@/lib/db/type-id", "../db/type-id"]);

/** What a text holds that this file refuses: each list it names, and each check of its own it declares. */
const ownTypeLists = (text: string): readonly string[] => [
  ...[...text.matchAll(TYPE_ID_LIST)].map((match) => match[0]),
  ...[...text.matchAll(OWN_CHECK)].map((match) => match[0]),
];

/** The specifiers a text value-imports from: imports that are not type-only. */
const valueSpecifiers = (text: string): readonly string[] =>
  [...text.matchAll(/^import\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);

describe("governance keeps no type-id list of its own", () => {
  test("no module under src/lib/governance names a type-id list of compatibility.ts or declares an isDatabaseType", () => {
    expect(MODULES.length).toBeGreaterThan(10);
    expect(MODULES.flatMap(({ path, text }) => ownTypeLists(text).map((found) => `${path}: ${found}`))).toEqual([]);
  });

  test("row admission and the boot preflight import the canonical check from the type-id module", () => {
    for (const path of [`${GOVERNANCE}/admission.ts`, `${GOVERNANCE}/preflight.ts`]) {
      // Read by path, so a module moved away throws ENOENT naming it rather than reading as one with no import.
      const text = readFileSync(join(ROOT, path), "utf8");
      expect([path, valueSpecifiers(text).some((specifier) => TYPE_ID_MODULE.has(specifier))]).toEqual([path, true]);
    }
  });

  test("the scan sees the shapes it refuses", () => {
    const shapes = [
      'import {\n  READS_TRUST_MATERIAL,\n  SHIPPED_DATABASE_TYPES,\n} from "@/lib/db/compatibility";',
      "const KNOWN_ENGINES: ReadonlySet<string> = new Set(EXTERNAL_DATABASE_TYPES);",
      "const isDatabaseType = (engine: string): engine is DatabaseType => KNOWN_ENGINES.has(engine);",
      "function isDatabaseType(value: unknown) {}",
    ].join("\n");
    expect(ownTypeLists(shapes)).toEqual([
      "SHIPPED_DATABASE_TYPES",
      "EXTERNAL_DATABASE_TYPES",
      "const isDatabaseType",
      "function isDatabaseType",
    ]);
    expect(
      valueSpecifiers('import { isDatabaseType } from "@/lib/db/type-id";\nimport type { X } from "../db/type-id";'),
    ).toEqual(["@/lib/db/type-id"]);
  });
});
