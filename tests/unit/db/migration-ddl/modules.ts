/**
 * The engine modules the migration DDL registry imports, read from `src/lib/db/migration-ddl/index.ts` itself, so
 * the seam and isolation tests hold the modules the registry really uses and not a list kept beside it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
export const REGISTRY = "src/lib/db/migration-ddl/index.ts";

export interface EngineModule {
  /** The type id, from the export name: `INFLUXDB3_MIGRATION_DDL` is `influxdb3`. */
  readonly id: string;
  /** The binding the registry imports. */
  readonly exportName: string;
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

export function engineModules(): EngineModule[] {
  const sf = ts.createSourceFile(REGISTRY, readFileSync(join(ROOT, REGISTRY), "utf8"), ts.ScriptTarget.Latest, true);
  const modules: EngineModule[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("@/lib/db/providers/")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exportName = (element.propertyName ?? element.name).text;
      const match = /^([A-Z0-9]+)_MIGRATION_DDL$/.exec(exportName);
      if (match === null) continue;
      modules.push({ id: match[1].toLowerCase(), exportName, specifier, path: fileOf(specifier) });
    }
  }
  return modules;
}
