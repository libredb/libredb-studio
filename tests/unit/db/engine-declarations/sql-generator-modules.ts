/**
 * The engine modules whose rows the query generators' registry collects as `SQL_ENGINE_GENERATORS`, read from
 * `src/lib/db/query-generators/index.ts` itself, so the census and the SQL generator replay hold the modules the
 * registry really uses and not a list kept beside it.
 *
 * The registry file also imports the dialect and language generator rows; only a binding named `<TYPE>_SQL_GENERATORS`
 * is an SQL engine's row, and its type id is the name's prefix lower-cased.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { fileOf, ROOT } from "../migration-ddl/modules";

export const SQL_GENERATORS_REGISTRY = "src/lib/db/query-generators/index.ts";

export interface SqlGeneratorModule {
  /** The type id, from the export name: `MSSQL_SQL_GENERATORS` is `mssql`. */
  readonly id: string;
  /** The binding the registry imports. */
  readonly exportName: string;
  /** The specifier as the registry spells it. */
  readonly specifier: string;
  /** The file, relative to the repository root. */
  readonly path: string;
}

/** Every provider module the registry file imports an SQL engine's generator row from, in the file's order. */
export function sqlGeneratorModules(): SqlGeneratorModule[] {
  const sf = ts.createSourceFile(
    SQL_GENERATORS_REGISTRY,
    readFileSync(join(ROOT, SQL_GENERATORS_REGISTRY), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const modules: SqlGeneratorModule[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("@/lib/db/providers/")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exportName = (element.propertyName ?? element.name).text;
      const match = /^([A-Z0-9]+)_SQL_GENERATORS$/.exec(exportName);
      if (match === null) continue;
      modules.push({ id: match[1].toLowerCase(), exportName, specifier, path: fileOf(specifier) });
    }
  }
  return modules;
}
