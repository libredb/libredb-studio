/**
 * A workspace package imports only what it declares, and core reaches a package only by its name
 * (packages/README.md, "Imports"; docs/providers/CONTRACT.md, clause M-17).
 *
 * A package's source and tests import their own files, Node built-ins, the names their `package.json` declares and
 * `@libredb/provider-sdk`; its tests may also import a Bun runtime module such as `bun:test`. Nothing in a package
 * imports an `@/` path or climbs out of its directory, so a package never depends on another package's internals or on
 * Studio's, and moving it to a repository of its own changes no import. Core (`src/`, `bin/`, `scripts/`, `tests/`,
 * `e2e/` and `vscode-extension/src/`) never reaches into `packages/` by path, so what core sees of a package is what
 * its `exports` publish.
 *
 * Specifiers are read with the scanner of `tests/unit/lib/db/provider-imports/scan.ts` (the TypeScript compiler's
 * `preProcessFile`), so a path in a comment or a string is never one. Inward, only core files whose text contains
 * `packages/` are parsed: a relative specifier that reaches the directory names it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { workspacePackageManifests } from "../../scripts/workspace-packages.mjs";
import { plantedRoot, REPOSITORY_ROOT, removePlantedRoot } from "../helpers/planted-package";
import { isSourcePath, moduleSpecifiers } from "./lib/db/provider-imports/scan";

const SDK = "@libredb/provider-sdk";
const CORE_ROOTS = ["src", "bin", "scripts", "tests", "e2e", "vscode-extension/src"];

/** Every source file under `directory` of `root`, as sorted repository-relative POSIX paths; none when it is absent. */
function sourceFilesUnder(root: string, directory: string): string[] {
  if (!existsSync(path.join(root, directory))) return [];
  return readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isSourcePath(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !file.split("/").includes("node_modules"))
    .sort();
}

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

/** Why `specifier` in package file `file` breaks the package import rule, or null when it keeps it. */
function packageSpecifierFailure(
  file: string,
  specifier: string,
  directory: string,
  declared: ReadonlySet<string>,
): string | null {
  const isTest = file.startsWith(`${directory}/tests/`);
  if (specifier.startsWith("/")) return `${file} imports "${specifier}", a path out of ${directory}`;
  if (specifier.startsWith(".")) {
    const target = path.posix.join(path.posix.dirname(file), specifier);
    return target.startsWith(`${directory}/`) ? null : `${file} imports "${specifier}", a path out of ${directory}`;
  }
  if (specifier.startsWith("@/")) return `${file} imports "${specifier}", a path into Studio's own source`;
  if (specifier.startsWith("bun:")) {
    return isTest ? null : `${file} imports "${specifier}", a Bun runtime module, outside the package's tests`;
  }
  // After the Bun check: under Bun, isBuiltin answers true for a bun: module too.
  if (specifier.startsWith("node:") || isBuiltin(specifier)) return null;
  const name = packageNameOf(specifier);
  if (name === SDK || declared.has(name)) return null;
  return `${file} imports "${specifier}", which ${directory}/package.json does not declare`;
}

/** Every breach of the package import rule under `root`, sorted. */
function packageImportFailures(root: string): string[] {
  const failures: string[] = [];
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    const declared = new Set(
      ["dependencies", "peerDependencies", "devDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {})),
    );
    for (const file of [
      ...sourceFilesUnder(root, `${directory}/src`),
      ...sourceFilesUnder(root, `${directory}/tests`),
    ]) {
      for (const specifier of moduleSpecifiers(readFileSync(path.join(root, file), "utf8"))) {
        const failure = packageSpecifierFailure(file, specifier, directory, declared);
        if (failure !== null) failures.push(failure);
      }
    }
  }
  return failures.sort();
}

/** Every core file under `root` that reaches into `packages/` by path, sorted. */
function inwardPathFailures(root: string): string[] {
  const failures: string[] = [];
  for (const file of CORE_ROOTS.flatMap((directory) => sourceFilesUnder(root, directory))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!text.includes("packages/")) continue;
    for (const specifier of moduleSpecifiers(text)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (target === "packages" || target.startsWith("packages/")) {
        failures.push(`${file} imports "${specifier}", reaching a workspace package by path: import it by its name`);
      }
    }
  }
  return failures.sort();
}

describe("the package import rule", () => {
  test("the repository's packages import only what they declare", () => {
    expect(workspacePackageManifests(REPOSITORY_ROOT).length).toBeGreaterThan(0);
    expect(packageImportFailures(REPOSITORY_ROOT)).toEqual([]);
  });

  test("the scan reads the SDK's source and tests", () => {
    const files = [
      ...sourceFilesUnder(REPOSITORY_ROOT, "packages/provider-sdk/src"),
      ...sourceFilesUnder(REPOSITORY_ROOT, "packages/provider-sdk/tests"),
    ];

    expect(files).toContain("packages/provider-sdk/src/manifest/validate.ts");
    expect(files).toContain("packages/provider-sdk/tests/manifest/validate.test.ts");
  });

  test("core reaches no workspace package by path", () => {
    expect(inwardPathFailures(REPOSITORY_ROOT)).toEqual([]);
  });

  test("a planted package and planted core files fail by file and specifier", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-planted/package.json": JSON.stringify({
          name: "@libredb/provider-planted",
          dependencies: { ajv: "^8.17.1" },
          devDependencies: { typescript: "^6.0.3" },
        }),
        "packages/provider-planted/src/index.ts": [
          'import "./local";',
          'import "../../provider-sdk/src/manifest/validate";',
          'import "@/lib/types";',
          'import "left-pad";',
          'import Ajv from "ajv/dist/2020";',
          'import "node:fs";',
          'import "path";',
          'import "bun:sqlite";',
          `import "${SDK}/manifest";`,
          '// import "@/lib/in-a-comment";',
          "export const value = Ajv;",
        ].join("\n"),
        "packages/provider-planted/src/local.ts": "export {};\n",
        "packages/provider-planted/tests/a.test.ts": [
          'import "bun:test";',
          'import "../src/index";',
          'import "typescript";',
          'import "/opt/elsewhere/module.js";',
        ].join("\n"),
        "src/lib/a.ts": 'import "../../packages/provider-planted/src/index";\nexport const note = "packages/x";\n',
        "scripts/b.ts": 'import "../packages/provider-planted";\n',
        "tests/unit/c.test.ts": 'import "@libredb/provider-planted";\nconst where = "packages/provider-planted";\n',
        "e2e/d.ts": 'export const where = "../packages/provider-planted";\n',
      },
    });
    try {
      expect(packageImportFailures(root)).toEqual([
        'packages/provider-planted/src/index.ts imports "../../provider-sdk/src/manifest/validate", a path out of packages/provider-planted',
        'packages/provider-planted/src/index.ts imports "@/lib/types", a path into Studio\'s own source',
        'packages/provider-planted/src/index.ts imports "bun:sqlite", a Bun runtime module, outside the package\'s tests',
        'packages/provider-planted/src/index.ts imports "left-pad", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/tests/a.test.ts imports "/opt/elsewhere/module.js", a path out of packages/provider-planted',
      ]);
      expect(inwardPathFailures(root)).toEqual([
        'scripts/b.ts imports "../packages/provider-planted", reaching a workspace package by path: import it by its name',
        'src/lib/a.ts imports "../../packages/provider-planted/src/index", reaching a workspace package by path: import it by its name',
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });
});
