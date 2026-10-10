/**
 * The S3 modules shipped to the browser: every browser-safe module of the provider's core and of the object preview
 * imports only another member of this table, a browser-safe console module, the shared console modules, the four
 * engine-neutral shared modules and types; never a server module, a Node built-in or `encoding`, `connection-options`
 * or `endpoint`; and none names `Buffer`. Each shared module, with its value imports transitively within src/lib,
 * imports no Node built-in and names no `Buffer`. Proven both ways: the real sources pass, and each planted import
 * fails by name. The console's and the editor's own modules have their rows in the console describe of this file.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const S3 = "src/lib/db/providers/objectstore/s3";

const BROWSER_MODULES: readonly string[] = [
  // The provider's core
  `${S3}/constants.ts`,
  `${S3}/names.ts`,
  `${S3}/xml.ts`,
  `${S3}/shapes.ts`,
  `${S3}/headers.ts`,
  `${S3}/labels.ts`,
  // The object preview
  `${S3}/preview-detect.ts`,
  `${S3}/preview-text.ts`,
  `${S3}/preview-csv.ts`,
  `${S3}/preview-json.ts`,
  `${S3}/parquet-schema.ts`,
  `${S3}/parquet-thrift-guard.ts`,
  `${S3}/preview-cells.ts`,
  `${S3}/preview-render.ts`,
];

/**
 * The console's browser-safe modules a module of this table may import (labels.ts reads the plan mode sentence);
 * the console describe of this file holds each one's own row.
 */
const CONSOLE_IMPORTABLE = new RegExp(
  `^${S3}/console/(constants|lexer|paths|token|commands|guard|format|generators|statement-language)\\.ts$`,
);

/** The engine-neutral shared modules a browser-safe module may import. */
const SHARED_MODULES: readonly string[] = [
  "@/lib/db/object-kinds",
  "@/lib/db/utils/json-integers",
  "@/lib/db/utils/result-fields",
  "@/lib/db/errors",
];
const CONSOLE_SHARED = /^@\/lib\/db\/console\/[a-z-]+$/;

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

/** The repository-relative file a specifier names, or undefined for a package or a Node built-in. */
function resolveModule(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(join(ROOT, fromFile)), specifier);
  else return undefined;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return relative(ROOT, candidate);
  }
  return relative(ROOT, `${base}.ts`);
}

/**
 * Whether the code of `source` names `Buffer`, as an identifier or a string literal; comments and docblocks are not
 * code, and ts.forEachChild never visits them, so a docblock stating this very rule is not a finding.
 */
function namesBuffer(source: string): boolean {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): boolean =>
    ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "Buffer") ||
    ts.forEachChild(node, visit) === true;
  return visit(file);
}

function findings(file: string, source: string): string[] {
  const found: string[] = [];
  for (const specifier of valueImports(source)) {
    if (CONSOLE_SHARED.test(specifier) || SHARED_MODULES.includes(specifier)) continue;
    const target = resolveModule(file, specifier);
    if (target !== undefined && (BROWSER_MODULES.includes(target) || CONSOLE_IMPORTABLE.test(target))) continue;
    found.push(`${file} imports ${specifier}, which is not browser-safe`);
  }
  // Buffer is Node's; a browser module that names it fails in the editor bundle, not in a server test.
  if (namesBuffer(source)) found.push(`${file} names Buffer, which the browser does not have`);
  return found;
}

/** A shared module and its value imports, transitively within src/lib: any Node built-in or Buffer it reaches. */
function sharedFindings(specifier: string): string[] {
  const start = resolveModule("src/module.ts", specifier) as string;
  const seen = new Set<string>();
  const queue = [start];
  const found: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(ROOT, file), "utf8");
    if (namesBuffer(source)) found.push(`${file} names Buffer`);
    for (const imported of valueImports(source)) {
      if (imported.startsWith("node:")) {
        found.push(`${file} imports ${imported}`);
        continue;
      }
      const target = resolveModule(file, imported);
      if (target?.startsWith("src/lib/")) queue.push(target);
    }
  }
  return found;
}

describe("the browser-shipped S3 modules", () => {
  test.each(BROWSER_MODULES.map((module) => [module]))(
    "%s imports only the table, the shared modules and types",
    (module) => {
      expect(findings(module, readFileSync(join(ROOT, module), "utf8"))).toEqual([]);
    },
  );

  test.each(SHARED_MODULES.map((module) => [module]))(
    "the shared module %s reaches no Node built-in and no Buffer",
    (module) => {
      expect(sharedFindings(module)).toEqual([]);
    },
  );

  test.each([
    [`${S3}/names.ts`, 'import { objectPath } from "./encoding";\n', "./encoding"],
    [`${S3}/headers.ts`, 'import { buildS3ConnectionOptions } from "./connection-options";\n', "./connection-options"],
    [`${S3}/xml.ts`, 'import { httpOrigin } from "@/lib/db/http/endpoint";\n', "@/lib/db/http/endpoint"],
    [`${S3}/labels.ts`, 'import { executeS3Command } from "./console/execute";\n', "./console/execute"],
    [`${S3}/preview-csv.ts`, 'import { gunzipPrefix } from "./preview-gzip";\n', "./preview-gzip"],
    [`${S3}/shapes.ts`, 'import { createHash } from "node:crypto";\n', "node:crypto"],
  ])("a planted import in %s fails by name", (file, planted, specifier) => {
    expect(findings(file, planted)).toEqual([`${file} imports ${specifier}, which is not browser-safe`]);
  });

  test("a planted import of a shared module outside the list fails by name", () => {
    const file = `${S3}/preview-cells.ts`;
    expect(findings(file, 'import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";\n')).toEqual([
      `${file} imports @/lib/db/utils/query-limiter, which is not browser-safe`,
    ]);
  });

  test("Buffer is a finding, and a type-only import is not", () => {
    expect(findings(`${S3}/shapes.ts`, "const bytes = Buffer.from('x');\n")).toEqual([
      `${S3}/shapes.ts names Buffer, which the browser does not have`,
    ]);
    expect(
      findings(`${S3}/headers.ts`, 'import type { NodeByteResponse } from "@/lib/db/http/node-transport";\n'),
    ).toEqual([]);
  });

  test("a comment or a docblock naming Buffer is not a finding, and code naming it is", () => {
    const file = `${S3}/names.ts`;
    expect(findings(file, "/** Browser-safe: no `Buffer`. */\n// Buffer\nexport const a = 1;\n")).toEqual([]);
    expect(findings(file, "let x: Buffer;\n")).toEqual([`${file} names Buffer, which the browser does not have`]);
    expect(findings(file, 'const B = globalThis["Buffer"];\n')).toEqual([
      `${file} names Buffer, which the browser does not have`,
    ]);
  });
});
