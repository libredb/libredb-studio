/**
 * The Firestore seam guard (spec 3.1, S1, S12). Every source of `src/lib/db/providers/document/firestore/`, the
 * `console/` directory included, is parsed with the TypeScript compiler, so a file a later task adds is held by the
 * same rules without editing this test.
 *
 * 1. No file imports a module under `src/lib/db/providers/` outside this directory, a type-only import included.
 * 2. No file names `fetch`.
 * 3. Outside `seams.ts`, no file imports a runtime built-in (`node:` or bare), reads `process.env` or `Date.now`, or
 *    names `setTimeout` or `setInterval`.
 * 4. A browser-safe module (spec 3.1's table), and every module its value imports reach in turn, reaches no runtime
 *    built-in, no `@/lib/db/http/node-transport`, and neither `transport.ts` nor `seams.ts` of this directory. A
 *    type-only import is erased from the bundle, so it does not count here.
 * 5. Outside `requests.ts`, which holds the closed request table, no string literal equals or starts with a write,
 *    transaction, pipeline, listen or partition verb, and none equals an HTTP method other than GET and POST.
 *
 * Module names are resolved as TypeScript resolves them, so an alias counts. Each rule is proven both ways: the real
 * sources pass, a violation planted in a copy of a real file's text fails by name, and a close but allowed line passes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DIR = "src/lib/db/providers/document/firestore";
const PROVIDERS = "src/lib/db/providers/";
const SEAMS = `${DIR}/seams.ts`;
const CLOSED_TABLE = `${DIR}/requests.ts`;
const SERVER_ONLY: ReadonlySet<string> = new Set(["src/lib/db/http/node-transport.ts", `${DIR}/transport.ts`, SEAMS]);
const BROWSER_SAFE: readonly string[] = [
  "constants",
  "labels",
  "connection-options",
  "names",
  "field-path",
  "values",
  "requests",
  "errors",
  "results",
  "sampling",
  "cursor",
  "console/lexer",
  "console/parser",
  "console/guard",
  "console/compile",
  "console/generators",
].map((stem) => `${DIR}/${stem}.ts`);
const VERBS = [
  ":commit",
  ":batchWrite",
  ":beginTransaction",
  ":rollback",
  ":executePipeline",
  ":listen",
  ":write",
  ":partitionQuery",
];
const METHODS: ReadonlySet<string> = new Set(["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"]);
const EFFECTS = ["process.env", "Date.now", "setTimeout", "setInterval"] as const;

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const relative = (path: string): string => path.slice(canonical(ROOT).length + 1);
const inDirectory = (target: string): boolean => target.startsWith(`${DIR}/`);
const texts = new Map<string, string>();
const read = (file: string): string => {
  const cached = texts.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(ROOT, file), "utf8");
  texts.set(file, text);
  return text;
};

let compilerOptions: ts.CompilerOptions | undefined;
/** The module a specifier names, as TypeScript resolves it, or as it is spelled when nothing exists there. */
function resolved(specifier: string, file: string): string {
  if (compilerOptions === undefined) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
  }
  const resolution = ts.resolveModuleName(specifier, join(ROOT, file), compilerOptions, ts.sys).resolvedModule;
  if (resolution !== undefined) return relative(canonical(resolution.resolvedFileName));
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}.ts`;
  return `${posix.normalize(posix.join(posix.dirname(file), specifier))}.ts`;
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
      const named = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : undefined;
      const values = (named ?? []).filter((element) => !element.isTypeOnly);
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined && named !== undefined && named.length > 0 && values.length === 0));
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

/** A `+` of string literals as the one string it builds, or undefined when any operand is not a literal. */
function joined(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return joined(node.expression);
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  const [left, right] = [joined(node.left), joined(node.right)];
  return left === undefined || right === undefined ? undefined : left + right;
}

/** The literal texts of a file: strings, plain templates, each part of a template, and literals joined by `+`. */
function literals(file: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text);
    } else if (ts.isBinaryExpression(node)) {
      const whole = joined(node);
      if (whole !== undefined) found.push(whole);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** The effects a file names: `fetch`, `process.env`, `Date.now`, `setTimeout` and `setInterval`, however reached. */
function effects(file: string, text: string): Set<string> {
  const found = new Set<string>();
  const member = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return joined(node.argumentExpression);
    return undefined;
  };
  const owner = (node: ts.Node): string | undefined => (ts.isIdentifier(node) ? node.text : member(node));
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && ["fetch", "setTimeout", "setInterval"].includes(node.text)) found.add(node.text);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = member(node);
      if (name === "fetch" || name === "setTimeout" || name === "setInterval") found.add(name);
      const of = owner(node.expression);
      if (name === "env" && of === "process") found.add("process.env");
      if (name === "now" && of === "Date") found.add("Date.now");
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

const builtin = (specifier: string): boolean => isBuiltin(specifier) || specifier.startsWith("bun:");

/** Whether a module, through its value imports and theirs, reaches a runtime built-in or a server-only module. */
function reachesServer(start: string): boolean {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (SERVER_ONLY.has(file)) return true;
    if (seen.has(file) || !file.startsWith("src/") || !existsSync(join(ROOT, file))) continue;
    seen.add(file);
    for (const reference of references(file, read(file))) {
      if (reference.typeOnly || reference.specifier === undefined) continue;
      if (builtin(reference.specifier)) return true;
      queue.push(resolved(reference.specifier, file));
    }
  }
  return false;
}

/** Every finding of rules 1 to 5 for one file's text. */
function seamFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  const browserSafe = BROWSER_SAFE.includes(file);
  const reach = (specifier: string) =>
    `rule 4: ${file}, a browser-safe module, reaches a runtime built-in or the transport through ${specifier}`;
  for (const { specifier, typeOnly } of references(file, text)) {
    if (specifier === undefined) {
      findings.push(`seam: ${file} loads a module whose name is not a plain string`);
      continue;
    }
    if (builtin(specifier)) {
      if (file !== SEAMS) findings.push(`rule 3: ${file} imports ${specifier} outside seams.ts`);
      if (browserSafe && !typeOnly) findings.push(reach(specifier));
      continue;
    }
    const target = resolved(specifier, file);
    if (target.startsWith(PROVIDERS) && !inDirectory(target))
      findings.push(`rule 1: ${file} imports ${specifier}, a module of another provider directory`);
    if (browserSafe && !typeOnly && reachesServer(target)) findings.push(reach(specifier));
  }
  const named = effects(file, text);
  if (named.has("fetch")) findings.push(`rule 2: ${file} reaches fetch`);
  if (file !== SEAMS)
    for (const effect of EFFECTS)
      if (named.has(effect)) findings.push(`rule 3: ${file} uses ${effect} outside seams.ts`);
  if (file !== CLOSED_TABLE) {
    for (const literal of literals(file, text)) {
      if (VERBS.some((verb) => literal === verb || literal.startsWith(verb)))
        findings.push(`rule 5: ${file} holds the literal "${literal}", a verb outside the closed request table`);
      if (METHODS.has(literal))
        findings.push(`rule 5: ${file} holds the HTTP method "${literal}" outside the closed request table`);
    }
  }
  return findings;
}

const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${dir}/${entry.name}`] : [],
  );
const SOURCES = walk(DIR);

/** A planted file: a real file's text, under its own name or another file's, with one line in front. */
const plant = (as: string, from: string, line: string): string[] =>
  seamFindings(`${DIR}/${as}`, line + read(`${DIR}/${from}`));

describe("the Firestore directory holds its seams", () => {
  test("every source passes rules 1 to 5", () => {
    for (const file of [`${DIR}/index.ts`, SEAMS, CLOSED_TABLE, `${DIR}/console/lexer.ts`])
      expect(SOURCES).toContain(file);
    for (const file of BROWSER_SAFE) expect(existsSync(join(ROOT, file))).toBe(true);
    expect(SOURCES.flatMap((file) => seamFindings(file, read(file)))).toEqual([]);
  });

  test("the detector reads real code", () => {
    // seams.ts holds the real effects, which only its own exemption admits.
    expect(seamFindings(`${DIR}/sampling.ts`, read(SEAMS)).some((finding) => finding.startsWith("rule 3:"))).toBe(true);
    expect(reachesServer(`${DIR}/index.ts`)).toBe(true);
    expect(reachesServer(`${DIR}/names.ts`)).toBe(false);
    expect(literals(`${DIR}/key-scan.ts`, read(`${DIR}/key-scan.ts`))).toContain("__name__");
  });
});

describe("planted violations fail by name", () => {
  test.each([
    // rule 1
    [
      "sampling.ts",
      "sampling.ts",
      'import { S3_KEY_SCAN } from "@/lib/db/providers/objectstore/s3/key-scan";\n',
      `rule 1: ${DIR}/sampling.ts imports @/lib/db/providers/objectstore/s3/key-scan, a module of another provider directory`,
    ],
    [
      "index.ts",
      "index.ts",
      'import type { BigQueryProvider } from "../../sql/bigquery";\n',
      `rule 1: ${DIR}/index.ts imports ../../sql/bigquery, a module of another provider directory`,
    ],
    // rule 2
    ["key-scan.ts", "key-scan.ts", "const send = globalThis.fetch;\n", `rule 2: ${DIR}/key-scan.ts reaches fetch`],
    ["objects.ts", "objects.ts", 'const send = globalThis["fetch"];\n', `rule 2: ${DIR}/objects.ts reaches fetch`],
    ["seams.ts", "seams.ts", "const send = fetch;\n", `rule 2: ${DIR}/seams.ts reaches fetch`],
    // rule 3
    [
      "objects.ts",
      "objects.ts",
      'import { readFileSync } from "node:fs";\n',
      `rule 3: ${DIR}/objects.ts imports node:fs outside seams.ts`,
    ],
    ["index.ts", "index.ts", 'import os from "os";\n', `rule 3: ${DIR}/index.ts imports os outside seams.ts`],
    [
      "index.ts",
      "index.ts",
      "const home = process.env.HOME;\n",
      `rule 3: ${DIR}/index.ts uses process.env outside seams.ts`,
    ],
    [
      "key-scan.ts",
      "key-scan.ts",
      'const home = globalThis.process["env"];\n',
      `rule 3: ${DIR}/key-scan.ts uses process.env outside seams.ts`,
    ],
    ["cursor.ts", "cursor.ts", "const at = Date.now();\n", `rule 3: ${DIR}/cursor.ts uses Date.now outside seams.ts`],
    [
      "objects.ts",
      "objects.ts",
      "setTimeout(() => undefined, 1);\n",
      `rule 3: ${DIR}/objects.ts uses setTimeout outside seams.ts`,
    ],
    [
      "index.ts",
      "index.ts",
      "const tick = globalThis.setInterval;\n",
      `rule 3: ${DIR}/index.ts uses setInterval outside seams.ts`,
    ],
    // rule 4
    [
      "names.ts",
      "names.ts",
      'import { createNodeTransport } from "@/lib/db/http/node-transport";\n',
      `rule 4: ${DIR}/names.ts, a browser-safe module, reaches a runtime built-in or the transport through @/lib/db/http/node-transport`,
    ],
    [
      "labels.ts",
      "labels.ts",
      'import { FirestoreProvider } from "./index";\n',
      `rule 4: ${DIR}/labels.ts, a browser-safe module, reaches a runtime built-in or the transport through ./index`,
    ],
    [
      "cursor.ts",
      "cursor.ts",
      'import { createFirestoreClient } from "./transport";\n',
      `rule 4: ${DIR}/cursor.ts, a browser-safe module, reaches a runtime built-in or the transport through ./transport`,
    ],
    [
      "values.ts",
      "values.ts",
      'import { createHash } from "node:crypto";\n',
      `rule 4: ${DIR}/values.ts, a browser-safe module, reaches a runtime built-in or the transport through node:crypto`,
    ],
    // rule 5
    [
      "key-scan.ts",
      "key-scan.ts",
      'const verb = ":commit";\n',
      `rule 5: ${DIR}/key-scan.ts holds the literal ":commit", a verb outside the closed request table`,
    ],
    [
      "objects.ts",
      "objects.ts",
      "const path = (parent: string) => `${parent}:batchWrite`;\n",
      `rule 5: ${DIR}/objects.ts holds the literal ":batchWrite", a verb outside the closed request table`,
    ],
    [
      "index.ts",
      "index.ts",
      'const verb = ":begin" + "Transaction";\n',
      `rule 5: ${DIR}/index.ts holds the literal ":beginTransaction", a verb outside the closed request table`,
    ],
    [
      "sampling.ts",
      "sampling.ts",
      'const verb = ":listen";\n',
      `rule 5: ${DIR}/sampling.ts holds the literal ":listen", a verb outside the closed request table`,
    ],
    [
      "transport.ts",
      "transport.ts",
      'const verb = ":partitionQuery";\n',
      `rule 5: ${DIR}/transport.ts holds the literal ":partitionQuery", a verb outside the closed request table`,
    ],
    [
      "key-scan.ts",
      "key-scan.ts",
      'const method = "DELETE";\n',
      `rule 5: ${DIR}/key-scan.ts holds the HTTP method "DELETE" outside the closed request table`,
    ],
    [
      "console/execute.ts",
      "console/execute.ts",
      'const method = "PATCH";\n',
      `rule 5: ${DIR}/console/execute.ts holds the HTTP method "PATCH" outside the closed request table`,
    ],
    // a module name that is not a plain string
    [
      "objects.ts",
      "objects.ts",
      'const loaded = await import(["./sam", "pling"].join(""));\n',
      `seam: ${DIR}/objects.ts loads a module whose name is not a plain string`,
    ],
  ])("%s (from %s) with %p fails", (as, from, line, finding) => {
    expect(plant(as, from, line)).toContain(finding);
  });

  test.each([
    ["index.ts", "index.ts", 'import { BaseDatabaseProvider } from "@/lib/db/base-provider";\n'],
    ["key-scan.ts", "key-scan.ts", 'import type { KeyScanPage } from "@/lib/db/types";\n'],
    ["seams.ts", "seams.ts", "const at = Date.now();\n"],
    ["seams.ts", "seams.ts", 'import { readFileSync } from "node:fs";\n'],
    ["seams.ts", "seams.ts", "const tick = setTimeout;\n"],
    ["requests.ts", "requests.ts", 'const verb = ":commit";\n'],
    ["requests.ts", "requests.ts", 'const method = "DELETE";\n'],
    ["key-scan.ts", "key-scan.ts", 'const sentence = "Studio never sends a commit or a write.";\n'],
    ["key-scan.ts", "key-scan.ts", 'const verb = ":runQuery";\n'],
    ["key-scan.ts", "key-scan.ts", 'const method = "GET";\n'],
    ["names.ts", "names.ts", 'import type { NodeTransport } from "@/lib/db/http/node-transport";\n'],
    ["index.ts", "index.ts", 'import { executeStatement } from "./console/execute";\n'],
    ["objects.ts", "objects.ts", 'const options = { env: "production" };\n'],
    ["sampling.ts", "sampling.ts", 'const label = "Date.now";\n'],
  ])("%s (from %s) with %p passes", (as, from, line) => {
    expect(plant(as, from, line)).toEqual([]);
  });
});
