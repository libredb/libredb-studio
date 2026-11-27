#!/usr/bin/env node
/**
 * Builds the lock command (scripts/providers-lock.ts) as one Node.js ES module, `dist/providers-lock.mjs`: the module
 * the npm launcher (bin/studio.js, `npx @libredb/studio providers lock --dir <absolute directory>`) and each image's
 * `libredb-studio` wrapper (docker/libredb-studio.mjs) import and run through its exported `main`
 * (docs/TOOLCHAIN.md, "The lock command module (`lib:lock`)").
 *
 * `build:lib` runs it after tsup, whose `clean: true` would otherwise remove the module, and each Dockerfile's builder
 * stage runs it after `next build`. It makes one esbuild call: the entry is esbuild's `stdin` entry
 * `export { main, USAGE } from "./scripts/providers-lock.ts";`, so the script's `#!/usr/bin/env bun` line, which
 * esbuild keeps at the top of an entry file, stays out of the module, and the module exports only `main` and
 * `USAGE`. It bundles every module the command reaches, `@/` imports through tsconfig.json's `paths` and acorn
 * included, for `platform: "node"`, `format: "esm"` and `target: "node24"`, the package's `engines.node` floor, with no
 * minification and no source map, so the shipped text is the text read.
 *
 * acorn's MIT license asks that its notice travel with every copy, so the module begins with a comment holding the
 * license text of the installed acorn, read from `node_modules/acorn/LICENSE` at build time; the build fails naming
 * that file when it is missing.
 *
 * After the build it reads esbuild's metafile and fails, naming each, on an input from a package other than acorn and
 * on an import of the module that is not a `node:` built-in, so a new dependency reaching the command fails the build
 * and never reaches an operator.
 *
 * Run: node scripts/build-lock-module.mjs (from the repository root; `bun run build:lib` runs it)
 */
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The entry of the module: the command's `main` and `USAGE`, re-exported. */
export const LOCK_MODULE_ENTRY = 'export { main, USAGE } from "./scripts/providers-lock.ts";\n';

/** The one package the module may bundle. */
const BUNDLED_PACKAGE = "acorn";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The package an input path from `node_modules` belongs to, `@scope/name` or `name`; null for any other input. */
export function inputPackage(input) {
  const segments = input.split(/[\\/]/);
  const at = segments.lastIndexOf("node_modules");
  if (at === -1) return null;
  const first = segments[at + 1];
  return first.startsWith("@") ? `${first}/${segments[at + 2]}` : first;
}

/**
 * The leading comment of the module: acorn's name, version and license text, as the installed package states them.
 * @param {string} root the repository root, whose node_modules holds acorn
 */
export function acornNotice(root) {
  const directory = path.join(root, "node_modules", BUNDLED_PACKAGE);
  const license = path.join(directory, "LICENSE");
  if (!fs.existsSync(license)) {
    throw new Error(
      `${license} is missing, so the lock module cannot carry acorn's license notice. Run bun install first.`,
    );
  }
  const text = fs.readFileSync(license, "utf8");
  if (text.includes("*/")) throw new Error(`${license} holds "*/", so it cannot be written inside a comment.`);
  const { version } = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  return `/*\nThis module bundles acorn ${version} (https://github.com/acornjs/acorn), under this license:\n\n${text.trimEnd()}\n*/`;
}

/**
 * Builds the module from `entry` into `outfile` and checks what it bundles and imports; throws, naming each, on an
 * input from a package other than acorn or an import that is not a `node:` built-in.
 * @param {{ root?: string, outfile?: string, entry?: string }} [options]
 * @returns {Promise<{ outfile: string, inputs: string[], imports: string[] }>} the metafile's inputs and the module's
 *   imports
 */
export async function buildLockModule({
  root = REPOSITORY_ROOT,
  outfile = path.join(root, "dist", "providers-lock.mjs"),
  entry = LOCK_MODULE_ENTRY,
} = {}) {
  const notice = acornNotice(root);
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: entry, resolveDir: root, sourcefile: "lock-module-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    banner: { js: notice },
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
  const failures = [
    ...[...new Set(inputs.map(inputPackage))]
      .filter((name) => name !== null && name !== BUNDLED_PACKAGE)
      .map((name) => `it bundles the package ${name}, and the lock module may bundle ${BUNDLED_PACKAGE} alone`),
    ...[...new Set(imports)]
      .filter((specifier) => !(specifier.startsWith("node:") && isBuiltin(specifier)))
      .map((specifier) => `it imports ${specifier}, and the lock module may import node: built-ins alone`),
  ];
  if (failures.length > 0) {
    fs.rmSync(outfile, { force: true });
    throw new Error(`The lock module ${outfile} is refused: ${failures.join("; ")}.`);
  }
  return { outfile, inputs, imports: [...new Set(imports)].sort() };
}

/**
 * Whether this file runs as the program rather than as the unit test's import, compared by real path as
 * scripts/check-lib-load.mjs does.
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
  const built = await buildLockModule();
  console.log(
    `build-lock-module: wrote ${path.relative(REPOSITORY_ROOT, built.outfile)} (${built.inputs.length} inputs)`,
  );
}
