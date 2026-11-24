/**
 * The published engine id type of `@libredb/studio`, frozen until the library's next major: `DatabaseType`, the
 * union in src/lib/types.ts that the `index` and `types` entries export, and every published position whose type
 * names it.
 *
 * WHAT IT PINS. The package's entries (tsup's `entry`, held one to one to the types exports of package.json); the
 * alias's form, a union of string literals written in its own declaration, so it never moves with a table, a generated
 * module or a catalog; the entries that export it and the one declaration they export; its members, compared as a set;
 * and the published positions that name it, each keyed `<repository path> :: <dotted owner path>`.
 *
 * HOW IT READS. One TypeScript program over the package's entries with tsconfig.lib.json's options, built once and
 * shared by the tests below. From every export of every entry, the walk follows type references through every
 * declaration of the repository it reaches, skipping function bodies, because only a declared shape is published, and
 * records each place whose type reference resolves to the alias. It reads source, not the built `dist/`, so it runs in
 * `bun run test` on every platform without a build. Measured when it was written: the positions it finds are exactly
 * the ones rollup-plugin-dts names `DatabaseType` at in the built declarations (docs/TOOLCHAIN.md, "The published
 * engine id type (`DatabaseType`)").
 *
 * WHAT A DIFFERENCE MEANS. An added id or an added position is a deliberate edit of the frozen list below, made by the
 * change that ships it and stated in its PR as a new member or position of a published type: not breaking for a value
 * a consumer passes in, a new case for one it receives. A removed id, a removed position, or the alias or a position
 * opened to other text is breaking and waits for the library's next major. The change that first gives core an engine
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

/** The published positions whose type names the alias, frozen until the library's next major. */
const FROZEN_POSITIONS: readonly string[] = [
  "src/components/QueryEditor.tsx :: QueryEditorProps.databaseType",
  "src/components/ResultsGrid.tsx :: ResultsGridProps.databaseType",
  "src/lib/db/editor-language/types.ts :: EditorCompletionContext.databaseType",
  "src/lib/db/types.ts :: DatabaseProvider.type",
  "src/lib/db/types.ts :: ObjectEditPlan.type",
  "src/lib/types.ts :: DatabaseConnection.type",
  "src/lib/types.ts :: SavedQuery.connectionType",
  "src/lib/types.ts :: SchemaSnapshot.databaseType",
  "src/workspace/types.ts :: StudioWorkspaceProps.onTestConnection.config.type",
  "src/workspace/types.ts :: WorkspaceConnection.type",
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

/** The name a type reference resolves through, or `undefined` for a node that is no type reference. */
function referencedName(node: ts.Node): ts.Node | undefined {
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isTypeQueryNode(node)) return node.exprName;
  if (ts.isExpressionWithTypeArguments(node)) return node.expression;
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
    // A body is never published: only the declared shape reaches the declarations.
    if (ts.isBlock(node)) return;
    const name = referencedName(node);
    const target = name === undefined ? undefined : this.checker.getSymbolAtLocation(name);
    if (target !== undefined) {
      if (resolveAlias(this.checker, target) === this.alias) this.positions.add(`${modulePath} :: ${ownerPath(node)}`);
      else this.walkSymbol(target);
    }
    ts.forEachChild(node, (child) => this.visit(child, modulePath));
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
