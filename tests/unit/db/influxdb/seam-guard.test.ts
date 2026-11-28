/**
 * The InfluxDB seam guard (InfluxDB spec 3.5 and E18, contract section 1), in the Qdrant and Prometheus shape: every
 * source of `src/lib/db/providers/timeseries/influxdb/` and of the influxql family module,
 * `src/lib/languages/influxql/`, is parsed, so a file a later task adds is held by the same rules without editing
 * this list.
 *
 * 1. No file imports a module under `src/lib/db/providers/` outside this directory, with exactly one exception: the
 *    specifier `@/lib/db/providers/sql/sql-base`, imported by `sql-provider.ts` (R15).
 * 2. No `influxql-*` module imports an `sql-*` module, and no `sql-*` module imports an `influxql-*` module.
 * 3. No shared-layer module imports an `influxql-*` or `sql-*` module.
 *    For rules 2 and 3, a module of the influxql statement language's core family module, `src/lib/languages/influxql/`
 *    (the lexer, the policy, the confirmation row and the agent's statement reader), counts as an `influxql-*`
 *    module, so the halves stay apart for the modules that moved there.
 * 4. Only `client.ts` imports `createNodeTransport`, only `connection-options.ts` imports `nodeTlsMaterial`, and
 *    nothing reaches `fetch`, `node:http` or `node:https` itself.
 * 5. No file outside `routes.ts` holds a string literal whose whole value starts with `/api/` or equals `/query`,
 *    `/ping` or `/health`; a sentence that mentions a path inside longer text is not a path literal.
 * 6. Each layer value-imports only what contract section 1 lets it (types are free): `connection-options.ts` may take
 *    the value `TUNNEL_FAR_END` from `@/lib/types` (the Qdrant shape, architect amendment from T09), and a file of no
 *    layer fails, so a new file is placed in one on purpose. The browser and InfluxQL server layers
 *    may take values from the influxql family module, which holds the lexer and the policy they read. Each type-id's
 *    SQL grammar, SQL writing and migration DDL are its declaration's (docs/providers/CONTRACT.md, clauses M-78, M-79
 *    and M-80), so no module here declares any of them.
 *    Each type-id's engine facets module (`<type-id>-engine-facets.ts`) is a contract layer of its own: it may import
 *    no value, and from none of this directory's modules.
 *    The influxql family module is a layer of its own: its lexer, policy, confirmation row and agent statement reader
 *    are shipped to the browser, so each may import values only from another family member and from none of this
 *    directory's modules, and a family file of no layer fails too. Rules 1, 4 and 5 hold its files as they hold this
 *    directory's, and rule 2 counts each of them as an `influxql-*` module.
 *
 * Rules 1 to 3 count a type-only import too: they keep modules apart, not values. Module names are resolved as
 * TypeScript resolves them, so an alias counts; a planted module that does not exist yet resolves by its spelling.
 * Each rule is proven both ways: the real sources pass, and a violation planted in a copy of a real file's text fails
 * by name.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";
import { statementLanguageFamilyDirectory } from "../../../helpers/statement-language-family";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DIR = "src/lib/db/providers/timeseries/influxdb";
const PROVIDERS = "src/lib/db/providers/";
const FAMILY_DIR = statementLanguageFamilyDirectory("influxql");
const SQL_BASE = "@/lib/db/providers/sql/sql-base";

const SHARED = ["connection-options", "routes", "client", "versions", "errors", "run-database", "monitoring", "labels"];
const BROWSER = [
  "influxql-quote",
  "influxql-generators",
  // The editor's InfluxQL language, its completion and its editor language row, which read only the lexer and quoter.
  "influxql-editor-syntax",
  "influxql-editor-completions",
  "influxql-editor-language",
];
const INFLUXQL_SERVER = ["influxql-results", "influxql-objects", "influxql-provider", "influxql-agent-read"];
/** Each type-id's declaration of a per-engine contract, which reads its contract and nothing of this directory. */
const CONTRACT = ["influxdb-engine-facets", "influxdb3-engine-facets"];
/**
 * The influxql family module, `src/lib/languages/influxql/`: the lexer, the policy, the confirmation row and the
 * agent's statement reader, all shipped to the browser, so it reads only its own members and nothing of this directory.
 */
const FAMILY = ["lexer", "policy", "destructive", "agent-statement"];

type Layer = "connection" | "browser" | "influxql-server" | "sql" | "contract" | "family";

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const relative = (path: string): string => path.slice(canonical(ROOT).length + 1);
const stem = (file: string): string => posix.basename(file).replace(/\.ts$/, "");

const inFamily = (path: string): boolean => path.startsWith(`${FAMILY_DIR}/`);

function layerOf(file: string): Layer | undefined {
  const name = stem(file);
  if (inFamily(file)) return FAMILY.includes(name) ? "family" : undefined;
  if (SHARED.includes(name) || name === "index") return "connection";
  if (BROWSER.includes(name)) return "browser";
  if (INFLUXQL_SERVER.includes(name)) return "influxql-server";
  if (name.startsWith("sql-")) return "sql";
  if (CONTRACT.includes(name)) return "contract";
  return undefined;
}

const inDirectory = (target: string): boolean => target.startsWith(`${DIR}/`);
const isInfluxql = (target: string): boolean =>
  (inDirectory(target) && stem(target).startsWith("influxql-")) || inFamily(target);
const isSql = (target: string): boolean => inDirectory(target) && stem(target).startsWith("sql-");

/** What the connection layer may import a value from outside this directory. */
const CONNECTION_OUTSIDE = [
  "src/lib/db/http/",
  "src/lib/db/errors.ts",
  "src/lib/db/utils/server-text.ts",
  "src/lib/db/credential-warnings.ts",
];

/**
 * What each layer may import a value from, beside this directory's modules its row names (contract section 1). The
 * InfluxQL server and SQL rows name "the connection layer", read as its modules and what they may import, so a
 * results module or a provider may raise the repository's error classes; rule 4 still keeps the transport factory
 * and the TLS mapping where they are.
 */
const OUTSIDE_VALUES: Readonly<Record<Layer, readonly string[]>> = {
  connection: CONNECTION_OUTSIDE,
  // The influxql family module: the lexer and the policy the editor language reads.
  browser: [`${FAMILY_DIR}/`],
  "influxql-server": [
    ...CONNECTION_OUTSIDE,
    // The influxql family module: the lexer, the policy and the agent's statement reader the provider runs.
    `${FAMILY_DIR}/`,
    // The SDK's value readers, which `quoteUnsafeIntegers` is one of.
    "packages/provider-sdk/src/values/index.ts",
    "src/lib/db/utils/bounded-limiter.ts",
    "src/lib/db/base-provider.ts",
    "src/lib/db/object-kinds.ts",
    "src/lib/db/read-only-budget.ts",
    // The shared write-reach declaration helpers, a pure module that names no engine.
    "src/lib/db/write-reach.ts",
  ],
  sql: [
    ...CONNECTION_OUTSIDE,
    "src/lib/sql/grammar.ts",
    "src/lib/sql/leading-keyword.ts",
    "src/lib/sql/statement-splitter.ts",
    "src/lib/sql/spans.ts",
    "packages/provider-sdk/src/values/index.ts",
    "src/lib/db/utils/bounded-limiter.ts",
    // The shared column naming every SQL provider uses, a pure module that imports nothing.
    "src/lib/db/utils/result-fields.ts",
    "src/lib/db/object-kinds.ts",
    "src/lib/db/providers/sql/sql-base.ts",
    "src/lib/db/read-only-budget.ts",
    "src/lib/db/write-reach.ts",
  ],
  contract: [],
  family: [`${FAMILY_DIR}/`],
};

/** Which of this directory's modules each layer may import a value from. */
function insideAllowed(file: string, layer: Layer, target: string): boolean {
  const name = stem(target);
  const shared = SHARED.includes(name);
  switch (layer) {
    case "connection":
      return shared || (stem(file) === "index" && (name === "influxql-provider" || name === "sql-provider"));
    case "browser":
      return BROWSER.includes(name);
    case "influxql-server":
      return shared || name.startsWith("influxql-");
    case "sql":
      return shared || name.startsWith("sql-");
    case "contract":
    case "family":
      return false;
  }
}

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
  /** The names a value import binds, when it binds named elements. */
  readonly names: readonly string[];
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
      const valueNames = (named ?? []).filter((element) => !element.isTypeOnly).map((element) => element.name.text);
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined && named !== undefined && named.length > 0 && valueNames.length === 0));
      found.push({
        specifier: plain(node.moduleSpecifier),
        typeOnly,
        names: clause?.name === undefined ? valueNames : [...valueNames, clause.name.text],
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      found.push({ specifier: plain(node.moduleSpecifier), typeOnly: node.isTypeOnly, names: [] });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) ? plain(argument.literal) : undefined;
      found.push({ specifier, typeOnly: true, names: [] });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found.push({ specifier: plain(node.arguments[0]), typeOnly: false, names: [] });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** The literal texts of a file whose whole value is a string: strings, plain templates and a template's head. */
function literals(file: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** True when a file names `fetch` as a value: a call, `globalThis.fetch`, or any other reference. */
function reachesFetch(file: string, text: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "fetch") found = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

const PATH_LITERALS = new Set(["/query", "/ping", "/health"]);

/**
 * Every finding of the six rules for one file. The rules that name a module of this directory (`client.ts`,
 * `routes.ts`, an `influxql-*` or `sql-*` module) name it by its path here, so a family file of the same stem is
 * not that module; every family file is on the InfluxQL side of rule 2.
 */
function seamFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  const name = inDirectory(file) ? stem(file) : "";
  const influxqlSide = name.startsWith("influxql-") || inFamily(file);
  const layer = layerOf(file);
  if (layer === undefined) findings.push(`layer: ${file} belongs to no layer of contract section 1`);

  for (const { specifier, typeOnly, names } of references(file, text)) {
    if (specifier === undefined) {
      findings.push(`seam: ${file} loads a module whose name is not a plain string`);
      continue;
    }
    if (["node:http", "node:https", "http", "https"].includes(specifier)) {
      findings.push(`rule 4: ${file} imports ${specifier}`);
      continue;
    }
    if (isBuiltin(specifier) || specifier.startsWith("bun:")) {
      if (!typeOnly) findings.push(`layer: ${file} imports ${specifier}, a runtime built-in`);
      continue;
    }
    const target = resolved(specifier, file);

    if (target.startsWith(PROVIDERS) && !inDirectory(target)) {
      const excepted = name === "sql-provider" && specifier === SQL_BASE;
      if (!excepted) {
        findings.push(`rule 1: ${file} imports ${specifier}, a module of another provider directory`);
      }
    }
    if ((influxqlSide && isSql(target)) || (name.startsWith("sql-") && isInfluxql(target))) {
      findings.push(`rule 2: ${file} imports ${specifier} across the InfluxQL and SQL halves`);
    }
    if (SHARED.includes(name) && (isInfluxql(target) || isSql(target))) {
      findings.push(`rule 3: ${file} is a shared-layer module and imports ${specifier}`);
    }
    if (names.includes("createNodeTransport") && name !== "client") {
      findings.push(`rule 4: ${file} imports createNodeTransport, which only client.ts imports`);
    }
    if (names.includes("nodeTlsMaterial") && name !== "connection-options") {
      findings.push(`rule 4: ${file} imports nodeTlsMaterial, which only connection-options.ts imports`);
    }

    if (layer === undefined || typeOnly) continue;
    const allowed = inDirectory(target)
      ? insideAllowed(file, layer, target)
      : OUTSIDE_VALUES[layer].some((prefix) => target.startsWith(prefix)) ||
        (name === "connection-options" &&
          target === "src/lib/types.ts" &&
          names.length > 0 &&
          names.every((bound) => bound === "TUNNEL_FAR_END"));
    if (!allowed) findings.push(`layer: ${file} imports a value from ${specifier}, which its layer may not`);
  }

  if (reachesFetch(file, text)) findings.push(`rule 4: ${file} reaches fetch`);
  if (name !== "routes") {
    for (const literal of literals(file, text)) {
      if (literal.startsWith("/api/") || PATH_LITERALS.has(literal)) {
        findings.push(`rule 5: ${file} holds the path literal "${literal}", which only routes.ts may hold`);
      }
    }
  }
  return findings;
}

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const sourcesOf = (dir: string): string[] =>
  readdirSync(join(ROOT, dir))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${dir}/${entry}`);
const SOURCES = [...sourcesOf(DIR), ...sourcesOf(FAMILY_DIR)];

describe("the InfluxDB directory holds its seams", () => {
  test("every source passes all six rules", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.flatMap((file) => seamFindings(file, read(file)))).toEqual([]);
  });

  test("the detector reads real code", () => {
    const client = references(`${DIR}/client.ts`, read(`${DIR}/client.ts`));
    expect(client.find((reference) => reference.specifier === "@/lib/db/http/node-transport")?.names).toContain(
      "createNodeTransport",
    );
    const options = references(`${DIR}/connection-options.ts`, read(`${DIR}/connection-options.ts`));
    expect(options.find((reference) => reference.specifier === "@/lib/types")?.names).toEqual(["TUNNEL_FAR_END"]);
    expect(literals(`${DIR}/routes.ts`, read(`${DIR}/routes.ts`))).toContain("/query");
    expect(seamFindings(`${DIR}/routes.ts`, read(`${DIR}/routes.ts`))).toEqual([]);
  });
});

/** A planted file: a real file's text under its own name or a name a later task will add. */
const plant = (as: string, from: string, line: string): string[] =>
  seamFindings(`${DIR}/${as}`, line + read(`${DIR}/${from}`));

/** A planted file of the influxql family module: a real family file's text under its own name or a new one. */
const plantFamily = (as: string, from: string, line: string): string[] =>
  seamFindings(`${FAMILY_DIR}/${as}`, line + read(`${FAMILY_DIR}/${from}`));

describe("the influxql family module is held as a layer of its own", () => {
  test("the guard reads every family source", () => {
    for (const name of ["lexer", "policy", "destructive", "agent-statement"]) {
      expect(SOURCES).toContain(`${FAMILY_DIR}/${name}.ts`);
    }
  });

  test.each([
    [
      "destructive.ts",
      "destructive.ts",
      'import { QueryError } from "@/lib/db/errors";\nvoid QueryError;\n',
      `layer: ${FAMILY_DIR}/destructive.ts imports a value from @/lib/db/errors, which its layer may not`,
    ],
    [
      "agent-statement.ts",
      "agent-statement.ts",
      'import { QueryError } from "@/lib/db/errors";\nvoid QueryError;\n',
      `layer: ${FAMILY_DIR}/agent-statement.ts imports a value from @/lib/db/errors, which its layer may not`,
    ],
    [
      "policy.ts",
      "policy.ts",
      `import { quoteInfluxqlIdentifier } from "@/${DIR.slice("src/".length)}/influxql-quote";\n`,
      `layer: ${FAMILY_DIR}/policy.ts imports a value from @/${DIR.slice("src/".length)}/influxql-quote, which its layer may not`,
    ],
    [
      "destructive.ts",
      "destructive.ts",
      'import { readFileSync } from "node:fs";\n',
      `layer: ${FAMILY_DIR}/destructive.ts imports node:fs, a runtime built-in`,
    ],
    [
      "agent-statement.ts",
      "agent-statement.ts",
      'import http from "node:http";\n',
      `rule 4: ${FAMILY_DIR}/agent-statement.ts imports node:http`,
    ],
    [
      "client.ts",
      "lexer.ts",
      'import { createNodeTransport } from "@/lib/db/http/node-transport";\n',
      `rule 4: ${FAMILY_DIR}/client.ts imports createNodeTransport, which only client.ts imports`,
    ],
    [
      "destructive.ts",
      "destructive.ts",
      'void fetch("http://x");\n',
      `rule 4: ${FAMILY_DIR}/destructive.ts reaches fetch`,
    ],
    [
      "routes.ts",
      "lexer.ts",
      'const path = "/query";\n',
      `rule 5: ${FAMILY_DIR}/routes.ts holds the path literal "/query", which only routes.ts may hold`,
    ],
    [
      "agent-statement.ts",
      "agent-statement.ts",
      `import type { SqlRows } from "@/${DIR.slice("src/".length)}/sql-results";\n`,
      `rule 2: ${FAMILY_DIR}/agent-statement.ts imports @/${DIR.slice("src/".length)}/sql-results across the InfluxQL and SQL halves`,
    ],
    ["stray.ts", "lexer.ts", "", `layer: ${FAMILY_DIR}/stray.ts belongs to no layer of contract section 1`],
    ["labels.ts", "lexer.ts", "", `layer: ${FAMILY_DIR}/labels.ts belongs to no layer of contract section 1`],
  ])("%s (from %s) with %p fails", (as, from, line, finding) => {
    expect(plantFamily(as, from, line)).toContain(finding);
  });

  test.each([
    ["destructive.ts", "destructive.ts", 'import { lexInfluxql } from "@/lib/languages/influxql/lexer";\n'],
    ["agent-statement.ts", "agent-statement.ts", 'import { evaluateInfluxql } from "./policy";\n'],
    ["policy.ts", "policy.ts", 'import type { QueryResult } from "@/lib/types";\n'],
  ])("%s (from %s) with %p passes", (as, from, line) => {
    expect(plantFamily(as, from, line)).toEqual([]);
  });
});

describe("planted violations fail by name", () => {
  test.each([
    // rule 1
    [
      "client.ts",
      "client.ts",
      'import { QdrantProvider } from "@/lib/db/providers/vector/qdrant";\n',
      `rule 1: ${DIR}/client.ts imports @/lib/db/providers/vector/qdrant, a module of another provider directory`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import type { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n',
      `rule 1: ${DIR}/errors.ts imports @/lib/db/providers/sql/sql-base, a module of another provider directory`,
    ],
    [
      "sql-results.ts",
      "sql-policy.ts",
      'import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n',
      `rule 1: ${DIR}/sql-results.ts imports @/lib/db/providers/sql/sql-base, a module of another provider directory`,
    ],
    [
      "sql-provider.ts",
      "sql-policy.ts",
      'import { declaredColumnTypes } from "@/lib/db/providers/sql/column-types";\n',
      `rule 1: ${DIR}/sql-provider.ts imports @/lib/db/providers/sql/column-types, a module of another provider directory`,
    ],
    [
      "influxql-agent-read.ts",
      "influxql-quote.ts",
      'import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n',
      `rule 1: ${DIR}/influxql-agent-read.ts imports @/lib/db/providers/sql/sql-base, a module of another provider directory`,
    ],
    [
      "sql-agent-read.ts",
      "sql-policy.ts",
      'import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n',
      `rule 1: ${DIR}/sql-agent-read.ts imports @/lib/db/providers/sql/sql-base, a module of another provider directory`,
    ],
    [
      "sql-provider.ts",
      "sql-policy.ts",
      'import { SQLBaseProvider } from "../../sql/sql-base";\n',
      `rule 1: ${DIR}/sql-provider.ts imports ../../sql/sql-base, a module of another provider directory`,
    ],
    // rule 2
    [
      "influxql-results.ts",
      "run-database.ts",
      'import { evaluateInfluxSql } from "./sql-policy";\n',
      `rule 2: ${DIR}/influxql-results.ts imports ./sql-policy across the InfluxQL and SQL halves`,
    ],
    [
      "sql-policy.ts",
      "sql-policy.ts",
      'import type { InfluxqlToken } from "./influxql-lexer";\n',
      `rule 2: ${DIR}/sql-policy.ts imports ./influxql-lexer across the InfluxQL and SQL halves`,
    ],
    [
      "sql-policy.ts",
      "sql-policy.ts",
      'import type { InfluxqlToken } from "@/lib/languages/influxql/lexer";\n',
      `rule 2: ${DIR}/sql-policy.ts imports @/lib/languages/influxql/lexer across the InfluxQL and SQL halves`,
    ],
    // rule 3
    [
      "run-database.ts",
      "run-database.ts",
      'import { evaluateInfluxql } from "./influxql-policy";\n',
      `rule 3: ${DIR}/run-database.ts is a shared-layer module and imports ./influxql-policy`,
    ],
    [
      "run-database.ts",
      "run-database.ts",
      'import { evaluateInfluxql } from "@/lib/languages/influxql/policy";\n',
      `rule 3: ${DIR}/run-database.ts is a shared-layer module and imports @/lib/languages/influxql/policy`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import type { SqlRows } from "./sql-results";\n',
      `rule 3: ${DIR}/errors.ts is a shared-layer module and imports ./sql-results`,
    ],
    // rule 4
    [
      "routes.ts",
      "routes.ts",
      'import { createNodeTransport } from "@/lib/db/http/node-transport";\n',
      `rule 4: ${DIR}/routes.ts imports createNodeTransport, which only client.ts imports`,
    ],
    [
      "client.ts",
      "client.ts",
      'import { nodeTlsMaterial } from "@/lib/db/http/node-transport";\n',
      `rule 4: ${DIR}/client.ts imports nodeTlsMaterial, which only connection-options.ts imports`,
    ],
    [
      "errors.ts",
      "errors.ts",
      'import { request } from "node:https";\n',
      `rule 4: ${DIR}/errors.ts imports node:https`,
    ],
    ["client.ts", "client.ts", 'import http from "node:http";\n', `rule 4: ${DIR}/client.ts imports node:http`],
    ["versions.ts", "versions.ts", "const send = globalThis.fetch;\n", `rule 4: ${DIR}/versions.ts reaches fetch`],
    ["client.ts", "client.ts", 'void fetch("http://x");\n', `rule 4: ${DIR}/client.ts reaches fetch`],
    // rule 5
    [
      "errors.ts",
      "errors.ts",
      'const path = "/query";\n',
      `rule 5: ${DIR}/errors.ts holds the path literal "/query", which only routes.ts may hold`,
    ],
    [
      "monitoring.ts",
      "monitoring.ts",
      "const path = `/health`;\n",
      `rule 5: ${DIR}/monitoring.ts holds the path literal "/health", which only routes.ts may hold`,
    ],
    [
      "client.ts",
      "client.ts",
      "const path = (db: string) => `/api/v3/${db}`;\n",
      `rule 5: ${DIR}/client.ts holds the path literal "/api/v3/", which only routes.ts may hold`,
    ],
    [
      "sql-policy.ts",
      "sql-policy.ts",
      'const ping = "/ping";\n',
      `rule 5: ${DIR}/sql-policy.ts holds the path literal "/ping", which only routes.ts may hold`,
    ],
    // rule 6
    [
      "errors.ts",
      "errors.ts",
      'import { quoteUnsafeIntegers } from "@libredb/provider-sdk/values";\n',
      `layer: ${DIR}/errors.ts imports a value from @libredb/provider-sdk/values, which its layer may not`,
    ],
    [
      "labels.ts",
      "labels.ts",
      'import { TUNNEL_FAR_END } from "@/lib/types";\n',
      `layer: ${DIR}/labels.ts imports a value from @/lib/types, which its layer may not`,
    ],
    [
      "labels.ts",
      "labels.ts",
      'import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";\n',
      `layer: ${DIR}/labels.ts imports a value from @/lib/db/execution-ui/shared, which its layer may not`,
    ],
    [
      "connection-options.ts",
      "connection-options.ts",
      'import { isTunnelled } from "@/lib/types";\n',
      `layer: ${DIR}/connection-options.ts imports a value from @/lib/types, which its layer may not`,
    ],
    [
      "influxql-quote.ts",
      "influxql-quote.ts",
      'import { QueryError } from "@/lib/db/errors";\n',
      `layer: ${DIR}/influxql-quote.ts imports a value from @/lib/db/errors, which its layer may not`,
    ],
    [
      "influxql-objects.ts",
      "run-database.ts",
      'import { readSqlSpan } from "@/lib/sql/spans";\n',
      `layer: ${DIR}/influxql-objects.ts imports a value from @/lib/sql/spans, which its layer may not`,
    ],
    [
      "index.ts",
      "labels.ts",
      'export { InfluxqlLexer } from "./influxql-lexer";\n',
      `layer: ${DIR}/index.ts imports a value from ./influxql-lexer, which its layer may not`,
    ],
    [
      "sql-results.ts",
      "sql-policy.ts",
      'import { readFileSync } from "node:fs";\n',
      `layer: ${DIR}/sql-results.ts imports node:fs, a runtime built-in`,
    ],
    [
      "sql-results.ts",
      "sql-policy.ts",
      'const loaded = await import(["./sql-", "objects"].join(""));\n',
      `seam: ${DIR}/sql-results.ts loads a module whose name is not a plain string`,
    ],
    ["stray.ts", "labels.ts", "", `layer: ${DIR}/stray.ts belongs to no layer of contract section 1`],
    [
      "influxdb-engine-facets.ts",
      "influxdb-engine-facets.ts",
      'import { DatabaseConfigError } from "@/lib/db/errors";\n',
      `layer: ${DIR}/influxdb-engine-facets.ts imports a value from @/lib/db/errors, which its layer may not`,
    ],
    [
      "influxdb3-engine-facets.ts",
      "influxdb3-engine-facets.ts",
      'import { INFLUX_LIST_CAP } from "./connection-options";\n',
      `layer: ${DIR}/influxdb3-engine-facets.ts imports a value from ./connection-options, which its layer may not`,
    ],
    [
      "influxdb3-engine-facets.ts",
      "influxdb3-engine-facets.ts",
      'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n',
      `layer: ${DIR}/influxdb3-engine-facets.ts imports a value from @/lib/db/migration-ddl/shared, which its layer may not`,
    ],
    [
      "sql-objects.ts",
      "sql-policy.ts",
      'import { standardDropTable } from "@/lib/db/migration-ddl/shared";\n',
      `layer: ${DIR}/sql-objects.ts imports a value from @/lib/db/migration-ddl/shared, which its layer may not`,
    ],
    [
      "sql-objects.ts",
      "sql-policy.ts",
      'import { literalStandard } from "@/lib/db/sql-writing/shared";\n',
      `layer: ${DIR}/sql-objects.ts imports a value from @/lib/db/sql-writing/shared, which its layer may not`,
    ],
  ])("%s (from %s) with %p fails", (as, from, line, finding) => {
    expect(plant(as, from, line)).toContain(finding);
  });

  test.each([
    ["sql-provider.ts", "sql-policy.ts", 'import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";\n'],
    ["sql-objects.ts", "sql-policy.ts", 'import { INFLUX_LIST_CAP } from "./connection-options";\n'],
    ["sql-results.ts", "sql-policy.ts", 'import { quoteUnsafeIntegers } from "@libredb/provider-sdk/values";\n'],
    ["influxql-results.ts", "run-database.ts", 'import { evaluateInfluxql } from "./influxql-policy";\n'],
    ["influxql-provider.ts", "run-database.ts", 'import { BaseDatabaseProvider } from "@/lib/db/base-provider";\n'],
    ["index.ts", "labels.ts", 'export { InfluxDBProvider } from "./influxql-provider";\n'],
    ["errors.ts", "errors.ts", 'import { TransportError } from "@/lib/db/http/node-transport";\n'],
    ["errors.ts", "errors.ts", 'import type { QueryResult } from "@/lib/types";\n'],
    ["errors.ts", "errors.ts", 'const sentence = "This server has no InfluxDB /query endpoint.";\n'],
    ["monitoring.ts", "monitoring.ts", 'const notAPath = "/api";\n'],
    ["sql-results.ts", "sql-policy.ts", 'import type { Readable } from "node:stream";\n'],
    [
      "influxdb3-engine-facets.ts",
      "influxdb3-engine-facets.ts",
      'import type { EngineFacets } from "@/lib/db/engine-facets/types";\n',
    ],
  ])("%s (from %s) with %p passes", (as, from, line) => {
    expect(plant(as, from, line)).toEqual([]);
  });
});
