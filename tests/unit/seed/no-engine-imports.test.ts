/**
 * The built-in samples load no engine code at boot.
 *
 * Boot copies two committed, digest-pinned files (src/lib/seed/samples.ts) and opens no database, so nothing under
 * src/lib/seed may import a provider or an engine package, and the sample modules src/instrumentation.ts loads may not
 * reach one through any chain of value imports. Before the sample service, the two sample modules reached 112 provider
 * files and the LibreDB and SQLite engines from the boot hook.
 *
 * Both checks parse the sources with the TypeScript compiler, so a specifier in a comment or a string is never read as
 * an import. The first reads every import, export-from, `import()` and `require()` of every file under src/lib/seed,
 * type-only ones included. The second walks value edges only (an `import type` is erased before anything runs),
 * dynamic `import()` included, from the `@/lib/seed/...` modules instrumentation.ts imports.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SRC = path.join(ROOT, "src");
const SEED_DIR = path.join(SRC, "lib", "seed");
const PROVIDERS_DIR = path.join(SRC, "lib", "db", "providers");
const INSTRUMENTATION = path.join(SRC, "instrumentation.ts");

/** The packages that are engine code: the LibreDB engine and every SQLite binding Studio uses. */
const ENGINE_PACKAGES = ["@libredb/libredb", "bun:sqlite", "node:sqlite", "better-sqlite3"] as const;

interface ImportEdge {
  readonly specifier: string;
  /** Erased before anything runs: `import type`, `export type`, an import whose every binding is a type, `import("x").T`. */
  readonly typeOnly: boolean;
}

const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

/** Every import edge of `source`, read from its syntax tree. */
function importEdges(fileName: string, source: string): ImportEdge[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edges: ImportEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const everyBindingIsType =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: clause?.isTypeOnly === true || everyBindingIsType });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isImport || isRequire) && argument !== undefined && ts.isStringLiteralLike(argument)) {
        edges.push({ specifier: argument.text, typeOnly: false });
      }
    } else if (ts.isImportTypeNode(node)) {
      const literal = node.argument;
      if (ts.isLiteralTypeNode(literal) && ts.isStringLiteral(literal.literal)) {
        edges.push({ specifier: literal.literal.text, typeOnly: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return edges;
}

/** A `@/` or relative specifier resolved to its source file, or null for a package. Throws for one that names none. */
function resolveSource(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(fromFile)} imports ${specifier}, which resolves to no source file`);
}

const isProviderFile = (file: string): boolean => file.startsWith(`${PROVIDERS_DIR}${path.sep}`);

const isEnginePackage = (specifier: string): boolean =>
  ENGINE_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));

/** The engine imports among `edges` of `file`: a provider module, by alias or relative path, or an engine package. */
function engineImports(file: string, edges: readonly ImportEdge[]): string[] {
  return edges
    .filter(({ specifier }) => {
      if (isEnginePackage(specifier)) return true;
      const resolved = resolveSource(specifier, file);
      return resolved !== null && isProviderFile(resolved);
    })
    .map(({ specifier }) => `${relative(file)} imports ${specifier}`);
}

function sourceFilesUnder(directory: string): string[] {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

interface Walk {
  readonly files: ReadonlySet<string>;
  readonly packages: ReadonlySet<string>;
}

/** The files and packages reached from `seeds` through value edges, transitively. */
function valueClosure(seeds: readonly string[]): Walk {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const edge of importEdges(file, fs.readFileSync(file, "utf8"))) {
      if (edge.typeOnly) continue;
      const resolved = resolveSource(edge.specifier, file);
      if (resolved === null) packages.add(edge.specifier);
      else queue.push(resolved);
    }
  }
  return { files, packages };
}

/** The `@/lib/seed/...` modules instrumentation.ts imports, resolved. */
function seedModulesOfInstrumentation(): string[] {
  return importEdges(INSTRUMENTATION, fs.readFileSync(INSTRUMENTATION, "utf8"))
    .filter(({ specifier, typeOnly }) => !typeOnly && specifier.startsWith("@/lib/seed"))
    .map(({ specifier }) => resolveSource(specifier, INSTRUMENTATION) as string);
}

describe("the scan reads what it claims to read", () => {
  test("a planted provider import and a planted engine package import are found, in every import form", () => {
    const planted = path.join(SEED_DIR, "planted.ts");
    const source = [
      'import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";',
      'import type { Database } from "bun:sqlite";',
      'export { open } from "@libredb/libredb";',
      'const lazy = () => import("../db/providers/sql/sqlite");',
      'const required = require("node:sqlite");',
      'type T = import("better-sqlite3").Database;',
      '// import "@libredb/libredb" in a comment is not an import',
      'const text = "import(\\"bun:sqlite\\")";',
    ].join("\n");
    expect(engineImports(planted, importEdges(planted, source))).toEqual([
      "src/lib/seed/planted.ts imports @/lib/db/providers/sql/sqlite",
      "src/lib/seed/planted.ts imports bun:sqlite",
      "src/lib/seed/planted.ts imports @libredb/libredb",
      "src/lib/seed/planted.ts imports ../db/providers/sql/sqlite",
      "src/lib/seed/planted.ts imports node:sqlite",
      "src/lib/seed/planted.ts imports better-sqlite3",
    ]);
  });

  test("type-only edges are told apart from value edges", () => {
    const source = [
      'import type { A } from "./a";',
      'import { type B } from "./b";',
      'import { type C, d } from "./c";',
      'export type { E } from "./e";',
      'import "./f";',
    ].join("\n");
    expect(importEdges("x.ts", source)).toEqual([
      { specifier: "./a", typeOnly: true },
      { specifier: "./b", typeOnly: true },
      { specifier: "./c", typeOnly: false },
      { specifier: "./e", typeOnly: true },
      { specifier: "./f", typeOnly: false },
    ]);
  });

  test("the directory scan reads the sample service's modules", () => {
    const scanned = sourceFilesUnder(SEED_DIR).map(relative);
    expect(scanned).toContain("src/lib/seed/samples.ts");
    expect(scanned).toContain("src/lib/seed/sample-copy.ts");
    expect(scanned).toContain("src/lib/seed/sources/file.ts");
  });

  test("the walk starts from at least one seed module instrumentation.ts imports", () => {
    expect(seedModulesOfInstrumentation().map(relative)).toEqual(["src/lib/seed/samples.ts"]);
  });
});

describe("no engine code at boot", () => {
  test("nothing under src/lib/seed imports engine code", () => {
    const found = sourceFilesUnder(SEED_DIR).flatMap((file) =>
      engineImports(file, importEdges(file, fs.readFileSync(file, "utf8"))),
    );
    expect(found).toEqual([]);
  });

  test("the sample modules instrumentation loads reach no engine code", () => {
    const { files, packages } = valueClosure(seedModulesOfInstrumentation());
    expect([...files].filter(isProviderFile).map(relative)).toEqual([]);
    expect([...packages].filter(isEnginePackage)).toEqual([]);
    // And nothing that brings in the provider connection-string rows: the role filter is applied at request time.
    expect([...files].map(relative)).not.toContain("src/lib/seed/connection-filter.ts");
  });
});
