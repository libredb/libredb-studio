/**
 * The Databend seam guard (design 2.5 and 7.3), in the InfluxDB layered form: every source of
 * `src/lib/db/providers/sql/databend/` is parsed, so a file a later task adds is held by the same rules without
 * editing this list.
 *
 * 1. No file imports a module under `src/lib/db/providers/` outside this directory, with one exception: `index.ts`
 *    extends `SQLBaseProvider` from `../sql-base` (design 2.1).
 * 2. Only `http-transport.ts` imports `createNodeTransport`, the one socket path, and nothing imports `node:http`,
 *    `node:https` or reaches `fetch` itself.
 * 3. No file outside `routes.ts` holds a string literal whose whole value starts with `/v1/`; a sentence that names a
 *    path inside longer text is not a path literal.
 * 4. Only `connection-options.ts` imports `nodeTlsMaterial` or `plaintextSecretRefusal`.
 * 5. Only `connection-options.ts`, `session.ts` and `http-transport.ts` hold a string literal that starts with an
 *    `x-databend-` header name, in any case.
 * 6. `index.ts` holds no `system.` SQL: every statement it sends comes from `objects.ts` or `introspect.ts`.
 * 7. A value is imported from outside this directory only from `@/lib/db/http/*`, `@/lib/db/errors`,
 *    `@/lib/db/utils/*`, `@/lib/sql/*`, `@/lib/types`, the base classes, `@/lib/db/object-kinds`, `tunnelRoute` of
 *    `@/lib/db/connection-fingerprint`, `@/lib/app-version` (I15), `@/lib/db/sql-grammar/shared` (the SQL grammar
 *    contract's building blocks, for `sql-grammar.ts`) and the runtime's `node:crypto`; types are free.
 *    `execution-ui.ts`, the engine's execution UI contract module, may also import values from
 *    `@/lib/db/execution-ui/shared`, its contract's shared building block, `migration-ddl.ts`, the engine's
 *    migration DDL contract module, from `@/lib/db/migration-ddl/*`, its contract's shared building blocks, and
 *    `sql-writing.ts` and its `typed-literals.ts` sibling, the engine's SQL writing contract modules, from
 *    `@/lib/db/sql-writing/*`.
 * 8. Every value export has an importer other than its own file, so nothing is exported only for a test [12 #15].
 *    An importer is a module under `src/`, or `tests/unit/db/databend/provider-doc.test.ts`, which reads back what
 *    `docs/providers/databend.md` quotes (design section 10); no other test file counts. The doc test reaches only
 *    the names it imports, so a namespace import of it reaches none. A type is part of the contract of the values
 *    that use it, so only values are held.
 *
 * Rules 1 and 2 count a type-only import too: they keep modules apart, not values. Module names are resolved as
 * TypeScript resolves them, so an alias counts; a planted module that does not exist yet resolves by its spelling.
 * Each rule is proven both ways: the real sources pass, and a violation planted in a copy of a real file's text fails
 * by name.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";
import { platformTimeoutMs } from "../../../helpers/platform-timeout";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DIR = "src/lib/db/providers/sql/databend";
const PROVIDERS = "src/lib/db/providers/";
const SQL_BASE = "src/lib/db/providers/sql/sql-base.ts";

/** Where a value from outside this directory may come from (rule 7). */
const OUTSIDE_VALUES = [
  "src/lib/db/http/",
  "src/lib/db/errors.ts",
  "src/lib/db/utils/",
  "src/lib/sql/",
  "src/lib/types.ts",
  "src/lib/db/base-provider.ts",
  SQL_BASE,
  "src/lib/db/object-kinds.ts",
  "src/lib/app-version.ts",
  "src/lib/db/sql-grammar/shared.ts",
];
/** A module a value may come from only under the names listed. */
const OUTSIDE_NAMED: Readonly<Record<string, readonly string[]>> = {
  "src/lib/db/connection-fingerprint.ts": ["tunnelRoute"],
};
/**
 * The per-engine contract modules, each with the contract module or directory whose shared building blocks it may
 * import as values (rule 7). No other file of this directory may.
 */
const CONTRACT_VALUES: Readonly<Record<string, string>> = {
  "execution-ui": "src/lib/db/execution-ui/shared.ts",
  "migration-ddl": "src/lib/db/migration-ddl/",
  "sql-writing": "src/lib/db/sql-writing/",
  "typed-literals": "src/lib/db/sql-writing/",
};
const BUILTIN_VALUES = new Set(["node:crypto"]);
const HEADER_FILES = new Set(["connection-options", "session", "http-transport"]);

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const relative = (path: string): string => path.slice(canonical(ROOT).length + 1);
const stem = (file: string): string => posix.basename(file).replace(/\.tsx?$/, "");
const inDirectory = (target: string): boolean => target.startsWith(`${DIR}/`);

let compilerOptions: ts.CompilerOptions | undefined;
/** The module a specifier names, as TypeScript resolves it, or as it is spelled when nothing exists there yet. */
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
  /** The exported names a value import binds, by their names in the target module. */
  readonly names: readonly string[];
  /** Every exported name the reference reaches, types included; `"*"` for a namespace import or `export *`. */
  readonly reaches: readonly string[];
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
      const original = (element: ts.ImportSpecifier) => (element.propertyName ?? element.name).text;
      const valueNames = (named ?? []).filter((element) => !element.isTypeOnly).map(original);
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined && named !== undefined && named.length > 0 && valueNames.length === 0));
      const namespace = bindings !== undefined && ts.isNamespaceImport(bindings);
      found.push({
        specifier: plain(node.moduleSpecifier),
        typeOnly,
        names: clause?.isTypeOnly ? [] : clause?.name === undefined ? valueNames : [...valueNames, "default"],
        reaches: namespace
          ? ["*"]
          : [...(named ?? []).map(original), ...(clause?.name === undefined ? [] : ["default"])],
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      const named = clause !== undefined && ts.isNamedExports(clause) ? clause.elements : undefined;
      found.push({
        specifier: plain(node.moduleSpecifier),
        typeOnly: node.isTypeOnly,
        names: [],
        reaches: named === undefined ? ["*"] : named.map((element) => (element.propertyName ?? element.name).text),
      });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) ? plain(argument.literal) : undefined;
      const qualifier = node.qualifier;
      found.push({
        specifier,
        typeOnly: true,
        names: [],
        reaches:
          qualifier === undefined ? ["*"] : [ts.isIdentifier(qualifier) ? qualifier.text : qualifier.left.getText()],
      });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found.push({ specifier: plain(node.arguments[0]), typeOnly: false, names: [], reaches: ["*"] });
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
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      found.push(node.text);
    } else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
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

/** True when a file names `fetch` as a value: a call, `globalThis.fetch`, `globalThis["fetch"]`, or any other reference. */
function reachesFetch(file: string, text: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "fetch") found = true;
    if (ts.isElementAccessExpression(node) && joined(node.argumentExpression) === "fetch") found = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** Every finding of rules 1 to 7 for one file. */
function seamFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  const name = stem(file);

  for (const { specifier, typeOnly, names } of references(file, text)) {
    if (specifier === undefined) {
      findings.push(`seam: ${file} loads a module whose name is not a plain string`);
      continue;
    }
    if (["node:http", "node:https", "http", "https"].includes(specifier)) {
      findings.push(`rule 2: ${file} imports ${specifier}`);
      continue;
    }
    if (isBuiltin(specifier) || specifier.startsWith("bun:")) {
      if (!typeOnly && !BUILTIN_VALUES.has(specifier)) {
        findings.push(`rule 7: ${file} imports a value from ${specifier}, a runtime built-in it may not`);
      }
      continue;
    }
    const target = resolved(specifier, file);
    if (target.startsWith(PROVIDERS) && !inDirectory(target) && !(name === "index" && target === SQL_BASE)) {
      findings.push(`rule 1: ${file} imports ${specifier}, a module of another provider directory`);
    }
    if (names.includes("createNodeTransport") && name !== "http-transport") {
      findings.push(`rule 2: ${file} imports createNodeTransport, which only http-transport.ts imports`);
    }
    for (const guarded of ["nodeTlsMaterial", "plaintextSecretRefusal"]) {
      if (names.includes(guarded) && name !== "connection-options") {
        findings.push(`rule 4: ${file} imports ${guarded}, which only connection-options.ts imports`);
      }
    }
    if (typeOnly || inDirectory(target)) continue;
    const named = OUTSIDE_NAMED[target];
    const allowed =
      (Object.hasOwn(CONTRACT_VALUES, name) && target.startsWith(CONTRACT_VALUES[name])) ||
      OUTSIDE_VALUES.some((prefix) => target.startsWith(prefix)) ||
      (named !== undefined && names.length > 0 && names.every((bound) => named.includes(bound)));
    if (!allowed) findings.push(`rule 7: ${file} imports a value from ${specifier}, which this directory may not`);
  }

  if (reachesFetch(file, text)) findings.push(`rule 2: ${file} reaches fetch`);
  for (const literal of literals(file, text)) {
    if (name !== "routes" && literal.startsWith("/v1/")) {
      findings.push(`rule 3: ${file} holds the path literal "${literal}", which only routes.ts may hold`);
    }
    if (!HEADER_FILES.has(name) && literal.toLowerCase().startsWith("x-databend-")) {
      findings.push(`rule 5: ${file} holds the header name "${literal}", which only the transport's modules may hold`);
    }
    if (name === "index" && /\bsystem\./i.test(literal)) {
      findings.push(`rule 6: ${file} holds system. SQL, which objects.ts and introspect.ts own`);
    }
  }
  return findings;
}

interface Exported {
  readonly name: string;
  /** An interface or a type alias, which rule 8 does not hold. */
  readonly type: boolean;
}

/** The names a module exports (rule 8): each declaration, and each name of a local `export { ... }`. */
function exportsOf(file: string, text: string): Exported[] {
  const declared = new Map(declarationsOf(file, text, false).map((entry) => [entry.name, entry]));
  const found = declarationsOf(file, text, true);
  for (const statement of ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined) continue;
    if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const local = declared.get((element.propertyName ?? element.name).getText());
      const type = statement.isTypeOnly || element.isTypeOnly || local?.type === true;
      found.push({ name: element.name.getText(), type });
    }
  }
  return found;
}

/** The top-level declarations of a module, the exported ones or every one. */
function declarationsOf(file: string, text: string, exportedOnly: boolean): Exported[] {
  const found: Exported[] = [];
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).statements) {
    if (exportedOnly && !exported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        found.push({ name: declaration.name.getText(), type: false });
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      const type = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
      found.push({ name: statement.name.text, type });
    }
  }
  return found;
}

/** The one test file whose imports count for rule 8: it reads back what the provider doc quotes. */
const DOC_TEST = "tests/unit/db/databend/provider-doc.test.ts";

interface Importer {
  readonly file: string;
  readonly text: string;
}

/**
 * The importers rule 8 counts: every `.ts` and `.tsx` file of this directory, every other one under `src/` whose text
 * names `databend` (the only ones that can import from here), and the provider doc test.
 */
function importers(): Importer[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  return [...walk("src"), DOC_TEST]
    .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }))
    .filter(({ file, text }) => inDirectory(file) || text.includes("databend"));
}

/** Every value export of this directory that no reader under `src/`, and not the doc test, imports (rule 8). */
function unimportedExports(sources: readonly Importer[], readers: readonly Importer[] = importers()): string[] {
  const reached = new Map<string, Set<string>>();
  for (const { file, text } of readers) {
    if (!file.startsWith("src/") && file !== DOC_TEST) continue;
    for (const reference of references(file, text)) {
      if (reference.specifier === undefined) continue;
      const target = resolved(reference.specifier, file);
      if (!inDirectory(target) || target === file) continue;
      const names = reached.get(target) ?? new Set<string>();
      // The doc test is held to the names it reads: a namespace import of it would admit every export unread.
      for (const name of reference.reaches) if (file !== DOC_TEST || name !== "*") names.add(name);
      reached.set(target, names);
    }
  }
  return sources.flatMap(({ file, text }) => {
    const names = reached.get(file) ?? new Set<string>();
    if (names.has("*")) return [];
    return exportsOf(file, text)
      .filter((entry) => !entry.type && !names.has(entry.name))
      .map((entry) => `rule 8: ${file} exports ${entry.name}, which nothing under src/ or the doc test imports`);
  });
}

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const SOURCES = readdirSync(join(ROOT, DIR))
  .filter((entry) => entry.endsWith(".ts"))
  .map((entry) => `${DIR}/${entry}`);

describe("the Databend directory holds its seams", () => {
  // The first parse of the directory pays the parser's warm-up: 0.5s alone with coverage and 4.5s under a
  // 15% CPU quota.
  test(
    "every source passes rules 1 to 7",
    () => {
      expect(SOURCES).toContain(`${DIR}/index.ts`);
      expect(SOURCES.flatMap((file) => seamFindings(file, read(file)))).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  // Reads every file under src/: 0.5s alone with coverage and 4.5s under a 15% CPU quota.
  test(
    "every value export has an importer under src/ or the doc test (rule 8)",
    () => {
      expect(unimportedExports(SOURCES.map((file) => ({ file, text: read(file) })))).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test("the detector reads real code", () => {
    const transport = references(`${DIR}/http-transport.ts`, read(`${DIR}/http-transport.ts`));
    expect(transport.find((reference) => reference.specifier === "@/lib/db/http/node-transport")?.names).toContain(
      "createNodeTransport",
    );
    const options = references(`${DIR}/connection-options.ts`, read(`${DIR}/connection-options.ts`));
    expect(options.find((reference) => reference.specifier === "@/lib/db/connection-fingerprint")?.names).toEqual([
      "tunnelRoute",
    ]);
    expect(literals(`${DIR}/routes.ts`, read(`${DIR}/routes.ts`))).toContain("/v1/query");
    expect(literals(`${DIR}/connection-options.ts`, read(`${DIR}/connection-options.ts`))).toContain(
      "x-databend-session",
    );
    const index = references(`${DIR}/index.ts`, read(`${DIR}/index.ts`));
    expect(index.find((reference) => reference.specifier === "../sql-base")?.names).toEqual(["SQLBaseProvider"]);
    expect(exportsOf(`${DIR}/sql-text.ts`, read(`${DIR}/sql-text.ts`))).toContainEqual({
      name: "DATABEND_MULTIPLE_STATEMENTS",
      type: false,
    });
    const readers = importers().map((importer) => importer.file);
    expect(readers).toContain(DOC_TEST);
    // A file of this directory counts though its text never spells the name in lower case.
    expect(read(`${DIR}/auth-latch.ts`)).not.toContain("databend");
    expect(readers).toContain(`${DIR}/auth-latch.ts`);
  });
});

/** A planted file: a real file's text under its own name or a name a later task will add. */
const plant = (as: string, from: string, line: string): string[] =>
  seamFindings(`${DIR}/${as}`, line + read(`${DIR}/${from}`));

describe("planted violations fail by name", () => {
  test.each([
    // rule 1
    [
      "objects.ts",
      "objects.ts",
      'import { TrinoProvider } from "@/lib/db/providers/sql/trino";\n',
      `rule 1: ${DIR}/objects.ts imports @/lib/db/providers/sql/trino, a module of another provider directory`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import type { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n',
      `rule 1: ${DIR}/errors.ts imports @/lib/db/providers/sql/sql-base, a module of another provider directory`,
    ],
    [
      "index.ts",
      "labels.ts",
      'import { quoteTrinoIdentifier } from "../trino/objects";\n',
      `rule 1: ${DIR}/index.ts imports ../trino/objects, a module of another provider directory`,
    ],
    // rule 2
    [
      "routes.ts",
      "routes.ts",
      'import { createNodeTransport } from "@/lib/db/http/node-transport";\n',
      `rule 2: ${DIR}/routes.ts imports createNodeTransport, which only http-transport.ts imports`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import { request } from "node:https";\n',
      `rule 2: ${DIR}/errors.ts imports node:https`,
    ],
    ["index.ts", "labels.ts", 'import http from "node:http";\n', `rule 2: ${DIR}/index.ts imports node:http`],
    ["session.ts", "session.ts", "const send = globalThis.fetch;\n", `rule 2: ${DIR}/session.ts reaches fetch`],
    ["session.ts", "session.ts", 'const send = globalThis["fetch"];\n', `rule 2: ${DIR}/session.ts reaches fetch`],
    // rule 3
    [
      "http-transport.ts",
      "http-transport.ts",
      'const path = "/v1/query";\n',
      `rule 3: ${DIR}/http-transport.ts holds the path literal "/v1/query", which only routes.ts may hold`,
    ],
    [
      "objects.ts",
      "objects.ts",
      "const path = (id: string) => `/v1/query/${id}/kill`;\n",
      `rule 3: ${DIR}/objects.ts holds the path literal "/v1/query/", which only routes.ts may hold`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'const path = "/v1" + "/query";\n',
      `rule 3: ${DIR}/errors.ts holds the path literal "/v1/query", which only routes.ts may hold`,
    ],
    // rule 4
    [
      "http-transport.ts",
      "http-transport.ts",
      'import { nodeTlsMaterial } from "@/lib/db/http/node-transport";\n',
      `rule 4: ${DIR}/http-transport.ts imports nodeTlsMaterial, which only connection-options.ts imports`,
    ],
    [
      "index.ts",
      "labels.ts",
      'import { plaintextSecretRefusal } from "@/lib/db/http/endpoint";\n',
      `rule 4: ${DIR}/index.ts imports plaintextSecretRefusal, which only connection-options.ts imports`,
    ],
    // rule 5
    [
      "index.ts",
      "labels.ts",
      'const header = "X-Databend-Warehouse";\n',
      `rule 5: ${DIR}/index.ts holds the header name "X-Databend-Warehouse", which only the transport's modules may hold`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'const header = "x-databend-query-id";\n',
      `rule 5: ${DIR}/errors.ts holds the header name "x-databend-query-id", which only the transport's modules may hold`,
    ],
    // rule 6
    [
      "index.ts",
      "labels.ts",
      'const sql = "SELECT name FROM system.tables";\n',
      `rule 6: ${DIR}/index.ts holds system. SQL, which objects.ts and introspect.ts own`,
    ],
    // rule 7
    [
      "objects.ts",
      "objects.ts",
      'import { getDBConfig } from "@/lib/db-ui-config";\n',
      `rule 7: ${DIR}/objects.ts imports a value from @/lib/db-ui-config, which this directory may not`,
    ],
    [
      "connection-options.ts",
      "connection-options.ts",
      'import { connectionFingerprint } from "@/lib/db/connection-fingerprint";\n',
      `rule 7: ${DIR}/connection-options.ts imports a value from @/lib/db/connection-fingerprint, which this directory may not`,
    ],
    [
      "index.ts",
      "labels.ts",
      'import { createDatabaseProvider } from "@/lib/db/factory";\n',
      `rule 7: ${DIR}/index.ts imports a value from @/lib/db/factory, which this directory may not`,
    ],
    [
      "objects.ts",
      "objects.ts",
      'import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";\n',
      `rule 7: ${DIR}/objects.ts imports a value from @/lib/db/execution-ui/shared, which this directory may not`,
    ],
    [
      "objects.ts",
      "objects.ts",
      'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n',
      `rule 7: ${DIR}/objects.ts imports a value from @/lib/db/migration-ddl/shared, which this directory may not`,
    ],
    [
      "objects.ts",
      "objects.ts",
      'import { literalStandard } from "@/lib/db/sql-writing/shared";\n',
      `rule 7: ${DIR}/objects.ts imports a value from @/lib/db/sql-writing/shared, which this directory may not`,
    ],
    [
      "sql-writing.ts",
      "sql-writing.ts",
      'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n',
      `rule 7: ${DIR}/sql-writing.ts imports a value from @/lib/db/migration-ddl/shared, which this directory may not`,
    ],
    [
      "decode.ts",
      "decode.ts",
      'import { readFileSync } from "node:fs";\n',
      `rule 7: ${DIR}/decode.ts imports a value from node:fs, a runtime built-in it may not`,
    ],
    [
      "decode.ts",
      "decode.ts",
      'const loaded = await import(["./obj", "ects"].join(""));\n',
      `seam: ${DIR}/decode.ts loads a module whose name is not a plain string`,
    ],
  ])("%s (from %s) with %p fails", (as, from, line, finding) => {
    expect(plant(as, from, line)).toContain(finding);
  });

  test.each([
    ["index.ts", "labels.ts", 'import { SQLBaseProvider } from "../sql-base";\n'],
    ["index.ts", "labels.ts", 'import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n'],
    ["index.ts", "labels.ts", 'import { getAppVersion } from "@/lib/app-version";\n'],
    ["index.ts", "labels.ts", 'import { DatabaseConfigError } from "@/lib/db/errors";\n'],
    ["index.ts", "labels.ts", 'import { findKind } from "@/lib/db/object-kinds";\n'],
    ["index.ts", "labels.ts", 'import { quoteIdentifier } from "@/lib/sql/identifier";\n'],
    ["index.ts", "labels.ts", 'import { BaseDatabaseProvider } from "@/lib/db/base-provider";\n'],
    ["index.ts", "labels.ts", 'import type { DatabaseProvider } from "@/lib/db/factory";\n'],
    ["index.ts", "labels.ts", 'const sentence = "The databases come from the system catalog, read elsewhere.";\n'],
    ["errors.ts", "errors.ts", 'import { TransportError } from "@/lib/db/http/node-transport";\n'],
    ["objects.ts", "objects.ts", 'import { tunnelRoute } from "@/lib/db/connection-fingerprint";\n'],
    ["auth-latch.ts", "auth-latch.ts", 'import { randomUUID } from "node:crypto";\n'],
    ["decode.ts", "decode.ts", 'import type { Readable } from "node:stream";\n'],
    ["errors.ts", "errors.ts", 'const sentence = "Databend refused POST /v1/query before it ran.";\n'],
    ["session.ts", "session.ts", 'const header = "x-databend-session";\n'],
    ["execution-ui.ts", "execution-ui.ts", 'import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";\n'],
    ["migration-ddl.ts", "migration-ddl.ts", 'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n'],
    ["sql-writing.ts", "sql-writing.ts", 'import { binaryUnhex } from "@/lib/db/sql-writing/export-shared";\n'],
    [
      "typed-literals.ts",
      "typed-literals.ts",
      'import { literalDoubleAndBackslash } from "@/lib/db/sql-writing/shared";\n',
    ],
  ])("%s (from %s) with %p passes", (as, from, line) => {
    expect(plant(as, from, line)).toEqual([]);
  });
});

describe("rule 8 fails by name", () => {
  const sources = (file: string, extra: string) => [{ file: `${DIR}/${file}`, text: read(`${DIR}/${file}`) + extra }];
  const finding = (file: string, name: string) =>
    `rule 8: ${DIR}/${file} exports ${name}, which nothing under src/ or the doc test imports`;
  const ONLY_FOR_A_TEST = "\nexport function onlyForATest(): number {\n  return 1;\n}\n";
  const readerOf = (file: string) => ({
    file,
    text: 'import { onlyForATest } from "@/lib/db/providers/sql/databend/decode";\n',
  });

  test("an export nothing imports fails", () => {
    expect(unimportedExports(sources("decode.ts", ONLY_FOR_A_TEST))).toEqual([finding("decode.ts", "onlyForATest")]);
  });

  test("an export by name and an enum nothing imports fail", () => {
    const extra =
      "\nfunction exportedLater(): number {\n  return 1;\n}\nexport { exportedLater };\nexport enum Probe {\n  A,\n}\n";
    expect(unimportedExports(sources("decode.ts", extra))).toEqual([
      finding("decode.ts", "Probe"),
      finding("decode.ts", "exportedLater"),
    ]);
  });

  test("a sentence and a frozen sentence table nothing imports fail like any other value", () => {
    const extra =
      '\nexport const DATABEND_UNREAD = "A sentence nobody quotes.";\nexport const DATABEND_TABLE_SENTENCES = Object.freeze({});\n';
    expect(unimportedExports(sources("decode.ts", extra))).toEqual([
      finding("decode.ts", "DATABEND_UNREAD"),
      finding("decode.ts", "DATABEND_TABLE_SENTENCES"),
    ]);
  });

  test("a type passes without an importer", () => {
    const extra = "\nexport interface Unread {\n  readonly a: number;\n}\nexport type Alias = Unread;\n";
    expect(unimportedExports(sources("decode.ts", extra))).toEqual([]);
  });

  // Reads every file under src/ twice: 0.8s alone with coverage and 2.8s under a 15% CPU quota.
  test(
    "a bound only the doc test reads passes, and fails once the doc test is no reader",
    () => {
      const real = sources("auth-latch.ts", "");
      expect(unimportedExports(real)).toEqual([]);
      const srcOnly = importers().filter((importer) => importer.file !== DOC_TEST);
      expect(unimportedExports(real, srcOnly)).toEqual([
        finding("auth-latch.ts", "AUTH_LATCH_TTL_MS"),
        finding("auth-latch.ts", "AUTH_LATCH_MAX_ENTRIES"),
      ]);
    },
    platformTimeoutMs(40_000),
  );

  test("a function planted in sql-text.ts fails by name", () => {
    expect(unimportedExports(sources("sql-text.ts", ONLY_FOR_A_TEST))).toEqual([
      finding("sql-text.ts", "onlyForATest"),
    ]);
  });

  test("a namespace import of the doc test reaches no name", () => {
    const planted = sources("decode.ts", ONLY_FOR_A_TEST);
    const namespace = {
      file: DOC_TEST,
      text: 'import * as decode from "@/lib/db/providers/sql/databend/decode";\n',
    };
    expect(unimportedExports(planted, [...importers(), namespace])).toEqual([finding("decode.ts", "onlyForATest")]);
  });

  // Reads every file under src/ twice: 0.7s alone with coverage and 2.6s under a 15% CPU quota.
  test(
    "the doc test counts as an importer, and no other test file does",
    () => {
      const planted = sources("decode.ts", ONLY_FOR_A_TEST);
      expect(unimportedExports(planted, [...importers(), readerOf(DOC_TEST)])).toEqual([]);
      expect(unimportedExports(planted, [...importers(), readerOf("tests/unit/db/databend/decode.test.ts")])).toEqual([
        finding("decode.ts", "onlyForATest"),
      ]);
    },
    platformTimeoutMs(40_000),
  );
});
