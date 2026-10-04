/**
 * The shared gRPC transport's seam guard, on the etcd guard's shape (tests/unit/db/etcd/seam-guard.test.ts).
 *
 * src/lib/db/grpc/ is the one place Studio opens a gRPC channel, and this file keeps it that way. It reads the
 * repository through git's own lists (tracked, and untracked but not ignored), parses each source file with the
 * TypeScript compiler, resolves module names with the repository's tsconfig, and fails the build when an ordinary edit
 * crosses one of these lines:
 *
 * - G1: under src/, exactly channel.ts and credentials.ts load @grpc/grpc-js;
 * - G2: no file of the transport loads @grpc/proto-loader, type-only included;
 * - G3: no file of the transport imports a provider;
 * - G4: no file of the transport names an engine, comments included;
 * - G5: the files outside the transport that import it are exactly the registry's `transportImporters`, which is the
 *   browser boundary: every one is a provider's server-side adapter or connection options, and each provider's own
 *   browser-modules rule already keeps those out of the browser;
 * - G6: among the transport's tests and helpers, the importers of each client package are held exactly;
 * - G7: no file of the transport reaches a logger or the console;
 * - G8 to G10: no copy of the transport returns: no import of @grpc/grpc-js, no channel code and no TLS panel mapping
 *   outside it, read from the same file list, so an untracked file counts;
 * - G11: the registry itself is sound;
 * - G12: the transport builds no generated client and sends no call shape that has no consumer;
 * - G13: no file the transport row holds reaches a provider's descriptor or its generator.
 *
 * Each rule is a pure function of a repository root, proven both ways: the real tree passes, and a violation planted
 * in a temporary git repository fails by name. The planted files are never added, so every proof is of an untracked
 * file.
 *
 * The guard is syntactic, as the etcd guard is: a module name built at run time, a require reached under another
 * name, or text run as code is stated, not chased.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { GRPC_SEAM_HOLDINGS, type GrpcSeamHolding } from "../../../helpers/grpc-seam-holdings";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TRANSPORT = "src/lib/db/grpc";
const CHANNEL = `${TRANSPORT}/channel.ts`;
const CREDENTIALS = `${TRANSPORT}/credentials.ts`;
const TLS = `${TRANSPORT}/tls.ts`;
const PROVIDERS = "src/lib/db/providers";
const TRANSPORT_TESTS = "tests/unit/db/grpc";
const CHANNEL_TEST = `${TRANSPORT_TESTS}/channel.test.ts`;
const CREDENTIALS_TEST = `${TRANSPORT_TESTS}/credentials.test.ts`;
const TLS_TEST = `${TRANSPORT_TESTS}/tls.test.ts`;
const SERVER_STREAM_TEST = `${TRANSPORT_TESTS}/server-stream.test.ts`;
const SERVER_STREAM_CASES = "tests/helpers/grpc-server-stream-cases.ts";
const REGISTRY = "tests/helpers/grpc-seam-holdings.ts";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

const GRPC_JS = "@grpc/grpc-js";
const PROTO_LOADER = "@grpc/proto-loader";

type Holdings = Readonly<Record<string, GrpcSeamHolding>>;

// -- reading files ------------------------------------------------------------------------------------------------

/** A parsed source file of a repository, by its path relative to the root with `/` on every platform. */
interface RepositoryFile {
  readonly path: string;
  readonly text: string;
  readonly sf: ts.SourceFile;
}

/** What git lists in one repository: every path, and every source file parsed. */
interface Repository {
  readonly paths: readonly string[];
  readonly files: readonly RepositoryFile[];
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
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
      return { path, text, sf: parse(path, text) };
    });
  return { paths, files };
}

/** Each repository, read once for every rule of a run. */
const repositories = new Map<string, Repository>();
function repositoryOf(root: string, env?: NodeJS.ProcessEnv): Repository {
  let repository = repositories.get(root);
  if (repository === undefined) {
    repository = readRepository(root, env);
    repositories.set(root, repository);
  }
  return repository;
}

// Reading and parsing every file of the repository is this file's one costly step, and repositoryOf keeps the result:
// pay it once here, under its own budget, as the etcd guard does, so no test spends bun's per-test budget on it.
beforeAll(() => {
  repositoryOf(ROOT);
}, 60_000);

/** How TypeScript resolves a module name in the repository at `root`, with that repository's tsconfig.json. */
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

/** A file's one name: symlinks followed, with `/` separators. */
function canonical(path: string): string {
  return realpathSync.native(path).split("\\").join("/");
}

/** The file a module name written in `containing` resolves to, by its canonical name, or undefined. */
function resolvedFile(specifier: string, containing: string, root: string): string | undefined {
  const { options, cache } = resolverFor(root);
  const resolved = ts.resolveModuleName(specifier, containing, options, ts.sys, cache).resolvedModule;
  return resolved === undefined ? undefined : canonical(resolved.resolvedFileName);
}

/** Whether a module name loads the package `name`: it names it, or resolves inside its directory. */
function loadsPackage(name: string, specifier: string, containing: string, root: string): boolean {
  if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  return resolvedFile(specifier, containing, root)?.includes(`/node_modules/${name}/`) === true;
}

/**
 * Whether a module name written in the file at `path` reaches the directory `directory` of the repository: the file
 * it resolves to is inside it, or, when it resolves to nothing, the name itself spells a path inside it.
 */
function reaches(directory: string, specifier: string, path: string, root: string): boolean {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return false;
  const resolved = resolvedFile(specifier, join(root, path), root);
  if (resolved !== undefined) {
    return existsSync(join(root, directory)) && resolved.startsWith(`${canonical(join(root, directory))}/`);
  }
  const spelled = specifier.startsWith("@/")
    ? `src/${specifier.slice(2)}`
    : posix.normalize(posix.join(posix.dirname(path), specifier));
  return spelled.startsWith(`${directory}/`);
}

// -- module references ----------------------------------------------------------------------------------------------

/** The name a node writes, when it is a plain string: a string literal or a template with no substitution. */
function plainString(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** A call of require or of what createRequire answers, the two forms a CommonJS load takes in these files. */
function isRequireCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "require";
  return (
    ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "createRequire"
  );
}

/** A module name a file writes, and the node that writes it. */
interface ModuleName {
  readonly node: ts.Node;
  readonly specifier: string;
}

/**
 * Every module a file loads under a plain name, type-only included: an import, a re-export, an import-equals, an
 * import type, import() and require().
 */
function moduleNames(sf: ts.SourceFile): ModuleName[] {
  const names: ModuleName[] = [];
  const add = (node: ts.Node | undefined) => {
    const specifier = plainString(node);
    if (node !== undefined && specifier !== undefined) names.push({ node, specifier });
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
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireCall(node))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

const importsPackage =
  (name: string, root: string) =>
  ({ path, sf }: RepositoryFile): boolean =>
    moduleNames(sf).some(({ specifier }) => loadsPackage(name, specifier, join(root, path), root));

const lineOf = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** A name or a string a file writes, with its 1-based line. Comments are trivia, so prose is free. */
interface Spelling {
  readonly node: ts.Node;
  readonly text: string;
  readonly isString: boolean;
  readonly line: number;
}

function spellings(sf: ts.SourceFile): Spelling[] {
  const found: Spelling[] = [];
  const visit = (node: ts.Node) => {
    const isString =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node);
    if (isString || ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      found.push({ node, text: (node as ts.Identifier | ts.StringLiteral).text, isString, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// -- the rules ------------------------------------------------------------------------------------------------------

/** One rule of the guard: its findings over the repository at `root`, each starting with the rule's name. */
type Rule = (root: string, env?: NodeJS.ProcessEnv) => string[];

const inTransport = (path: string) => path.startsWith(`${TRANSPORT}/`);
const transportFiles = (root: string, env?: NodeJS.ProcessEnv) =>
  repositoryOf(root, env).files.filter((file) => inTransport(file.path));

/** The findings of a list held exactly: every file that holds and is not named, then every named file that does not. */
function exactly(
  rule: string,
  what: string,
  named: readonly string[],
  holding: readonly string[],
  listed: readonly string[],
  stray: (path: string) => string,
): string[] {
  return [
    ...holding.filter((path) => !named.includes(path)).map((path) => `${rule}: ${path} ${stray(path)}`),
    ...named
      .filter((path) => !holding.includes(path))
      .map((path) =>
        listed.includes(path)
          ? `${rule}: ${path} is named, and no longer imports ${what}`
          : `${rule}: ${path} is named, and is not in the repository`,
      ),
  ];
}

/** G1: under src/, exactly channel.ts and credentials.ts load @grpc/grpc-js. */
const GRPC_JS_SOURCES: readonly string[] = [CHANNEL, CREDENTIALS];
const g1GrpcJsImporters: Rule = (root, env) => {
  const { files, paths } = repositoryOf(root, env);
  const holding = files
    .filter((file) => file.path.startsWith("src/") && importsPackage(GRPC_JS, root)(file))
    .map((file) => file.path);
  return exactly("grpc-js importers under src", GRPC_JS, GRPC_JS_SOURCES, holding, paths, (path) =>
    inTransport(path)
      ? `imports ${GRPC_JS}, and only channel.ts and credentials.ts may`
      : `imports ${GRPC_JS} outside ${TRANSPORT}/`,
  );
};

/** G2: no file of the transport loads @grpc/proto-loader, type-only included. */
const g2NoProtoLoader: Rule = (root, env) =>
  transportFiles(root, env)
    .filter(importsPackage(PROTO_LOADER, root))
    .map((file) => `no proto-loader in the transport: ${file.path} imports ${PROTO_LOADER}`);

/** G3: no module a file of the transport names is a provider's. */
const g3NoProviderImport: Rule = (root, env) =>
  transportFiles(root, env).flatMap(({ path, sf }) =>
    moduleNames(sf)
      .filter(({ specifier }) => reaches(PROVIDERS, specifier, path, root))
      .map(({ specifier }) => `no provider import: ${path} imports ${specifier}, which is under ${PROVIDERS}/`),
  );

/** G4: the whole text of each file of the transport, comments included, names no engine. */
const ENGINE_NAME = new RegExp(`\\b(?:${[...EXTERNAL_DATABASE_TYPES, "libredb"].join("|")})\\b`, "gi");
const g4NoEngineName: Rule = (root, env) =>
  transportFiles(root, env).flatMap(({ path, text }) =>
    text
      .split("\n")
      .flatMap((line, index) =>
        [...line.matchAll(ENGINE_NAME)].map(
          (match) => `no engine name: ${path}:${index + 1} names ${match[0].toLowerCase()}`,
        ),
      ),
  );

/** G5: the files of src/ outside the transport that import it are exactly the registry's `transportImporters`. */
const g5TransportImporters: Rule = (root, env) => {
  const { files, paths } = repositoryOf(root, env);
  const named = Object.values(GRPC_SEAM_HOLDINGS).flatMap((holding) => holding.transportImporters);
  const holding = files
    .filter(
      ({ path, sf }) =>
        path.startsWith("src/") &&
        !inTransport(path) &&
        moduleNames(sf).some(({ specifier }) => reaches(TRANSPORT, specifier, path, root)),
    )
    .map((file) => file.path);
  return exactly(
    "who imports the transport",
    `${TRANSPORT}/`,
    named,
    holding,
    paths,
    () => `imports ${TRANSPORT}/, and no row of ${REGISTRY} names it`,
  );
};

/** G6: among the transport's tests and helpers, who loads each client package, held exactly. */
const TEST_IMPORTERS: readonly (readonly [string, readonly string[]])[] = [
  [GRPC_JS, [CHANNEL_TEST, CREDENTIALS_TEST, SERVER_STREAM_TEST, SERVER_STREAM_CASES]],
  [PROTO_LOADER, [CHANNEL_TEST]],
];
const g6TestImporters: Rule = (root, env) => {
  const { files, paths } = repositoryOf(root, env);
  const tests = files.filter(
    ({ path }) => path.startsWith(`${TRANSPORT_TESTS}/`) || path.startsWith("tests/helpers/grpc-"),
  );
  return TEST_IMPORTERS.flatMap(([name, named]) =>
    exactly(
      `${name} importers among the transport's tests`,
      name,
      named,
      tests.filter(importsPackage(name, root)).map((file) => file.path),
      paths,
      () => `imports ${name}, and the rule does not name it`,
    ),
  );
};

/** G7: no file of the transport imports a logger or names a member of the console. */
const g7NoLogger: Rule = (root, env) =>
  transportFiles(root, env).flatMap(({ path, sf }) => {
    const findings = moduleNames(sf)
      .filter(({ specifier }) => /logger/i.test(specifier))
      .map(({ specifier }) => `no logger: ${path} imports ${specifier}`);
    const visit = (node: ts.Node) => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "console"
      ) {
        findings.push(`no logger: ${path}:${lineOf(sf, node)} names a member of the console`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return findings;
  });

/** The lines of every listed file among `paths` that match `pattern`, as findings of `rule`. */
function textFindings(rule: string, root: string, paths: readonly string[], pattern: RegExp): string[] {
  return paths.flatMap((path) =>
    readFileSync(join(root, path), "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const match = pattern.exec(line);
        return match === null ? [] : [`${rule}: ${path}:${index + 1} holds ${match[0]}`];
      }),
  );
}

const outsideTransport = (root: string, env?: NodeJS.ProcessEnv) =>
  repositoryOf(root, env).paths.filter((path) => path.startsWith("src/") && !inTransport(path));

/** G8, check 1 of the pull request: no file of src/ outside the transport spells the package as a module name. */
const GRPC_JS_NAME = /['"]@grpc\/grpc-js['"]/;
const g8NoGrpcJsName: Rule = (root, env) =>
  textFindings("no third copy, check 1", root, outsideTransport(root, env), GRPC_JS_NAME);

/**
 * G9, check 2: no file of src/ outside the transport holds the channel's own code, any channel option key included,
 * quoted or a computed template key. A backticked option name in a comment is prose, not a key, and passes.
 */
const CHANNEL_CODE =
  /class ClosingCredentials|function (closingConnector|pickNotice|cancelOnAbort|channelCredentials|verifyOptions|unaryCall|openStream)\b|['"]grpc(-node)?\.[a-z_]+['"]|\[`grpc(-node)?\.[a-z_]+`\]|make(Unary|ServerStream|BidiStream)Request|createFromMetadataGenerator|createSsl\(|createInsecure\(/;
const g9NoChannelCode: Rule = (root, env) =>
  textFindings("no third copy, check 2", root, outsideTransport(root, env), CHANNEL_CODE);

/** G10, check 3: no provider directory of the registry holds a TLS panel mapping of its own. */
const TLS_MAPPING = /PEM_CERTIFICATE_BLOCK|BEGIN TRUSTED CERTIFICATE|ENCRYPTED_PEM_KEY|checkServerIdentity|TLS_MODES/;
const g10NoTlsMapping: Rule = (root, env) => {
  const directories = Object.values(GRPC_SEAM_HOLDINGS).flatMap((holding) =>
    holding.providerDirectory === undefined ? [] : [holding.providerDirectory],
  );
  const paths = repositoryOf(root, env).paths.filter((path) =>
    directories.some((directory) => path.startsWith(`${directory}/`)),
  );
  return textFindings("no third copy, check 3", root, paths, TLS_MAPPING);
};

/** G11: the registry is sound, over the files of the repository at `root`. */
function g11Registry(root: string, env?: NodeJS.ProcessEnv, holdings: Holdings = GRPC_SEAM_HOLDINGS): string[] {
  const { paths } = repositoryOf(root, env);
  const findings: string[] = [];
  for (const [row, holding] of Object.entries(holdings)) {
    for (const pattern of holding.held) {
      if (!pattern.source.startsWith("^")) {
        findings.push(`the registry: ${row} holds ${pattern}, which is not anchored with ^`);
      }
      if (!paths.some((path) => pattern.test(path))) {
        findings.push(`the registry: ${row} holds ${pattern}, which matches no file`);
      }
    }
    for (const importer of holding.transportImporters) {
      if (holding.providerDirectory === undefined || !importer.startsWith(`${holding.providerDirectory}/`)) {
        findings.push(`the registry: ${row} names ${importer}, which is not under its provider directory`);
      }
    }
  }
  for (const path of paths) {
    const rows = Object.entries(holdings)
      .filter(([, holding]) => holding.held.some((pattern) => pattern.test(path)))
      .map(([row]) => row);
    if (rows.length > 1) findings.push(`the registry: ${path} is held by ${rows.join(" and ")}`);
  }
  return findings;
}

/**
 * G12: the names of grpc-js the transport never writes. The first three build a generated client, which would hold
 * every RPC of a service, not the ones an adapter allows; the last one is a call shape no provider sends.
 */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  "makeClientConstructor",
  "makeGenericClientConstructor",
  "loadPackageDefinition",
  "makeClientStreamRequest",
]);
const g12RefusedNames: Rule = (root, env) =>
  transportFiles(root, env).flatMap(({ path, sf }) =>
    spellings(sf)
      .filter(({ text }) => REFUSED_NAMES.has(text))
      .map(({ text, line }) => `refused names: ${path}:${line} names ${text}`),
  );

/** G13: no file the transport row holds imports a provider's descriptor or its generator, or names a descriptor's file. */
const DESCRIPTOR_MODULE = /(?:^|\/)proto\/descriptor(?:\.ts)?$/;
const DESCRIPTOR_FILE = /(?:^|[/\\])descriptor\.ts$/;
const GENERATOR_MODULE = /(?:^|\/)generate-[\w-]*descriptor\.mjs$/;
const g13NoDescriptor: Rule = (root, env) =>
  repositoryOf(root, env)
    .files.filter(({ path }) => GRPC_SEAM_HOLDINGS.transport.held.some((pattern) => pattern.test(path)))
    .flatMap(({ path, sf }) => {
      const names = moduleNames(sf);
      const nodes = new Set(names.map(({ node }) => node));
      const descriptors = names
        .filter(
          ({ specifier }) =>
            DESCRIPTOR_MODULE.test(specifier) ||
            DESCRIPTOR_MODULE.test(resolvedFile(specifier, join(root, path), root) ?? ""),
        )
        .map(({ specifier }) => `no descriptor in the transport: ${path} imports a descriptor, ${specifier}`);
      const generators = names
        .filter(({ specifier }) => GENERATOR_MODULE.test(specifier))
        .map(({ specifier }) => `no descriptor in the transport: ${path} imports a descriptor generator, ${specifier}`);
      const readers = spellings(sf)
        .filter(({ node, text, isString }) => isString && !nodes.has(node) && DESCRIPTOR_FILE.test(text))
        .map(({ line }) => `no descriptor in the transport: ${path}:${line} names the file of a descriptor`);
      return descriptors.concat(generators, readers);
    });

const RULES: readonly (readonly [string, Rule])[] = [
  ["G1 grpc-js importers under src", g1GrpcJsImporters],
  ["G2 no proto-loader in the transport", g2NoProtoLoader],
  ["G3 no provider import", g3NoProviderImport],
  ["G4 no engine name", g4NoEngineName],
  ["G5 who imports the transport", g5TransportImporters],
  ["G6 the client packages among the transport's tests", g6TestImporters],
  ["G7 no logger", g7NoLogger],
  ["G8 no third copy, check 1", g8NoGrpcJsName],
  ["G9 no third copy, check 2", g9NoChannelCode],
  ["G10 no third copy, check 3", g10NoTlsMapping],
  ["G12 refused names", g12RefusedNames],
  ["G13 no descriptor in the transport", g13NoDescriptor],
];

// -- the real tree --------------------------------------------------------------------------------------------------

describe("the real tree holds every rule", () => {
  test.each(RULES)("%s", (_name, rule) => {
    expect(rule(ROOT)).toEqual([]);
  });

  test("G11 the registry is sound", () => {
    expect(g11Registry(ROOT)).toEqual([]);
  });

  test("the rules read files, so none passes over nothing", () => {
    const { files } = repositoryOf(ROOT);
    expect(files.filter((file) => inTransport(file.path)).map((file) => file.path)).toEqual([
      CHANNEL,
      CREDENTIALS,
      TLS,
    ]);
    for (const path of [CHANNEL_TEST, CREDENTIALS_TEST, TLS_TEST, SERVER_STREAM_TEST, SERVER_STREAM_CASES, REGISTRY]) {
      expect(files.some((file) => file.path === path)).toBe(true);
    }
    expect(Object.values(GRPC_SEAM_HOLDINGS).flatMap((holding) => holding.transportImporters).length).toBeGreaterThan(
      0,
    );
  });
});

// -- planted violations: each rule fails by name ---------------------------------------------------------------------

/**
 * git's environment for a temporary repository: every GIT_ variable dropped, and an empty global configuration, so
 * the caller's own git settings (an ignore file, a hook's variables) cannot change what git lists.
 */
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

/** Runs `check` over a temporary git repository holding `files` and a tsconfig.json, then removes it. */
function inPlantedRepository<T>(
  files: Readonly<Record<string, string>>,
  check: (root: string, env: NodeJS.ProcessEnv) => T,
): T {
  const home = mkdtempSync(join(tmpdir(), "grpc-seam-guard-"));
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

const IMPORTERS = Object.values(GRPC_SEAM_HOLDINGS).flatMap((holding) => holding.transportImporters);
const FIRST_IMPORTER = IMPORTERS[0] as string;
const PROVIDER_DIRECTORY = dirname(FIRST_IMPORTER);

/** A repository that holds every rule, as each planted one starts: the transport, its tests and every named importer. */
const HOLDING: Readonly<Record<string, string>> = {
  [CHANNEL]: `import { Client } from "${GRPC_JS}";\nimport type { GrpcTlsOptions } from "./tls";\nexport const open = (tls: GrpcTlsOptions) => new Client(String(tls), null as never);\n`,
  [CREDENTIALS]: `import { credentials } from "${GRPC_JS}";\nexport const insecure = () => credentials;\n`,
  [TLS]: "/** The transport's TLS options. */\nexport interface GrpcTlsOptions {}\n",
  [CHANNEL_TEST]: `import { Server } from "${GRPC_JS}";\nimport { fromJSON } from "${PROTO_LOADER}";\n`,
  [CREDENTIALS_TEST]: `import { credentials } from "${GRPC_JS}";\n`,
  [TLS_TEST]: 'import type { GrpcTlsOptions } from "@/lib/db/grpc/tls";\n',
  [SERVER_STREAM_TEST]: `import type { ServiceError } from "${GRPC_JS}";\n`,
  [SERVER_STREAM_CASES]: `import { Server } from "${GRPC_JS}";\n`,
  [REGISTRY]: "export const GRPC_SEAM_HOLDINGS = {};\n",
  ...Object.fromEntries(IMPORTERS.map((path) => [path, 'import { open } from "@/lib/db/grpc/channel";\n'])),
};

const planted = (files: Readonly<Record<string, string>>, rule: Rule) =>
  inPlantedRepository({ ...HOLDING, ...files }, (root, env) => rule(root, env));

/** The holding repository with one file gone. */
const holdingWithout = (gone: string) => Object.fromEntries(Object.entries(HOLDING).filter(([path]) => path !== gone));

describe("planted violations: each rule fails by name", () => {
  test.each(RULES)("%s: the holding repository passes", (_name, rule) => {
    expect(planted({}, rule)).toEqual([]);
  });

  test("G1: an adapter importing @grpc/grpc-js, a third transport file, and a named file that stops", () => {
    expect(planted({ [FIRST_IMPORTER]: `import { Client } from "${GRPC_JS}";\n` }, g1GrpcJsImporters)).toEqual([
      `grpc-js importers under src: ${FIRST_IMPORTER} imports @grpc/grpc-js outside src/lib/db/grpc/`,
    ]);
    expect(
      planted(
        { "src/app/api/stray/route.ts": `const grpc = require("${GRPC_JS}/build/src/index.js");\n` },
        g1GrpcJsImporters,
      ),
    ).toEqual([
      "grpc-js importers under src: src/app/api/stray/route.ts imports @grpc/grpc-js outside src/lib/db/grpc/",
    ]);
    expect(planted({ [TLS]: `import type { VerifyOptions } from "${GRPC_JS}";\n` }, g1GrpcJsImporters)).toEqual([
      `grpc-js importers under src: ${TLS} imports @grpc/grpc-js, and only channel.ts and credentials.ts may`,
    ]);
    expect(planted({ [CREDENTIALS]: "export {};\n" }, g1GrpcJsImporters)).toEqual([
      `grpc-js importers under src: ${CREDENTIALS} is named, and no longer imports @grpc/grpc-js`,
    ]);
    expect(inPlantedRepository(holdingWithout(CHANNEL), (root, env) => g1GrpcJsImporters(root, env))).toEqual([
      `grpc-js importers under src: ${CHANNEL} is named, and is not in the repository`,
    ]);
  });

  test("G2: a type-only import of @grpc/proto-loader in channel.ts", () => {
    const text = `${HOLDING[CHANNEL]}import type { MethodDefinition } from "${PROTO_LOADER}";\n`;
    expect(planted({ [CHANNEL]: text }, g2NoProtoLoader)).toEqual([
      `no proto-loader in the transport: ${CHANNEL} imports @grpc/proto-loader`,
    ]);
  });

  test("G3: a provider imported by its alias, by a relative path, and by a path that resolves to nothing", () => {
    const client = `${PROVIDER_DIRECTORY}/client.ts`;
    const alias = `@/${client.slice("src/".length, -".ts".length)}`;
    const relative = posix.relative(TRANSPORT, client).slice(0, -".ts".length);
    const provider = { [client]: "export interface ProviderError {}\n" };
    expect(
      planted({ ...provider, [TLS]: `import type { ProviderError } from "${alias}";\n` }, g3NoProviderImport),
    ).toEqual([`no provider import: ${TLS} imports ${alias}, which is under src/lib/db/providers/`]);
    expect(
      planted({ ...provider, [TLS]: `import type { ProviderError } from "${relative}";\n` }, g3NoProviderImport),
    ).toEqual([`no provider import: ${TLS} imports ${relative}, which is under src/lib/db/providers/`]);
    expect(
      planted({ [TLS]: 'export type Gone = import("../providers/gone/client").Gone;\n' }, g3NoProviderImport),
    ).toEqual([`no provider import: ${TLS} imports ../providers/gone/client, which is under src/lib/db/providers/`]);
    expect(planted({ [TLS]: 'import { validateHost } from "@/lib/db/http/endpoint";\n' }, g3NoProviderImport)).toEqual(
      [],
    );
  });

  test("G4: a comment naming an engine fails, in any case; a word that only holds one passes", () => {
    expect(planted({ [TLS]: "// as Milvus's server does\nexport {};\n" }, g4NoEngineName)).toEqual([
      `no engine name: ${TLS}:1 names milvus`,
    ]);
    expect(planted({ [TLS]: "export {};\n/** The ETCD and libredb rule. */\n" }, g4NoEngineName)).toEqual([
      `no engine name: ${TLS}:2 names etcd`,
      `no engine name: ${TLS}:2 names libredb`,
    ]);
    expect(
      planted({ [TLS]: "// the transport of every provider\nexport const kafkaesque = 1;\n" }, g4NoEngineName),
    ).toEqual([]);
  });

  test("the engine names G4 refuses are the external engines and the embedded store", () => {
    expect(EXTERNAL_DATABASE_TYPES.length).toBeGreaterThan(1);
    for (const name of [...EXTERNAL_DATABASE_TYPES, "libredb"]) {
      expect(planted({ [TLS]: `// ${name}\n` }, g4NoEngineName)).toEqual([`no engine name: ${TLS}:1 names ${name}`]);
    }
  });

  test("G5: a client component importing the transport, and a named importer that stops", () => {
    const stray = "src/components/Stray.tsx";
    expect(
      planted(
        { [stray]: '"use client";\nimport type { GrpcTlsOptions } from "@/lib/db/grpc/tls";\n' },
        g5TransportImporters,
      ),
    ).toEqual([`who imports the transport: ${stray} imports src/lib/db/grpc/, and no row of ${REGISTRY} names it`]);
    const sibling = `${PROVIDER_DIRECTORY}/stray.ts`;
    const relative = posix.relative(PROVIDER_DIRECTORY, CHANNEL).slice(0, -".ts".length);
    expect(planted({ [sibling]: `export * from "${relative}";\n` }, g5TransportImporters)).toEqual([
      `who imports the transport: ${sibling} imports src/lib/db/grpc/, and no row of ${REGISTRY} names it`,
    ]);
    expect(planted({ [FIRST_IMPORTER]: "export {};\n" }, g5TransportImporters)).toEqual([
      `who imports the transport: ${FIRST_IMPORTER} is named, and no longer imports src/lib/db/grpc/`,
    ]);
    expect(inPlantedRepository(holdingWithout(FIRST_IMPORTER), (root, env) => g5TransportImporters(root, env))).toEqual(
      [`who imports the transport: ${FIRST_IMPORTER} is named, and is not in the repository`],
    );
  });

  test("G6: a third test importing a client package, a helper, and a named test that stops", () => {
    expect(planted({ [TLS_TEST]: `import { credentials } from "${GRPC_JS}";\n` }, g6TestImporters)).toEqual([
      `@grpc/grpc-js importers among the transport's tests: ${TLS_TEST} imports @grpc/grpc-js, and the rule does not name it`,
    ]);
    const helper = "tests/helpers/grpc-server.ts";
    expect(planted({ [helper]: `import { fromJSON } from "${PROTO_LOADER}";\n` }, g6TestImporters)).toEqual([
      `@grpc/proto-loader importers among the transport's tests: ${helper} imports @grpc/proto-loader, and the rule does not name it`,
    ]);
    expect(planted({ [CREDENTIALS_TEST]: `import { fromJSON } from "${PROTO_LOADER}";\n` }, g6TestImporters)).toEqual([
      `@grpc/grpc-js importers among the transport's tests: ${CREDENTIALS_TEST} is named, and no longer imports @grpc/grpc-js`,
      `@grpc/proto-loader importers among the transport's tests: ${CREDENTIALS_TEST} imports @grpc/proto-loader, and the rule does not name it`,
    ]);
    expect(planted({ [CHANNEL_TEST]: `import { Server } from "${GRPC_JS}";\n` }, g6TestImporters)).toEqual([
      `@grpc/proto-loader importers among the transport's tests: ${CHANNEL_TEST} is named, and no longer imports @grpc/proto-loader`,
    ]);
    expect(planted({ [SERVER_STREAM_TEST]: "export {};\n" }, g6TestImporters)).toEqual([
      `@grpc/grpc-js importers among the transport's tests: ${SERVER_STREAM_TEST} is named, and no longer imports @grpc/grpc-js`,
    ]);
    expect(planted({ [SERVER_STREAM_CASES]: "export {};\n" }, g6TestImporters)).toEqual([
      `@grpc/grpc-js importers among the transport's tests: ${SERVER_STREAM_CASES} is named, and no longer imports @grpc/grpc-js`,
    ]);
  });

  test("G7: a logger import and a console member", () => {
    expect(planted({ [TLS]: 'import { logger } from "@/lib/logger";\n' }, g7NoLogger)).toEqual([
      `no logger: ${TLS} imports @/lib/logger`,
    ]);
    expect(planted({ [CHANNEL]: `${HOLDING[CHANNEL]}console.debug("opened");\n` }, g7NoLogger)).toEqual([
      `no logger: ${CHANNEL}:4 names a member of the console`,
    ]);
    expect(planted({ [TLS]: "/** Nothing is written to the console. */\nexport {};\n" }, g7NoLogger)).toEqual([]);
  });

  const COPY = "src/lib/db/providers/keyvalue/third/grpc-client.ts";

  test("G8: an untracked copy naming the package, in a comment too", () => {
    expect(planted({ [COPY]: `export {};\n// import { Client } from '${GRPC_JS}';\n` }, g8NoGrpcJsName)).toEqual([
      `no third copy, check 1: ${COPY}:2 holds '@grpc/grpc-js'`,
    ]);
  });

  test("G9: the adapter's old credentials function, and a channel option literal", () => {
    const credentialsCopy = [
      "function channelCredentials(tls) {",
      "  if (tls === undefined) return credentials.createInsecure();",
      "  return credentials.createSsl(tls.ca);",
      "}",
      "",
    ].join("\n");
    expect(planted({ [COPY]: credentialsCopy }, g9NoChannelCode)).toEqual([
      `no third copy, check 2: ${COPY}:1 holds function channelCredentials`,
      `no third copy, check 2: ${COPY}:2 holds createInsecure(`,
      `no third copy, check 2: ${COPY}:3 holds createSsl(`,
    ]);
    expect(planted({ [COPY]: 'export const options = { "grpc.enable_retries": 0 };\n' }, g9NoChannelCode)).toEqual([
      `no third copy, check 2: ${COPY}:1 holds "grpc.enable_retries"`,
    ]);
    const keys = [
      "export const options = {",
      "  'grpc.keepalive_permit_without_calls': 1,",
      '  [`grpc.default_authority`]: "x",',
      '  "grpc-node.max_session_memory": 10,',
      "};",
      "/** Set as `grpc.ssl_target_name_override` in prose. */",
      "",
    ].join("\n");
    expect(planted({ [COPY]: keys }, g9NoChannelCode)).toEqual([
      `no third copy, check 2: ${COPY}:2 holds 'grpc.keepalive_permit_without_calls'`,
      `no third copy, check 2: ${COPY}:3 holds [\`grpc.default_authority\`]`,
      `no third copy, check 2: ${COPY}:4 holds "grpc-node.max_session_memory"`,
    ]);
    expect(planted({ [COPY]: "export const call = client.makeUnaryRequest;\n" }, g9NoChannelCode)).toEqual([
      `no third copy, check 2: ${COPY}:1 holds makeUnaryRequest`,
    ]);
  });

  test("G10: a TLS mode table in a provider directory of the registry, and nowhere else", () => {
    const table = "const TLS_MODES = { disable: false };\nexport {};\n";
    const copy = `${PROVIDER_DIRECTORY}/tls-copy.ts`;
    expect(planted({ [copy]: table }, g10NoTlsMapping)).toEqual([`no third copy, check 3: ${copy}:1 holds TLS_MODES`]);
    expect(planted({ [copy]: "// identity is checked by checkServerIdentity\nexport {};\n" }, g10NoTlsMapping)).toEqual(
      [`no third copy, check 3: ${copy}:1 holds checkServerIdentity`],
    );
    expect(planted({ "src/lib/db/providers/document/other/tls.ts": table }, g10NoTlsMapping)).toEqual([]);
  });

  test("G10 reads every provider directory the registry names", () => {
    const directories = Object.values(GRPC_SEAM_HOLDINGS).flatMap((holding) =>
      holding.providerDirectory === undefined ? [] : [holding.providerDirectory],
    );
    expect(directories.length).toBeGreaterThan(1);
    for (const directory of directories) {
      expect(planted({ [`${directory}/pem.ts`]: "const ENCRYPTED_PEM_KEY = /x/;\n" }, g10NoTlsMapping)).toEqual([
        `no third copy, check 3: ${directory}/pem.ts:1 holds ENCRYPTED_PEM_KEY`,
      ]);
    }
  });

  test("G11: an unanchored pattern, a pattern over nothing, a file held twice, an importer outside its directory", () => {
    const sound: Holdings = {
      transport: { held: [/^src\/lib\/db\/grpc\//], transportImporters: [] },
      first: {
        held: [],
        transportImporters: [FIRST_IMPORTER],
        providerDirectory: PROVIDER_DIRECTORY,
      },
    };
    const check = (holdings: Holdings) => inPlantedRepository(HOLDING, (root, env) => g11Registry(root, env, holdings));
    expect(check(sound)).toEqual([]);
    expect(check({ ...sound, transport: { held: [/src\/lib\/db\/grpc\//], transportImporters: [] } })).toEqual([
      "the registry: transport holds /src\\/lib\\/db\\/grpc\\//, which is not anchored with ^",
    ]);
    expect(check({ ...sound, second: { held: [/^tests\/live\/second-/], transportImporters: [] } })).toEqual([
      "the registry: second holds /^tests\\/live\\/second-/, which matches no file",
    ]);
    expect(check({ ...sound, second: { held: [/^src\/lib\/db\/grpc\/tls\.ts$/], transportImporters: [] } })).toEqual([
      `the registry: ${TLS} is held by transport and second`,
    ]);
    expect(
      check({
        ...sound,
        second: { held: [], transportImporters: [FIRST_IMPORTER], providerDirectory: "src/lib/db/providers/second" },
      }),
    ).toEqual([`the registry: second names ${FIRST_IMPORTER}, which is not under its provider directory`]);
    expect(check({ ...sound, second: { held: [], transportImporters: [FIRST_IMPORTER] } })).toEqual([
      `the registry: second names ${FIRST_IMPORTER}, which is not under its provider directory`,
    ]);
  });

  test.each([...REFUSED_NAMES])("G12: %s named in the transport", (name) => {
    expect(planted({ [TLS]: `export const call = (client: any) => client.${name}();\n` }, g12RefusedNames)).toEqual([
      `refused names: ${TLS}:1 names ${name}`,
    ]);
  });

  test("G12: a server-streaming request is a call shape the transport sends", () => {
    expect(
      planted(
        { [CHANNEL]: `${HOLDING[CHANNEL]}export const stream = (client: any) => client.makeServerStreamRequest();\n` },
        g12RefusedNames,
      ),
    ).toEqual([]);
  });

  test("G12: a refused name as a string fails, and in a comment it does not", () => {
    expect(planted({ [TLS]: 'export const name = "loadPackageDefinition";\n' }, g12RefusedNames)).toEqual([
      `refused names: ${TLS}:1 names loadPackageDefinition`,
    ]);
    expect(planted({ [TLS]: "// never makeClientConstructor\nexport {};\n" }, g12RefusedNames)).toEqual([]);
  });

  test("G13: a descriptor import, a generator import and a descriptor's file name, in every file the row holds", () => {
    const rule = "no descriptor in the transport";
    const descriptor = `@/${PROVIDER_DIRECTORY.slice("src/".length)}/proto/descriptor`;
    expect(planted({ [CHANNEL_TEST]: `${HOLDING[CHANNEL_TEST]}import "${descriptor}";\n` }, g13NoDescriptor)).toEqual([
      `${rule}: ${CHANNEL_TEST} imports a descriptor, ${descriptor}`,
    ]);
    const fileName = ["descriptor", "ts"].join(".");
    const sibling = `./proto/${fileName}`;
    expect(planted({ [TLS]: `export type Stub = typeof import("${sibling}");\n` }, g13NoDescriptor)).toEqual([
      `${rule}: ${TLS} imports a descriptor, ${sibling}`,
    ]);
    const generator = "../../scripts/generate-third-descriptor.mjs";
    const helper = "tests/helpers/grpc-server.ts";
    expect(planted({ [helper]: `import { load } from "${generator}";\n` }, g13NoDescriptor)).toEqual([
      `${rule}: ${helper} imports a descriptor generator, ${generator}`,
    ]);
    expect(
      planted({ [TLS_TEST]: `export {};\nconst file = join(dir, "proto", "${fileName}");\n` }, g13NoDescriptor),
    ).toEqual([`${rule}: ${TLS_TEST}:2 names the file of a descriptor`]);
    expect(
      planted({ [FIRST_IMPORTER]: `${HOLDING[FIRST_IMPORTER]}import "./proto/descriptor";\n` }, g13NoDescriptor),
    ).toEqual([]);
  });
});
