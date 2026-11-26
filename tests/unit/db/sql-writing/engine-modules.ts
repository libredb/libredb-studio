/**
 * The engine SQL writing function modules as the registry imports them, read from the import statements of
 * `src/lib/db/sql-writing/index.ts` as source rather than from a list typed here, so the seam, isolation and census
 * tests cover every module the registry reaches and a new one the day it lands. `compose.test.ts` holds each binding to
 * the slot Studio's SQL writing function table binds it at.
 *
 * Each module's engine is read from its path: the directory of a `sql-writing.ts` or `typed-literals.ts`, and the
 * prefix of an `<id>-sql-writing.ts` or `<id>-typed-literals.ts`. The typed writer siblings are also found on disk,
 * each with the engine its path names, so a sibling the registry stops importing is still held by the seam.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import ts from "typescript";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDERS = join(ROOT, "src", "lib", "db", "providers");
export const REGISTRY_INDEX = join(ROOT, "src", "lib", "db", "sql-writing", "index.ts");

export interface EngineModule {
  /** The type id the module's path names: `src/lib/db/providers/sql/mssql-sql-writing.ts` is `mssql`. */
  readonly id: string;
  /** The bindings the registry imports from the module, each a function its SQL writing function table binds. */
  readonly exportNames: readonly string[];
  /** The specifier as the registry spells it. */
  readonly specifier: string;
  readonly absPath: string;
  /** The path from the repo root, `src/lib/db/providers/sql/mssql-sql-writing.ts`. */
  readonly repoPath: string;
}

/** The module file names whose engine is their directory's name, and the suffixes whose engine is their prefix. */
const DIRECTORY_NAMED = ["sql-writing.ts", "typed-literals.ts"];
const PREFIX_NAMED = ["-sql-writing.ts", "-typed-literals.ts"];

/** The engine a SQL writing function module's path names, or a thrown error naming a path of no such module. */
function engineOfPath(absPath: string): string {
  const name = basename(absPath);
  if (DIRECTORY_NAMED.includes(name)) return basename(dirname(absPath));
  const suffix = PREFIX_NAMED.find((candidate) => name.endsWith(candidate));
  if (suffix === undefined) throw new Error(`${absPath} is no SQL writing function module`);
  return name.slice(0, -suffix.length);
}

const repoPathOf = (absPath: string): string => relative(ROOT, absPath).split("\\").join("/");

/** The file an `@/` specifier names. */
function fileOf(specifier: string): string {
  const base = join(ROOT, "src", specifier.slice(2));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier} imported by the SQL writing index resolves to no file`);
}

/** Every module the registry imports from a provider directory, with the bindings it imports, in path order. */
export const ENGINE_MODULES: readonly EngineModule[] = (() => {
  const source = ts.createSourceFile(
    REGISTRY_INDEX,
    readFileSync(REGISTRY_INDEX, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const modules: EngineModule[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("@/lib/db/providers/")) continue;
    const bindings = statement.importClause?.namedBindings;
    const exportNames =
      bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
        : [];
    const absPath = fileOf(specifier);
    modules.push({ id: engineOfPath(absPath), exportNames, specifier, absPath, repoPath: repoPathOf(absPath) });
  }
  return modules.sort((a, b) => a.repoPath.localeCompare(b.repoPath));
})();

export interface TypedLiteralModule {
  /** The type id the sibling's path names. */
  readonly ownerId: string;
  readonly absPath: string;
  /** The path from the repo root, `src/lib/db/providers/sql/postgres-typed-literals.ts`. */
  readonly repoPath: string;
}

/**
 * The siblings an engine's typed writer lives in (spec 5.3), found on disk: `typed-literals.ts` in an engine's
 * directory, or `<id>-typed-literals.ts`.
 */
export const TYPED_LITERAL_MODULES: readonly TypedLiteralModule[] = (function find(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return find(full);
    return entry.name === "typed-literals.ts" || entry.name.endsWith("-typed-literals.ts") ? [full] : [];
  });
})(PROVIDERS)
  .sort()
  .map((absPath) => ({ ownerId: engineOfPath(absPath), absPath, repoPath: repoPathOf(absPath) }));
