/**
 * Reads the imports that cross the provider boundary, for the guard in `tests/unit/lib/db/provider-imports.test.ts`
 * and the census in `docs/PROVIDER_IMPORTS.md` (provider plugins program, FND-8).
 *
 * Every function is pure over `{ path, text }` records and a set of listed paths, so a test can plant a tree.
 * Paths are repository-relative and joined with `/`, as `git ls-files` prints them, so every platform compares the
 * same strings.
 *
 * - A source file has a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs` extension.
 * - The provider directory is `src/lib/db/providers/`, compared as a whole path segment, so
 *   `src/lib/db/providers-x/` and `src/lib/db/provider-files.ts` lie outside it.
 * - A core file is a source file under `src/`, `bin/`, `scripts/` or `vscode-extension/src/` outside the provider
 *   directory. Tests, e2e and workspace packages are not core.
 *
 * Specifiers come from `ts.preProcessFile(text, true, true)`, the TypeScript compiler's public API for the imports of
 * a file: static imports, `import type` and inline `type` imports, `export ... from` and `export * from`, side-effect
 * imports, `import()`, `require()`, `import x = require()` and `typeof import()`, each with a literal specifier. A
 * path inside a comment, a string or a template literal is never one, and neither is an `import()` or `require()`
 * whose argument is not a literal.
 *
 * A specifier resolves as the compiler resolves it for this repository: `@/x` is `src/x` from every scanned root
 * (`tsconfig.json` and `vscode-extension/tsconfig.json` map it to the same directory), a relative one joins the
 * importer's directory, and anything else is a package or a `node:` builtin. The module is the first listed file of
 * the path itself, the path with `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts`, its `index.ts`,
 * `index.tsx` or `index.js`, and, for a `.js` specifier, the `.ts` file beside it.
 *
 * Inward, only core files whose text contains `providers` are parsed. That skips no import: a specifier that reaches
 * the provider directory from outside it names the directory's own segment, whether it is written with `@/` or as a
 * relative path, since a relative path climbs out of the importer's directory and then descends through
 * `providers/`. An inward specifier no listed file answers is still a finding when its path lies in the provider
 * directory, named by that path.
 *
 * Outward, every provider file is parsed, and every listed file outside the provider directory it imports is a core
 * module. A relative or `@/` specifier in a provider file that resolves to no listed file throws, naming it, because a
 * census that skipped it would be short by a module nobody could see.
 */
import { posix } from "node:path";
import ts from "typescript";

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** One core file importing one provider module, the module named relative to the provider directory. */
export interface InwardImport {
  readonly file: string;
  readonly module: string;
}

/** A core file and the provider modules it may import, relative to the provider directory. */
export interface AllowlistEntry {
  readonly file: string;
  readonly modules: readonly string[];
}

export type Resolution =
  | { readonly kind: "package" }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unresolved"; readonly path: string };

export const PROVIDER_DIRECTORY = "src/lib/db/providers";
export const SCANNED_ROOTS: readonly string[] = ["src", "bin", "scripts", "vscode-extension/src"];

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MODULE_SUFFIXES = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"];

export function isSourcePath(path: string): boolean {
  return SOURCE_FILE.test(path);
}

/** Whether `path` is the provider directory or lies inside it, compared by whole segment. */
function inProviderDirectory(path: string): boolean {
  return path === PROVIDER_DIRECTORY || path.startsWith(`${PROVIDER_DIRECTORY}/`);
}

export function isProviderPath(path: string): boolean {
  return isSourcePath(path) && inProviderDirectory(path);
}

export function isCorePath(path: string): boolean {
  return isSourcePath(path) && !inProviderDirectory(path) && SCANNED_ROOTS.some((root) => path.startsWith(`${root}/`));
}

/** A core file that could import a provider module: its text names the directory's segment. */
export function isCandidate(file: SourceText): boolean {
  return isCorePath(file.path) && file.text.includes("providers");
}

export function moduleSpecifiers(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((reference) => reference.fileName);
}

export function resolveSpecifier(importer: string, specifier: string, listed: ReadonlySet<string>): Resolution {
  let base: string;
  if (specifier.startsWith("@/")) base = posix.join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = posix.join(posix.dirname(importer), specifier);
  else return { kind: "package" };
  const candidates = [base, ...MODULE_SUFFIXES.map((suffix) => `${base}${suffix}`)];
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -".js".length)}.ts`);
  const path = candidates.find((candidate) => listed.has(candidate));
  return path === undefined ? { kind: "unresolved", path: base } : { kind: "file", path };
}

/** Code-unit order, the order `Array.prototype.sort` gives strings, so the allowlist's own order matches. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byFileThenModule = (a: InwardImport, b: InwardImport): number =>
  compareText(a.file, b.file) || compareText(a.module, b.module);

/** Every distinct (core file, provider module) pair, sorted by file and then module. */
export function inwardImports(files: readonly SourceText[], listed: ReadonlySet<string>): InwardImport[] {
  const pairs = new Map<string, InwardImport>();
  for (const file of files.filter(isCandidate)) {
    for (const specifier of moduleSpecifiers(file.text)) {
      const resolution = resolveSpecifier(file.path, specifier, listed);
      if (resolution.kind === "package" || !inProviderDirectory(resolution.path)) continue;
      const providerModule = posix.relative(PROVIDER_DIRECTORY, resolution.path);
      pairs.set(`${file.path}\0${providerModule}`, { file: file.path, module: providerModule });
    }
  }
  return [...pairs.values()].sort(byFileThenModule);
}

/** Every core module provider files import, sorted by path, each with its importing provider files, sorted. */
export function outwardImports(
  files: readonly SourceText[],
  listed: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const importers = new Map<string, Set<string>>();
  for (const file of files.filter((candidate) => isProviderPath(candidate.path))) {
    for (const specifier of moduleSpecifiers(file.text)) {
      const resolution = resolveSpecifier(file.path, specifier, listed);
      if (resolution.kind === "package") continue;
      if (resolution.kind === "unresolved") {
        throw new Error(`${file.path}: "${specifier}" resolves to no listed file`);
      }
      if (inProviderDirectory(resolution.path)) continue;
      const set = importers.get(resolution.path) ?? new Set<string>();
      set.add(file.path);
      importers.set(resolution.path, set);
    }
  }
  return new Map(
    [...importers.keys()].sort().map((module) => [module, [...(importers.get(module) ?? [])].sort()] as const),
  );
}

/** The found pairs the allowlist does not list, and the listed pairs nothing found matches, each sorted. */
export function compareToAllowlist(
  found: readonly InwardImport[],
  allowlist: readonly AllowlistEntry[],
): { added: InwardImport[]; stale: InwardImport[] } {
  const key = ({ file, module }: InwardImport): string => `${file}\0${module}`;
  const listed = allowlist.flatMap(({ file, modules }) => modules.map((module) => ({ file, module })));
  const foundKeys = new Set(found.map(key));
  const listedKeys = new Set(listed.map(key));
  return {
    added: found.filter((pair) => !listedKeys.has(key(pair))).sort(byFileThenModule),
    stale: listed.filter((pair) => !foundKeys.has(key(pair))).sort(byFileThenModule),
  };
}
