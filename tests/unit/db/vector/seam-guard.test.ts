/**
 * The vector family's seam guard (vector-family spec 3.2): the browser-safe set imports nothing but itself.
 *
 * The set is every file of src/lib/db/vector/ and src/lib/db/console/, and src/lib/editor/console-language.ts. A
 * member may import another member; types, and only types, from @/lib/types; the error classes of @/lib/db/errors;
 * and, for the editor file alone, types from monaco-editor. Nothing else: no Node built-in, no provider module, no
 * other module of the repository, and no engine's name anywhere in the file. Module names are resolved as
 * TypeScript resolves them, with the repository's tsconfig, so an alias counts as well as a relative path.
 *
 * Each rule is proven both ways: the real sources pass, and a violation planted in a copy of a real file's text
 * fails by name. The guard is syntactic, as etcd's is (tests/unit/db/etcd/seam-guard.test.ts): a module name built
 * at run time is refused as not a plain string rather than chased.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DIRECTORIES = ["src/lib/db/vector", "src/lib/db/console"];
const EDITOR_FILE = "src/lib/editor/console-language.ts";
const TYPES_ONLY = new Set(["src/lib/types.ts"]);
const ANY_IMPORT = new Set(["src/lib/db/errors.ts"]);
const ENGINE_NAMES = /\b(milvus|qdrant|zilliz)\b/i;

/** Every file of the browser-safe set, as repository-relative paths. */
function browserSafeFiles(): string[] {
  const members = DIRECTORIES.flatMap((directory) =>
    readdirSync(join(ROOT, directory))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `${directory}/${name}`),
  );
  return [...members, EDITOR_FILE].sort();
}

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");

let compilerOptions: ts.CompilerOptions | undefined;
function resolved(specifier: string, containing: string): string | undefined {
  if (compilerOptions === undefined) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
  }
  const resolution = ts.resolveModuleName(specifier, containing, compilerOptions, ts.sys).resolvedModule;
  return resolution === undefined ? undefined : canonical(resolution.resolvedFileName);
}

interface Reference {
  readonly specifier: string | undefined;
  readonly typeOnly: boolean;
}

/** Every module a file loads: an import, a re-export, an import type, import() and require(). */
function references(file: string, text: string): Reference[] {
  const found: Reference[] = [];
  const plain = (node: ts.Node | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)));
      found.push({ specifier: plain(node.moduleSpecifier), typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      found.push({ specifier: plain(node.moduleSpecifier), typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      found.push({ specifier: ts.isLiteralTypeNode(argument) ? plain(argument.literal) : undefined, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found.push({ specifier: plain(node.arguments[0]), typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** What one file of the set does that the set does not allow, as findings. */
function seamFindings(file: string, text: string): string[] {
  const members = new Set(browserSafeFiles().map((member) => canonical(join(ROOT, member))));
  const shared = (paths: ReadonlySet<string>) =>
    new Set([...paths].filter((path) => existsSync(join(ROOT, path))).map((path) => canonical(join(ROOT, path))));
  const typesOnly = shared(TYPES_ONLY);
  const anyImport = shared(ANY_IMPORT);
  const findings: string[] = [];
  for (const { specifier, typeOnly } of references(file, text)) {
    if (specifier === undefined) {
      findings.push(`browser-safe set: ${file} loads a module whose name is not a plain string`);
      continue;
    }
    if (isBuiltin(specifier) || specifier.startsWith("bun:")) {
      findings.push(`browser-safe set: ${file} imports ${specifier}, a runtime built-in`);
      continue;
    }
    if (specifier === "monaco-editor" && file === EDITOR_FILE) {
      if (!typeOnly)
        findings.push(
          `browser-safe set: ${file} imports a value from monaco-editor; it takes types, and only types, from it`,
        );
      continue;
    }
    const target = resolved(specifier, join(ROOT, file));
    if (target?.includes("/src/lib/db/providers/")) {
      findings.push(`browser-safe set: ${file} imports ${specifier}, a provider module`);
    } else if (target !== undefined && typesOnly.has(target)) {
      if (!typeOnly)
        findings.push(
          `browser-safe set: ${file} imports a value from ${specifier}; it takes types, and only types, from it`,
        );
    } else if (target === undefined || (!members.has(target) && !anyImport.has(target))) {
      findings.push(`browser-safe set: ${file} imports ${specifier}, which the browser-safe set does not allow`);
    }
  }
  const engine = ENGINE_NAMES.exec(text);
  if (engine !== null) findings.push(`browser-safe set: ${file} names the engine ${engine[1]}`);
  return findings;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("the browser-safe set imports nothing but itself (spec 3.2)", () => {
  test("every file of the set holds the rule", () => {
    const files = browserSafeFiles();
    expect(files).toContain(EDITOR_FILE);
    expect(files).toContain("src/lib/db/console/parser.ts");
    expect(files).toContain("src/lib/db/vector/dense.ts");
    expect(files.flatMap((file) => seamFindings(file, read(file)))).toEqual([]);
  });

  test("the detector reads real code: the set's own imports resolve to members and to the shared modules", () => {
    expect(
      references("dense.ts", read("src/lib/db/vector/dense.ts")).map((reference) => reference.specifier),
    ).toContain("../console/tagged-json");
    expect(references("score.ts", read("src/lib/db/vector/score.ts"))).toContainEqual({
      specifier: "@/lib/types",
      typeOnly: true,
    });
    expect(references("dialect.ts", read("src/lib/db/console/dialect.ts"))).toContainEqual({
      specifier: "@/lib/db/errors",
      typeOnly: false,
    });
    expect(references(EDITOR_FILE, read(EDITOR_FILE))).toContainEqual({ specifier: "monaco-editor", typeOnly: true });
  });
});

describe("planted violations fail by name", () => {
  test.each([
    [
      "src/lib/db/vector/dense.ts",
      'import { readFileSync } from "node:fs";\n',
      "browser-safe set: src/lib/db/vector/dense.ts imports node:fs, a runtime built-in",
    ],
    [
      "src/lib/db/console/bounds.ts",
      'import { Buffer } from "buffer";\n',
      "browser-safe set: src/lib/db/console/bounds.ts imports buffer, a runtime built-in",
    ],
    [
      "src/lib/db/console/lexer.ts",
      'import { tokenizeLine as etcdLine } from "@/lib/db/providers/keyvalue/etcd/lexer";\n',
      "browser-safe set: src/lib/db/console/lexer.ts imports @/lib/db/providers/keyvalue/etcd/lexer, a provider module",
    ],
    [
      "src/lib/db/vector/score.ts",
      'import { cn } from "@/lib/utils";\n',
      "browser-safe set: src/lib/db/vector/score.ts imports @/lib/utils, which the browser-safe set does not allow",
    ],
    [
      "src/lib/db/vector/score.ts",
      'import { QueryWarning as Warning } from "@/lib/types";\n',
      "browser-safe set: src/lib/db/vector/score.ts imports a value from @/lib/types; it takes types, and only types, from it",
    ],
    [
      EDITOR_FILE,
      'import * as monacoValue from "monaco-editor";\n',
      "browser-safe set: src/lib/editor/console-language.ts imports a value from monaco-editor; it takes types, and only types, from it",
    ],
    [
      "src/lib/db/vector/probe.ts",
      'import type * as Monaco from "monaco-editor";\n',
      "browser-safe set: src/lib/db/vector/probe.ts imports monaco-editor, which the browser-safe set does not allow",
    ],
    [
      "src/lib/db/console/guard.ts",
      'const lexer = await import(["./lex", "er"].join(""));\n',
      "browser-safe set: src/lib/db/console/guard.ts loads a module whose name is not a plain string",
    ],
    [
      EDITOR_FILE,
      "// reads Qdrant answers\n",
      "browser-safe set: src/lib/editor/console-language.ts names the engine Qdrant",
    ],
    [
      "src/lib/db/vector/count.ts",
      'const label = "milvus";\n',
      "browser-safe set: src/lib/db/vector/count.ts names the engine milvus",
    ],
  ])("%s with %p fails", (file, planted, finding) => {
    expect(seamFindings(file, planted + read(file))).toEqual([finding]);
  });

  test.each([
    ["src/lib/db/vector/score.ts", 'import type { QueryResult } from "@/lib/types";\n'],
    ["src/lib/db/vector/count.ts", 'import { QueryError } from "@/lib/db/errors";\n'],
    ["src/lib/db/vector/count.ts", 'import { utf8ByteLength } from "../console/bounds";\n'],
    ["src/lib/db/console/guard.ts", 'import type { VectorTarget } from "@/lib/db/vector/dense";\n'],
  ])("%s with %p passes", (file, planted) => {
    expect(seamFindings(file, planted + read(file))).toEqual([]);
  });
});
