/**
 * A workspace package imports only what it declares, and core reaches a package only by its name
 * (packages/README.md, "Imports"; docs/providers/CONTRACT.md, clauses M-17 and C-42).
 *
 * A package's source and tests import their own files, Node built-ins, the names their `package.json` declares and
 * `@libredb/provider-sdk`; its tests may also import a Bun runtime module such as `bun:test`. Nothing in a package
 * imports an `@/` path or climbs out of its directory, so a package never depends on another package's internals or on
 * Studio's, and moving it to a repository of its own changes no import. Core (`src/`, `bin/`, `scripts/`, `tests/`,
 * `e2e/` and `vscode-extension/src/`) never reaches into `packages/` by path, so what core sees of a package is what
 * its `exports` publish. No package but the kit depends on another provider package: the SDK alone, and the kit in a
 * package's tests and `devDependencies` only.
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
/** The provider kit, which a package's tests may import (docs/providers/CONTRACT.md, clause C-42). */
const KIT = "@libredb/provider-kit";
const CORE_ROOTS = ["src", "bin", "scripts", "tests", "e2e", "vscode-extension/src"];
/** Studio's runtime source, which never imports the SDK's testing entry (docs/providers/CONTRACT.md, clause C-18). */
const RUNTIME_ROOTS = ["src", "bin", "vscode-extension/src"];
const SDK_TESTING = `${SDK}/testing`;

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

const PROVIDER_PACKAGE_PREFIX = "@libredb/provider-";
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

/**
 * Every way a workspace package under `root` depends on another provider package, sorted (docs/providers/CONTRACT.md,
 * clause C-42): a name starting `@libredb/provider-` that its source or tests import, or that its `package.json`
 * declares, other than the SDK and its own name. The kit is admitted in a package's tests and in its `devDependencies`
 * only. The kit's own package is outside the rule, and its rule is the kit's.
 */
function providerDependenceFailures(root: string): string[] {
  const failures: string[] = [];
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    if (manifest.name === KIT) continue;
    const foreign = (name: string): boolean =>
      name.startsWith(PROVIDER_PACKAGE_PREFIX) && name !== SDK && name !== manifest.name;
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {}).filter(foreign)) {
        if (name !== KIT)
          failures.push(`${directory}/package.json declares "${name}" in ${field}, another provider package`);
        else if (field !== "devDependencies") {
          failures.push(
            `${directory}/package.json declares "${name}" in ${field}, and the kit belongs in devDependencies only`,
          );
        }
      }
    }
    for (const file of [
      ...sourceFilesUnder(root, `${directory}/src`),
      ...sourceFilesUnder(root, `${directory}/tests`),
    ]) {
      const isTest = file.startsWith(`${directory}/tests/`);
      for (const specifier of moduleSpecifiers(readFileSync(path.join(root, file), "utf8"))) {
        const name = packageNameOf(specifier);
        if (!foreign(name)) continue;
        if (name !== KIT) failures.push(`${file} imports "${specifier}", another provider package`);
        else if (!isTest) failures.push(`${file} imports "${specifier}", the kit, which only a package's tests import`);
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

/**
 * Every runtime file under `root` that imports the SDK's testing entry, in any form the scanner reads (static, `import
 * type`, `export from`, `import()` and `require()`), sorted. Only files whose text names the entry are parsed.
 */
function testingEntryFailures(root: string): string[] {
  const failures: string[] = [];
  for (const file of RUNTIME_ROOTS.flatMap((directory) => sourceFilesUnder(root, directory))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!text.includes(SDK_TESTING)) continue;
    for (const specifier of moduleSpecifiers(text)) {
      if (specifier === SDK_TESTING || specifier.startsWith(`${SDK_TESTING}/`)) {
        failures.push(`${file} imports "${specifier}", the SDK's testing entry, which only tests import`);
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

  test("Studio's runtime source never imports the SDK's testing entry", () => {
    expect(sourceFilesUnder(REPOSITORY_ROOT, "bin").length).toBeGreaterThan(0);
    expect(testingEntryFailures(REPOSITORY_ROOT)).toEqual([]);
  });

  test("a planted runtime file that imports the testing entry fails by file and specifier", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: false,
      linkNodeModules: false,
      files: {
        "src/lib/a.ts": `import { serve } from "${SDK_TESTING}";\nexport const a = serve;\n`,
        "src/lib/b.ts": `export const b = () => require("${SDK_TESTING}");\n`,
        "bin/c.ts": `import type { FrameRefusal } from "${SDK_TESTING}";\nexport type C = FrameRefusal;\n`,
        "vscode-extension/src/d.ts": `export const d = () => import("${SDK_TESTING}");\n`,
        "src/lib/e.ts": `// import "${SDK_TESTING}";\nexport const e = "${SDK_TESTING}";\n`,
        "tests/unit/f.test.ts": `import { readFrame } from "${SDK_TESTING}";\nexport const f = readFrame;\n`,
        "scripts/g.ts": `import "${SDK_TESTING}";\n`,
        "e2e/h.ts": `export * from "${SDK_TESTING}";\n`,
      },
    });
    try {
      expect(testingEntryFailures(root)).toEqual([
        `bin/c.ts imports "${SDK_TESTING}", the SDK's testing entry, which only tests import`,
        `src/lib/a.ts imports "${SDK_TESTING}", the SDK's testing entry, which only tests import`,
        `src/lib/b.ts imports "${SDK_TESTING}", the SDK's testing entry, which only tests import`,
        `vscode-extension/src/d.ts imports "${SDK_TESTING}", the SDK's testing entry, which only tests import`,
      ]);
    } finally {
      removePlantedRoot(root);
    }
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

  test("no workspace package imports or declares another provider package", () => {
    expect(providerDependenceFailures(REPOSITORY_ROOT)).toEqual([]);
  });

  test("a planted package that imports or declares another provider package fails by file and name, the kit admitted in its tests only", () => {
    const B = "@libredb/provider-b";
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-a/package.json": JSON.stringify({
          name: "@libredb/provider-a",
          dependencies: { [SDK]: "*", [B]: "*", [KIT]: "*" },
          peerDependencies: { [B]: "*" },
          optionalDependencies: { [B]: "*" },
          devDependencies: { [KIT]: "*", [B]: "*" },
        }),
        "packages/provider-a/src/index.ts": [
          `import { b } from "${B}";`,
          `import type { T } from "${B}/types";`,
          `export const later = () => import("${B}/later");`,
          `export const required = () => require("${B}/required");`,
          `import { check } from "${KIT}";`,
          `import { defineProvider } from "${SDK}/calls";`,
          'import "@libredb/provider-a/self";',
          `// import "${B}/in-a-comment";`,
          "export const value = [b, check, defineProvider];",
          "export type U = T;",
        ].join("\n"),
        "packages/provider-a/tests/a.test.ts": [
          `import { check } from "${KIT}/cases";`,
          `import "${B}/in-tests";`,
        ].join("\n"),
        "packages/provider-kit/package.json": JSON.stringify({
          name: KIT,
          dependencies: { "@libredb/provider-a": "*" },
        }),
        "packages/provider-kit/src/index.ts": 'import "@libredb/provider-a";\n',
      },
    });
    try {
      expect(providerDependenceFailures(root)).toEqual([
        `packages/provider-a/package.json declares "${B}" in dependencies, another provider package`,
        `packages/provider-a/package.json declares "${B}" in devDependencies, another provider package`,
        `packages/provider-a/package.json declares "${B}" in optionalDependencies, another provider package`,
        `packages/provider-a/package.json declares "${B}" in peerDependencies, another provider package`,
        `packages/provider-a/package.json declares "${KIT}" in dependencies, and the kit belongs in devDependencies only`,
        `packages/provider-a/src/index.ts imports "${B}", another provider package`,
        `packages/provider-a/src/index.ts imports "${B}/later", another provider package`,
        `packages/provider-a/src/index.ts imports "${B}/required", another provider package`,
        `packages/provider-a/src/index.ts imports "${B}/types", another provider package`,
        `packages/provider-a/src/index.ts imports "${KIT}", the kit, which only a package's tests import`,
        `packages/provider-a/tests/a.test.ts imports "${B}/in-tests", another provider package`,
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });
});
