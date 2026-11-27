/**
 * The exit of milestone M3 of the provider plugins program: no module of Studio's `src/` keeps a hand-written grant
 * record or grant projection keyed by engine id. Until then, every such record or projection core still exports is on
 * `CORE_GRANT_RECORDS`, a closed list, each entry with the changes that remove it: an item of M3 (issue #2557 and its
 * siblings), or, for a projection a browser module reads, milestone M7 and those readers, and, for a function the legacy
 * adapter reads too, milestone M18, which deletes the legacy adapter, and that reader.
 *
 * The list is `CORE_GRANT_RECORDS` (tests/helpers/core-grant-records.ts). A record is found two ways:
 * - every entry of the engine table inventory (tests/unit/db/engine-declarations/inventory.ts) whose destination is a
 *   claim table, `REVIEW_RECORD_PHRASE`, or a granted table, `GRANTED_DESTINATION`;
 * - by name, `UNINVENTORIED_GRANT_RECORDS`, the records the inventory cannot see or classifies otherwise: a list of
 *   engine ids and a function answering a legacy engine's grants by id.
 * A detected record the list does not name fails by name, and so does an entry whose module no longer exports its name
 * or a reader file that does not exist or does not import the name.
 *
 * The readers are a closed set too: a module of src or vscode-extension/src whose value inputs (`valueInputs`,
 * tests/helpers/value-inputs.ts) hold a listed name from a specifier resolving to the entry's module is one of that
 * entry's readers, or it fails by module and input. A namespace import, an `export *`, or an `import()` or `require()`
 * of an entry's module reaches every name it exports, so it fails for every module. A re-export of a listed name, by
 * `export ... from` or by a local `export { ... }` or `export default` of its imported binding, fails for every module,
 * a reader included, since a module importing the name from the reader would read it outside the set. A type-only
 * import and a side-effect import read no name, and a name the list does not hold passes. Test files stay outside the
 * set: none is tracked under either root. A computed `import()` names no module the scan can resolve; under src, the
 * census tests/security/kubernetes-access-callers.test.ts refuses one that has no allowance.
 *
 * The list may only shrink. A new record keyed by engine id raises the isolation ratchet's `engineKeyedTypePositions`,
 * and a new list of engine ids its `coreHandwritten.linesNamingAnEngine`, both gate counters that only fall, so an
 * addition is refused there; a change that turns an entry into a browser projection replaces it one for one.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  CLAIM_GRANTS,
  CORE_GRANT_RECORDS,
  type GrantRecordEntry,
  type RemovedBy,
} from "../../helpers/core-grant-records";
import { trackedFiles } from "../../helpers/repo-text-scope";
import { moduleOf, valueInputs } from "../../helpers/value-inputs";
import { ENGINE_TABLE_INVENTORY, GRANTED_DESTINATION, REVIEW_RECORD_PHRASE } from "./engine-declarations/inventory";

const ROOT = path.resolve(import.meta.dir, "../../..");

const COMPATIBILITY = "src/lib/db/compatibility.ts";

/** The grant records the engine table inventory cannot see or classifies otherwise, each with why. */
const UNINVENTORIED_GRANT_RECORDS: readonly (Pick<GrantRecordEntry, "module" | "name"> & { readonly why: string })[] = [
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_EXECUTION_ENGINES",
    why: "a list of engine ids, not a table keyed by engine",
  },
  {
    module: CLAIM_GRANTS,
    name: "legacyEngineGrants",
    why: "a function answering a legacy engine's grants by id, which the browser's confirmation gate and the legacy adapter's record composer call",
  },
];

function key(entry: { readonly module: string; readonly name: string }): string {
  return `${entry.module} ${entry.name}`;
}

/** Whether `module` exports a value declaration or a function declaration named `name`. */
function exportsName(module: string, name: string): boolean {
  const file = path.join(ROOT, module);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
  const exported = (statement: ts.VariableStatement | ts.FunctionDeclaration) =>
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  return source.statements.some(
    (statement) =>
      (ts.isVariableStatement(statement) &&
        exported(statement) &&
        statement.declarationList.declarations.some((declaration) => declaration.name.getText(source) === name)) ||
      (ts.isFunctionDeclaration(statement) && exported(statement) && statement.name?.text === name),
  );
}

/** Every reader of `entry`, over all its removals. */
function readersOf(entry: GrantRecordEntry): readonly string[] {
  return entry.removedBy.flatMap((removal) => ("readers" in removal ? removal.readers : []));
}

/** Whether `module` imports `name` by an import declaration, a type-only one excepted. */
function importsName(module: string, name: string): boolean {
  const file = path.join(ROOT, module);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const kind = module.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true, kind);
  return source.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name)
    );
  });
}

/** The roots whose modules the importer set is read over. */
const IMPORTER_ROOTS = ["src/", "vscode-extension/src/"] as const;

/** A JavaScript or TypeScript module, as `moduleOf` strips its extension. */
const MODULE_FILE = /\.(c|m)?(t|j)sx?$/;

/** Every tracked module of `IMPORTER_ROOTS`, with its text. */
function sourceModules(): ReadonlyMap<string, string> {
  return new Map(
    trackedFiles(ROOT)
      .filter((file) => IMPORTER_ROOTS.some((root) => file.startsWith(root)) && MODULE_FILE.test(file))
      .map((file) => [file, readFileSync(path.join(ROOT, file), "utf8")]),
  );
}

/** An `import()` or `require()` call, as `valueInputs` writes its input. */
const LOAD_CALL = /^(import|require)\s*\(/;

/** The module of each listed entry, as `moduleOf` writes it. */
const LISTED_MODULES: ReadonlySet<string> = new Set(CORE_GRANT_RECORDS.map((entry) => moduleOf(entry.module)));

/** The last path segment of each listed module, `claim-grants` for src/lib/db/claim-grants.ts. */
const LISTED_BASENAMES: readonly string[] = [
  ...new Set([...LISTED_MODULES].map((module) => path.posix.basename(module))),
];

/**
 * Whether `file` can hold an input resolving to a listed module, so only those modules are parsed: parsing every module
 * of both roots under coverage instrumentation outruns bun's default test timeout. An input resolves to a listed module
 * only when that module's last segment is a segment of the specifier, `@/...` or relative, or else a directory segment
 * of `file`'s own path that a relative specifier climbs back to, such as `.` or `./index`. So a module whose text
 * and path both lack every listed basename holds no such input, and skipping it changes no answer. The text is read as
 * written: a specifier spelling the basename with an escape sequence is not seen.
 */
function mayNameListedModule(file: string, text: string): boolean {
  return LISTED_BASENAMES.some((basename) => text.includes(basename) || file.includes(basename));
}

/**
 * Every value input of `modules` from the module of a listed entry: `<file> imports <input>`, or `<file> re-exports
 * <input>` for one the module exports again. Each input carries the name it reads, `*` for one that reaches every
 * name, or the call that loads the module whole.
 */
function listedModuleInputs(
  modules: ReadonlyMap<string, string>,
): readonly { readonly file: string; readonly name: string; readonly exported: boolean; readonly line: string }[] {
  return [...modules].flatMap(([file, text]) =>
    (mayNameListedModule(file, text) ? valueInputs(file, text) : [])
      .filter(({ module }) => module !== null && LISTED_MODULES.has(module))
      .map(({ input, exported }) => ({
        file,
        name: LOAD_CALL.test(input) ? "*" : input.slice(0, input.indexOf(" from ")),
        exported,
        line: `${file} ${exported ? "re-exports" : "imports"} ${input}`,
      })),
  );
}

/**
 * Each value input of `modules` that reads a listed name without its module being one of that entry's readers, each
 * that re-exports a listed name, a reader's included, and each that reaches every name of a listed entry's module, a
 * namespace import, an `export *`, an `import()` or a `require()`, sorted. A name the list does not hold passes.
 */
function unlistedImporters(modules: ReadonlyMap<string, string>): readonly string[] {
  return listedModuleInputs(modules)
    .filter(
      ({ file, name, exported }) =>
        name === "*" ||
        CORE_GRANT_RECORDS.some((entry) => entry.name === name && (exported || !readersOf(entry).includes(file))),
    )
    .map(({ line }) => line)
    .sort();
}

describe("the exit of M3", () => {
  test("every module of src exporting a grant record or projection keyed by engine id is on the closed list, each with the item or the browser reader and milestone that removes it", () => {
    const detected = [
      ...ENGINE_TABLE_INVENTORY.filter(
        (entry) => entry.destination.includes(REVIEW_RECORD_PHRASE) || entry.destination === GRANTED_DESTINATION,
      ),
      ...UNINVENTORIED_GRANT_RECORDS,
    ];
    const listed = new Set(CORE_GRANT_RECORDS.map(key));

    expect(detected.filter((entry) => !listed.has(key(entry))).map(key)).toEqual([]);
    expect(new Set(detected.map(key)).size).toBe(CORE_GRANT_RECORDS.length);
    expect(listed.size).toBe(CORE_GRANT_RECORDS.length);
    expect(CORE_GRANT_RECORDS.filter((entry) => !exportsName(entry.module, entry.name)).map(key)).toEqual([]);
    for (const entry of CORE_GRANT_RECORDS) {
      for (const removal of entry.removedBy) {
        if ("readers" in removal) expect(removal.readers.length).toBeGreaterThan(0);
      }
      for (const reader of readersOf(entry)) {
        expect({ entry: key(entry), reader, imports: importsName(reader, entry.name) }).toEqual({
          entry: key(entry),
          reader,
          imports: true,
        });
      }
    }
  });

  test("the inventory finds every claim table and granted table it records, and the list counts each item's records", () => {
    const claimTables = ENGINE_TABLE_INVENTORY.filter((entry) => entry.destination.includes(REVIEW_RECORD_PHRASE));
    const grantedTables = ENGINE_TABLE_INVENTORY.filter((entry) => entry.destination === GRANTED_DESTINATION);
    const count = (removed: (removal: RemovedBy) => boolean) =>
      CORE_GRANT_RECORDS.filter((entry) => entry.removedBy.some(removed)).length;

    expect(claimTables).toHaveLength(0);
    expect(grantedTables).toHaveLength(4);
    expect(count((removal) => "item" in removal && removal.item === 4)).toBe(0);
    expect(count((removal) => "milestone" in removal && removal.milestone === "M7")).toBe(6);
    expect(count((removal) => "milestone" in removal && removal.milestone === "M18")).toBe(1);
  });

  test("the list's checks fail by name on a stale entry, a module that does not export the name and a reader that does not import it", () => {
    expect(exportsName(COMPATIBILITY, "SHIPPED_DATABASE_TYPES")).toBe(true);
    expect(exportsName(COMPATIBILITY, "NOT_A_RECORD")).toBe(false);
    expect(exportsName(CLAIM_GRANTS, "legacyEngineGrants")).toBe(true);
    expect(exportsName(CLAIM_GRANTS, "grantTables")).toBe(false);
    expect(exportsName("src/lib/db/absent-module.ts", "WRITE_REACH")).toBe(false);
    expect(importsName("src/components/read-only-marker.tsx", "GRANTED_WRITE_REACH")).toBe(true);
    expect(importsName("src/components/read-only-marker.tsx", "GRANTED_SSH_TUNNEL_REFUSAL")).toBe(false);
    expect(importsName("src/components/absent.tsx", "GRANTED_WRITE_REACH")).toBe(false);
  });

  test("no module of src or vscode-extension/src imports a listed grant name unless the list names it as that entry's reader", () => {
    const modules = sourceModules();
    const planted = (file: string, text: string) => unlistedImporters(new Map([[file, text]]));
    const from = "@/lib/db/claim-grants";

    expect(unlistedImporters(modules)).toEqual([]);

    // Each planted module answers exactly its own input, by module and name; none is written to disk.
    expect(planted("src/lib/planted-grants.ts", `import { legacyEngineGrants } from "${from}";`)).toEqual([
      `src/lib/planted-grants.ts imports legacyEngineGrants from ${from}`,
    ]);
    // A relative specifier resolves, and an aliased binding is named by its exported name.
    expect(
      planted("src/lib/sql/planted-grants.ts", 'import { GRANTED_WRITE_REACH as reach } from "../db/claim-grants";'),
    ).toEqual(["src/lib/sql/planted-grants.ts imports GRANTED_WRITE_REACH from ../db/claim-grants"]);
    // Only a module naming a listed module's basename is parsed: a relative load names it in its text, and `.` written
    // in a directory named for it names it by the path of the module that writes it.
    expect(planted("src/lib/db/planted-grants.ts", 'const grants = require("./claim-grants");')).toEqual([
      'src/lib/db/planted-grants.ts imports require("./claim-grants")',
    ]);
    expect(planted("src/lib/db/claim-grants/planted-grants.ts", 'import { legacyEngineGrants } from ".";')).toEqual([
      "src/lib/db/claim-grants/planted-grants.ts imports legacyEngineGrants from .",
    ]);
    expect(
      planted("vscode-extension/src/planted-grants.ts", `import { GRANTED_AGENT_READINGS } from "${from}";`),
    ).toEqual([`vscode-extension/src/planted-grants.ts imports GRANTED_AGENT_READINGS from ${from}`]);
    // A reader of one entry is not a reader of another.
    const marker = "src/components/read-only-marker.tsx";
    expect(
      planted(marker, `import { GRANTED_SSH_TUNNEL_REFUSAL } from "${from}";\n${modules.get(marker) ?? ""}`),
    ).toEqual([`${marker} imports GRANTED_SSH_TUNNEL_REFUSAL from ${from}`]);
    expect(planted("src/lib/planted-grants.ts", `export { legacyEngineGrants } from "${from}";`)).toEqual([
      `src/lib/planted-grants.ts re-exports legacyEngineGrants from ${from}`,
    ]);
    // A form that reaches every name of the module is refused for every module, a reader included.
    expect(planted(marker, `import * as grants from "${from}";`)).toEqual([`${marker} imports * from ${from}`]);
    expect(planted("src/lib/planted-grants.ts", `export * from "${from}";`)).toEqual([
      `src/lib/planted-grants.ts re-exports * from ${from}`,
    ]);
    expect(planted("src/lib/planted-grants.ts", `const grants = await import("${from}");`)).toEqual([
      `src/lib/planted-grants.ts imports import("${from}")`,
    ]);
    // A type-only import, a name the list does not hold and a listed name from another module read no listed name.
    expect(planted("src/lib/planted-grants.ts", `import type { EngineGrants } from "${from}";`)).toEqual([]);
    expect(planted("src/lib/planted-grants.ts", `import { grantEngineClaims } from "${from}";`)).toEqual([]);
    expect(planted("src/lib/planted-grants.ts", 'import { legacyEngineGrants } from "./elsewhere";')).toEqual([]);

    // Vacuity: the scan over the tree finds every reader's import of its listed name, the .tsx readers included.
    const listedNames = new Set(CORE_GRANT_RECORDS.map((entry) => entry.name));
    const found = listedModuleInputs(modules).filter(({ name }) => listedNames.has(name));
    expect(found).toHaveLength(12);
    expect(new Set(found.map(({ file }) => file)).size).toBe(10);
    for (const entry of CORE_GRANT_RECORDS) {
      for (const reader of readersOf(entry)) {
        expect(found.some(({ file, name }) => file === reader && name === entry.name)).toBe(true);
      }
    }
  });

  test("no module of src or vscode-extension/src re-exports a listed grant name, a reader included, so the importer set stays closed past a reader", () => {
    const modules = sourceModules();
    const from = "@/lib/db/claim-grants";
    const reader = "src/lib/sql/dangerous-query.ts";
    const readerText = modules.get(reader) ?? "";
    // A module importing the name from the reader: it reads no listed module, so the reader's re-export is what fails.
    const importer = [
      "src/lib/planted-grants.ts",
      'import { legacyEngineGrants } from "@/lib/sql/dangerous-query";',
    ] as const;
    const planted = (text: string) => unlistedImporters(new Map([[reader, text], importer]));

    expect(readerText).toContain(`import { legacyEngineGrants } from "${from}";`);
    expect(planted(readerText)).toEqual([]);

    // Each form answers the reader and the name; the planted modules are never written to disk.
    expect(planted(`${readerText}\nexport { legacyEngineGrants } from "${from}";`)).toEqual([
      `${reader} re-exports legacyEngineGrants from ${from}`,
    ]);
    expect(planted(`${readerText}\nexport { legacyEngineGrants as engineGrants } from "../db/claim-grants";`)).toEqual([
      `${reader} re-exports legacyEngineGrants from ../db/claim-grants`,
    ]);
    expect(planted(`${readerText}\nexport { legacyEngineGrants };`)).toEqual([
      `${reader} re-exports legacyEngineGrants from ${from}`,
    ]);
    expect(planted(`${readerText}\nexport default legacyEngineGrants;`)).toEqual([
      `${reader} re-exports legacyEngineGrants from ${from}`,
    ]);
    expect(
      planted(`import { legacyEngineGrants as grants } from "${from}";\nexport { grants as engineGrants };`),
    ).toEqual([`${reader} re-exports legacyEngineGrants from ${from}`]);
    expect(planted(`${readerText}\nexport * from "${from}";`)).toEqual([`${reader} re-exports * from ${from}`]);
    // A type-only re-export loads nothing, and a local export of another binding re-exports no listed name.
    expect(planted(`${readerText}\nexport type { EngineGrants } from "${from}";`)).toEqual([]);
    expect(planted(`${readerText}\nexport { type EngineGrants };`)).toEqual([]);
  });
});
