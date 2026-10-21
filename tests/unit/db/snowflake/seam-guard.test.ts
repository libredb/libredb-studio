/**
 * The Snowflake seam guard, in Databend's layered form: every source of `src/lib/db/providers/sql/snowflake/` is
 * parsed, so a file a later change adds is held by the same rules without editing this list.
 *
 * 1. No file imports a module under `src/lib/db/providers/` outside this directory, with one exception: `index.ts`
 *    extends `SQLBaseProvider` from `../sql-base`.
 * 2. Only `transport.ts` and `index.ts` name `createNodeTransport` or `createNodeByteTransport`, the socket paths:
 *    the transport builds them and the provider's `deps` may replace them. No file imports `node:http` or
 *    `node:https`, and none reaches `fetch`.
 * 3. Only `statements.ts` holds a string literal whose whole value starts with `/api/v2/statements`.
 * 4. Only `transport.ts` holds a string literal that starts with an `x-snowflake-` header name, in any case.
 * 5. A SQL statement literal (a literal whose whole value starts with an upper-case statement keyword and a space)
 *    appears only in `introspect.ts`, which also holds what `connect()` and `getHealth()` send, `monitoring.ts` and
 *    `statements.ts`, so `index.ts` sends none of its own. `errors.ts` may hold the `ALTER USER ... ADD KEY PAIR`
 *    statement its sentences print for the user to run; it never sends one. `migration-ddl.ts` may hold the
 *    `ALTER`, `CREATE` and `DROP` text it writes for the user to review; it never sends one either.
 * 6. The wire envelope's field names (`statementHandle`, `resultSetMetaData`, `rowType`, `partitionInfo`), as names
 *    or literals, appear only in `statements.ts`, `rows.ts` and `decode.ts`.
 * 7. A value is imported from outside this directory only from `@/lib/db/http/*`, `@/lib/db/errors`,
 *    `@/lib/db/types`, `@/lib/db/utils/*`, `@/lib/db/object-kinds`, `@/lib/db/inventory-bounds`, `@/lib/sql/*`,
 *    `@/lib/types`, `@/lib/app-version`, `@/lib/logger`, `../sql-base`, `@/lib/db/sql-grammar/shared` (the SQL
 *    grammar contract's building blocks, for `sql-grammar.ts`), `jose`, `node:crypto` and `node:zlib`; types are
 *    free. `execution-ui.ts`, the engine's execution UI contract module, may also import values from
 *    `@/lib/db/execution-ui/shared`, its contract's shared building block, `migration-ddl.ts`, the engine's
 *    migration DDL contract module, from `@/lib/db/migration-ddl/*`, its contract's shared building blocks, and
 *    `sql-writing.ts` and its `typed-literals.ts` sibling, the engine's SQL writing contract modules, from
 *    `@/lib/db/sql-writing/*`.
 * 8. Only `account.ts` builds an origin: outside it, the only values imported from `@/lib/db/http/endpoint` are
 *    `endpointUrl` and `rejectForeignLink`, which act on an origin already built; and `account-host.ts`, which the
 *    browser bundles, imports nothing.
 * 9. No file reads `process.env`.
 * 10. Every value export has an importer other than its own file: a module under `src/`, or
 *     `tests/unit/db/snowflake/provider-doc.test.ts`, which reads back what `docs/providers/snowflake.md` quotes; no
 *     other test file counts. The doc test reaches only the names it imports, so a namespace import of it reaches
 *     none. A type is part of the contract of the values that use it, so only values are held.
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
const DIR = "src/lib/db/providers/sql/snowflake";
const PROVIDERS = "src/lib/db/providers/";
const SQL_BASE = "src/lib/db/providers/sql/sql-base.ts";
const ENDPOINT = "src/lib/db/http/endpoint.ts";

/** Where a value from outside this directory may come from (rule 7). */
const OUTSIDE_VALUES = [
  "src/lib/db/http/",
  "src/lib/db/errors.ts",
  "src/lib/db/types.ts",
  "src/lib/db/utils/",
  "src/lib/db/object-kinds.ts",
  "src/lib/db/inventory-bounds.ts",
  "src/lib/sql/",
  "src/lib/types.ts",
  "src/lib/app-version.ts",
  "src/lib/logger.ts",
  SQL_BASE,
  "src/lib/db/sql-grammar/shared.ts",
];
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
const PACKAGE_VALUES = new Set(["jose"]);
const BUILTIN_VALUES = new Set(["node:crypto", "node:zlib"]);
const SOCKET_FACTORIES = ["createNodeTransport", "createNodeByteTransport"];
const SOCKET_FILES = new Set(["transport", "index"]);
const SQL_FILES = new Set(["introspect", "monitoring", "statements"]);
const ENVELOPE_FILES = new Set(["statements", "rows", "decode"]);
const ENVELOPE_FIELDS = ["statementHandle", "resultSetMetaData", "rowType", "partitionInfo"];
const ENDPOINT_SHARED = new Set(["endpointUrl", "rejectForeignLink"]);
/** An upper-case statement keyword and a space, at the start of a literal's whole value. */
const SQL_STATEMENT =
  /^(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|MERGE|CALL|USE|GRANT|REVOKE|TRUNCATE|UNDROP|COPY|PUT|GET|LIST|REMOVE|EXECUTE|SET|UNSET|WITH) /;
/** The one statement errors.ts may hold: the key registration its sentences print. */
const PRINTED_STATEMENT = /^ALTER USER (?:ADD KEY PAIR |<name> ADD KEY PAIR )/;
/** The statements migration-ddl.ts may hold: the DDL it writes for the user to review. */
const WRITTEN_DDL = /^(?:ALTER|CREATE|DROP) /;

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
  if (resolution !== undefined && !resolution.isExternalLibraryImport) {
    return relative(canonical(resolution.resolvedFileName));
  }
  if (resolution?.isExternalLibraryImport) return `package:${specifier}`;
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}.ts`;
  if (!specifier.startsWith(".")) return `package:${specifier}`;
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
      const namespace = bindings !== undefined && ts.isNamespaceImport(bindings);
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            !namespace &&
            named !== undefined &&
            named.length > 0 &&
            valueNames.length === 0));
      found.push({
        specifier: plain(node.moduleSpecifier),
        typeOnly,
        names: clause?.isTypeOnly
          ? []
          : [...valueNames, ...(clause?.name === undefined ? [] : ["default"]), ...(namespace ? ["*"] : [])],
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
      found.push({ specifier: plain(node.arguments[0]), typeOnly: false, names: ["*"], reaches: ["*"] });
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

/** Every identifier and property name a file spells, imports and declarations included. */
function names(file: string, text: string): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) found.add(node.text);
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

/** True when a file reads `process.env`, by property or by element access. */
function readsEnvironment(file: string, text: string): boolean {
  let found = false;
  const isProcess = (node: ts.Node) => ts.isIdentifier(node) && node.text === "process";
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isProcess(node.expression) && node.name.text === "env") found = true;
    if (ts.isElementAccessExpression(node) && isProcess(node.expression) && joined(node.argumentExpression) === "env") {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** Every finding of rules 1 to 9 for one file. */
function seamFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  const name = stem(file);

  for (const { specifier, typeOnly, names: bound } of references(file, text)) {
    if (specifier === undefined) {
      findings.push(`seam: ${file} loads a module whose name is not a plain string`);
      continue;
    }
    if (name === "account-host")
      findings.push(`rule 8: ${file} imports ${specifier}, and account-host.ts imports nothing`);
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
    if (target === ENDPOINT && name !== "account" && bound.some((value) => !ENDPOINT_SHARED.has(value))) {
      findings.push(`rule 8: ${file} imports an origin builder from ${specifier}, which only account.ts imports`);
    }
    if (typeOnly || inDirectory(target)) continue;
    const contract = Object.hasOwn(CONTRACT_VALUES, name) && target.startsWith(CONTRACT_VALUES[name]);
    const allowed = target.startsWith("package:")
      ? PACKAGE_VALUES.has(target.slice("package:".length))
      : contract || OUTSIDE_VALUES.some((prefix) => target.startsWith(prefix));
    if (!allowed) findings.push(`rule 7: ${file} imports a value from ${specifier}, which this directory may not`);
  }

  const spelled = names(file, text);
  if (!SOCKET_FILES.has(name)) {
    for (const factory of SOCKET_FACTORIES) {
      if (spelled.has(factory))
        findings.push(`rule 2: ${file} names ${factory}, which only transport.ts and index.ts name`);
    }
  }
  if (reachesFetch(file, text)) findings.push(`rule 2: ${file} reaches fetch`);
  if (!ENVELOPE_FILES.has(name)) {
    for (const field of ENVELOPE_FIELDS) {
      if (spelled.has(field)) findings.push(`rule 6: ${file} names the envelope field ${field}`);
    }
  }
  for (const literal of literals(file, text)) {
    if (name !== "statements" && literal.startsWith("/api/v2/statements")) {
      findings.push(`rule 3: ${file} holds the path literal "${literal}", which only statements.ts may hold`);
    }
    if (name !== "transport" && literal.toLowerCase().startsWith("x-snowflake-")) {
      findings.push(`rule 4: ${file} holds the header name "${literal}", which only transport.ts may hold`);
    }
    const printed = name === "errors" && PRINTED_STATEMENT.test(literal);
    const written = name === "migration-ddl" && WRITTEN_DDL.test(literal);
    if (!SQL_FILES.has(name) && SQL_STATEMENT.test(literal) && !printed && !written) {
      findings.push(`rule 5: ${file} holds the SQL statement literal "${literal.slice(0, 40)}"`);
    }
    if (!ENVELOPE_FILES.has(name) && ENVELOPE_FIELDS.includes(literal)) {
      findings.push(`rule 6: ${file} holds the envelope field literal "${literal}"`);
    }
  }
  if (readsEnvironment(file, text)) findings.push(`rule 9: ${file} reads process.env`);
  return findings;
}

interface Exported {
  readonly name: string;
  /** An interface or a type alias, which rule 10 does not hold. */
  readonly type: boolean;
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

/** The names a module exports (rule 10): each declaration, and each name of a local `export { ... }`. */
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

/** The one test file whose imports count for rule 10: it reads back what the provider doc quotes. */
const DOC_TEST = "tests/unit/db/snowflake/provider-doc.test.ts";

interface Importer {
  readonly file: string;
  readonly text: string;
}

/**
 * The importers rule 10 counts: every `.ts` and `.tsx` file of this directory, every other one under `src/` whose
 * text names `snowflake` (the only ones that can import from here), and the provider doc test.
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
    .filter(({ file, text }) => inDirectory(file) || text.includes("snowflake"));
}

/** Every value export of this directory that no reader under `src/`, and not the doc test, imports (rule 10). */
function unimportedExports(sources: readonly Importer[], readers: readonly Importer[] = importers()): string[] {
  const reached = new Map<string, Set<string>>();
  for (const { file, text } of readers) {
    if (!file.startsWith("src/") && file !== DOC_TEST) continue;
    for (const reference of references(file, text)) {
      if (reference.specifier === undefined) continue;
      const target = resolved(reference.specifier, file);
      if (!inDirectory(target) || target === file) continue;
      const set = reached.get(target) ?? new Set<string>();
      // The doc test is held to the names it reads: a namespace import of it would admit every export unread.
      for (const reachedName of reference.reaches) if (file !== DOC_TEST || reachedName !== "*") set.add(reachedName);
      reached.set(target, set);
    }
  }
  return sources.flatMap(({ file, text }) => {
    const set = reached.get(file) ?? new Set<string>();
    if (set.has("*")) return [];
    return exportsOf(file, text)
      .filter((entry) => !entry.type && !set.has(entry.name))
      .map((entry) => `rule 10: ${file} exports ${entry.name}, which nothing under src/ or the doc test imports`);
  });
}

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const SOURCES = readdirSync(join(ROOT, DIR))
  .filter((entry) => entry.endsWith(".ts"))
  .map((entry) => `${DIR}/${entry}`);

describe("the Snowflake directory holds its seams", () => {
  // The first parse of the directory pays the parser's warm-up: 0.7s alone with coverage and 5.4s under a
  // 15% CPU quota, past bun's 5s default, so it carries its own bound.
  test(
    "every source passes rules 1 to 9",
    () => {
      expect(SOURCES).toContain(`${DIR}/index.ts`);
      expect(SOURCES).toContain(`${DIR}/account-host.ts`);
      expect(SOURCES.flatMap((file) => seamFindings(file, read(file)))).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  // Reads every file under src/: 0.5s alone with coverage and 3.1s under a 15% CPU quota.
  test(
    "every value export has an importer under src/ or the doc test (rule 10)",
    () => {
      expect(unimportedExports(SOURCES.map((file) => ({ file, text: read(file) })))).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test("the detector reads real code", () => {
    const transport = references(`${DIR}/transport.ts`, read(`${DIR}/transport.ts`));
    expect(transport.find((reference) => reference.specifier === "@/lib/db/http/node-transport")?.names).toEqual(
      expect.arrayContaining(SOCKET_FACTORIES),
    );
    expect(literals(`${DIR}/transport.ts`, read(`${DIR}/transport.ts`))).toContain(
      "x-snowflake-authorization-token-type",
    );
    expect(literals(`${DIR}/statements.ts`, read(`${DIR}/statements.ts`))).toContain("/api/v2/statements");
    expect(literals(`${DIR}/introspect.ts`, read(`${DIR}/introspect.ts`)).some((l) => SQL_STATEMENT.test(l))).toBe(
      true,
    );
    expect(names(`${DIR}/statements.ts`, read(`${DIR}/statements.ts`)).has("statementHandle")).toBe(true);
    const index = references(`${DIR}/index.ts`, read(`${DIR}/index.ts`));
    expect(index.find((reference) => reference.specifier === "../sql-base")?.names).toEqual(["SQLBaseProvider"]);
    const auth = references(`${DIR}/auth.ts`, read(`${DIR}/auth.ts`));
    expect(auth.find((reference) => reference.specifier === "jose")?.names).toEqual(["SignJWT"]);
    expect(resolved("jose", `${DIR}/auth.ts`)).toBe("package:jose");
    expect(references(`${DIR}/account-host.ts`, read(`${DIR}/account-host.ts`))).toEqual([]);
    const errors = literals(`${DIR}/errors.ts`, read(`${DIR}/errors.ts`));
    expect(errors.some((literal) => PRINTED_STATEMENT.test(literal))).toBe(true);
    const readers = importers().map((importer) => importer.file);
    expect(readers).toContain(DOC_TEST);
    expect(readers).toContain(`${DIR}/rows.ts`);
  });
});

/** A planted file: a real file's text under its own name or a name a later change will add. */
const plant = (as: string, from: string, line: string): string[] =>
  seamFindings(`${DIR}/${as}`, line + read(`${DIR}/${from}`));

describe("planted violations fail by name", () => {
  test.each([
    // rule 1
    [
      "introspect.ts",
      "introspect.ts",
      'import { DatabendProvider } from "@/lib/db/providers/sql/databend";\n',
      `rule 1: ${DIR}/introspect.ts imports @/lib/db/providers/sql/databend, a module of another provider directory`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import type { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n',
      `rule 1: ${DIR}/errors.ts imports @/lib/db/providers/sql/sql-base, a module of another provider directory`,
    ],
    [
      "transport.ts",
      "transport.ts",
      'import { createBigQueryTransport } from "../bigquery/transport";\n',
      `rule 1: ${DIR}/transport.ts imports ../bigquery/transport, a module of another provider directory`,
    ],
    // rule 2
    [
      "statements.ts",
      "statements.ts",
      'import { createNodeTransport } from "@/lib/db/http/node-transport";\n',
      `rule 2: ${DIR}/statements.ts names createNodeTransport, which only transport.ts and index.ts name`,
    ],
    [
      "rows.ts",
      "rows.ts",
      "const open = createNodeByteTransport;\n",
      `rule 2: ${DIR}/rows.ts names createNodeByteTransport, which only transport.ts and index.ts name`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import { request } from "node:https";\n',
      `rule 2: ${DIR}/errors.ts imports node:https`,
    ],
    ["index.ts", "index.ts", 'import http from "node:http";\n', `rule 2: ${DIR}/index.ts imports node:http`],
    ["monitoring.ts", "monitoring.ts", "const send = fetch;\n", `rule 2: ${DIR}/monitoring.ts reaches fetch`],
    [
      "introspect.ts",
      "introspect.ts",
      'const send = globalThis["fetch"];\n',
      `rule 2: ${DIR}/introspect.ts reaches fetch`,
    ],
    // rule 3
    [
      "transport.ts",
      "transport.ts",
      'const path = "/api/v2/statements";\n',
      `rule 3: ${DIR}/transport.ts holds the path literal "/api/v2/statements", which only statements.ts may hold`,
    ],
    [
      "index.ts",
      "index.ts",
      "const path = (id: string) => `/api/v2/statements/${id}/cancel`;\n",
      `rule 3: ${DIR}/index.ts holds the path literal "/api/v2/statements/", which only statements.ts may hold`,
    ],
    // rule 4
    [
      "statements.ts",
      "statements.ts",
      'const header = "X-Snowflake-Authorization-Token-Type";\n',
      `rule 4: ${DIR}/statements.ts holds the header name "X-Snowflake-Authorization-Token-Type", which only transport.ts may hold`,
    ],
    // rule 5
    [
      "index.ts",
      "index.ts",
      'const sql = "SELECT CURRENT_VERSION()";\n',
      `rule 5: ${DIR}/index.ts holds the SQL statement literal "SELECT CURRENT_VERSION()"`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'const sql = "SHOW USERS";\n',
      `rule 5: ${DIR}/errors.ts holds the SQL statement literal "SHOW USERS"`,
    ],
    [
      "index.ts",
      "index.ts",
      'const ddl = "ALTER TABLE t DROP COLUMN c";\n',
      `rule 5: ${DIR}/index.ts holds the SQL statement literal "ALTER TABLE t DROP COLUMN c"`,
    ],
    [
      "migration-ddl.ts",
      "migration-ddl.ts",
      'const sql = "SELECT CURRENT_VERSION()";\n',
      `rule 5: ${DIR}/migration-ddl.ts holds the SQL statement literal "SELECT CURRENT_VERSION()"`,
    ],
    // rule 6
    [
      "index.ts",
      "index.ts",
      "const handleOf = (answer: { statementHandle: string }) => answer.statementHandle;\n",
      `rule 6: ${DIR}/index.ts names the envelope field statementHandle`,
    ],
    [
      "introspect.ts",
      "introspect.ts",
      'const field = "partitionInfo";\n',
      `rule 6: ${DIR}/introspect.ts holds the envelope field literal "partitionInfo"`,
    ],
    // rule 7
    [
      "introspect.ts",
      "introspect.ts",
      'import { getDBConfig } from "@/lib/db-ui-config";\n',
      `rule 7: ${DIR}/introspect.ts imports a value from @/lib/db-ui-config, which this directory may not`,
    ],
    [
      "index.ts",
      "index.ts",
      'import { createDatabaseProvider } from "@/lib/db/factory";\n',
      `rule 7: ${DIR}/index.ts imports a value from @/lib/db/factory, which this directory may not`,
    ],
    [
      "introspect.ts",
      "introspect.ts",
      'import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";\n',
      `rule 7: ${DIR}/introspect.ts imports a value from @/lib/db/execution-ui/shared, which this directory may not`,
    ],
    [
      "decode.ts",
      "decode.ts",
      'import { readFileSync } from "node:fs";\n',
      `rule 7: ${DIR}/decode.ts imports a value from node:fs, a runtime built-in it may not`,
    ],
    [
      "auth.ts",
      "auth.ts",
      'import { sign } from "jsonwebtoken";\n',
      `rule 7: ${DIR}/auth.ts imports a value from jsonwebtoken, which this directory may not`,
    ],
    [
      "introspect.ts",
      "introspect.ts",
      'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n',
      `rule 7: ${DIR}/introspect.ts imports a value from @/lib/db/migration-ddl/shared, which this directory may not`,
    ],
    [
      "introspect.ts",
      "introspect.ts",
      'import { literalStandard } from "@/lib/db/sql-writing/shared";\n',
      `rule 7: ${DIR}/introspect.ts imports a value from @/lib/db/sql-writing/shared, which this directory may not`,
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
      'const loaded = await import(["./intro", "spect"].join(""));\n',
      `seam: ${DIR}/decode.ts loads a module whose name is not a plain string`,
    ],
    // rule 8
    [
      "transport.ts",
      "transport.ts",
      'import { httpOrigin } from "@/lib/db/http/endpoint";\n',
      `rule 8: ${DIR}/transport.ts imports an origin builder from @/lib/db/http/endpoint, which only account.ts imports`,
    ],
    [
      "account-host.ts",
      "account-host.ts",
      'import { SNOWFLAKE } from "./errors";\n',
      `rule 8: ${DIR}/account-host.ts imports ./errors, and account-host.ts imports nothing`,
    ],
    // rule 9
    ["index.ts", "index.ts", "const host = process.env.SNOWFLAKE_HOST;\n", `rule 9: ${DIR}/index.ts reads process.env`],
    [
      "transport.ts",
      "transport.ts",
      'const flag = process["env"].DEBUG;\n',
      `rule 9: ${DIR}/transport.ts reads process.env`,
    ],
  ])("%s (from %s) with %p fails", (as, from, line, finding) => {
    expect(plant(as, from, line)).toContain(finding);
  });

  test.each([
    ["index.ts", "index.ts", 'import { SQLBaseProvider } from "../sql-base";\n'],
    ["index.ts", "index.ts", 'import { createNodeTransport } from "@/lib/db/http/node-transport";\n'],
    ["index.ts", "index.ts", 'import { getAppVersion } from "@/lib/app-version";\n'],
    ["index.ts", "index.ts", 'import { logger } from "@/lib/logger";\n'],
    ["introspect.ts", "introspect.ts", 'import { INVENTORY_LIMIT } from "@/lib/db/inventory-bounds";\n'],
    ["index.ts", "index.ts", 'import type { DatabaseProvider } from "@/lib/db/factory";\n'],
    ["rows.ts", "rows.ts", 'import { gunzipSync } from "node:zlib";\n'],
    ["auth.ts", "auth.ts", 'import { SignJWT } from "jose";\n'],
    ["statements.ts", "statements.ts", 'import { endpointUrl, rejectForeignLink } from "@/lib/db/http/endpoint";\n'],
    ["errors.ts", "errors.ts", 'import type { HttpOrigin } from "@/lib/db/http/endpoint";\n'],
    ["account.ts", "account.ts", 'import { httpOrigin } from "@/lib/db/http/endpoint";\n'],
    ["introspect.ts", "introspect.ts", 'const sql = "SHOW DATABASES LIMIT 1";\n'],
    ["migration-ddl.ts", "migration-ddl.ts", 'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n'],
    ["migration-ddl.ts", "migration-ddl.ts", "const drop = (table: string) => `DROP TABLE ${table};`;\n"],
    ["sql-writing.ts", "sql-writing.ts", 'import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";\n'],
    [
      "typed-literals.ts",
      "typed-literals.ts",
      'import { literalDoubleAndBackslash } from "@/lib/db/sql-writing/shared";\n',
    ],
    ["errors.ts", "errors.ts", "const fix = (body: string) => `ALTER USER ADD KEY PAIR k PUBLIC_KEY = '${body}'`;\n"],
    ["index.ts", "index.ts", 'const sentence = "Set Warehouse on the connection to run statements.";\n'],
    ["errors.ts", "errors.ts", 'const sentence = "Snowflake refused POST /api/v2/statements before it ran.";\n'],
    ["execution-ui.ts", "execution-ui.ts", 'import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";\n'],
  ])("%s (from %s) with %p passes", (as, from, line) => {
    expect(plant(as, from, line)).toEqual([]);
  });
});

describe("rule 10 fails by name", () => {
  const sources = (file: string, extra: string) => [{ file: `${DIR}/${file}`, text: read(`${DIR}/${file}`) + extra }];
  const finding = (file: string, name: string) =>
    `rule 10: ${DIR}/${file} exports ${name}, which nothing under src/ or the doc test imports`;
  const ONLY_FOR_A_TEST = "\nexport function onlyForATest(): number {\n  return 1;\n}\n";
  const readerOf = (file: string) => ({
    file,
    text: 'import { onlyForATest } from "@/lib/db/providers/sql/snowflake/decode";\n',
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

  test("a sentence table nothing imports fails like any other value", () => {
    const extra = '\nexport const SNOWFLAKE_UNREAD_SENTENCES = Object.freeze({ a: "A sentence nobody quotes." });\n';
    expect(unimportedExports(sources("rows.ts", extra))).toEqual([finding("rows.ts", "SNOWFLAKE_UNREAD_SENTENCES")]);
  });

  test("a type passes without an importer", () => {
    const extra = "\nexport interface Unread {\n  readonly a: number;\n}\nexport type Alias = Unread;\n";
    expect(unimportedExports(sources("decode.ts", extra))).toEqual([]);
  });

  test("a namespace import of the doc test reaches no name", () => {
    const planted = sources("decode.ts", ONLY_FOR_A_TEST);
    const namespace = { file: DOC_TEST, text: 'import * as decode from "@/lib/db/providers/sql/snowflake/decode";\n' };
    expect(unimportedExports(planted, [...importers(), namespace])).toEqual([finding("decode.ts", "onlyForATest")]);
  });

  // Reads every file under src/ twice: 0.5s alone with coverage and 2.8s under a 15% CPU quota.
  test(
    "the doc test counts as an importer, and no other test file does",
    () => {
      const planted = sources("decode.ts", ONLY_FOR_A_TEST);
      expect(unimportedExports(planted, [...importers(), readerOf(DOC_TEST)])).toEqual([]);
      expect(unimportedExports(planted, [...importers(), readerOf("tests/unit/db/snowflake/decode.test.ts")])).toEqual([
        finding("decode.ts", "onlyForATest"),
      ]);
    },
    platformTimeoutMs(40_000),
  );
});
