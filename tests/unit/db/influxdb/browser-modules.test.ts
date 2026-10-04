/**
 * The InfluxQL modules shipped to the browser (SPEC 3.1, E18): the editor, the confirmation gate row and the
 * query generators import the lexer, the policy, the quoter and the generators, so each of the four imports only
 * another member of the set and types, never a Node built-in, `@/lib/db/http/*` or a server module of the
 * directory. Bytes are measured with `TextEncoder`, so none of the four names `Buffer` outside a comment: it is a
 * Node global, which an import check cannot see. Proven both ways: the real sources pass, and a planted import or
 * `Buffer` fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const INFLUXDB_DIR = "src/lib/db/providers/timeseries/influxdb";

/** The browser-safe set, exactly (SPEC 3.1). */
const BROWSER_MODULES = ["influxql-lexer", "influxql-policy", "influxql-quote", "influxql-generators"];

/**
 * Every value import or re-export of `source`, plus every dynamic `import("...")` and `require("...")` (type-only
 * imports and type-only names are allowed anywhere).
 */
function valueImports(file: ts.SourceFile): string[] {
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
  const visit = (node: ts.Node): void => {
    const loads =
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"));
    const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (loads && argument !== undefined && ts.isStringLiteralLike(argument)) found.push(argument.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every identifier `Buffer` in code, and every element access by the string `"Buffer"` (`globalThis["Buffer"]`);
 * a comment or a plain string literal holds no identifier.
 */
function bufferReferences(file: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "Buffer") count += 1;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "Buffer"
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

function findings(module: string, source: string): string[] {
  const file = ts.createSourceFile(`${module}.ts`, source, ts.ScriptTarget.Latest, true);
  const imports = valueImports(file)
    .filter((specifier) => {
      const sibling = /^\.\/([a-z0-9-]+)$/.exec(specifier);
      return sibling === null || !BROWSER_MODULES.includes(sibling[1]);
    })
    .map((specifier) => `${module}.ts imports ${specifier}, which is not browser-safe`);
  const buffers = bufferReferences(file) > 0 ? [`${module}.ts names Buffer, a Node global; use TextEncoder`] : [];
  return [...imports, ...buffers];
}

describe("the browser-shipped InfluxQL modules (SPEC 3.1, E18)", () => {
  test.each(BROWSER_MODULES.map((module) => [module]))("%s.ts imports only the set and types", (module) => {
    expect(findings(module, readFileSync(join(ROOT, INFLUXDB_DIR, `${module}.ts`), "utf8"))).toEqual([]);
  });

  test.each([
    ['import { createNodeTransport } from "@/lib/db/http/node-transport";\n', "@/lib/db/http/node-transport"],
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    ['import { createInfluxClient } from "./client";\n', "./client"],
    ['import { decodeInfluxqlResults } from "./influxql-results";\n', "./influxql-results"],
    ['import { evaluateInfluxSql } from "./sql-policy";\n', "./sql-policy"],
    ['export { influxErrorOf } from "./errors";\n', "./errors"],
    ['import { quoteSqlString } from "@/lib/sql/values";\n', "@/lib/sql/values"],
  ])("a planted %s fails by name", (planted, specifier) => {
    expect(findings("influxql-policy", planted)).toEqual([
      `influxql-policy.ts imports ${specifier}, which is not browser-safe`,
    ]);
  });

  test.each([
    ['const fs = await import("node:fs");\n', "node:fs"],
    ['const client = require("./client");\n', "./client"],
  ])("a planted dynamic import or require, %s, fails by name", (planted, specifier) => {
    expect(findings("influxql-policy", planted)).toEqual([
      `influxql-policy.ts imports ${specifier}, which is not browser-safe`,
    ]);
  });

  test("a dynamic import of a sibling of the set is allowed", () => {
    expect(findings("influxql-generators", 'const quote = await import("./influxql-quote");\n')).toEqual([]);
  });

  test("a type-only import of a server module is allowed, and a sibling of the set is", () => {
    expect(
      findings(
        "influxql-generators",
        'import type { ColumnSchema } from "@/lib/types";\nimport { type InfluxClient } from "./client";\nimport { quoteInfluxqlIdentifier } from "./influxql-quote";\n',
      ),
    ).toEqual([]);
  });

  test("Buffer in code fails, and Buffer in a comment or a string does not", () => {
    expect(findings("influxql-policy", "const n = Buffer.byteLength(text);\n")).toEqual([
      "influxql-policy.ts names Buffer, a Node global; use TextEncoder",
    ]);
    expect(findings("influxql-policy", 'const n = globalThis["Buffer"].byteLength(text);\n')).toEqual([
      "influxql-policy.ts names Buffer, a Node global; use TextEncoder",
    ]);
    expect(findings("influxql-policy", '// never Buffer\n/* Buffer */\nconst s = "Buffer";\n')).toEqual([]);
  });
});
