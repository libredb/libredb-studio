/**
 * The engine function modules as the registry imports them, read from the TypeScript AST of
 * `src/lib/db/sql-grammar/index.ts` rather than from a list typed here, so the seam and isolation tests cover every
 * module the registry reaches and a new one the day it lands. `compose.test.ts` holds each binding to the slot Studio's
 * grammar function table binds it at.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
export const REGISTRY_DIR = join(ROOT, "src", "lib", "db", "sql-grammar");
export const REGISTRY_INDEX = join(REGISTRY_DIR, "index.ts");

/** One import, export-from, `import()` or `require()` of a source file. */
export interface ModuleImport {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}

export interface EngineModule {
  readonly id: string;
  /** The bindings the registry imports from the module, each a function its grammar function table binds. */
  readonly exportNames: readonly string[];
  readonly specifier: string;
  readonly path: string;
}

/** Every import of a file, including re-exports and calls, so none can reach past the seam unread. */
export function importsOf(path: string): ModuleImport[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: ModuleImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      let typeOnly = clause?.isTypeOnly ?? false;
      if (clause?.name) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
        if (!typeOnly && clause?.name === undefined && bindings.elements.length > 0) {
          typeOnly = bindings.elements.every((element) => element.isTypeOnly);
        }
      } else if (bindings) {
        names.push("*");
      }
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: clause !== undefined && typeOnly, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const names =
        clause && ts.isNamedExports(clause) ? clause.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"];
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((e) => e.isTypeOnly));
      found.push({ specifier: node.moduleSpecifier.text, typeOnly, names });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      const specifier = argument && ts.isStringLiteralLike(argument) ? argument.text : "<computed>";
      found.push({ specifier, typeOnly: false, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The file a specifier names, for the `@/` alias and relative paths; null for a package. */
export function resolveSpecifier(specifier: string, fromPath: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(dirname(fromPath), specifier);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier} imported by ${fromPath} resolves to no file`);
}

/** The suffixes of the bindings the registry imports from a function module, one per slot kind of its function table. */
const FUNCTION_SUFFIXES = ["_REDACTION_READER", "_FORMAT_SEGMENT", "_READ_QUOTED_QUALIFIER"] as const;

/**
 * Every function module the registry imports from a provider directory, one per engine, with the bindings it imports
 * from it: the modules that hold the functions Studio's grammar function table binds to the names a declaration or the
 * redaction record gives.
 */
export function engineModules(): EngineModule[] {
  const modules: EngineModule[] = [];
  for (const entry of importsOf(REGISTRY_INDEX)) {
    if (!entry.specifier.startsWith("@/lib/db/providers/")) continue;
    const path = resolveSpecifier(entry.specifier, REGISTRY_INDEX) as string;
    const prefixes = new Set(
      entry.names.map((name) => {
        const suffix = FUNCTION_SUFFIXES.find((candidate) => name.endsWith(candidate));
        if (suffix === undefined) throw new Error(`${name} from ${entry.specifier} is no grammar function`);
        return name.slice(0, -suffix.length);
      }),
    );
    if (prefixes.size !== 1) throw new Error(`${entry.specifier} holds the functions of more than one engine`);
    const [prefix] = prefixes;
    modules.push({ id: prefix.toLowerCase(), exportNames: entry.names, specifier: entry.specifier, path });
  }
  return modules.sort((a, b) => a.id.localeCompare(b.id));
}
