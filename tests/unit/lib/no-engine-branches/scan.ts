/**
 * Finds the places a source file branches on a database type id, by walking its syntax tree, for the guard in
 * `tests/unit/lib/no-engine-branches.test.ts` (engine contract spec 6.1).
 *
 * A branch is one of five shapes:
 *
 * - `keyed-table`: a `Record`, `Set`, `Map` or their read-only forms keyed by an engine type, or a mapped type over
 *   one, where an engine type is `DatabaseType`, the `type` of `DatabaseConnection` or of an alias of it, a type-id
 *   literal, a union with any member that is one (so `DatabaseType | "default"` counts), an `Exclude`, `Extract`,
 *   `NonNullable`, `Lowercase` or `Uncapitalize` of one, an `import("...")` type of one, or a type alias of any of
 *   these, declared in the same file or imported from another;
 * - `type-id-array`: an array literal holding a type-id string, or a non-empty one declared or asserted as an array of
 *   an engine type, one finding per array;
 * - `comparison`: `===`, `!==`, `==`, `!=` or `Object.is` with a type-id string on either side;
 * - `case-label`: a `case` whose label is a type-id string;
 * - `default-position`: a type-id string as the fallback of `||`, `??`, `||=` or `??=`, as a branch of a
 *   conditional, or as the default of a parameter or a destructured binding.
 *
 * A type-id string is a string literal, or a template literal with no substitution, whose whole text is a member of
 * the given set, or a `const` whose value is one, declared in the same file or imported from another, seen through
 * parentheses and `as`, `satisfies`, `<T>` and `!`. An imported name is followed through `import`, `export ... from`
 * and the `@/` path alias by the `read` callback, so moving a type alias or a constant into a shared file does not
 * take its branches out of sight.
 *
 * Each file is parsed in the syntax its extension names, and a file that does not parse fails the scan, because a
 * broken tree would hide every branch after the error.
 *
 * Comments, plain arguments, object keys and values, JSX attributes and longer words are never a finding: spec 6.4
 * names the four shapes above, and an object keyed or valued by type ids is data (a parser's result, a fence tag, a
 * registry row) far more often than a branch, so a per-engine table must be typed by an engine key to be seen.
 * A key read through a value's type (`keyof typeof X`, `(typeof X)[number]`) or through an interface other than
 * `DatabaseConnection` is not resolved either, since that needs the type checker rather than the syntax tree.
 */
import { posix } from "node:path";
import ts from "typescript";

export type BranchShape = "keyed-table" | "type-id-array" | "comparison" | "case-label" | "default-position";

export interface BranchFinding {
  readonly path: string;
  readonly declaration: string;
  readonly shape: BranchShape;
  readonly line: number;
  readonly text: string;
}

const KEYED_COLLECTIONS = new Set(["Record", "Set", "ReadonlySet", "Map", "ReadonlyMap", "WeakMap"]);
const ARRAYS = new Set(["Array", "ReadonlyArray"]);
const NARROWING_HELPERS = new Set(["Exclude", "Extract", "NonNullable", "Lowercase", "Uncapitalize"]);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const FALLBACK = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];

/** Reads a source file by its path from the repository root, or gives `undefined` when there is none. */
export type ReadModule = (path: string) => string | undefined;

/** A name another module gives this one: `import { name as local } from "from"`, or `export { name } from "from"`. */
interface Binding {
  readonly from: string;
  readonly name: string;
}

interface Module {
  readonly path: string;
  readonly source: string;
  readonly file: ts.SourceFile;
  readonly aliases: ReadonlyMap<string, ts.TypeNode>;
  readonly constants: ReadonlyMap<string, readonly ts.Expression[]>;
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly starExports: readonly string[];
}

/** The rightmost name of a type reference, so `types.DatabaseType` reads as `DatabaseType`. */
function referenceName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

function stringText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(c|m)?ts$/.test(path)) return ts.ScriptKind.TS;
  if (/\.(c|m)?js$/.test(path)) return ts.ScriptKind.JS;
  throw new Error(`${path} has no TypeScript or JavaScript extension to scan it by`);
}

const modules = new Map<string, Module>();

/** Parses a file in the syntax its extension names, and fails when it does not parse, since a broken tree hides branches. */
function parseModule(path: string, source: string): Module {
  const cached = modules.get(path);
  if (cached !== undefined && cached.source === source) return cached;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const { parseDiagnostics } = file as unknown as { readonly parseDiagnostics: readonly ts.Diagnostic[] };
  const first = parseDiagnostics[0];
  if (first !== undefined) {
    const line = file.getLineAndCharacterOfPosition(first.start ?? 0).line + 1;
    throw new Error(`${path}:${line} does not parse: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`);
  }

  const aliases = new Map<string, ts.TypeNode>();
  const bindings = new Map<string, Binding>();
  const starExports: string[] = [];
  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement.type);
    const from =
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined
        ? stringText(statement.moduleSpecifier)
        : undefined;
    if (from === undefined) continue;
    const named = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : (statement as ts.ExportDeclaration).exportClause;
    if (named === undefined && ts.isExportDeclaration(statement)) starExports.push(from);
    if (named === undefined || !(ts.isNamedImports(named) || ts.isNamedExports(named))) continue;
    for (const element of named.elements) {
      bindings.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
    }
  }

  const constants = new Map<string, ts.Expression[]>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constants.set(node.name.text, [...(constants.get(node.name.text) ?? []), node.initializer]);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  const parsed = { path, source, file, aliases, constants, bindings, starExports };
  modules.set(path, parsed);
  return parsed;
}

/**
 * A type id spelled in one module and read in another, followed through `import`, `export ... from` and the `@/`
 * path alias, so a branch cannot leave the guard's sight by moving its type alias or constant into a shared file.
 */
class Resolver {
  constructor(
    private readonly typeIds: ReadonlySet<string>,
    private readonly read: ReadModule,
  ) {}

  private resolve(from: Module, specifier: string): Module | undefined {
    const base = specifier.startsWith("@/")
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(from.path), specifier))
        : undefined;
    if (base === undefined) return undefined;
    for (const suffix of MODULE_SUFFIXES) {
      const path = `${base}${suffix}`;
      if (suffix === "" && !/\.(c|m)?(t|j)sx?$/.test(path)) continue;
      const source = this.read(path);
      if (source !== undefined) return parseModule(path, source);
    }
    return undefined;
  }

  /** Each module and name a name in `from` comes from, when it is no declaration of `from` itself. */
  private origins(from: Module, name: string): { module: Module; name: string }[] {
    const binding = from.bindings.get(name);
    const found: { module: Module; name: string }[] = [];
    if (binding !== undefined) {
      const target = this.resolve(from, binding.from);
      if (target !== undefined) found.push({ module: target, name: binding.name });
    }
    for (const specifier of from.starExports) {
      const target = this.resolve(from, specifier);
      if (target !== undefined) found.push({ module: target, name });
    }
    return found;
  }

  private follow(
    from: Module,
    name: string,
    seen: ReadonlySet<string>,
    test: (module: Module, name: string, seen: ReadonlySet<string>) => boolean,
  ): boolean {
    const key = `${from.path}#${name}`;
    if (seen.has(key)) return false;
    const next = new Set([...seen, key]);
    return this.origins(from, name).some((origin) => test(origin.module, origin.name, next));
  }

  isTypeId(module: Module, node: ts.Expression, seen: ReadonlySet<string> = new Set()): boolean {
    let inner: ts.Expression = node;
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isSatisfiesExpression(inner) ||
      ts.isTypeAssertionExpression(inner) ||
      ts.isNonNullExpression(inner)
    ) {
      inner = inner.expression;
    }
    if (ts.isIdentifier(inner)) return this.isTypeIdConstant(module, inner.text, seen);
    const text = stringText(inner);
    return text !== undefined && this.typeIds.has(text);
  }

  private isTypeIdConstant(module: Module, name: string, seen: ReadonlySet<string>): boolean {
    const key = `${module.path}#${name}`;
    if (seen.has(key)) return false;
    const initializers = module.constants.get(name);
    if (initializers !== undefined) {
      const next = new Set([...seen, key]);
      return initializers.some((initializer) => this.isTypeId(module, initializer, next));
    }
    return this.follow(module, name, seen, (target, imported, next) => this.isTypeIdConstant(target, imported, next));
  }

  isEngineType(module: Module, node: ts.TypeNode, seen: ReadonlySet<string> = new Set()): boolean {
    if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node))
      return this.isEngineType(module, node.type, seen);
    if (ts.isLiteralTypeNode(node)) {
      const text = stringText(node.literal);
      return text !== undefined && this.typeIds.has(text);
    }
    if (ts.isUnionTypeNode(node)) return node.types.some((member) => this.isEngineType(module, member, seen));
    if (ts.isIndexedAccessTypeNode(node)) {
      return (
        ts.isTypeReferenceNode(node.objectType) &&
        this.isConnection(module, referenceName(node.objectType.typeName), seen) &&
        ts.isLiteralTypeNode(node.indexType) &&
        stringText(node.indexType.literal) === "type"
      );
    }
    if (ts.isImportTypeNode(node)) {
      const specifier =
        ts.isLiteralTypeNode(node.argument) && node.qualifier !== undefined
          ? stringText(node.argument.literal)
          : undefined;
      if (specifier === undefined || node.qualifier === undefined) return false;
      const name = referenceName(node.qualifier);
      if (name === "DatabaseType") return true;
      const target = this.resolve(module, specifier);
      return target !== undefined && this.isEngineName(target, name, seen);
    }
    if (!ts.isTypeReferenceNode(node)) return false;
    const name = referenceName(node.typeName);
    const first = node.typeArguments?.[0];
    if (NARROWING_HELPERS.has(name)) return first !== undefined && this.isEngineType(module, first, seen);
    return this.isEngineName(module, name, seen);
  }

  private isEngineName(module: Module, name: string, seen: ReadonlySet<string>): boolean {
    if (name === "DatabaseType" || module.bindings.get(name)?.name === "DatabaseType") return true;
    const key = `${module.path}#${name}`;
    if (seen.has(key)) return false;
    const target = module.aliases.get(name);
    if (target !== undefined) return this.isEngineType(module, target, new Set([...seen, key]));
    return this.follow(module, name, seen, (origin, imported, next) => this.isEngineName(origin, imported, next));
  }

  private isConnection(module: Module, name: string, seen: ReadonlySet<string>): boolean {
    if (name === "DatabaseConnection" || module.bindings.get(name)?.name === "DatabaseConnection") return true;
    const key = `${module.path}#${name}`;
    if (seen.has(key)) return false;
    const target = module.aliases.get(name);
    if (target !== undefined) {
      return (
        ts.isTypeReferenceNode(target) &&
        this.isConnection(module, referenceName(target.typeName), new Set([...seen, key]))
      );
    }
    return this.follow(module, name, seen, (origin, imported, next) => this.isConnection(origin, imported, next));
  }

  /** An array type, read-only or not, of an engine type: `DatabaseType[]`, `readonly X[]`, `Array<X>`. */
  isEngineArrayType(module: Module, node: ts.TypeNode): boolean {
    if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node))
      return this.isEngineArrayType(module, node.type);
    if (ts.isArrayTypeNode(node)) return this.isEngineType(module, node.elementType);
    const first = ts.isTypeReferenceNode(node) ? node.typeArguments?.[0] : undefined;
    return (
      ts.isTypeReferenceNode(node) &&
      ARRAYS.has(referenceName(node.typeName)) &&
      first !== undefined &&
      this.isEngineType(module, first)
    );
  }
}

/** The type an array literal is declared or asserted as: a variable's annotation, `as`, `satisfies` or `<T>`. */
function declaredType(node: ts.Expression): ts.TypeNode | undefined {
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.initializer === current ? parent.type : undefined;
  }
  if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)) {
    return parent.type;
  }
  return undefined;
}

const isObjectIs = (node: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "Object" &&
  node.expression.name.text === "is";

export function findEngineBranches(
  path: string,
  source: string,
  typeIds: ReadonlySet<string>,
  read: ReadModule = () => undefined,
): BranchFinding[] {
  const scanned = parseModule(path, source);
  const { file } = scanned;
  const resolver = new Resolver(typeIds, read);
  const findings: BranchFinding[] = [];
  const isTypeId = (node: ts.Expression): boolean => resolver.isTypeId(scanned, node);
  const isEngineType = (node: ts.TypeNode): boolean => resolver.isEngineType(scanned, node);

  const declarationOf = (node: ts.Node): string => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (
        (ts.isVariableDeclaration(current) ||
          ts.isFunctionDeclaration(current) ||
          ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current) ||
          ts.isGetAccessorDeclaration(current) ||
          ts.isSetAccessorDeclaration(current) ||
          ts.isClassDeclaration(current) ||
          ts.isClassExpression(current) ||
          ts.isPropertyDeclaration(current) ||
          ts.isTypeAliasDeclaration(current) ||
          ts.isInterfaceDeclaration(current)) &&
        current.name !== undefined &&
        (ts.isIdentifier(current.name) || ts.isPrivateIdentifier(current.name) || ts.isStringLiteral(current.name))
      ) {
        return current.name.text;
      }
    }
    return "<module>";
  };

  const report = (node: ts.Node, shape: BranchShape): void => {
    findings.push({
      path,
      declaration: declarationOf(node),
      shape,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      text: node.getText(file).replace(/\s+/g, " "),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && KEYED_COLLECTIONS.has(referenceName(node.typeName))) {
      const key = node.typeArguments?.[0];
      if (key !== undefined && isEngineType(key)) report(node, "keyed-table");
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const key = node.typeArguments?.[0];
      if (KEYED_COLLECTIONS.has(node.expression.text) && key !== undefined && isEngineType(key)) {
        report(node, "keyed-table");
      }
    } else if (ts.isMappedTypeNode(node)) {
      const constraint = node.typeParameter.constraint;
      if (constraint !== undefined && isEngineType(constraint)) report(node, "keyed-table");
    } else if (ts.isArrayLiteralExpression(node)) {
      const declared = declaredType(node);
      if (
        node.elements.some(isTypeId) ||
        (node.elements.length > 0 && declared !== undefined && resolver.isEngineArrayType(scanned, declared))
      ) {
        report(node, "type-id-array");
      }
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (EQUALITY.has(operator) && (isTypeId(node.left) || isTypeId(node.right))) report(node, "comparison");
      else if (FALLBACK.has(operator) && isTypeId(node.right)) report(node, "default-position");
    } else if (ts.isCallExpression(node) && isObjectIs(node)) {
      if (node.arguments.some(isTypeId)) report(node, "comparison");
    } else if (ts.isCaseClause(node)) {
      if (isTypeId(node.expression)) report(node.expression, "case-label");
    } else if (ts.isConditionalExpression(node)) {
      if (isTypeId(node.whenTrue) || isTypeId(node.whenFalse)) report(node, "default-position");
    } else if (ts.isParameter(node) || ts.isBindingElement(node)) {
      if (node.initializer !== undefined && isTypeId(node.initializer)) report(node, "default-position");
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return findings;
}
