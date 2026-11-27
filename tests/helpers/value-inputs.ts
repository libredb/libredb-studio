/**
 * The value inputs of a module, read from its text by the TypeScript parser: every name it imports or re-exports, by
 * the specifier it names and the repository module that specifier resolves to. tests/unit/db/claim-grants.test.ts
 * reads the grant reader's inputs with it, and tests/unit/db/no-core-grant-records.test.ts every importer of a listed
 * grant name, so both hold one set of rules for what a module loads.
 */
import path from "node:path";
import ts from "typescript";

export interface Input {
  /** `<name> from <specifier>`, or the call that loads a module at run time. */
  readonly input: string;
  /** The repository path, without extension, of the module it loads, or null for a package. */
  readonly module: string | null;
}

/** `module`, a repository path, without its extension or a trailing `/index`. */
export function moduleOf(module: string): string {
  return module.replace(/\.(c|m)?(t|j)sx?$/, "").replace(/\/index$/, "");
}

/** The module `specifier` written in `file` resolves to, as `moduleOf` writes it, or null for a package. */
function resolved(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return moduleOf(`src/${specifier.slice(2)}`);
  if (specifier.startsWith("."))
    return moduleOf(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  return null;
}

/**
 * Every value input of `text`, the module at `file`: each name a non-type-only import or `export ... from`
 * declaration binds, `*` for a namespace import or an `export *`, the bare specifier for a side-effect import, and
 * every dynamic `import()` or `require()` call by its text. A type-only import or export loads nothing and is passed
 * over. The text is parsed in the script kind of `file`'s extension, so a `.tsx` module parses as TSX.
 */
export function valueInputs(file: string, text: string): readonly Input[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const inputs: Input[] = [];
  const add = (name: string, specifier: string) =>
    inputs.push({ input: `${name} from ${specifier}`, module: resolved(file, specifier) });
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause === undefined) add("(side effect)", specifier);
      else if (!clause.isTypeOnly) {
        if (clause.name !== undefined) add("default", specifier);
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) add("*", specifier);
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) add((element.propertyName ?? element.name).text, specifier);
          }
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) add("*", specifier);
      else {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) add((element.propertyName ?? element.name).text, specifier);
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      const specifier = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "";
      inputs.push({ input: node.getText(source), module: resolved(file, specifier) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return inputs;
}
