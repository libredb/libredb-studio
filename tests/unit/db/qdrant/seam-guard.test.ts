/**
 * The Qdrant modules shipped to the browser import only each other (vector-family spec 6.11): routes.ts,
 * request.ts and guard.ts reach the editor through the dialect registry and the vocabulary row, and generators.ts,
 * labels.ts and type-spelling.ts through the query generators and the labels, so each may import the other browser
 * modules, the shared console and vector modules, the repository's error classes, and types, and only types, from
 * @/lib/types, @/lib/db/types and client.ts. Never qdrant-vocabulary.ts, results.ts, execute.ts or any other
 * module, and never a runtime built-in. Module names are resolved as TypeScript resolves them, so an alias counts.
 *
 * Each rule is proven both ways: the real sources pass, and a violation planted in a copy of a real file's text
 * fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER = "src/lib/db/providers/vector/qdrant";
const BROWSER_MODULES = ["routes.ts", "request.ts", "guard.ts", "generators.ts", "labels.ts", "type-spelling.ts"].map(
  (name) => `${PROVIDER}/${name}`,
);
const SHARED_DIRECTORIES = ["src/lib/db/console/", "src/lib/db/vector/"];
const TYPES_ONLY = ["src/lib/types.ts", "src/lib/db/types.ts", `${PROVIDER}/client.ts`];
const ANY_IMPORT = ["src/lib/db/errors.ts"];

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const relative = (path: string): string => path.slice(canonical(ROOT).length + 1);

let compilerOptions: ts.CompilerOptions | undefined;
function resolved(specifier: string, containing: string): string | undefined {
  if (compilerOptions === undefined) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
  }
  const resolution = ts.resolveModuleName(specifier, containing, compilerOptions, ts.sys).resolvedModule;
  return resolution === undefined ? undefined : relative(canonical(resolution.resolvedFileName));
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

/** What one browser module does that the rule does not allow, as findings. */
function seamFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  for (const { specifier, typeOnly } of references(file, text)) {
    if (specifier === undefined) {
      findings.push(`qdrant browser module: ${file} loads a module whose name is not a plain string`);
      continue;
    }
    if (isBuiltin(specifier) || specifier.startsWith("bun:")) {
      findings.push(`qdrant browser module: ${file} imports ${specifier}, a runtime built-in`);
      continue;
    }
    const target = resolved(specifier, join(ROOT, file));
    if (target !== undefined && TYPES_ONLY.includes(target)) {
      if (!typeOnly) {
        findings.push(
          `qdrant browser module: ${file} imports a value from ${specifier}; it takes types, and only types, from it`,
        );
      }
    } else if (
      target === undefined ||
      !(
        BROWSER_MODULES.includes(target) ||
        ANY_IMPORT.includes(target) ||
        SHARED_DIRECTORIES.some((directory) => target.startsWith(directory))
      )
    ) {
      findings.push(`qdrant browser module: ${file} imports ${specifier}, which a browser module may not import`);
    }
  }
  return findings;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("the Qdrant browser modules import only what the browser may run", () => {
  test("routes.ts, request.ts, guard.ts, generators.ts, labels.ts and type-spelling.ts hold the rule", () => {
    expect(BROWSER_MODULES.flatMap((file) => seamFindings(file, read(file)))).toEqual([]);
  });

  test("the detector reads real code", () => {
    expect(references("guard.ts", read(`${PROVIDER}/guard.ts`)).map((reference) => reference.specifier)).toContain(
      "./request",
    );
    expect(references("request.ts", read(`${PROVIDER}/request.ts`))).toContainEqual({
      specifier: "./client",
      typeOnly: true,
    });
  });
});

describe("planted violations fail by name", () => {
  test.each([
    [
      `${PROVIDER}/request.ts`,
      'import { qdrantMetric } from "./qdrant-vocabulary";\n',
      `qdrant browser module: ${PROVIDER}/request.ts imports ./qdrant-vocabulary, which a browser module may not import`,
    ],
    [
      `${PROVIDER}/guard.ts`,
      'import { qdrantResult } from "@/lib/db/providers/vector/qdrant/results";\n',
      `qdrant browser module: ${PROVIDER}/guard.ts imports @/lib/db/providers/vector/qdrant/results, which a browser module may not import`,
    ],
    [
      `${PROVIDER}/routes.ts`,
      'import { readFileSync } from "node:fs";\n',
      `qdrant browser module: ${PROVIDER}/routes.ts imports node:fs, a runtime built-in`,
    ],
    [
      `${PROVIDER}/routes.ts`,
      'import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";\n',
      `qdrant browser module: ${PROVIDER}/routes.ts imports @/lib/db/utils/json-integers, which a browser module may not import`,
    ],
    [
      `${PROVIDER}/request.ts`,
      'import { QDRANT_OPS } from "./client";\n',
      `qdrant browser module: ${PROVIDER}/request.ts imports a value from ./client; it takes types, and only types, from it`,
    ],
    [
      `${PROVIDER}/generators.ts`,
      'import { qdrantMetric } from "./qdrant-vocabulary";\n',
      `qdrant browser module: ${PROVIDER}/generators.ts imports ./qdrant-vocabulary, which a browser module may not import`,
    ],
    [
      `${PROVIDER}/type-spelling.ts`,
      'import { vectorColumnName } from "./columns";\n',
      `qdrant browser module: ${PROVIDER}/type-spelling.ts imports ./columns, which a browser module may not import`,
    ],
    [
      `${PROVIDER}/labels.ts`,
      'import { isVectorProvider } from "@/lib/db/types";\n',
      `qdrant browser module: ${PROVIDER}/labels.ts imports a value from @/lib/db/types; it takes types, and only types, from it`,
    ],
    [
      `${PROVIDER}/guard.ts`,
      'const loaded = await import(["./res", "ults"].join(""));\n',
      `qdrant browser module: ${PROVIDER}/guard.ts loads a module whose name is not a plain string`,
    ],
  ])("%s with %p fails", (file, planted, finding) => {
    expect(seamFindings(file, planted + read(file))).toEqual([finding]);
  });

  test.each([
    [`${PROVIDER}/guard.ts`, 'import { QDRANT_BOUNDS } from "./routes";\n'],
    [`${PROVIDER}/routes.ts`, 'import { QueryError } from "@/lib/db/errors";\n'],
    [`${PROVIDER}/routes.ts`, 'import { isFiniteFloat32 } from "@/lib/db/vector/float32";\n'],
    [`${PROVIDER}/guard.ts`, 'import type { QueryResult } from "@/lib/types";\n'],
  ])("%s with %p passes", (file, planted) => {
    expect(seamFindings(file, planted + read(file))).toEqual([]);
  });
});
