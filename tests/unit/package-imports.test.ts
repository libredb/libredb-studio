/**
 * A workspace package imports only what it declares, and core reaches a package only by its name
 * (packages/README.md, "Imports"; docs/providers/CONTRACT.md, clauses M-17 and C-42).
 *
 * Every module a package holds, outside `node_modules` (its source, its tests and the build modules its `build` script
 * runs), imports its own files, Node built-ins, the names its `package.json` declares and `@libredb/provider-sdk`; a
 * module of its tests may also import a `bun:` module such as `bun:test`. A module outside the package's `src/` and
 * `tests/` imports no `child_process`, so a build module starts no program by a specifier the rule reads; this guards
 * the repository's install, and the contract states no sentence for it. A built-in is a name of Node.js's list as
 * Studio commits it (src/lib/provider-host/node-builtins.ts), never what the running runtime serves, so `bun`, `ws` and
 * `undici`, which Bun serves as built-ins, are undeclared names. Nothing in a package imports an `@/` path or climbs
 * out of its directory, so a package never depends on another package's internals or on Studio's, and moving it to a
 * repository of its own changes no import. Core (`src/`, `bin/`, `scripts/`, `tests/`, `e2e/` and
 * `vscode-extension/src/`) never reaches into `packages/` by path, so what core sees of a package is what its `exports`
 * publish. Core never imports a provider package, by name or by path, so a provider's code reaches Studio only through
 * admission; `@libredb/provider-sdk` and `@libredb/provider-loader` are the two `@libredb/provider-` names it imports.
 * No package but the kit depends on another provider package: the SDK alone, and the kit in a package's tests and
 * `devDependencies` only, every module a package holds read as the import rule reads it.
 *
 * A package's `build` script is `node <file>` for a JavaScript module it holds outside `src/` and `tests/`, named by a
 * path of letters, digits, `.`, `_`, `-` and `/` with no `..` segment and judged against the package's listing, and
 * the package has no `prebuild` or `postbuild` script, which `bun run build` runs around it, and no `bunfig.toml` in
 * any case of its letters, which can make that `node` run Bun. So the modules a build runs are judged by the rule
 * above like the package's source, by the specifiers the scanner reads: a computed `import()` or a `createRequire`
 * call is not read, and a build module may import the package's own `src/`, where `child_process` is allowed. Nothing
 * more is claimed.
 *
 * Core imports no driver a provider package declares (the names of its `dependencies`, `optionalDependencies` and
 * `peerDependencies`, the build output check's `DRIVER_FIELDS`), so a driver leaves Studio with its engine. The one
 * exception is an entry of `CORE_IMPORTED_DRIVERS` in scripts/check-build-output.ts naming the driver and its
 * importer, the closed list the build output check reads too; an entry excuses only while the check's own
 * `exceptionProblem` passes it and a provider package declares its driver, and a stale entry fails by name.
 *
 * Specifiers are read with the scanner of `tests/unit/lib/db/provider-imports/scan.ts` (the TypeScript compiler's
 * `preProcessFile`), so a path in a comment or a string is never one. Inward, only core files whose text contains
 * `packages/` are parsed: a relative, absolute or `file:` specifier that reaches the directory names it, written with
 * forward slashes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNodeBuiltin } from "@/lib/provider-host/node-builtins";
import {
  CORE_IMPORTED_DRIVERS,
  type CoreImportedDriver,
  DRIVER_FIELDS,
  exceptionProblem,
} from "../../scripts/check-build-output";
import { providerPackageDirectories, workspacePackageManifests } from "../../scripts/workspace-packages.mjs";
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

/**
 * The built-in that starts another program. A build module outside a package's `src/` and `tests/` imports none, since
 * a program it started would be found on the workspace's `PATH`, which no import declares; a provider's own source may
 * (a driver run in a child process).
 */
const STARTS_A_PROGRAM: ReadonlySet<string> = new Set(["child_process", "node:child_process"]);

/** Why `specifier` in package file `file` breaks the package import rule, or null when it keeps it. */
function packageSpecifierFailure(
  file: string,
  specifier: string,
  directory: string,
  declared: ReadonlySet<string>,
): string | null {
  const isTest = file.startsWith(`${directory}/tests/`);
  if (!isTest && !file.startsWith(`${directory}/src/`) && STARTS_A_PROGRAM.has(specifier)) {
    return `${file} imports "${specifier}", which starts a program, outside the package's src/ and tests/: a build module starts no program`;
  }
  if (specifier.startsWith("/")) return `${file} imports "${specifier}", a path out of ${directory}`;
  if (specifier.startsWith(".")) {
    const target = path.posix.join(path.posix.dirname(file), specifier);
    return target.startsWith(`${directory}/`) ? null : `${file} imports "${specifier}", a path out of ${directory}`;
  }
  if (specifier.startsWith("@/")) return `${file} imports "${specifier}", a path into Studio's own source`;
  if (specifier.startsWith("bun:")) {
    return isTest ? null : `${file} imports "${specifier}", a Bun runtime module, outside the package's tests`;
  }
  // Node.js's list as Studio commits it, never this runtime's own check: Bun also serves `bun`, `ws` and `undici`.
  if (isNodeBuiltin(specifier)) return null;
  const name = packageNameOf(specifier);
  if (name === SDK || declared.has(name)) return null;
  return `${file} imports "${specifier}", which ${directory}/package.json does not declare`;
}

/**
 * Every breach of the package import rule under `root`, sorted. Every module of a package's directory is read, outside
 * `node_modules`: its source, its tests and the build modules its `build` script runs, a module under `tests/` judged
 * as a test and every other as source.
 */
function packageImportFailures(root: string): string[] {
  const failures: string[] = [];
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    const declared = new Set(
      ["dependencies", "peerDependencies", "devDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {})),
    );
    for (const file of sourceFilesUnder(root, directory)) {
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
 * clause C-42): a name starting `@libredb/provider-` that a module of the package imports, or that its `package.json`
 * declares, other than the SDK and its own name. The modules read are those of {@link packageImportFailures}, every
 * module outside `node_modules`, a module under `tests/` as a test and every other, a build module among them, as
 * source. The kit is admitted in a package's tests and in its `devDependencies` only. The kit's own package is outside
 * the rule, and its rule is the kit's.
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
    for (const file of sourceFilesUnder(root, directory)) {
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

/**
 * The repository-relative POSIX path a path specifier in core file `file` under `root` lands on, or null for a
 * specifier that is not a path: a relative one is read from the file's directory, an absolute one and a `file:` URL
 * from `root`, so each lands where the runtime would load it. An absolute path or URL outside `root` lands on a path
 * starting `../`, which no package directory is.
 */
function pathTarget(root: string, file: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return path.posix.join(path.posix.dirname(file), specifier);
  const absolute = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : path.isAbsolute(specifier)
      ? specifier
      : null;
  return absolute === null ? null : path.relative(root, absolute).split(path.sep).join("/");
}

/** Every core file under `root` that reaches into `packages/` by path, relative, absolute or a `file:` URL, sorted. */
function inwardPathFailures(root: string): string[] {
  const failures: string[] = [];
  for (const file of CORE_ROOTS.flatMap((directory) => sourceFilesUnder(root, directory))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!text.includes("packages/")) continue;
    for (const specifier of moduleSpecifiers(text)) {
      const target = pathTarget(root, file, specifier);
      if (target !== null && (target === "packages" || target.startsWith("packages/"))) {
        failures.push(`${file} imports "${specifier}", reaching a workspace package by path: import it by its name`);
      }
    }
  }
  return failures.sort();
}

/** The `@libredb/provider-` names core imports: the SDK, and Studio's own loader, neither of them a provider package. */
const CORE_PROVIDER_NAMES: ReadonlySet<string> = new Set([SDK, "@libredb/provider-loader"]);

/**
 * Every core file under `root` that imports a provider package, by name or by path, in any form the scanner reads
 * (static, `import type`, `export from`, `import()` and `require()`), sorted. A provider package is a directory of
 * `providerPackageDirectories`; a name is one when it is such a package's `name`, or when it starts with
 * `@libredb/provider-` and is neither the SDK nor the loader, so a provider package's conventional name is refused
 * before the package exists. A path is one when it is relative, `@/` (read as `src/`), absolute or a `file:` URL
 * ({@link pathTarget}) and lands on such a package's directory or under it. Only files whose text holds
 * `@libredb/provider-`, `packages/` or a provider package's name are parsed: a specifier of the refused kinds holds
 * one of them, a path or URL written with forward slashes.
 *
 * @throws {Error} Naming its package.json, for a provider package with no string `name`, since no import of it by
 * name could then be refused.
 */
function providerPackageImportFailures(root: string): string[] {
  const directories = providerPackageDirectories(root);
  const names = new Set(
    workspacePackageManifests(root)
      .filter(({ directory }) => directories.includes(directory))
      .map(({ directory, manifest }) => {
        if (typeof manifest.name !== "string") {
          throw new Error(
            `${directory}/package.json has no string name, so core's imports of the provider package by name cannot be refused. Give it a "name".`,
          );
        }
        return manifest.name;
      }),
  );
  const markers = [PROVIDER_PACKAGE_PREFIX, "packages/", ...names];
  const failures: string[] = [];
  for (const file of CORE_ROOTS.flatMap((directory) => sourceFilesUnder(root, directory))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!markers.some((marker) => text.includes(marker))) continue;
    for (const specifier of moduleSpecifiers(text)) {
      let refused: boolean;
      const target = specifier.startsWith("@/")
        ? path.posix.join("src", specifier.slice(2))
        : pathTarget(root, file, specifier);
      if (target !== null) {
        refused = directories.some((directory) => target === directory || target.startsWith(`${directory}/`));
      } else {
        const name = packageNameOf(specifier);
        refused = names.has(name) || (name.startsWith(PROVIDER_PACKAGE_PREFIX) && !CORE_PROVIDER_NAMES.has(name));
      }
      if (refused) {
        failures.push(`${file} imports "${specifier}", a provider package: core imports none, by name or by path`);
      }
    }
  }
  return failures.sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The one form of a `build` script: `node` and one path, the pack step's own arguments appended after it. */
const BUILD_FORM = /^node (\S+)$/;
/**
 * The characters a build path may hold: letters, digits, `.`, `_`, `-` and `/`. The pack step runs the script through
 * Bun's shell, which would read any other, such as `;`, `|`, `&`, `$`, a quote or a bracket, as shell syntax.
 */
const BUILD_PATH = /^[A-Za-z0-9._/-]+$/;
/** The extensions of a JavaScript module node runs without a loader. */
const BUILD_MODULE = /\.(mjs|js|cjs)$/;

/**
 * Why `script`, the `build` script of the package at `directory`, does not run a build module the package holds, or
 * null when it does. The path holds only the characters of {@link BUILD_PATH}, does not start with `/` and has no `..`
 * segment, so the shell reads it as one plain path. The module is judged against the package's listing (`files`, its
 * repository-relative source files), never by opening its path, so a link, a directory or a missing path are alike no
 * file of the package on every platform.
 */
function buildScriptFailure(directory: string, script: unknown, files: readonly string[]): string | null {
  const where = `${directory}/package.json scripts.build`;
  const match = typeof script === "string" ? BUILD_FORM.exec(script) : null;
  if (match === null) return `${where} is ${JSON.stringify(script)}, not node <file>: run a module the package holds`;
  const written = match[1] as string;
  if (!BUILD_PATH.test(written)) {
    return `${where} runs ${written}, which holds a character other than a letter, a digit, '.', '_', '-' or '/'`;
  }
  const file = path.posix.normalize(written);
  if (file === ".." || file.startsWith("../") || file.startsWith("/")) {
    return `${where} runs ${file}, a path out of ${directory}`;
  }
  if (written.split("/").includes("..")) return `${where} runs ${written}, which holds a '..' segment`;
  if (file.startsWith("src/") || file.startsWith("tests/")) {
    return `${where} runs ${file}, which lies in the package's src/ or tests/: run a build module outside them`;
  }
  if (!BUILD_MODULE.test(file)) return `${where} runs ${file}, which is not a JavaScript module (.mjs, .js or .cjs)`;
  return files.includes(`${directory}/${file}`)
    ? null
    : `${where} runs ${file}, which is no regular file of ${directory}`;
}

/**
 * Every workspace package under `root` whose build breaks the build rule, sorted: a `build` script that is not
 * `node <file>` for a JavaScript module the package holds outside `src/` and `tests/`, by a path {@link BUILD_PATH}
 * admits; a `prebuild` or `postbuild` script, which `bun run build` runs around the build (measured with Bun 1.4.4,
 * 2026-11-27); a `scripts` that is not an object; and a `bunfig.toml` in the package's directory, which `bun run`
 * reads there and which can make the script's `node` run Bun, whose globals are tools no import shows. The name is
 * compared in any case, since the file systems of macOS and Windows find `bunfig.toml` under any case of its letters.
 * A package with no `build` script has nothing to judge but those.
 */
function buildScriptFailures(root: string): string[] {
  const failures: string[] = [];
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    for (const name of readdirSync(path.join(root, directory)).filter((n) => n.toLowerCase() === "bunfig.toml")) {
      failures.push(
        `${directory} holds ${name}, which bun run build reads in the package's directory: Bun is configured at the repository's root only`,
      );
    }
    const scripts: unknown = manifest.scripts;
    if (scripts === undefined) continue;
    if (!isRecord(scripts)) {
      failures.push(`${directory}/package.json scripts is not an object of named scripts`);
      continue;
    }
    for (const [hook, when] of [
      ["prebuild", "before"],
      ["postbuild", "after"],
    ] as const) {
      if (hook in scripts) {
        failures.push(`${directory}/package.json declares scripts.${hook}, which bun run build runs ${when} the build`);
      }
    }
    if (!("build" in scripts)) continue;
    const failure = buildScriptFailure(directory, scripts.build, sourceFilesUnder(root, directory));
    if (failure !== null) failures.push(failure);
  }
  return failures.sort();
}

/**
 * Every core import of a driver a provider package declares, and every stale exception, sorted. A driver is a name a
 * provider package's `package.json` declares in a member of the build output check's `DRIVER_FIELDS`; core is the six
 * roots of {@link CORE_ROOTS}, and only a core file whose text holds a driver's name is parsed. A specifier that is a
 * Node built-in by Studio's committed list (`isNodeBuiltin`, the list admission reads) is never a driver import, since
 * Node.js loads the built-in for it though a package declares an npm package of that name; a subpath such as
 * `events/sub` is no built-in and loads the package, so it is read as one. An import is excused only by an entry of
 * `exceptions` naming that driver and that file, and only while the entry holds: the build output check's own
 * `exceptionProblem` passes it and a provider package declares its driver; every other entry is a failure by its own
 * sentence.
 */
function providerDriverImportFailures(root: string, exceptions: readonly CoreImportedDriver[]): string[] {
  const declaredBy = new Map<string, string[]>();
  const directories = providerPackageDirectories(root);
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    if (!directories.includes(directory)) continue;
    for (const field of DRIVER_FIELDS) {
      const members: unknown = manifest[field];
      for (const driver of Object.keys(isRecord(members) ? members : {})) {
        const declaring = declaredBy.get(driver) ?? [];
        if (!declaring.includes(directory)) declaring.push(directory);
        declaredBy.set(driver, declaring);
      }
    }
  }
  const failures: string[] = [];
  const excused: CoreImportedDriver[] = [];
  for (const entry of exceptions) {
    const problem =
      exceptionProblem(entry, root) ??
      (declaredBy.has(entry.driver)
        ? null
        : `check-build-output: the exception for ${entry.driver} imported by ${entry.importer}: no provider package declares ${entry.driver}`);
    if (problem === null) excused.push(entry);
    else failures.push(problem);
  }
  const drivers = [...declaredBy.keys()];
  for (const file of drivers.length === 0 ? [] : CORE_ROOTS.flatMap((directory) => sourceFilesUnder(root, directory))) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!drivers.some((driver) => text.includes(driver))) continue;
    for (const specifier of moduleSpecifiers(text)) {
      // Node.js resolves a specifier of its list to the built-in, never to a package of that name.
      if (isNodeBuiltin(specifier)) continue;
      const driver = packageNameOf(specifier);
      const declaring = declaredBy.get(driver);
      if (declaring === undefined) continue;
      if (excused.some((entry) => entry.driver === driver && entry.importer === file)) continue;
      failures.push(
        `${file} imports "${specifier}", ${driver}, a driver ${declaring.join(", ")} declares: core imports none unless CORE_IMPORTED_DRIVERS in scripts/check-build-output.ts lists its importer`,
      );
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
          'import "ws";',
          'import "undici";',
          'import "bun";',
          'import "node:nosuch";',
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
        'packages/provider-planted/src/index.ts imports "bun", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "bun:sqlite", a Bun runtime module, outside the package\'s tests',
        'packages/provider-planted/src/index.ts imports "left-pad", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "node:nosuch", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "undici", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "ws", which packages/provider-planted/package.json does not declare',
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

  test("a package source import of a name only Bun treats as a built-in fails as undeclared", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-planted/package.json": JSON.stringify({ name: "@libredb/provider-planted" }),
        "packages/provider-planted/src/index.ts": [
          'import "ws";',
          'import "undici";',
          'import "bun";',
          'import "node:nosuch";',
          'import "node:fs";',
          'import "fs";',
          'import "node:test";',
        ].join("\n"),
        "packages/provider-planted/tests/a.test.ts": ['import "bun:test";', 'import "ws";'].join("\n"),
      },
    });
    try {
      expect(packageImportFailures(root)).toEqual([
        'packages/provider-planted/src/index.ts imports "bun", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "node:nosuch", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "undici", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/src/index.ts imports "ws", which packages/provider-planted/package.json does not declare',
        'packages/provider-planted/tests/a.test.ts imports "ws", which packages/provider-planted/package.json does not declare',
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("core imports no provider package, by name or by path", () => {
    expect(providerPackageImportFailures(REPOSITORY_ROOT)).toEqual([]);
  });

  test("a planted core file importing a provider package fails by file and specifier", () => {
    const ALPHA = "@libredb/provider-alpha";
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-alpha/package.json": JSON.stringify({ name: ALPHA }),
        "packages/provider-alpha/src/index.ts": "export const x = 1;\n",
        "packages/provider-alpha/src/self.ts": `import { x } from "${ALPHA}";\nexport const y = x;\n`,
        "packages/provider-sdk/package.json": JSON.stringify({ name: SDK }),
        "src/lib/a.ts": `import { x } from "${ALPHA}";\nexport const a = x;\n`,
        "tests/unit/b.test.ts": `import type { T } from "${ALPHA}/types";\nexport type B = T;\n`,
        "bin/c.ts": `export const c = () => import("${ALPHA}");\n`,
        "scripts/d.ts": 'import "../packages/provider-alpha/src/index";\n',
        "e2e/e.ts": 'export const e = () => require("@libredb/provider-beta");\n',
        "vscode-extension/src/f.ts": 'import "@/../packages/provider-alpha/src";\n',
        "src/lib/controls.ts": [
          `import { defineProvider } from "${SDK}/calls";`,
          'import { load } from "@libredb/provider-loader";',
          `// import "${ALPHA}";`,
          `export const name = "${ALPHA}";`,
          'export const where = "../packages/provider-alpha/src";',
          "export const value = [defineProvider, load];",
        ].join("\n"),
      },
    });
    try {
      expect(providerPackageImportFailures(root)).toEqual([
        `bin/c.ts imports "${ALPHA}", a provider package: core imports none, by name or by path`,
        'e2e/e.ts imports "@libredb/provider-beta", a provider package: core imports none, by name or by path',
        'scripts/d.ts imports "../packages/provider-alpha/src/index", a provider package: core imports none, by name or by path',
        `src/lib/a.ts imports "${ALPHA}", a provider package: core imports none, by name or by path`,
        `tests/unit/b.test.ts imports "${ALPHA}/types", a provider package: core imports none, by name or by path`,
        'vscode-extension/src/f.ts imports "@/../packages/provider-alpha/src", a provider package: core imports none, by name or by path',
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a planted core file reaching a provider package by an absolute path or a file: URL fails by file and specifier", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-alpha/package.json": JSON.stringify({ name: "@libredb/provider-alpha" }),
        "packages/provider-alpha/src/index.ts": "export const x = 1;\n",
        "packages/provider-sdk/package.json": JSON.stringify({ name: SDK }),
      },
    });
    try {
      // Forward slashes on every platform: a Windows absolute path is then `C:/...`, which path.isAbsolute and
      // path.relative read as they read a POSIX one, and a file: URL is written with forward slashes on all three.
      const absolute = (relative: string): string => path.join(root, relative).split(path.sep).join("/");
      const url = (relative: string): string => pathToFileURL(path.join(root, relative)).href;
      const planted: Record<string, string> = {
        "src/lib/a.ts": `import ${JSON.stringify(absolute("packages/provider-alpha/src/index"))};\n`,
        "bin/b.ts": `export const b = () => import(${JSON.stringify(url("packages/provider-alpha"))});\n`,
        "tests/unit/c.test.ts": `import ${JSON.stringify(url("packages/provider-sdk/src/index.ts"))};\n`,
        "scripts/d.ts": `import ${JSON.stringify(absolute("packages/provider-sdk"))};\n`,
        "e2e/e.ts": 'import "/opt/elsewhere/packages/provider-alpha/index.js";\n',
      };
      for (const [file, text] of Object.entries(planted)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), text);
      }
      const refused = (file: string, specifier: string): string =>
        `${file} imports "${specifier}", a provider package: core imports none, by name or by path`;
      const inward = (file: string, specifier: string): string =>
        `${file} imports "${specifier}", reaching a workspace package by path: import it by its name`;

      expect(providerPackageImportFailures(root)).toEqual([
        refused("bin/b.ts", url("packages/provider-alpha")),
        refused("src/lib/a.ts", absolute("packages/provider-alpha/src/index")),
      ]);
      expect(inwardPathFailures(root)).toEqual([
        inward("bin/b.ts", url("packages/provider-alpha")),
        inward("scripts/d.ts", absolute("packages/provider-sdk")),
        inward("src/lib/a.ts", absolute("packages/provider-alpha/src/index")),
        inward("tests/unit/c.test.ts", url("packages/provider-sdk/src/index.ts")),
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a provider package is refused by its own name when the name lacks the provider prefix", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-gamma/package.json": JSON.stringify({ name: "gamma-engine" }),
        "packages/provider-gamma/src/index.ts": "export const x = 1;\n",
        "packages/tooling/package.json": JSON.stringify({ name: "gamma-tooling" }),
        "src/lib/a.ts": 'import { x } from "gamma-engine/sub";\nexport const a = x;\n',
        "src/lib/b.ts": 'import "gamma-tooling";\nimport "gamma-engine-other";\n',
      },
    });
    try {
      expect(providerPackageImportFailures(root)).toEqual([
        'src/lib/a.ts imports "gamma-engine/sub", a provider package: core imports none, by name or by path',
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a provider package with no name fails by its directory, before any core file is read", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-nameless/package.json": JSON.stringify({ version: "0.0.0" }),
        "src/lib/a.ts": 'export const a = "undefined";\n',
      },
    });
    try {
      expect(() => providerPackageImportFailures(root)).toThrow(
        "packages/provider-nameless/package.json has no string name",
      );
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a provider package's build files import only what the package declares", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-alpha/package.json": JSON.stringify({
          name: "@libredb/provider-alpha",
          scripts: { build: "node build/run.mjs" },
          devDependencies: { "alpha-bundler": "*" },
        }),
        "packages/provider-alpha/build/run.mjs": [
          'import "alpha-bundler";',
          'import "beta-bundler";',
          'import "./helper.mjs";',
          'import "node:fs";',
          'import "bun:sqlite";',
          'import "node:child_process";',
        ].join("\n"),
        "packages/provider-alpha/build/helper.mjs": [
          'import "gamma-tool";',
          'import "../../outside.mjs";',
          'export const run = () => require("child_process");',
        ].join("\n"),
        "packages/provider-alpha/alpha.config.mjs": 'import "delta-tool";\n',
        "packages/provider-alpha/src/index.ts": [`import "${SDK}";`, 'import "node:child_process";'].join("\n"),
        "packages/provider-alpha/tests/a.test.ts": ['import "bun:test";', 'import "child_process";'].join("\n"),
      },
    });
    const undeclared = (file: string, specifier: string): string =>
      `packages/provider-alpha/${file} imports "${specifier}", which packages/provider-alpha/package.json does not declare`;
    const startsAProgram = (file: string, specifier: string): string =>
      `packages/provider-alpha/${file} imports "${specifier}", which starts a program, outside the package's src/ and tests/: a build module starts no program`;
    try {
      expect(packageImportFailures(root)).toEqual(
        [
          undeclared("alpha.config.mjs", "delta-tool"),
          undeclared("build/helper.mjs", "gamma-tool"),
          'packages/provider-alpha/build/helper.mjs imports "../../outside.mjs", a path out of packages/provider-alpha',
          startsAProgram("build/helper.mjs", "child_process"),
          undeclared("build/run.mjs", "beta-bundler"),
          'packages/provider-alpha/build/run.mjs imports "bun:sqlite", a Bun runtime module, outside the package\'s tests',
          startsAProgram("build/run.mjs", "node:child_process"),
        ].sort(),
      );
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a provider package's build script runs a file the package holds", () => {
    const pkg = (name: string, scripts: unknown, files: Record<string, string> = {}): Record<string, string> => ({
      [`packages/${name}/package.json`]: JSON.stringify(scripts === undefined ? { name } : { name, scripts }),
      ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`packages/${name}/${file}`, text])),
    });
    const held = { "build.mjs": "export {};\n" };
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        ...pkg("out-relative", { build: "node ../outside.mjs" }),
        ...pkg("out-absolute", { build: "node /opt/x.mjs" }),
        ...pkg("out-parent", { build: "node .." }),
        ...pkg("not-node", { build: "bundler src/index.ts --bundle" }),
        ...pkg("two-commands", { build: "node build.mjs && node more.mjs" }, held),
        ...pkg("missing", { build: "node build/missing.mjs" }),
        // A directory named like a module: its listing's Dirent.isFile() is false on Linux, macOS and Windows alike,
        // and no path is opened, so Windows' EISDIR never arises.
        ...pkg("directory", { build: "node tools.mjs" }, { "tools.mjs/inner.mjs": "export {};\n" }),
        ...pkg("typescript-entry", { build: "node build.ts" }, { "build.ts": "export {};\n" }),
        ...pkg("in-source", { build: "node src/build.mjs" }, { "src/build.mjs": "export {};\n" }),
        ...pkg("in-tests", { build: "node tests/build.mjs" }, { "tests/build.mjs": "export {};\n" }),
        ...pkg("numeric", { build: 7 }),
        ...pkg("scripts-string", "node build.mjs", held),
        ...pkg("pre", { prebuild: "echo pre", build: "node build.mjs" }, held),
        ...pkg("post", { build: "node build.mjs", postbuild: "echo post" }, held),
        ...pkg("bunfig", { build: "node build.mjs" }, { ...held, "bunfig.toml": "[run]\nbun = true\n" }),
        ...pkg("nested-ok", { build: "node build/run.mjs" }, { "build/run.mjs": "export {};\n" }),
        ...pkg("dot-ok", { build: "node ./build.mjs" }, held),
        ...pkg("cjs-ok", { build: "node build.cjs" }, { "build.cjs": "module.exports = {};\n" }),
        ...pkg("no-scripts", undefined),
        ...pkg("no-build", { test: "bun test" }),
      },
    });
    const form = (name: string, script: string): string =>
      `packages/${name}/package.json scripts.build is ${script}, not node <file>: run a module the package holds`;
    try {
      expect(buildScriptFailures(root)).toEqual(
        [
          "packages/out-relative/package.json scripts.build runs ../outside.mjs, a path out of packages/out-relative",
          "packages/out-absolute/package.json scripts.build runs /opt/x.mjs, a path out of packages/out-absolute",
          "packages/out-parent/package.json scripts.build runs .., a path out of packages/out-parent",
          form("not-node", '"bundler src/index.ts --bundle"'),
          form("two-commands", '"node build.mjs && node more.mjs"'),
          form("numeric", "7"),
          "packages/missing/package.json scripts.build runs build/missing.mjs, which is no regular file of packages/missing",
          "packages/directory/package.json scripts.build runs tools.mjs, which is no regular file of packages/directory",
          "packages/typescript-entry/package.json scripts.build runs build.ts, which is not a JavaScript module (.mjs, .js or .cjs)",
          "packages/in-source/package.json scripts.build runs src/build.mjs, which lies in the package's src/ or tests/: run a build module outside them",
          "packages/in-tests/package.json scripts.build runs tests/build.mjs, which lies in the package's src/ or tests/: run a build module outside them",
          "packages/scripts-string/package.json scripts is not an object of named scripts",
          "packages/pre/package.json declares scripts.prebuild, which bun run build runs before the build",
          "packages/post/package.json declares scripts.postbuild, which bun run build runs after the build",
          "packages/bunfig holds bunfig.toml, which bun run build reads in the package's directory: Bun is configured at the repository's root only",
        ].sort(),
      );
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a provider package's build path holds only letters, digits, '.', '_', '-' and '/', with no '..' segment", () => {
    const pkg = (name: string, build: string, files: Record<string, string> = {}): Record<string, string> => ({
      [`packages/${name}/package.json`]: JSON.stringify({ name, scripts: { build } }),
      ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`packages/${name}/${file}`, text])),
    });
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        // A file named `a;b.mjs` is held, so only the path's characters refuse it: Linux, macOS and Windows all allow
        // `;` in a file name, while the pack step's shell would run `node a` and then `b.mjs`.
        ...pkg("semicolon", "node a;b.mjs", { "a;b.mjs": "export {};\n" }),
        // No file is planted with a quote in its name, which Windows refuses; the path is refused before the listing.
        ...pkg("quote", 'node "build.mjs"', { "build.mjs": "export {};\n" }),
        ...pkg("dollar", "node $BUILD.mjs"),
        ...pkg("inner-parent", "node build/../build.mjs", { "build.mjs": "export {};\n" }),
        ...pkg("chars-ok", "node build_1/run-2.v3.mjs", { "build_1/run-2.v3.mjs": "export {};\n" }),
      },
    });
    const characters = (name: string, file: string): string =>
      `packages/${name}/package.json scripts.build runs ${file}, which holds a character other than a letter, a digit, '.', '_', '-' or '/'`;
    try {
      expect(buildScriptFailures(root)).toEqual(
        [
          characters("semicolon", "a;b.mjs"),
          characters("quote", '"build.mjs"'),
          characters("dollar", "$BUILD.mjs"),
          "packages/inner-parent/package.json scripts.build runs build/../build.mjs, which holds a '..' segment",
        ].sort(),
      );
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a package-root bunfig.toml is refused in any case, since macOS and Windows read file names regardless of case", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/mixed/package.json": JSON.stringify({ name: "mixed" }),
        "packages/mixed/Bunfig.toml": "[run]\nbun = true\n",
        "packages/upper/package.json": JSON.stringify({ name: "upper" }),
        "packages/upper/BUNFIG.TOML": "[run]\nbun = true\n",
        "packages/nested/package.json": JSON.stringify({ name: "nested" }),
        "packages/nested/config/bunfig.toml": "[run]\nbun = true\n",
      },
    });
    try {
      expect(buildScriptFailures(root)).toEqual([
        "packages/mixed holds Bunfig.toml, which bun run build reads in the package's directory: Bun is configured at the repository's root only",
        "packages/upper holds BUNFIG.TOML, which bun run build reads in the package's directory: Bun is configured at the repository's root only",
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a provider package's build modules import no other provider package, and not the kit", () => {
    const B = "@libredb/provider-b";
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-a/package.json": JSON.stringify({
          name: "@libredb/provider-a",
          scripts: { build: "node build/run.mjs" },
          devDependencies: { [KIT]: "*" },
        }),
        "packages/provider-a/build/run.mjs": `import "${KIT}";\nimport "${SDK}";\n`,
        "packages/provider-a/a.config.mjs": `export const b = () => import("${B}");\n`,
        "packages/provider-a/tests/a.test.ts": `import "${KIT}";\n`,
      },
    });
    try {
      expect(providerDependenceFailures(root)).toEqual([
        `packages/provider-a/a.config.mjs imports "${B}", another provider package`,
        `packages/provider-a/build/run.mjs imports "${KIT}", the kit, which only a package's tests import`,
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("the repository's packages' build scripts each run a file the package holds", () => {
    expect(workspacePackageManifests(REPOSITORY_ROOT).length).toBeGreaterThan(0);
    expect(buildScriptFailures(REPOSITORY_ROOT)).toEqual([]);
  });

  /** The refusal of `file`'s import of `specifier`, a module of `driver` that `directories` declare. */
  const driverImport = (file: string, specifier: string, driver: string, directories: string): string =>
    `${file} imports "${specifier}", ${driver}, a driver ${directories} declares: core imports none unless CORE_IMPORTED_DRIVERS in scripts/check-build-output.ts lists its importer`;

  test("core imports no driver a provider package declares, but a listed exception by its importer", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-alpha/package.json": JSON.stringify({
          name: "@libredb/provider-alpha",
          dependencies: { "alpha-driver": "*" },
          optionalDependencies: { "alpha-optional": "*" },
          peerDependencies: { "alpha-peer": "*" },
          devDependencies: { "alpha-tool": "*" },
        }),
        "packages/provider-beta/package.json": JSON.stringify({
          name: "@libredb/provider-beta",
          dependencies: { "alpha-driver": "*" },
        }),
        "packages/provider-sdk/package.json": JSON.stringify({ name: SDK, dependencies: { ajv: "*" } }),
        "src/lib/a.ts": 'import { x } from "alpha-driver/sub";\nexport const a = x;\n',
        "bin/b.ts": 'export const b = () => require("alpha-optional");\n',
        "tests/unit/c.test.ts": 'import type { T } from "alpha-peer";\nexport type C = T;\n',
        "e2e/d.ts": 'export const d = () => import("alpha-driver");\n',
        "vscode-extension/src/e.ts": 'export * from "alpha-driver";\n',
        "scripts/f.ts": 'import "alpha-tool";\n',
        "src/lib/excepted.ts": 'import "alpha-driver";\n',
        "src/lib/g.ts": '// import "alpha-driver";\nexport const name = "alpha-driver";\n',
        "src/lib/h.ts": 'import Ajv from "ajv";\nexport const h = Ajv;\n',
      },
    });
    const both = "packages/provider-alpha, packages/provider-beta";
    const failures = [
      driverImport("bin/b.ts", "alpha-optional", "alpha-optional", "packages/provider-alpha"),
      driverImport("e2e/d.ts", "alpha-driver", "alpha-driver", both),
      driverImport("src/lib/a.ts", "alpha-driver/sub", "alpha-driver", both),
      driverImport("tests/unit/c.test.ts", "alpha-peer", "alpha-peer", "packages/provider-alpha"),
      driverImport("vscode-extension/src/e.ts", "alpha-driver", "alpha-driver", both),
    ];
    try {
      expect(providerDriverImportFailures(root, [{ driver: "alpha-driver", importer: "src/lib/excepted.ts" }])).toEqual(
        failures,
      );
      expect(providerDriverImportFailures(root, [])).toEqual(
        [...failures, driverImport("src/lib/excepted.ts", "alpha-driver", "alpha-driver", both)].sort(),
      );
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a listed exception whose importer no longer imports the driver fails by name", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-alpha/package.json": JSON.stringify({
          name: "@libredb/provider-alpha",
          dependencies: { "alpha-driver": "*" },
        }),
        "src/lib/no-longer.ts": "export const x = 1;\n",
        "tests/unit/c.test.ts": 'import "alpha-driver";\n',
        "src/lib/uses-beta.ts": 'import "beta-driver";\n',
      },
    });
    const stale = (driver: string, importer: string, why: string): string =>
      `check-build-output: the exception for ${driver} imported by ${importer}: ${why}`;
    try {
      expect(
        providerDriverImportFailures(root, [
          { driver: "alpha-driver", importer: "src/lib/no-longer.ts" },
          { driver: "alpha-driver", importer: "src/lib/missing.ts" },
          { driver: "alpha-driver", importer: "tests/unit/c.test.ts" },
          { driver: "beta-driver", importer: "src/lib/uses-beta.ts" },
        ]),
      ).toEqual(
        [
          stale("alpha-driver", "src/lib/no-longer.ts", "the importer imports no module of alpha-driver"),
          stale("alpha-driver", "src/lib/missing.ts", "the importer does not exist"),
          stale(
            "alpha-driver",
            "tests/unit/c.test.ts",
            "the importer is not under src/, bin/, scripts/ or vscode-extension/src/",
          ),
          stale("beta-driver", "src/lib/uses-beta.ts", "no provider package declares beta-driver"),
          // An exception that fails is no exception: the test's import is refused as well.
          driverImport("tests/unit/c.test.ts", "alpha-driver", "alpha-driver", "packages/provider-alpha"),
        ].sort(),
      );
    } finally {
      removePlantedRoot(root);
    }
  });

  test("a core import that names a Node built-in is never a driver import, though a provider package declares that name", () => {
    const root = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "packages/provider-alpha/package.json": JSON.stringify({
          name: "@libredb/provider-alpha",
          dependencies: { events: "*" },
          peerDependencies: { buffer: "*" },
        }),
        "src/lib/a.ts": 'import { EventEmitter } from "events";\nexport const a = EventEmitter;\n',
        "src/lib/b.ts": 'import { EventEmitter } from "node:events";\nexport const b = EventEmitter;\n',
        "bin/c.ts": 'export const c = () => require("buffer");\n',
        // Node.js serves only the exact names of its list as built-ins, so a subpath loads the npm package.
        "src/lib/d.ts": 'import "events/sub";\n',
      },
    });
    try {
      expect(providerDriverImportFailures(root, [])).toEqual([
        driverImport("src/lib/d.ts", "events/sub", "events", "packages/provider-alpha"),
      ]);
    } finally {
      removePlantedRoot(root);
    }
  });

  test("core imports no driver a provider package declares", () => {
    expect(providerDriverImportFailures(REPOSITORY_ROOT, CORE_IMPORTED_DRIVERS)).toEqual([]);
  });
});
