/**
 * The published engine id type of `@libredb/studio`, frozen until the library's next major: `DatabaseType`, the
 * union in src/lib/types.ts that the `index` and `types` entries export, and every published position whose type
 * names it.
 *
 * WHAT IT PINS. The package's entries (tsup's `entry`, held one to one to the types exports of package.json); the
 * alias's form, a union of string literals written in its own declaration, so it never moves with a table, a generated
 * module or a catalog; the entries that export it and the one declaration they export; its members, compared as a set;
 * and the published positions that name it, each keyed `<repository path> :: <dotted owner path>` followed by how it
 * is written: `?` when its declaration is optional, then its declaration's whole type, such as
 * `src/lib/types.ts :: DatabaseConnection.type: DatabaseType`.
 *
 * HOW IT READS. One TypeScript program over the package's entries with tsconfig.lib.json's options, built once and
 * shared by the tests below. From every export of every entry, the walk reads only the types the declaration emitter
 * publishes and follows their type references through every declaration of the repository it reaches: a declaration's
 * written type, its type parameters and parameters, an interface's or a class's heritage clauses and members, and for
 * a declaration written without a type, the type the checker infers for it, which is the type the emitter writes. It
 * never reads an initializer, a function body or an expression body, so a `satisfies` or a cast there is no position,
 * and it skips a `private` or `#private` class member, which the declarations publish without its type. It records
 * each place whose type reference or import type, such as `import("./types").DatabaseType`, resolves to the alias,
 * and keys an inferred type that names it by the type the checker prints for its declaration. An indexed access such
 * as `DatabaseConnection["type"]` is not recorded, since it follows a base position that is pinned in its own right. A
 * reference outside its declaration's written type, such as a type parameter's constraint or a heritage clause, is
 * refused by name, because it has no written form to key. It reads source, not the built `dist/`, so it runs in
 * `bun run test` on every platform without a build. Measured when it was written: the positions it finds are exactly
 * the ones rollup-plugin-dts names `DatabaseType` at in the built declarations (docs/TOOLCHAIN.md, "The published
 * engine id type (`DatabaseType`)").
 *
 * WHAT A DIFFERENCE MEANS. An added id or an added position is a deliberate edit of the frozen list below, made by the
 * change that ships it and stated in its PR as a new member or position of a published type: not breaking for a value
 * a consumer passes in, a new case for one it receives. A removed id, a removed position, or the alias or a position
 * opened to other text is breaking and waits for the library's next major. A position whose written type or whose
 * optionality changes, widened, narrowed or opened while it still names the alias, is reported removed under its old
 * form and added under its new one, so it is held as a removed position. The change that first gives core an engine
 * id outside the union declares the library's alias apart and keeps every published position on it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import tsupConfig from "../../tsup.config";

const ROOT = join(import.meta.dir, "..", "..");
const ALIAS_NAME = "DatabaseType";
const ALIAS_MODULE = "src/lib/types.ts";

/** Every test that builds or reads the program takes this timeout: the program takes seconds on a slow runner. */
const PROGRAM_TIMEOUT_MS = 60_000;

/** The engine ids the published alias holds, frozen until the library's next major. */
const FROZEN_ENGINE_IDS: readonly string[] = [
  "bigquery",
  "cassandra",
  "clickhouse",
  "couchbase",
  "databend",
  "db2",
  "druid",
  "duckdb",
  "elasticsearch",
  "etcd",
  "firestore",
  "influxdb",
  "influxdb3",
  "kafka",
  "kubernetes",
  "libredb",
  "libsql",
  "milvus",
  "modbus",
  "mongodb",
  "mqtt",
  "mssql",
  "mtconnect",
  "mysql",
  "neo4j",
  "netconf",
  "opcua",
  "opensearch",
  "oracle",
  "oxia",
  "postgres",
  "prometheus",
  "qdrant",
  "rabbitmq",
  "redis",
  "s3",
  "snmp",
  "snowflake",
  "spark",
  "sparkplug",
  "sqlite",
  "trino",
  "weaviate",
];

/**
 * The published positions whose type names the alias, frozen until the library's next major, each with how it is
 * written: `?` when its declaration is optional, then its declaration's whole type.
 */
const FROZEN_POSITIONS: readonly string[] = [
  "src/components/QueryEditor.tsx :: QueryEditorProps.databaseType?: DatabaseType",
  "src/components/ResultsGrid.tsx :: ResultsGridProps.databaseType?: DatabaseType",
  "src/lib/db/editor-language/types.ts :: EditorCompletionContext.databaseType?: DatabaseType",
  "src/lib/db/types.ts :: DatabaseProvider.type: DatabaseType",
  "src/lib/db/types.ts :: ObjectEditPlan.type: DatabaseType",
  "src/lib/types.ts :: DatabaseConnection.type: DatabaseType",
  "src/lib/types.ts :: SavedQuery.connectionType: DatabaseType",
  "src/lib/types.ts :: SchemaSnapshot.databaseType: DatabaseType",
  "src/workspace/types.ts :: StudioWorkspaceProps.onTestConnection.config.type: DatabaseType",
  "src/workspace/types.ts :: WorkspaceConnection.type: DatabaseType",
];

/** The entries that export the alias, each under its own name. */
const EXPORTING_ENTRIES: readonly string[] = ["index", "types"];

/** The subpaths of package.json `exports` that are not a tsup entry. */
const NON_ENTRY_SUBPATHS: readonly string[] = ["./styles.css"];

// ============================================================================
// The package's entries
// ============================================================================

/** A file's path relative to the repository root with `/` between its names, or `undefined` outside the root. */
function repositoryPath(fileName: string): string | undefined {
  const within = relative(ROOT, resolve(fileName));
  return within === "" || within.startsWith("..") || isAbsolute(within) ? undefined : within.split(sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} is not an object`);
  return value;
}

function stringAt(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} is not a string`);
  return value;
}

/** tsup's `entry`, by entry name: the module each entry builds from. */
function tsupEntries(): Record<string, string> {
  if (typeof tsupConfig === "function" || Array.isArray(tsupConfig)) {
    throw new Error("tsup.config.ts exports no single options object");
  }
  const entry = recordAt(tsupConfig.entry, "tsup.config.ts `entry`");
  return Object.fromEntries(Object.entries(entry).map(([name, source]) => [name, stringAt(source, `entry ${name}`)]));
}

/** The package.json subpath an entry is published at: `.` for `index`, `./<name>` for any other. */
function subpathOf(entry: string): string {
  return entry === "index" ? "." : `./${entry}`;
}

interface TypesExport {
  readonly importTypes: string;
  readonly requireTypes: string;
}

/** The types each entry's export should name, keyed by subpath, as tsup's entries give them. */
function expectedTypesExports(entries: Record<string, string>): Record<string, TypesExport> {
  return Object.fromEntries(
    Object.keys(entries).map((entry) => [
      subpathOf(entry),
      { importTypes: `./dist/${entry}.d.mts`, requireTypes: `./dist/${entry}.d.ts` },
    ]),
  );
}

function packageExports(): Record<string, unknown> {
  const manifest = recordAt(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")), "package.json");
  return recordAt(manifest.exports, "package.json `exports`");
}

/** The types package.json's exports name, keyed by subpath, for every subpath that is an entry. */
function publishedTypesExports(exports: Record<string, unknown>): Record<string, TypesExport> {
  const entrySubpaths = Object.keys(exports).filter((subpath) => !NON_ENTRY_SUBPATHS.includes(subpath));
  return Object.fromEntries(
    entrySubpaths.map((subpath) => {
      const conditions = recordAt(exports[subpath], `exports["${subpath}"]`);
      const importTypes = recordAt(conditions.import, `exports["${subpath}"].import`).types;
      const requireTypes = recordAt(conditions.require, `exports["${subpath}"].require`).types;
      return [
        subpath,
        {
          importTypes: stringAt(importTypes, `exports["${subpath}"].import.types`),
          requireTypes: stringAt(requireTypes, `exports["${subpath}"].require.types`),
        },
      ];
    }),
  );
}

// ============================================================================
// The program and the walk
// ============================================================================

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.lib.json"), ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(
      `tsconfig.lib.json cannot be read: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true, incremental: false };
}

interface PublishedExport {
  readonly entry: string;
  readonly exportedAs: string;
  readonly declaredAt: readonly string[];
}

interface Surface {
  readonly checker: ts.TypeChecker;
  /** Core's alias, the declaration src/lib/types.ts holds. */
  readonly alias: ts.Symbol;
  /** Each export of an entry that is named `DatabaseType` or resolves to core's alias. */
  readonly exports: readonly PublishedExport[];
  /** Each published position whose type reference resolves to core's alias. */
  readonly positions: readonly string[];
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function moduleExports(program: ts.Program, checker: ts.TypeChecker, modulePath: string): ts.Symbol[] {
  const file = program.getSourceFile(join(ROOT, modulePath));
  if (file === undefined) throw new Error(`${modulePath} is not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) throw new Error(`${modulePath} is not a module`);
  return checker.getExportsOfModule(moduleSymbol);
}

function coreAlias(program: ts.Program, checker: ts.TypeChecker): ts.Symbol {
  const alias = moduleExports(program, checker, ALIAS_MODULE).find((symbol) => symbol.name === ALIAS_NAME);
  if (alias === undefined) throw new Error(`${ALIAS_MODULE} exports no ${ALIAS_NAME}`);
  return alias;
}

/** The name a declaration kind contributes to an owner path, or `undefined` for a node that names no owner. */
function ownerSegment(node: ts.Node): string | undefined {
  const named =
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isVariableDeclaration(node);
  return named && node.name !== undefined ? node.name.getText() : undefined;
}

/** The dotted path of the named declarations that enclose a node, outermost first. */
function ownerPath(node: ts.Node): string {
  const segments: string[] = [];
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    const segment = ownerSegment(current);
    if (segment !== undefined) segments.unshift(segment);
  }
  return segments.join(".");
}

/** The innermost named declaration that encloses a node. */
function ownerOf(node: ts.Node, where: string): ts.Node {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ownerSegment(current) !== undefined) return current;
  }
  throw new Error(`${where} names ${ALIAS_NAME} outside any named declaration`);
}

/** The type a declaration is written with: a property's, a parameter's or a variable's, an alias's, or a return type. */
function declaredTypeNode(node: ts.Node): ts.TypeNode | undefined {
  if (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  ) {
    return node.type;
  }
  return undefined;
}

function isOptional(node: ts.Node): boolean {
  return (
    (ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node)) &&
    node.questionToken !== undefined
  );
}

/**
 * How a position that names the alias is written: `?` when the declaration that owns it is optional, then that
 * declaration's whole type, whitespace collapsed. A reference outside its declaration's written type, such as a type
 * parameter's constraint or a heritage clause, has no such text, so it is refused by name rather than keyed by owner.
 */
function writtenPosition(reference: ts.Node, where: string): string {
  const owner = ownerOf(reference, where);
  const type = declaredTypeNode(owner);
  if (type === undefined || reference.pos < type.pos || reference.end > type.end) {
    throw new Error(`${where} names ${ALIAS_NAME} outside its declaration's written type, which this test cannot key`);
  }
  return `${isOptional(owner) ? "?" : ""}: ${type.getText().replace(/\s+/g, " ")}`;
}

/** The name a type reference resolves through, or `undefined` for a node that is no type reference. */
function referencedName(node: ts.Node): ts.Node | undefined {
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isTypeQueryNode(node)) return node.exprName;
  if (ts.isImportTypeNode(node)) return node.qualifier;
  if (ts.isExpressionWithTypeArguments(node)) return node.expression;
  return undefined;
}

/**
 * A class member the declarations publish without its type: a `private` or `#private` one. A `private` parameter
 * property is not one, since the constructor's published signature keeps its type.
 */
function isPrivateMember(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  return (
    (member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

function present(...nodes: readonly (ts.Node | undefined)[]): ts.Node[] {
  return nodes.filter((node): node is ts.Node => node !== undefined);
}

/**
 * The children of a node that hold types the declaration emitter publishes as written: a declaration's type
 * annotation, its type parameters and parameters, an interface's or a class's heritage clauses and members, and every
 * type inside a type. Never an initializer, a function body or an expression body, and never a private class member,
 * since the declarations publish none of them as written. A node of a kind the walk has not classed is refused by name.
 */
function publishedChildren(node: ts.Node): readonly ts.Node[] {
  // A name resolves at the reference that holds it; a literal type holds no reference.
  if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node) || ts.isImportTypeNode(node)) {
    return node.typeArguments ?? [];
  }
  if (ts.isExpressionWithTypeArguments(node)) return node.typeArguments ?? [];
  if (ts.isLiteralTypeNode(node)) return [];
  if (ts.isTypeNode(node)) {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    return children;
  }
  if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) return present(node.type);
  if (ts.isVariableDeclaration(node)) return present(node.type);
  if (ts.isFunctionLike(node)) return [...(node.typeParameters ?? []), ...node.parameters, ...present(node.type)];
  if (ts.isTypeParameterDeclaration(node)) return present(node.constraint, node.default);
  if (ts.isTypeAliasDeclaration(node)) return [...(node.typeParameters ?? []), node.type];
  if (ts.isInterfaceDeclaration(node)) {
    return [...(node.typeParameters ?? []), ...(node.heritageClauses ?? []), ...node.members];
  }
  if (ts.isClassDeclaration(node)) {
    const members = node.members.filter(
      (member) => !isPrivateMember(member) && !ts.isClassStaticBlockDeclaration(member),
    );
    return [...(node.typeParameters ?? []), ...(node.heritageClauses ?? []), ...members];
  }
  if (ts.isHeritageClause(node)) return node.types;
  if (ts.isIdentifier(node) || ts.isQualifiedName(node) || ts.isPrivateIdentifier(node)) return [];
  if (ts.isEnumDeclaration(node) || ts.isEnumMember(node) || ts.isSemicolonClassElement(node)) return [];
  throw new Error(`the walk has not classed which children of a ${ts.SyntaxKind[node.kind]} are published`);
}

/**
 * The type the declarations publish for a declaration written without one, which the emitter takes from the checker:
 * a variable's, a property's or a parameter's inferred type, or a function's inferred return type. `undefined` when
 * the declaration is written with its type or publishes none.
 */
function inferredType(checker: ts.TypeChecker, node: ts.Node): ts.Type | undefined {
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) && !node.type) {
    return checker.getTypeAtLocation(node.name);
  }
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) &&
    !node.type
  ) {
    return checker.getSignatureFromDeclaration(node)?.getReturnType();
  }
  return undefined;
}

class PositionWalk {
  private readonly visited = new Set<ts.Declaration>();
  readonly positions = new Set<string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly alias: ts.Symbol,
  ) {}

  /** Walks a symbol's declarations, unless it is the alias itself. */
  walkSymbol(symbol: ts.Symbol): void {
    const resolved = resolveAlias(this.checker, symbol);
    if (resolved === this.alias) return;
    for (const declaration of resolved.declarations ?? []) this.walkDeclaration(declaration);
  }

  private walkDeclaration(declaration: ts.Declaration): void {
    if (this.visited.has(declaration)) return;
    const modulePath = repositoryPath(declaration.getSourceFile().fileName);
    if (modulePath === undefined || modulePath.split("/").includes("node_modules")) return;
    this.visited.add(declaration);
    this.visit(declaration, modulePath);
  }

  private visit(node: ts.Node, modulePath: string): void {
    const name = referencedName(node);
    const target = name === undefined ? undefined : this.checker.getSymbolAtLocation(name);
    if (target !== undefined) {
      if (resolveAlias(this.checker, target) === this.alias) {
        const where = `${modulePath} :: ${ownerPath(node)}`;
        this.positions.add(`${where}${writtenPosition(node, where)}`);
      } else {
        this.walkSymbol(target);
      }
    }
    for (const child of publishedChildren(node)) this.visit(child, modulePath);
    const inferred = inferredType(this.checker, node);
    if (inferred !== undefined) {
      const written = this.checker.typeToString(inferred, node, ts.TypeFormatFlags.NoTruncation);
      const position = `${modulePath} :: ${ownerPath(node)}${isOptional(node) ? "?" : ""}: ${written}`;
      this.walkType(inferred, new Set(), () => this.positions.add(position));
    }
  }

  /**
   * Walks an inferred type as the emitter writes it: an alias by its name and type arguments, a reference to an
   * interface or a class by its declarations and type arguments, a union or an intersection by its members, and any
   * other object type by its properties, signatures and index types. `onAlias` records the position when the type
   * names the alias.
   */
  private walkType(type: ts.Type, seen: Set<ts.Type>, onAlias: () => void): void {
    const aliasSymbol = type.aliasSymbol;
    if (aliasSymbol !== undefined && resolveAlias(this.checker, aliasSymbol) === this.alias) {
      onAlias();
      return;
    }
    if (seen.has(type)) return;
    seen.add(type);
    const walk = (inner: ts.Type): void => this.walkType(inner, seen, onAlias);
    if (aliasSymbol !== undefined) {
      this.walkSymbol(aliasSymbol);
      for (const argument of type.aliasTypeArguments ?? []) walk(argument);
      return;
    }
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) walk(member);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return;
    const objectFlags = (type as ts.ObjectType).objectFlags;
    if (objectFlags & ts.ObjectFlags.Reference) {
      const reference = type as ts.TypeReference;
      // A tuple's target has no symbol: its elements are its type arguments.
      if (reference.target.symbol !== undefined) this.walkSymbol(reference.target.symbol);
      for (const argument of this.checker.getTypeArguments(reference)) walk(argument);
      return;
    }
    if (objectFlags & ts.ObjectFlags.ClassOrInterface) {
      this.walkSymbol(type.symbol);
      return;
    }
    for (const property of this.checker.getPropertiesOfType(type)) walk(this.checker.getTypeOfSymbol(property));
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      for (const parameter of signature.getParameters()) walk(this.checker.getTypeOfSymbol(parameter));
      walk(signature.getReturnType());
    }
    for (const info of this.checker.getIndexInfosOfType(type)) walk(info.type);
  }
}

function declarationKey(declaration: ts.Declaration): string {
  return `${repositoryPath(declaration.getSourceFile().fileName)} :: ${ownerPath(declaration)}`;
}

function buildSurface(): Surface {
  const entries = tsupEntries();
  const program = ts.createProgram({
    rootNames: Object.values(entries).map((source) => join(ROOT, source)),
    options: compilerOptions(),
  });
  const checker = program.getTypeChecker();
  const alias = coreAlias(program, checker);
  const walk = new PositionWalk(checker, alias);
  const published: PublishedExport[] = [];
  for (const [entry, source] of Object.entries(entries)) {
    for (const exported of moduleExports(program, checker, source)) {
      const resolved = resolveAlias(checker, exported);
      if (exported.name === ALIAS_NAME || resolved === alias) {
        published.push({
          entry,
          exportedAs: exported.name,
          declaredAt: (resolved.declarations ?? []).map(declarationKey),
        });
      }
      walk.walkSymbol(exported);
    }
  }
  return { checker, alias, exports: published, positions: [...walk.positions].sort() };
}

let surface: Surface | undefined;

function theSurface(): Surface {
  surface ??= buildSurface();
  return surface;
}

/** The form a type node is written in: a union of string literals, or the syntax kind that is not one. */
function writtenForm(node: ts.TypeNode): string {
  if (!ts.isUnionTypeNode(node)) return `written as ${ts.SyntaxKind[node.kind]}`;
  const other = node.types.find((member) => !(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)));
  return other === undefined
    ? "a union of string literals"
    : `a union with a member written as ${ts.SyntaxKind[other.kind]}`;
}

/** What `actual` holds that `frozen` does not, and the reverse, each sorted. */
function difference(actual: Iterable<string>, frozen: readonly string[]): { added: string[]; removed: string[] } {
  const held = new Set(actual);
  return {
    added: [...held].filter((value) => !frozen.includes(value)).sort(),
    removed: frozen.filter((value) => !held.has(value)),
  };
}

// ============================================================================
// The tests
// ============================================================================

describe("the published DatabaseType, frozen until the library's next major", () => {
  test("the program's roots are the package's entries: one tsup entry for each types export of package.json", () => {
    const entries = tsupEntries();
    const exports = packageExports();

    expect(NON_ENTRY_SUBPATHS.filter((subpath) => !(subpath in exports))).toEqual([]);
    expect(publishedTypesExports(exports)).toEqual(expectedTypesExports(entries));
    expect(entries).toEqual(
      Object.fromEntries(Object.keys(entries).map((entry) => [entry, `src/exports/${entry}.ts`])),
    );
  });

  test(
    "DatabaseType is written as a union of string literals, and the index and types entries export that one declaration",
    () => {
      const { alias, exports } = theSurface();
      const declarations = alias.declarations ?? [];

      expect(declarations.map(declarationKey)).toEqual([`${ALIAS_MODULE} :: ${ALIAS_NAME}`]);
      expect(
        declarations.map((declaration) =>
          ts.isTypeAliasDeclaration(declaration) ? writtenForm(declaration.type) : "not a type alias",
        ),
      ).toEqual(["a union of string literals"]);
      expect(exports).toEqual(
        EXPORTING_ENTRIES.map((entry) => ({
          entry,
          exportedAs: ALIAS_NAME,
          declaredAt: [`${ALIAS_MODULE} :: ${ALIAS_NAME}`],
        })),
      );
    },
    PROGRAM_TIMEOUT_MS,
  );

  test(
    "DatabaseType holds exactly the frozen engine ids, compared as a set",
    () => {
      const { checker, alias } = theSurface();
      const declared = checker.getDeclaredTypeOfSymbol(alias);
      const members = declared.isUnion() ? declared.types : [declared];
      const ids = members.map((member) =>
        member.isStringLiteral() ? member.value : `not a string literal: ${checker.typeToString(member)}`,
      );

      expect(difference(ids, FROZEN_ENGINE_IDS)).toEqual({ added: [], removed: [] });
    },
    PROGRAM_TIMEOUT_MS,
  );

  test(
    "every published position that names DatabaseType is in the frozen list, and each listed position still names it",
    () => {
      expect(difference(theSurface().positions, FROZEN_POSITIONS)).toEqual({ added: [], removed: [] });
    },
    PROGRAM_TIMEOUT_MS,
  );
});
