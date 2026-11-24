/**
 * The InfluxQL modules shipped to the browser (SPEC 3.1, E18): the editor, the confirmation gate row and the
 * query generators import the lexer, the policy, the quoter and the generators, so each of the four imports only
 * another member of the set and types, never a Node built-in, `@/lib/db/http/*` or a server module of the
 * directory. The lexer and the policy live in the influxql statement language's core family module, the quoter and
 * the generators in the provider directory: a member import is `./<name>` of a member in the importer's own
 * directory, or `@/lib/languages/influxql/<name>` of a family member. Bytes are measured with `TextEncoder`, so none of the four names `Buffer` outside a comment: it is a
 * Node global, which an import check cannot see. Proven both ways: the real sources pass, and a planted import or
 * `Buffer` fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { statementLanguageFamilyDirectory } from "../../../helpers/statement-language-family";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const INFLUXDB_DIR = "src/lib/db/providers/timeseries/influxdb";
const FAMILY_DIR = statementLanguageFamilyDirectory("influxql");

/** A browser-shipped module: its `/`-joined repository directory and its file name without `.ts`. */
interface Member {
  readonly dir: string;
  readonly name: string;
}

/** The browser-safe set, exactly (SPEC 3.1). */
const BROWSER_MODULES: readonly Member[] = [
  { dir: FAMILY_DIR, name: "lexer" },
  { dir: FAMILY_DIR, name: "policy" },
  { dir: INFLUXDB_DIR, name: "influxql-quote" },
  { dir: INFLUXDB_DIR, name: "influxql-generators" },
];

const member = (name: string): Member => {
  const found = BROWSER_MODULES.find((module) => module.name === name);
  if (found === undefined) throw new Error(`${name} is not a member of the browser-safe set`);
  return found;
};

/** The specifiers `importer` may load a member by: `./<name>` in its own directory, `@/...` for a family member. */
const memberSpecifiers = (importer: Member): Set<string> =>
  new Set(
    BROWSER_MODULES.flatMap((module) => [
      ...(module.dir === importer.dir ? [`./${module.name}`] : []),
      ...(module.dir === FAMILY_DIR ? [`@/${FAMILY_DIR.slice("src/".length)}/${module.name}`] : []),
    ]),
  );

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

function findings(module: Member, source: string): string[] {
  const file = ts.createSourceFile(`${module.name}.ts`, source, ts.ScriptTarget.Latest, true);
  const allowed = memberSpecifiers(module);
  const imports = valueImports(file)
    .filter((specifier) => !allowed.has(specifier))
    .map((specifier) => `${module.name}.ts imports ${specifier}, which is not browser-safe`);
  const buffers = bufferReferences(file) > 0 ? [`${module.name}.ts names Buffer, a Node global; use TextEncoder`] : [];
  return [...imports, ...buffers];
}

describe("the browser-shipped InfluxQL modules (SPEC 3.1, E18)", () => {
  test.each(BROWSER_MODULES.map((module) => [`${module.dir}/${module.name}`, module] as const))(
    "%s.ts imports only the set and types",
    (_label, module) => {
      expect(findings(module, readFileSync(join(ROOT, module.dir, `${module.name}.ts`), "utf8"))).toEqual([]);
    },
  );

  test.each([
    ['import { createNodeTransport } from "@/lib/db/http/node-transport";\n', "@/lib/db/http/node-transport"],
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    ['import { createInfluxClient } from "./client";\n', "./client"],
    ['import { decodeInfluxqlResults } from "./influxql-results";\n', "./influxql-results"],
    ['import { evaluateInfluxSql } from "./sql-policy";\n', "./sql-policy"],
    ['export { influxErrorOf } from "./errors";\n', "./errors"],
    ['import { quoteSqlString } from "@/lib/sql/values";\n', "@/lib/sql/values"],
  ])("a planted %s fails by name", (planted, specifier) => {
    expect(findings(member("policy"), planted)).toEqual([`policy.ts imports ${specifier}, which is not browser-safe`]);
  });

  test.each([
    ['const fs = await import("node:fs");\n', "node:fs"],
    ['const client = require("./client");\n', "./client"],
  ])("a planted dynamic import or require, %s, fails by name", (planted, specifier) => {
    expect(findings(member("policy"), planted)).toEqual([`policy.ts imports ${specifier}, which is not browser-safe`]);
  });

  test("a dynamic import of a sibling of the set is allowed", () => {
    expect(findings(member("influxql-generators"), 'const quote = await import("./influxql-quote");\n')).toEqual([]);
  });

  test("a family member is allowed by its core path from the provider directory", () => {
    expect(
      findings(member("influxql-generators"), 'import { lexInfluxql } from "@/lib/languages/influxql/lexer";\n'),
    ).toEqual([]);
  });

  test("a type-only import of a server module is allowed, and a sibling of the set is", () => {
    expect(
      findings(
        member("influxql-generators"),
        'import type { ColumnSchema } from "@/lib/types";\nimport { type InfluxClient } from "./client";\nimport { quoteInfluxqlIdentifier } from "./influxql-quote";\n',
      ),
    ).toEqual([]);
  });

  test("Buffer in code fails, and Buffer in a comment or a string does not", () => {
    expect(findings(member("policy"), "const n = Buffer.byteLength(text);\n")).toEqual([
      "policy.ts names Buffer, a Node global; use TextEncoder",
    ]);
    expect(findings(member("policy"), 'const n = globalThis["Buffer"].byteLength(text);\n')).toEqual([
      "policy.ts names Buffer, a Node global; use TextEncoder",
    ]);
    expect(findings(member("policy"), '// never Buffer\n/* Buffer */\nconst s = "Buffer";\n')).toEqual([]);
  });
});
