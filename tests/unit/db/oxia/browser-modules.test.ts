/**
 * The Oxia modules shipped to the browser (SB2-1, SB2-3.5, contract section 12): the vocabulary row imports guard.ts,
 * which reaches commands.ts, lexer.ts and constants.ts, all bundled into the editor with the Monaco language; the
 * query generators import generators.ts, provider-meta serves labels.ts, and the Keys panel's cursor and the key
 * order are pure modules the server shares with them. Each
 * imports only another member of this set, the shared console modules and types, never a server module, a Node
 * built-in or the shared gRPC transport, and none names `Buffer`. Proven both ways: the real sources pass, and a
 * planted import fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OXIA_DIR = "src/lib/db/providers/keyvalue/oxia";

/** The browser-shipped set: the console (T08), the key order and the cursor (T06), the labels and the generators (T12). */
const BROWSER_MODULES = ["constants", "lexer", "commands", "guard", "order", "cursor", "labels", "generators"];

const SHARED = [/^@\/lib\/db\/console\/[a-z-]+$/];

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
  const imports = valueImports(source)
    .filter((specifier) => {
      const sibling = /^\.\/([a-z0-9-]+)$/.exec(specifier);
      if (sibling !== null) return !BROWSER_MODULES.includes(sibling[1]);
      return !SHARED.some((pattern) => pattern.test(specifier));
    })
    .map((specifier) => `${module}.ts imports ${specifier}, which is not browser-safe`);
  // Buffer is Node's; a browser module that names it fails in the editor bundle, not in a server test.
  const buffer = /\bBuffer\b/.test(source) ? [`${module}.ts names Buffer, which the browser does not have`] : [];
  return [...imports, ...buffer];
}

describe("the browser-shipped Oxia modules", () => {
  test.each(BROWSER_MODULES.map((module) => [module]))(
    "%s.ts imports only the set, shared console modules and types",
    (module) => {
      expect(findings(module, readFileSync(join(ROOT, OXIA_DIR, `${module}.ts`), "utf8"))).toEqual([]);
    },
  );

  test.each([
    ['import { grpcTarget } from "@/lib/db/grpc/tls";\n', "@/lib/db/grpc/tls"],
    ['import { toOxiaError } from "./errors";\n', "./errors"],
    ['import { createGrpcOxiaClient } from "./grpc-client";\n', "./grpc-client"],
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    ['import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";\n', "@/lib/db/utils/query-limiter"],
    ['export { viewOxiaValue } from "./values";\n', "./values"],
  ])("a planted %s in commands.ts fails by name", (planted, specifier) => {
    expect(findings("commands", planted)).toEqual([`commands.ts imports ${specifier}, which is not browser-safe`]);
  });

  test("a planted walks import in labels.ts fails by name", () => {
    expect(findings("labels", 'import { detectKeyOrder } from "./walks";\n')).toEqual([
      "labels.ts imports ./walks, which is not browser-safe",
    ]);
  });

  test("a planted Buffer fails by name", () => {
    expect(findings("lexer", "const bytes = Buffer.from(text);\n")).toEqual([
      "lexer.ts names Buffer, which the browser does not have",
    ]);
  });

  test("a type-only import of a server module is allowed", () => {
    expect(
      findings(
        "commands",
        'import type { OxiaClient } from "./client";\nimport { type DatabaseType } from "@/lib/types";\n',
      ),
    ).toEqual([]);
  });
});
