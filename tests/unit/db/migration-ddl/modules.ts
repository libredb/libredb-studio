/**
 * The migration DDL function modules the registry imports, read from the import statements of
 * `src/lib/db/migration-ddl/index.ts` as source rather than from a list typed here, so the seam, isolation and
 * written-module tests cover every module the registry reaches and a new one the day it lands. `compose.test.ts` holds
 * each binding to the slot Studio's migration DDL function table binds it at.
 *
 * Each module's engine is read from its path: the directory of a `migration-ddl.ts`, and the prefix of an
 * `<id>-migration-ddl.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import ts from "typescript";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
export const REGISTRY = "src/lib/db/migration-ddl/index.ts";

export interface EngineModule {
  /** The type id the module's path names: `src/lib/db/providers/sql/mysql-migration-ddl.ts` is `mysql`. */
  readonly id: string;
  /** The bindings the registry imports from the module, each a function its migration DDL function table binds. */
  readonly exportNames: readonly string[];
  /** The specifier as the registry spells it. */
  readonly specifier: string;
  /** The file, relative to the repository root. */
  readonly path: string;
}

/** The repository file an `@/` specifier names, `.ts` first and then a directory's `index.ts`. */
export function fileOf(specifier: string): string {
  const base = `src/${specifier.slice(2)}`;
  if (existsSync(join(ROOT, `${base}.ts`))) return `${base}.ts`;
  return `${base}/index.ts`;
}

/** The engine a migration DDL function module's path names, or a thrown error naming a path of no such module. */
export function engineOfPath(path: string): string {
  const name = basename(path);
  if (name === "migration-ddl.ts") return basename(dirname(path));
  if (name.endsWith("-migration-ddl.ts")) return name.slice(0, -"-migration-ddl.ts".length);
  throw new Error(`${path} is no migration DDL function module`);
}

/** Every module the registry imports from a provider directory, with the bindings it imports, in path order. */
export function engineModules(): EngineModule[] {
  const sf = ts.createSourceFile(REGISTRY, readFileSync(join(ROOT, REGISTRY), "utf8"), ts.ScriptTarget.Latest, true);
  const modules: EngineModule[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("@/lib/db/providers/")) continue;
    const bindings = statement.importClause?.namedBindings;
    const exportNames =
      bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
        : [];
    const path = fileOf(specifier);
    modules.push({ id: engineOfPath(path), exportNames, specifier, path });
  }
  return modules.sort((a, b) => a.path.localeCompare(b.path));
}
