/**
 * The Milvus modules shipped to the browser (vector-family spec 5.11): the vocabulary row imports guard.ts, which
 * reaches routes.ts, request.ts and, through request.ts's phase 1 half, expr.ts and placeholder-group.ts, all
 * bundled into the editor. Each imports only another member of this set, the shared console and vector modules, and
 * types, never the gRPC adapter, the descriptor or a Node built-in. Proven both ways: the real sources pass, and a
 * planted import fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MILVUS_DIR = "src/lib/db/providers/vector/milvus";

/**
 * The browser-shipped set: the console's modules, the two modules request.ts's phase 1 half reaches, and the
 * generators, the type text they read back and the labels.
 */
const BROWSER_MODULES = [
  "routes",
  "request",
  "expr",
  "placeholder-group",
  "guard",
  "float32-text",
  "generators",
  "type-spelling",
  "labels",
];

const SHARED = [/^@\/lib\/db\/console\/[a-z-]+$/, /^@\/lib\/db\/vector\/[a-z0-9-]+$/];

/** Every value import of `source` (type-only imports and type-only names are allowed anywhere). */
function valueImports(source: string): string[] {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (onlyTypes) continue;
    } else if (statement.isTypeOnly) continue;
    found.push(specifier.text);
  }
  return found;
}

function findings(module: string, source: string): string[] {
  return valueImports(source)
    .filter((specifier) => {
      const sibling = /^\.\/([a-z0-9-]+)$/.exec(specifier);
      if (sibling !== null) return !BROWSER_MODULES.includes(sibling[1]);
      return !SHARED.some((pattern) => pattern.test(specifier));
    })
    .map((specifier) => `${module}.ts imports ${specifier}, which is not browser-safe`);
}

describe("the browser-shipped Milvus modules (5.11)", () => {
  test.each(BROWSER_MODULES.map((module) => [module]))(
    "%s.ts imports only the set, shared modules and types",
    (module) => {
      expect(findings(module, readFileSync(join(ROOT, MILVUS_DIR, `${module}.ts`), "utf8"))).toEqual([]);
    },
  );

  test.each([
    ['import { createGrpcMilvusClient } from "./grpc-client";\n', "./grpc-client"],
    ['import { MILVUS_DESCRIPTOR } from "./proto/descriptor";\n', "./proto/descriptor"],
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    ['import { fieldTypeText } from "./milvus-vocabulary";\n', "./milvus-vocabulary"],
    ['export { toMilvusError } from "./errors";\n', "./errors"],
  ])("a planted %s fails by name", (planted, specifier) => {
    expect(findings("request", planted)).toEqual([`request.ts imports ${specifier}, which is not browser-safe`]);
  });

  test("a type-only import of a server module is allowed", () => {
    expect(
      findings(
        "request",
        'import type { SearchRequest } from "./client";\nimport { type MilvusVersionGate } from "./versions";\n',
      ),
    ).toEqual([]);
  });
});
