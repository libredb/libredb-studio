/**
 * The seam guard of src/lib/db/auth, the shared layer through which a database connection signs in to a cloud
 * service, on the gRPC guard's shape (tests/unit/db/grpc/seam-guard.test.ts).
 *
 * It reads the repository through git's own lists (tracked, and untracked but not ignored), parses each source file
 * with the TypeScript compiler, resolves module names with the repository's tsconfig, and fails the build when an
 * ordinary edit crosses one of these lines:
 *
 * - AUTH1, imports: a file of the layer imports only jose, node:crypto (in aws/sigv4.ts alone), @/lib/db/errors,
 *   @/lib/db/http/*, @/lib/db/utils/*, @/lib/types and files of the layer, type-only imports included, so no
 *   provider, no logger and no module of Studio's user sign-in is ever reached;
 * - AUTH2, ambient effects: no process.env, Date.now, new Date() without an argument, setTimeout, setInterval,
 *   AbortSignal.timeout or console: every effect comes in as a parameter;
 * - AUTH3, names: no external engine's type id, as a whole word in any case, comments included;
 * - AUTH4, module state: a closed list of top-level code, so no module keeps a value between two connections;
 * - AUTH5, direction: under src/, only providers and the layer import the layer, and only the layer imports lanes.ts;
 * - AUTH6, one copy of each mechanism: under src/, the mechanism markers appear only in the layer, apart from the
 *   listed exceptions, each with its finding count and the PR that removes it; an exception that no longer matches
 *   fails too.
 *
 * Each rule is a pure function of a repository root, proven both ways: the real tree passes, and a violation planted
 * in a temporary git repository fails by name. The planted files are never added, so every proof is of an untracked
 * file.
 *
 * The guard is syntactic: a module name built at run time, a global reached under another name, or a marker spelled
 * in pieces is stated, not chased.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { platformTimeoutMs } from "../../../helpers/platform-timeout";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const LAYER = "src/lib/db/auth";
const LANES = `${LAYER}/lanes`;
const PROVIDERS = "src/lib/db/providers";
const SIGV4 = `${LAYER}/aws/sigv4.ts`;
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

/**
 * The files outside the layer that still hold a mechanism marker, each with how many lines hold one and the PR that
 * removes it. A count that no longer matches fails, so the PR that moves a copy deletes its entry.
 */
interface MarkerException {
  readonly path: string;
  readonly lines: number;
  readonly removedBy: string;
}
const MARKER_EXCEPTIONS: readonly MarkerException[] = [];
/**
 * The markers of each mechanism the layer holds: the Google token endpoint, the JWT-bearer grant, the metadata path,
 * and SigV4's algorithm name and scope terminator.
 */
const MARKERS = /oauth2\.googleapis\.com|grant-type:jwt-bearer|computeMetadata\/v1|AWS4-HMAC-SHA256|aws4_request/;

// -- reading files ------------------------------------------------------------------------------------------------

interface RepositoryFile {
  readonly path: string;
  readonly text: string;
  readonly sf: ts.SourceFile;
}

interface Repository {
  readonly paths: readonly string[];
  readonly files: readonly RepositoryFile[];
}

/** Every file git lists in the repository at `root`: tracked, or untracked and not ignored. */
function readRepository(root: string, env?: NodeJS.ProcessEnv): Repository {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  const paths = [...new Set(listed.split("\0"))].filter((path) => path !== "" && existsSync(join(root, path))).sort();
  const files = paths
    .filter((path) => SOURCE_FILE.test(path))
    .map((path) => {
      const text = readFileSync(join(root, path), "utf8");
      return { path, text, sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) };
    });
  return { paths, files };
}

const repositories = new Map<string, Repository>();
function repositoryOf(root: string, env?: NodeJS.ProcessEnv): Repository {
  let repository = repositories.get(root);
  if (repository === undefined) {
    repository = readRepository(root, env);
    repositories.set(root, repository);
  }
  return repository;
}

// Reading and parsing every file of the repository is this file's one costly step: pay it once, under its own budget.
beforeAll(() => {
  repositoryOf(ROOT);
}, platformTimeoutMs(120_000));

const resolvers = new Map<string, { readonly options: ts.CompilerOptions; readonly cache: ts.ModuleResolutionCache }>();
function resolverFor(root: string) {
  let resolver = resolvers.get(root);
  if (resolver === undefined) {
    const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile).config;
    const options = ts.parseJsonConfigFileContent(config, ts.sys, root).options;
    resolver = { options, cache: ts.createModuleResolutionCache(root, (name) => name, options) };
    resolvers.set(root, resolver);
  }
  return resolver;
}

function canonical(path: string): string {
  return realpathSync.native(path).split("\\").join("/");
}

/**
 * The repository path a module name written in the file at `path` names, without its extension: the file it resolves
 * to when that is inside the repository, else the path it spells; undefined for a package name.
 */
function targetOf(specifier: string, path: string, root: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return undefined;
  const { options, cache } = resolverFor(root);
  const resolved = ts.resolveModuleName(specifier, join(root, path), options, ts.sys, cache).resolvedModule;
  const base = `${canonical(root)}/`;
  const file =
    resolved !== undefined && canonical(resolved.resolvedFileName).startsWith(base)
      ? canonical(resolved.resolvedFileName).slice(base.length)
      : specifier.startsWith("@/")
        ? `src/${specifier.slice(2)}`
        : posix.normalize(posix.join(posix.dirname(path), specifier));
  return file.replace(SOURCE_FILE, "").replace(/\/index$/, "");
}

// -- module references ----------------------------------------------------------------------------------------------

interface ModuleName {
  readonly specifier: string;
}

function plainString(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** Every module a file loads under a plain name, type-only included: imports, re-exports, import types, import(), require(). */
function moduleNames(sf: ts.SourceFile): ModuleName[] {
  const names: ModuleName[] = [];
  const add = (node: ts.Node | undefined) => {
    const specifier = plainString(node);
    if (specifier !== undefined) names.push({ specifier });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// -- the rules ------------------------------------------------------------------------------------------------------

type Rule = (root: string, env?: NodeJS.ProcessEnv) => string[];

const inLayer = (path: string) => path.startsWith(`${LAYER}/`);
const layerFiles = (root: string, env?: NodeJS.ProcessEnv) =>
  repositoryOf(root, env).files.filter((file) => inLayer(file.path));

/** AUTH1: a file of the layer imports only from the allow-list. */
const ALLOWED_FILES: readonly string[] = ["src/lib/db/errors", "src/lib/types"];
const ALLOWED_DIRECTORIES: readonly string[] = ["src/lib/db/http/", "src/lib/db/utils/", `${LAYER}/`];
const auth1Imports: Rule = (root, env) =>
  layerFiles(root, env).flatMap(({ path, sf }) =>
    moduleNames(sf)
      .filter(({ specifier }) => {
        if (specifier === "jose") return false;
        if (specifier === "node:crypto") return path !== SIGV4;
        const target = targetOf(specifier, path, root);
        if (target === undefined) return true;
        return !ALLOWED_FILES.includes(target) && !ALLOWED_DIRECTORIES.some((prefix) => target.startsWith(prefix));
      })
      .map(({ specifier }) => `AUTH1 imports: ${path} imports ${specifier}, which is not on the allow-list`),
  );

/** AUTH2: no ambient effect in the layer. */
const AMBIENT_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["process", ["env"]],
  ["Date", ["now"]],
  ["AbortSignal", ["timeout"]],
]);
const AMBIENT_NAMES: ReadonlySet<string> = new Set(["setTimeout", "setInterval", "console"]);
const auth2AmbientEffects: Rule = (root, env) =>
  layerFiles(root, env).flatMap(({ path, sf }) => {
    const findings: string[] = [];
    const found = (node: ts.Node, what: string) =>
      findings.push(`AUTH2 ambient effects: ${path}:${lineOf(sf, node)} reaches ${what}`);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const members = AMBIENT_MEMBERS.get(node.expression.text);
        if (members?.includes(node.name.text)) found(node, `${node.expression.text}.${node.name.text}`);
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Date" &&
        (node.arguments === undefined || node.arguments.length === 0)
      ) {
        found(node, "new Date()");
      } else if (ts.isIdentifier(node) && AMBIENT_NAMES.has(node.text)) {
        found(node, node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return findings;
  });

/** AUTH3: the whole text of each file of the layer, comments included, names no external engine. */
const ENGINE_NAME = new RegExp(`\\b(?:${EXTERNAL_DATABASE_TYPES.join("|")})\\b`, "gi");
const auth3NoEngineName: Rule = (root, env) =>
  layerFiles(root, env).flatMap(({ path, text }) =>
    text
      .split("\n")
      .flatMap((line, index) =>
        [...line.matchAll(ENGINE_NAME)].map(
          (match) => `AUTH3 names: ${path}:${index + 1} names ${match[0].toLowerCase()}`,
        ),
      ),
  );

/** AUTH4: what a `const` of the layer may be initialised with; anything else holds state or builds a value at load. */
function stateless(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return stateless(node.expression);
  if (ts.isAsExpression(node)) {
    return ts.isTypeReferenceNode(node.type) && node.type.getText() === "const" && stateless(node.expression);
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand);
  }
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => stateless(span.expression));
  if (ts.isRegularExpressionLiteral(node)) {
    const flags = node.text.slice(node.text.lastIndexOf("/") + 1);
    return !flags.includes("g") && !flags.includes("y");
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return stateless(node.expression);
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const freezes =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      callee.name.text === "freeze";
    if (!freezes || node.arguments.length !== 1) return false;
    return frozenLiteral(node.arguments[0]);
  }
  return false;
}

/** The argument of Object.freeze: an object or array literal, possibly under `as const`, every member allowed. */
function frozenLiteral(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return frozenLiteral(node.expression);
  if (ts.isAsExpression(node)) {
    return ts.isTypeReferenceNode(node.type) && node.type.getText() === "const" && frozenLiteral(node.expression);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) =>
      ts.isSpreadElement(element) ? stateless(element.expression) : stateless(element),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (property.name !== undefined && ts.isComputedPropertyName(property.name)) return false;
      if (ts.isPropertyAssignment(property)) return stateless(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return true;
      if (ts.isSpreadAssignment(property)) return stateless(property.expression);
      return ts.isMethodDeclaration(property);
    });
  }
  return false;
}

const auth4ModuleState: Rule = (root, env) =>
  layerFiles(root, env).flatMap(({ path, sf }) =>
    sf.statements.flatMap((statement): string[] => {
      const at = `AUTH4 module state: ${path}:${lineOf(sf, statement)}`;
      if (
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)
      ) {
        return [];
      }
      if (ts.isClassDeclaration(statement)) return [`${at} declares a class`];
      if (!ts.isVariableStatement(statement)) return [`${at} is a top-level statement`];
      const flags = statement.declarationList.flags;
      if ((flags & ts.NodeFlags.Const) === 0) {
        return [`${at} declares a ${(flags & ts.NodeFlags.Let) === 0 ? "var" : "let"}`];
      }
      return statement.declarationList.declarations.flatMap((declaration) =>
        declaration.initializer !== undefined && stateless(declaration.initializer)
          ? []
          : [`${at} initialises ${declaration.name.getText(sf)} with a value built at load`],
      );
    }),
  );

/** AUTH5: under src/, only providers and the layer import the layer, and only the layer imports lanes.ts. */
const auth5Direction: Rule = (root, env) =>
  repositoryOf(root, env)
    .files.filter(({ path }) => path.startsWith("src/") && !inLayer(path))
    .flatMap(({ path, sf }) =>
      moduleNames(sf).flatMap(({ specifier }) => {
        const target = targetOf(specifier, path, root);
        if (target === undefined || !(target === LAYER || target.startsWith(`${LAYER}/`))) return [];
        if (target === LANES) return [`AUTH5 direction: ${path} imports ${specifier}, which only the layer may import`];
        return path.startsWith(`${PROVIDERS}/`)
          ? []
          : [`AUTH5 direction: ${path} imports ${specifier}, and only a provider may import the layer`];
      }),
    );

/** AUTH6: under src/, outside the layer, a mechanism marker only in a listed exception, with its count. */
function auth6OneCopy(
  root: string,
  env?: NodeJS.ProcessEnv,
  exceptions: readonly MarkerException[] = MARKER_EXCEPTIONS,
): string[] {
  const { paths } = repositoryOf(root, env);
  const holding = new Map<string, number>();
  const findings: string[] = [];
  for (const path of paths.filter((candidate) => candidate.startsWith("src/") && !inLayer(candidate))) {
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = MARKERS.exec(line);
      if (match === null) return;
      holding.set(path, (holding.get(path) ?? 0) + 1);
      if (!exceptions.some((exception) => exception.path === path)) {
        findings.push(`AUTH6 one copy: ${path}:${index + 1} holds ${match[0]} outside ${LAYER}/`);
      }
    });
  }
  for (const exception of exceptions) {
    const held = holding.get(exception.path) ?? 0;
    if (held !== exception.lines) {
      findings.push(
        `AUTH6 one copy: ${exception.path} is listed with ${exception.lines} marker lines (removed by ${exception.removedBy}) and holds ${held}`,
      );
    }
  }
  return findings;
}

const RULES: readonly (readonly [string, Rule])[] = [
  ["AUTH1 imports", auth1Imports],
  ["AUTH2 ambient effects", auth2AmbientEffects],
  ["AUTH3 names", auth3NoEngineName],
  ["AUTH4 module state", auth4ModuleState],
  ["AUTH5 direction", auth5Direction],
  ["AUTH6 one copy", (root, env) => auth6OneCopy(root, env)],
];

// -- the real tree --------------------------------------------------------------------------------------------------

describe("the real tree holds every rule", () => {
  test.each(RULES)("%s", (_name, rule) => {
    expect(rule(ROOT)).toEqual([]);
  });

  test("the rules read files, so none passes over nothing", () => {
    const { files } = repositoryOf(ROOT);
    expect(files.filter((file) => inLayer(file.path)).map((file) => file.path)).toEqual([
      `${LAYER}/aws/credentials.ts`,
      `${LAYER}/aws/endpoints.ts`,
      `${LAYER}/aws/signer.ts`,
      SIGV4,
      `${LAYER}/google/credentials.ts`,
      `${LAYER}/google/token-source.ts`,
      `${LAYER}/lanes.ts`,
      `${LAYER}/refresh.ts`,
      `${LAYER}/server-identity-gate.ts`,
    ]);
    expect(MARKER_EXCEPTIONS).toEqual([]);
    const marked = files.filter((file) => inLayer(file.path) && MARKERS.test(file.text)).map((file) => file.path);
    expect(marked).toEqual([SIGV4, `${LAYER}/google/token-source.ts`]);
  });
});

// -- planted violations: each rule fails by name ---------------------------------------------------------------------

/** git's environment for a temporary repository: every GIT_ variable dropped, and an empty global configuration. */
function isolatedGitEnvironment(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "gitconfig"), "");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.XDG_CONFIG_HOME = home;
  return env;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { module: "esnext", moduleResolution: "bundler", allowJs: true, paths: { "@/*": ["./src/*"] } },
});

function inPlantedRepository<T>(
  files: Readonly<Record<string, string>>,
  check: (root: string, env: NodeJS.ProcessEnv) => T,
): T {
  const home = mkdtempSync(join(tmpdir(), "auth-seam-guard-"));
  try {
    const root = join(home, "repository");
    mkdirSync(root);
    const env = isolatedGitEnvironment(join(home, "git-home"));
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, encoding: "utf8", env });
    for (const [path, text] of Object.entries({ "tsconfig.json": TSCONFIG, ...files })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return check(root, env);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const GATE = `${LAYER}/server-identity-gate.ts`;
const LANES_FILE = `${LAYER}/lanes.ts`;
const CREDENTIALS = `${LAYER}/google/credentials.ts`;
const PROVIDER = `${PROVIDERS}/document/sample/credential-policy.ts`;
/** An exception planted with its copy, since the real list is empty once every copy has moved into the layer. */
const EXCEPTION: MarkerException = {
  path: "src/lib/db/providers/document/sample/copy.ts",
  lines: 2,
  removedBy: "a later PR",
};
const EXCEPTION_COPY = `${Array.from({ length: EXCEPTION.lines }, () => "// https://oauth2.googleapis.com/token").join("\n")}\nexport {};\n`;

/** A repository that holds every rule, as each planted one starts. */
const HOLDING: Readonly<Record<string, string>> = {
  [GATE]: [
    'import { DatabaseConfigError } from "@/lib/db/errors";',
    'import type { DatabaseType } from "@/lib/types";',
    'export const OPT_IN_SUFFIX = "_SERVER_CREDENTIALS";',
    "export function admit(provider: DatabaseType): Error {",
    "  return new DatabaseConfigError(OPT_IN_SUFFIX, provider);",
    "}",
    "",
  ].join("\n"),
  [LANES_FILE]: [
    'import type { NodeTransportOptions } from "@/lib/db/http/node-transport";',
    "export const LANE = Object.freeze({ maxSockets: 1, headers: Object.freeze({}) });",
    "export type Options = NodeTransportOptions;",
    "",
  ].join("\n"),
  [CREDENTIALS]: [
    'import { SignJWT } from "jose";',
    'import { secretForms } from "@/lib/db/utils/server-text";',
    'import { LANE } from "../lanes";',
    'import { admit } from "./../server-identity-gate";',
    'const TOKEN_URL = "https://oauth2.googleapis.com/token";',
    'const GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";',
    'const METADATA = "/computeMetadata/v1/instance";',
    'const ABSENT = Object.freeze(["ENOENT", "ENOTDIR"] as const);',
    "const NAME = /^[a-z]+$/i;",
    "const sentence = `${TOKEN_URL} ${GRANT}`;",
    "export const SENTENCES = Object.freeze({ refused: (reason: string) => reason, sentence, at: LANE.maxSockets });",
    "export interface Io { now(): number }",
    "export function run(io: Io): unknown {",
    "  return [SignJWT, secretForms, admit, METADATA, ABSENT, NAME, io.now(), new Date(io.now())];",
    "}",
    "",
  ].join("\n"),
  [PROVIDER]: 'import { run } from "@/lib/db/auth/google/credentials";\nexport const used = run;\n',
};

const planted = (files: Readonly<Record<string, string>>, rule: Rule) =>
  inPlantedRepository({ ...HOLDING, ...files }, (root, env) => rule(root, env));

// Every test here builds one planted repository or more, each a git init, a write and a parse, so each carries its
// own bound.
describe("planted violations: each rule fails by name", () => {
  test.each(RULES)(
    "%s: the holding repository passes",
    (_name, rule) => {
      expect(planted({}, rule)).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH1: an import of Studio's user sign-in, of a provider, of the logger and of a package off the list",
    () => {
      expect(
        planted({ [GATE]: 'import { verify } from "@/lib/local-accounts";\nexport { verify };\n' }, auth1Imports),
      ).toEqual([`AUTH1 imports: ${GATE} imports @/lib/local-accounts, which is not on the allow-list`]);
      const provider = "../providers/document/sample/credential-policy";
      expect(planted({ [LANES_FILE]: `import type { Policy } from "${provider}";\n` }, auth1Imports)).toEqual([
        `AUTH1 imports: ${LANES_FILE} imports ${provider}, which is not on the allow-list`,
      ]);
      expect(
        planted(
          {
            [LANES_FILE]: 'export type L = typeof import("@/lib/logger");\nimport { createHash } from "node:crypto";\n',
          },
          auth1Imports,
        ),
      ).toEqual([
        `AUTH1 imports: ${LANES_FILE} imports @/lib/logger, which is not on the allow-list`,
        `AUTH1 imports: ${LANES_FILE} imports node:crypto, which is not on the allow-list`,
      ]);
      expect(
        planted({ [SIGV4]: 'import { createHash } from "node:crypto";\nexport { createHash };\n' }, auth1Imports),
      ).toEqual([]);
      expect(planted({ [GATE]: 'import got from "got";\nexport { got };\n' }, auth1Imports)).toEqual([
        `AUTH1 imports: ${GATE} imports got, which is not on the allow-list`,
      ]);
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH2: process.env, the clock, timers, AbortSignal.timeout and the console; a dated Date and prose pass",
    () => {
      const text = [
        "export function f(): unknown {",
        "  console.log(process.env.HOME);",
        "  return [Date.now(), new Date(), setTimeout, setInterval, AbortSignal.timeout(1)];",
        "}",
        "",
      ].join("\n");
      expect(planted({ [GATE]: text }, auth2AmbientEffects)).toEqual([
        `AUTH2 ambient effects: ${GATE}:2 reaches console`,
        `AUTH2 ambient effects: ${GATE}:2 reaches process.env`,
        `AUTH2 ambient effects: ${GATE}:3 reaches Date.now`,
        `AUTH2 ambient effects: ${GATE}:3 reaches new Date()`,
        `AUTH2 ambient effects: ${GATE}:3 reaches setTimeout`,
        `AUTH2 ambient effects: ${GATE}:3 reaches setInterval`,
        `AUTH2 ambient effects: ${GATE}:3 reaches AbortSignal.timeout`,
      ]);
      expect(
        planted(
          {
            [GATE]:
              "/** Never process.env, Date.now or the console. */\nexport const at = (ms: number) => new Date(ms);\n",
          },
          auth2AmbientEffects,
        ),
      ).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH3: a comment naming an engine fails, in any case; a word that only holds one passes",
    () => {
      expect(planted({ [LANES_FILE]: "// as the BigQuery lane does\nexport {};\n" }, auth3NoEngineName)).toEqual([
        `AUTH3 names: ${LANES_FILE}:1 names bigquery`,
      ]);
      expect(planted({ [LANES_FILE]: "export {};\n/** The firestore and S3 rule. */\n" }, auth3NoEngineName)).toEqual([
        `AUTH3 names: ${LANES_FILE}:2 names firestore`,
        `AUTH3 names: ${LANES_FILE}:2 names s3`,
      ]);
      expect(
        planted(
          { [LANES_FILE]: "// the embedded libredb store and a kafkaesque name\nexport {};\n" },
          auth3NoEngineName,
        ),
      ).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test(
    "the engine names AUTH3 refuses are the external engines",
    () => {
      expect(EXTERNAL_DATABASE_TYPES.length).toBeGreaterThan(1);
      const text = EXTERNAL_DATABASE_TYPES.map((name) => `// ${name}`).join("\n");
      expect(planted({ [LANES_FILE]: `${text}\n` }, auth3NoEngineName)).toEqual(
        EXTERNAL_DATABASE_TYPES.map((name, index) => `AUTH3 names: ${LANES_FILE}:${index + 1} names ${name}`),
      );
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH4: a built value, a bare object, a Set, a global regular expression, a let and a top-level call",
    () => {
      const text = [
        'import { createRefreshingValue } from "./refresh";',
        "const a = createRefreshingValue({});",
        "const b: Record<string, string> = {};",
        'const c = new Set(["a"]);',
        "const R = /x/g;",
        "let n = 0;",
        "createRefreshingValue(n);",
        "export { a, b, c, R };",
        "",
      ].join("\n");
      expect(planted({ [LANES_FILE]: text }, auth4ModuleState)).toEqual([
        `AUTH4 module state: ${LANES_FILE}:2 initialises a with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:3 initialises b with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:4 initialises c with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:5 initialises R with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:6 declares a let`,
        `AUTH4 module state: ${LANES_FILE}:7 is a top-level statement`,
      ]);
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH4: a var, a class, a sticky expression, a nested bare literal and a computed key; frozen literals pass",
    () => {
      const refused = [
        "var v = 1;",
        "class Cache {}",
        "const S = /x/y;",
        "const N = Object.freeze({ inner: {} });",
        'const K = Object.freeze({ ["k"]: 1 });',
        "const E = Object.freeze([new Map()]);",
        "const T = `${String(1)}`;",
        "const Q = Object.freeze([1], 2);",
        "export { v, Cache, S, N, K, E, T, Q };",
        "",
      ].join("\n");
      expect(planted({ [LANES_FILE]: refused }, auth4ModuleState)).toEqual([
        `AUTH4 module state: ${LANES_FILE}:1 declares a var`,
        `AUTH4 module state: ${LANES_FILE}:2 declares a class`,
        `AUTH4 module state: ${LANES_FILE}:3 initialises S with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:4 initialises N with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:5 initialises K with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:6 initialises E with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:7 initialises T with a value built at load`,
        `AUTH4 module state: ${LANES_FILE}:8 initialises Q with a value built at load`,
      ]);
      const allowed = [
        "const A = 1;",
        "const B = -1;",
        "const C = `a${A}`;",
        "const D = /x/iu;",
        "const E = (value: number) => value + A;",
        "const F = function named() { return A; };",
        "const G = Math.PI;",
        "const H = Object.freeze({ a: A, B, ...Object.freeze({}), m() { return 1; }, n: null, t: true, f: false });",
        "const I = Object.freeze([A, ...Object.freeze([B])] as const);",
        "const J = 1 satisfies number;",
        'const K = ("k" as const);',
        "const L = Object.freeze([10n, `x`, Object.freeze([1])]) satisfies readonly unknown[];",
        "export { A, B, C, D, E, F, G, H, I, J, K, L };",
        "export type T = number;",
        "export interface U { readonly a: number }",
        "export function f(): number { return A; }",
        "",
      ].join("\n");
      expect(planted({ [LANES_FILE]: allowed }, auth4ModuleState)).toEqual([]);
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH5: a route importing the layer and a provider importing lanes.ts fail; Studio's own auth module passes",
    () => {
      const route = "src/app/api/stray/route.ts";
      expect(
        planted(
          { [route]: 'import { run } from "@/lib/db/auth/google/credentials";\nexport { run };\n' },
          auth5Direction,
        ),
      ).toEqual([
        `AUTH5 direction: ${route} imports @/lib/db/auth/google/credentials, and only a provider may import the layer`,
      ]);
      const relative = "../../../auth/lanes";
      expect(
        planted({ [PROVIDER]: `import { LANE } from "${relative}";\nexport { LANE };\n` }, auth5Direction),
      ).toEqual([`AUTH5 direction: ${PROVIDER} imports ${relative}, which only the layer may import`]);
      expect(
        planted({ [PROVIDER]: 'import type { L } from "@/lib/db/auth/lanes";\nexport type { L };\n' }, auth5Direction),
      ).toEqual([`AUTH5 direction: ${PROVIDER} imports @/lib/db/auth/lanes, which only the layer may import`]);
      expect(planted({ [route]: 'import { auth } from "@/lib/auth";\nexport { auth };\n' }, auth5Direction)).toEqual(
        [],
      );
    },
    platformTimeoutMs(40_000),
  );

  test(
    "AUTH6: a Google or SigV4 marker outside the layer, in a comment too, and an exception whose count no longer matches",
    () => {
      const copy = "src/lib/db/providers/document/sample/token.ts";
      expect(
        planted(
          { [copy]: 'export {};\n// POST https://oauth2.googleapis.com/token\nconst p = "computeMetadata/v1";\n' },
          (root, env) => auth6OneCopy(root, env),
        ),
      ).toEqual([
        `AUTH6 one copy: ${copy}:2 holds oauth2.googleapis.com outside ${LAYER}/`,
        `AUTH6 one copy: ${copy}:3 holds computeMetadata/v1 outside ${LAYER}/`,
      ]);
      const signer = "src/lib/db/providers/objectstore/sample/sigv4.ts";
      expect(
        planted(
          {
            [signer]:
              'export {};\n// the string to sign starts with AWS4-HMAC-SHA256\nconst SCOPE = "/aws4_request";\n',
          },
          (root, env) => auth6OneCopy(root, env),
        ),
      ).toEqual([
        `AUTH6 one copy: ${signer}:2 holds AWS4-HMAC-SHA256 outside ${LAYER}/`,
        `AUTH6 one copy: ${signer}:3 holds aws4_request outside ${LAYER}/`,
      ]);
      expect(
        planted(
          { [SIGV4]: 'export const ALGORITHM = "AWS4-HMAC-SHA256";\nexport const END = "aws4_request";\n' },
          (root, env) => auth6OneCopy(root, env),
        ),
      ).toEqual([]);
      expect(
        planted({ [EXCEPTION.path]: EXCEPTION_COPY }, (root, env) => auth6OneCopy(root, env, [EXCEPTION])),
      ).toEqual([]);
      expect(
        planted({ [EXCEPTION.path]: "export {};\n" }, (root, env) => auth6OneCopy(root, env, [EXCEPTION])),
      ).toEqual([
        `AUTH6 one copy: ${EXCEPTION.path} is listed with ${EXCEPTION.lines} marker lines (removed by ${EXCEPTION.removedBy}) and holds 0`,
      ]);
      expect(planted({ [EXCEPTION.path]: EXCEPTION_COPY }, (root, env) => auth6OneCopy(root, env))).toEqual([
        `AUTH6 one copy: ${EXCEPTION.path}:1 holds oauth2.googleapis.com outside ${LAYER}/`,
        `AUTH6 one copy: ${EXCEPTION.path}:2 holds oauth2.googleapis.com outside ${LAYER}/`,
      ]);
    },
    platformTimeoutMs(40_000),
  );
});
