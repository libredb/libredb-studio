import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");

/** What a walk of a module's value imports reached. Paths are repository-relative, with forward slashes. */
export interface ValueImportClosure {
  /** Every module of this repository the walk entered, the entry included. */
  modules: string[];
  /** Every bare specifier (a package or a `node:` builtin) a module of the closure imports by value. */
  packages: string[];
  /** `<module> imports <specifier>` for an `@/` or relative specifier no file answers. */
  unresolved: string[];
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

function moduleFileOf(specifier: string, from: string): string | undefined {
  const base = specifier.startsWith("@/") ? join(SRC_DIR, specifier.slice(2)) : join(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

/** The value import specifiers of one `.ts` or `.tsx` file (an absolute path), by the rules `valueImportClosure` states. */
function valueSpecifiersOf(file: string): string[] {
  const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
  return transpiler.scanImports(readFileSync(file, "utf8")).map(({ path }) => path);
}

/**
 * The modules of this repository that `module` (a repository-relative `.ts` or `.tsx` path) imports by value directly,
 * resolved by the rules `valueImportClosure` states, repository-relative and sorted. A bare specifier is not a module
 * of this repository and is left out; an `@/` or relative specifier no file answers throws, naming it.
 */
export function valueImportsOf(module: string): string[] {
  const file = join(REPO_ROOT, module);
  const imported = new Set<string>();
  for (const specifier of valueSpecifiersOf(file)) {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) continue;
    const resolved = moduleFileOf(specifier, file);
    if (resolved === undefined) throw new Error(`${module} imports ${specifier}, which no file answers`);
    imported.add(repoRelative(resolved));
  }
  return [...imported].sort();
}

/**
 * Walks the VALUE imports of `entry` (a repository-relative path) through this repository's own source.
 *
 * Bun's transpiler reads each module, so a type-only import, which is erased and pulls nothing into a
 * bundle or a process, is left out, while a re-export, a side-effect import, a dynamic `import()` and a
 * `require()` are all counted. `@/` and relative specifiers are followed; a bare one is recorded and not
 * followed, since what a package imports is the package's affair.
 */
export function valueImportClosure(entry: string): ValueImportClosure {
  const walked = new Set<string>();
  const pending = [join(REPO_ROOT, entry)];
  const packages = new Set<string>();
  const unresolved: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (walked.has(file)) continue;
    walked.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const specifier of valueSpecifiersOf(file)) {
      if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      const resolved = moduleFileOf(specifier, file);
      if (resolved === undefined) unresolved.push(`${repoRelative(file)} imports ${specifier}`);
      else pending.push(resolved);
    }
  }
  return {
    modules: [...walked].map(repoRelative).sort(),
    packages: [...packages].sort(),
    unresolved,
  };
}

/**
 * What a module the VS Code extension's backend child runs must never reach: Next itself, and the two
 * server-only stores the child has no place for, query events and governance.
 */
export function serverOnlyReach(closure: ValueImportClosure): string[] {
  return [
    ...closure.packages.filter((name) => name === "next" || name.startsWith("next/")),
    ...closure.modules.filter(
      (path) => path.startsWith("src/lib/query-events/") || path.startsWith("src/lib/governance/"),
    ),
  ];
}
