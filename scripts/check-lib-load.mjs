#!/usr/bin/env node
/**
 * Whether the packed library loads under Node the way a consumer installs it: `bun run lib:load`, after
 * `bun run build:lib`.
 *
 * attw resolves types and `lib:closure` reads the built text, and both pass a dist that cannot load: one that names
 * an unpublished workspace package, a package the manifest does not declare, or a file Node cannot import. This check
 * packs the package as it is published and fails by name on each of those (docs/TOOLCHAIN.md, "The packed library
 * loads (`lib:load`)"):
 *
 * 1. It packs the repository with `bun pm pack` (as `attw` does) and extracts the tarball to
 *    `<os.tmpdir()>/lib-load-<random>/node_modules/<name>/`, the place a consumer's install puts it.
 * 2. The packed `package.json` names no workspace package under `dependencies`, `peerDependencies` or
 *    `optionalDependencies`, since a consumer cannot install an unpublished package; and every `dependencies` and
 *    `peerDependencies` name of a workspace package is a root `dependencies` or `peerDependencies` name, since the
 *    library build bundles the package and computes its externals from the root manifest alone.
 * 3. Every bare specifier of every `.js`, `.mjs`, `.d.ts` and `.d.mts` file of the packed `dist/` is a declared
 *    `dependencies` or `peerDependencies` name, a Node builtin (`module.isBuiltin`), or a Bun runtime module
 *    (`bun:`), read with the TypeScript parser so text inside a string is never taken for an import. A computed
 *    `import()` or `require()` fails too, because what it loads cannot be checked. A declaration file's relative
 *    specifier must be one of the two forms the build writes, `./<name>.js` naming `<name>.d.ts` from a `.d.ts` or
 *    `./<name>.mjs` naming `<name>.d.mts` from a `.d.mts`, with that declaration file in the dist, because no load
 *    reads a declaration and a dangling one would otherwise pass.
 * 4. Only the declared names are linked into the temporary `node_modules`, each to the repository's install, and a
 *    child `node` (scripts/load-lib-closure.mjs) loads every module of the `index` and `providers` closures, ESM by
 *    `import()` and CJS by `require`, dynamic imports included.
 *
 * The load is isolated so that only what the package declares can resolve:
 *
 * - the check refuses a temporary root with an ancestor directory holding `node_modules`, since Node would resolve an
 *   undeclared package there; set TMPDIR (TEMP on Windows) to move it;
 * - the child runs without `NODE_PATH` and `NODE_OPTIONS`, with `HOME` and `USERPROFILE` set to an empty directory,
 *   because Node's CommonJS loader also searches `$HOME/.node_modules` and `$HOME/.node_libraries` (Node docs,
 *   "Loading from the global folders");
 * - the check refuses when `<node prefix>/lib/node`, the third global folder, exists;
 * - the child has a 1 GB heap and a 120 s timeout, so a module whose top-level code hangs is named, not waited on.
 *
 * It prints one failure per line and a summary line, exits 1 on any failure, and always removes its temporary root.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { workspacePackageManifests } from "./workspace-packages.mjs";

/** The entries whose closures are loaded: the package root and the providers entry, in both formats. */
const ENTRIES = ["index.mjs", "index.js", "providers.mjs", "providers.js"];

/** The dist files whose specifiers are read: the JavaScript and the declaration files a consumer installs. */
const SCANNED = /\.(?:m?js|d\.m?ts)$/;

/** A declaration file, and the JavaScript extension its relative specifiers carry: `.js` from `.d.ts`, `.mjs` from `.d.mts`. */
const DECLARATION = /\.d\.(m?)ts$/;

const LOAD_LIB_CLOSURE = fileURLToPath(new URL("./load-lib-closure.mjs", import.meta.url));

/** The manifest fields a consumer's install reads. */
const PUBLISHED_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * Every module specifier in a file, read with the TypeScript parser: import and export declarations, `import x =
 * require("y")`, `import()`, `require()`, `require.resolve()`, import type nodes and triple-slash `types` references.
 * `computed` counts the `import()`, `require()` and `require.resolve()` calls whose argument is not a literal.
 * @param {string} text
 * @param {string} fileName decides how the text is parsed, by its extension
 * @returns {{ specifiers: string[], computed: number }}
 */
export function moduleSpecifiers(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers = source.typeReferenceDirectives.map((reference) => reference.fileName);
  let computed = 0;

  const literal = (node) => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined);
  const isRequire = (expression) =>
    (ts.isIdentifier(expression) && expression.text === "require") ||
    (ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "require" &&
      expression.name.text === "resolve");

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifiers.push(literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifiers.push(literal(node.argument.literal));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))
    ) {
      const specifier = literal(node.arguments[0]);
      if (specifier === undefined) computed += 1;
      else specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, computed };
}

/** The package a bare specifier names: `@scope/name` or `name`, its subpath dropped. */
export function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** Every file under `directory`, as sorted POSIX paths relative to it. */
function filesUnder(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/**
 * Whether a declaration file's relative specifier names a declaration file of the dist in a form the build writes:
 * `./<name>.js` from a `.d.ts` naming `<name>.d.ts`, or `./<name>.mjs` from a `.d.mts` naming `<name>.d.mts`.
 * @param {string} file the declaration file, a POSIX path relative to the dist
 * @param {string} specifier its relative specifier
 * @param {Set<string>} distFiles every file of the dist, POSIX paths relative to it
 */
function namesDistDeclaration(file, specifier, distFiles) {
  const esm = DECLARATION.exec(file)[1];
  const extension = `.${esm}js`;
  if (!specifier.startsWith("./") || !specifier.endsWith(extension)) return false;
  const target = path.posix.join(path.posix.dirname(file), `${specifier.slice(0, -extension.length)}.d.${esm}ts`);
  return distFiles.has(target);
}

/**
 * The failures of the specifier rule over every scanned file of `distDir`, one sentence each, and how many files it
 * read. A JavaScript file's relative specifier is the build's own file and is not checked here; the load checks it. A
 * declaration file's relative specifier is checked here, since nothing loads a declaration: it must name a declaration
 * file of the dist in a form the build writes.
 * @param {string} distDir
 * @param {{ dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} manifest
 * @returns {{ files: number, failures: string[] }}
 */
export function undeclaredSpecifiers(distDir, manifest) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const distFiles = filesUnder(distDir);
  const distFileSet = new Set(distFiles);
  const files = distFiles.filter((file) => SCANNED.test(file));
  const failures = [];
  for (const file of files) {
    const { specifiers, computed } = moduleSpecifiers(fs.readFileSync(path.join(distDir, file), "utf8"), file);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        if (!DECLARATION.test(file) || namesDistDeclaration(file, specifier, distFileSet)) continue;
        failures.push(
          `dist/${file} imports "${specifier}", which names no declaration file of the dist in a form the build writes (./<name>.js naming <name>.d.ts from a .d.ts, ./<name>.mjs naming <name>.d.mts from a .d.mts).`,
        );
        continue;
      }
      if (specifier.startsWith("bun:") || isBuiltin(specifier) || declared.has(packageNameOf(specifier))) continue;
      failures.push(
        `dist/${file} imports "${specifier}", which is not a dependencies or peerDependencies name of the packed package.json, a Node builtin or a Bun runtime module.`,
      );
    }
    if (computed > 0) {
      failures.push(
        `dist/${file} has ${computed} computed import() or require() whose specifier is not a literal, so what it loads cannot be checked.`,
      );
    }
  }
  return { files: files.length, failures };
}

/**
 * The failures of the two workspace rules, one sentence each: the packed manifest names no workspace package where a
 * consumer's install reads it, and a workspace package's dependencies are the library's own.
 * @param {Record<string, Record<string, string> | undefined>} manifest the packed (or root) package.json
 * @param {{ directory: string, manifest: Record<string, any> }[]} packages from workspacePackageManifests
 * @returns {string[]}
 */
export function workspaceDependencyFailures(manifest, packages) {
  const names = new Set(packages.map((entry) => entry.manifest.name));
  const failures = [];
  for (const field of PUBLISHED_DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!names.has(name)) continue;
      failures.push(
        `the packed package.json names the workspace package "${name}" under ${field}, which a consumer cannot install: the library build bundles it, so the root may list it under devDependencies only (packages/README.md, "Library").`,
      );
    }
  }
  const rootNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const { directory, manifest: packageManifest } of packages) {
    const required = [
      ...Object.keys(packageManifest.dependencies ?? {}),
      ...Object.keys(packageManifest.peerDependencies ?? {}),
    ];
    for (const name of new Set(required)) {
      if (names.has(name) || rootNames.has(name)) continue;
      failures.push(
        `${directory} depends on "${name}", which the root package.json does not declare under dependencies or peerDependencies: the library build bundles the package, so its dependencies must be the library's own (packages/README.md, "Library").`,
      );
    }
  }
  return failures;
}

/**
 * The nearest ancestor of `directory` (the directory itself excluded) that holds `node_modules`, or null. Asks
 * `exists` once per ancestor, up to and including the filesystem root.
 * @param {string} directory
 * @param {(candidate: string) => boolean} exists
 * @returns {string | null}
 */
export function ancestorNodeModules(directory, exists) {
  let current = path.resolve(directory);
  const top = path.parse(current).root;
  while (current !== top) {
    current = path.dirname(current);
    if (exists(path.join(current, "node_modules"))) return current;
  }
  return null;
}

/**
 * The child's environment: the parent's without NODE_PATH and NODE_OPTIONS, with HOME and USERPROFILE at `home`.
 * @param {Record<string, string | undefined>} parentEnv
 * @param {string} home
 * @returns {Record<string, string | undefined>}
 */
export function childEnvironment(parentEnv, home) {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    const upper = key.toUpperCase();
    if (upper === "NODE_PATH" || upper === "NODE_OPTIONS" || upper === "HOME" || upper === "USERPROFILE") continue;
    env[key] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home };
}

/**
 * Links each distinct `dependencies` and `peerDependencies` name of `manifest` into `targetNodeModules`, as a
 * junction (a plain symbolic link on POSIX) to the same name in `repositoryNodeModules`. Throws, naming it, on a
 * declared name the repository has not installed.
 * @returns {string[]} the linked names, sorted
 */
export function linkDeclaredDependencies(manifest, repositoryNodeModules, targetNodeModules) {
  const names = [
    ...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]),
  ].sort();
  for (const name of names) {
    const source = path.join(repositoryNodeModules, name);
    if (!fs.existsSync(source)) {
      throw new Error(
        `"${name}" is declared by the packed package.json but is not installed in ${repositoryNodeModules}, so the load cannot provide it. Run bun install.`,
      );
    }
    const target = path.join(targetNodeModules, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, "junction");
  }
  return names;
}

/** Runs a command with a timeout and throws, naming it, when it does not exit 0. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw new Error(`${command} ${args.join(" ")} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}: ${result.stderr.trim()}`);
  }
}

/**
 * Packs `root` with `bun pm pack` into `<temp>/pack`, extracts it there, and moves the package to
 * `<temp>/node_modules/<name>`. tar runs in the pack directory on the archive's base name, so no drive letter
 * reaches its arguments (GNU tar reads `C:` as a remote host).
 * @returns {{ packageDir: string, manifest: Record<string, any> }}
 */
export function packPackage(root, temp, tar = "tar") {
  const packDirectory = path.join(temp, "pack");
  run("bun", ["pm", "pack", "--quiet", "--destination", packDirectory], root);
  const archives = fs.readdirSync(packDirectory).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`bun pm pack left ${archives.length} archives in ${packDirectory}, expected one.`);
  }
  run(tar, ["-xzf", archives[0]], packDirectory);
  const extracted = path.join(packDirectory, "package");
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, "package.json"), "utf8"));
  const packageDir = path.join(temp, "node_modules", manifest.name);
  fs.mkdirSync(path.dirname(packageDir), { recursive: true });
  fs.renameSync(extracted, packageDir);
  return { packageDir, manifest };
}

/**
 * Loads each entry's closure from `<packageDir>/dist` in a child `node` (scripts/load-lib-closure.mjs) with a 1 GB
 * heap, and returns how many modules it checked and one sentence per failing module, or one naming the timeout, or one
 * naming the child's exit status and output when that status does not match its failure lines.
 * @param {string} packageDir
 * @param {string[]} entries
 * @param {{ env: Record<string, string | undefined>, timeoutMs?: number }} options
 * @returns {{ modules: number, failures: string[] }}
 */
export function loadFailures(packageDir, entries, { env, timeoutMs = 120_000 }) {
  const result = spawnSync(
    "node",
    ["--max-old-space-size=1024", LOAD_LIB_CLOSURE, path.join(packageDir, "dist"), ...entries],
    { cwd: packageDir, env, encoding: "utf8", timeout: timeoutMs },
  );
  if (result.error?.code === "ETIMEDOUT") {
    return {
      modules: 0,
      failures: [
        `the load of ${entries.join(", ")} did not finish within ${timeoutMs / 1000} s: a module's top-level code hangs or keeps the process open.`,
      ],
    };
  }
  if (result.error) throw result.error;
  const lines = result.stdout.trim().split("\n");
  const summary = /^checked (\d+) modules$/.exec(lines.at(-1) ?? "");
  const failureLines = lines.length - 1;
  // The child exits 0 with no failure line or 1 with at least one. Any other pairing, such as 1 with none from an
  // unhandled rejection or a late throw in a module's top-level code after the summary, is reported with its stderr.
  const consistent = (result.status === 0 && failureLines === 0) || (result.status === 1 && failureLines > 0);
  if (summary === null || !consistent) {
    return {
      modules: 0,
      failures: [
        `the load child exited ${result.status ?? result.signal}: ${`${result.stdout}${result.stderr}`.trim()}`,
      ],
    };
  }
  return { modules: Number(summary[1]), failures: lines.slice(0, -1) };
}

/** Node's third global folder, `<prefix>/lib/node`, where `<prefix>` is computed as Node's module loader does. */
function nodePrefixLibrary() {
  const prefix =
    process.platform === "win32" ? path.resolve(process.execPath, "..") : path.resolve(process.execPath, "..", "..");
  return path.join(prefix, "lib", "node");
}

function check(root, temp) {
  const ancestor = ancestorNodeModules(temp, fs.existsSync);
  if (ancestor !== null) {
    return [
      `${ancestor} holds node_modules above the temporary root ${temp}, so Node would resolve an undeclared package there. Point TMPDIR (TEMP on Windows) at a directory with no node_modules above it.`,
    ];
  }
  const globalFolder = nodePrefixLibrary();
  if (fs.existsSync(globalFolder)) {
    return [
      `${globalFolder} exists, and Node resolves a CommonJS require from it, so an undeclared package could load from there. Run the check with a node whose prefix has no lib/node.`,
    ];
  }
  const home = path.join(temp, "home");
  fs.mkdirSync(home);

  const { packageDir, manifest } = packPackage(root, temp);
  const missing = ENTRIES.filter((entry) => !fs.existsSync(path.join(packageDir, "dist", entry)));
  if (missing.length > 0) {
    return missing.map((entry) => `dist/${entry} is not in the packed package, so its closure cannot load.`);
  }

  const failures = workspaceDependencyFailures(manifest, workspacePackageManifests(root));
  const scan = undeclaredSpecifiers(path.join(packageDir, "dist"), manifest);
  failures.push(...scan.failures);
  linkDeclaredDependencies(manifest, path.join(root, "node_modules"), path.join(temp, "node_modules"));
  const load = loadFailures(packageDir, ENTRIES, { env: childEnvironment(process.env, home) });
  failures.push(...load.failures);
  if (failures.length === 0) {
    console.log(
      `lib:load: ${manifest.name}@${manifest.version} packed, ${scan.files} dist files scanned, ${load.modules} modules of ${ENTRIES.join(", ")} loaded under Node ${process.version}`,
    );
  }
  return failures;
}

function main() {
  const started = performance.now();
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, "dist"))) {
    console.error(
      `lib:load: dist/ is missing in ${root}, so there is no package to load. Run bun run build:lib first.`,
    );
    process.exit(1);
  }
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lib-load-"));
  let failures;
  try {
    failures = check(root, temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const failure of failures) console.error(`lib:load: ${failure}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`lib:load: ${failures.length} failures in ${seconds} s`);
  process.exit(failures.length === 0 ? 0 : 1);
}

/**
 * Whether this file runs as the program rather than as the unit test's import, compared by real path as
 * scripts/check-lib-closure.mjs does, so the check also runs from a symlinked checkout.
 * @param {string | undefined} argv1
 */
function isDirectExecution(argv1) {
  return (
    argv1 !== undefined &&
    fs.existsSync(argv1) &&
    fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))
  );
}

if (isDirectExecution(process.argv[1])) {
  main();
}
