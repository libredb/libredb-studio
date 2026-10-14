/**
 * The Apache Spark provider's seam guard, on the Milvus and Oxia guards' shape.
 *
 * Among the files this guard holds (GRPC_SEAM_HOLDINGS.spark.held: the provider directory, its generator, its unit
 * tests, helpers and live harnesses, which tests/unit/db/etcd/seam-guard.test.ts hands over), each import list below is
 * held exactly, so a stray importer fails by name and a named file that stops importing fails too: who imports
 * @grpc/grpc-js, who imports @grpc/proto-loader, who imports the generated descriptor, who names its file, who
 * imports the generator, and which provider files import the shared transport under src/lib/db/grpc/ (the registry
 * row's transportImporters, which the shared guard's G5 holds too). Two isolation rules hold over the repository: no
 * Spark file imports a module under src/lib/db/providers/ outside its directory but the base class ../sql-base, and no
 * file under src/ outside the directory but the factory and the connection-string parser imports a Spark module.
 * Every rule is proven both ways: the real sources pass it and a planted file fails it by name.
 *
 * The pure modules (PURE_MODULES) import no I/O, no logger and no transport, and write nothing to the console
 * at all; that rule is proven both ways too, and so is the allowlist rule: grpc-client.ts names no
 * SparkConnectService RPC off SPARK_ALLOWLISTED_RPCS.
 *
 * The guard is syntactic: a module name built at run time is stated, not chased. Each list grows with
 * its files.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { SPARK_ALLOWLISTED_RPCS } from "@/lib/db/providers/sql/spark/grpc-client";
import { GRPC_SEAM_HOLDINGS } from "../../../helpers/grpc-seam-holdings";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SPARK = "src/lib/db/providers/sql/spark";
const DESCRIPTOR = `${SPARK}/proto/descriptor.ts`;
const GENERATOR = "scripts/generate-spark-descriptor.mjs";
const DESCRIPTOR_TEST = "tests/unit/db/spark/descriptor.test.ts";
const THIS_FILE = "tests/unit/db/spark/seam-guard.test.ts";
const HARNESS = "tests/live/spark-evidence.ts";
const ADAPTER = `${SPARK}/grpc-client.ts`;
const FAKE = "tests/helpers/spark-connect-server.ts";
const CLIENT_TEST = "tests/unit/db/spark/grpc-client.test.ts";
const TLS_HANDSHAKE_TEST = "tests/unit/db/spark/tls-handshake.test.ts";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

// The named lists. Each grows in the change that adds its files.
const GRPC_IMPORTERS: readonly string[] = [HARNESS, FAKE, CLIENT_TEST, TLS_HANDSHAKE_TEST];
const PROTO_LOADER_IMPORTERS: readonly string[] = [ADAPTER, DESCRIPTOR, GENERATOR, DESCRIPTOR_TEST, HARNESS];
const DESCRIPTOR_IMPORTERS: readonly string[] = [ADAPTER];
const DESCRIPTOR_READERS: readonly string[] = [GENERATOR, DESCRIPTOR_TEST, THIS_FILE];
const GENERATOR_IMPORTERS: readonly string[] = [DESCRIPTOR_TEST, HARNESS];
/** The provider files that import src/lib/db/grpc/, type-only imports included, as the shared guard's G5 counts them. */
const TRANSPORT_IMPORTERS: readonly string[] = [`${SPARK}/connection-options.ts`, ADAPTER];
/** The only files under src/ outside the provider directory that may import a Spark module. */
const OUTSIDE_IMPORTERS_ALLOWED: readonly string[] = ["src/lib/db/factory.ts", "src/lib/connection-string-parser.ts"];
/** The one module under src/lib/db/providers/ outside the directory a Spark file may import. */
const SQL_BASE = "src/lib/db/providers/sql/sql-base";
/** The pure modules: no I/O, no logger, no transport and no console. */
const PURE_MODULES: readonly string[] = [
  `${SPARK}/constants.ts`,
  `${SPARK}/namespace.ts`,
  `${SPARK}/status-details.ts`,
  `${SPARK}/errors.ts`,
  `${SPARK}/version.ts`,
  `${SPARK}/requests.ts`,
  `${SPARK}/statement-shape.ts`,
  `${SPARK}/heartbeat.ts`,
];
const IO_MODULE =
  /^(?:node:)?(?:fs|fs\/promises|net|tls|http|http2|https|dns|dgram|child_process|worker_threads)$|^@grpc\/|^@\/lib\/logger(?:\/|$)/;
const NO_IO_TARGET = /^src\/lib\/(?:db\/grpc|logger)(?:\/|$)/;

interface RepositoryFile {
  readonly path: string;
  readonly sf: ts.SourceFile;
}

const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

function repositoryPaths(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return [...new Set(listed.split("\0"))]
    .filter((path) => SOURCE_FILE.test(path) && existsSync(join(ROOT, path)))
    .sort();
}

const load = (path: string): RepositoryFile => ({ path, sf: parse(path, readFileSync(join(ROOT, path), "utf8")) });
const PATHS = repositoryPaths();
const HELD = PATHS.filter((path) => GRPC_SEAM_HOLDINGS.spark.held.some((pattern) => pattern.test(path))).map(load);
const SOURCES = PATHS.filter((path) => path.startsWith("src/")).map(load);

/** Every module name a file names: imports, exports, `import()`, `require()` and `import x = require()`. */
function moduleNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      names.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      names.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require"))
        names.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

const importsPackage = (name: string) => (file: RepositoryFile) =>
  moduleNames(file.sf).some(
    (specifier) =>
      specifier === name || specifier.startsWith(`${name}/`) || specifier.includes(`node_modules/${name}/`),
  );
const importsDescriptor = (file: RepositoryFile) =>
  moduleNames(file.sf).some((specifier) => /(?:^|\/)proto\/descriptor(?:\.ts)?$/.test(specifier));
const importsGenerator = (file: RepositoryFile) =>
  moduleNames(file.sf).some((specifier) => specifier.endsWith("generate-spark-descriptor.mjs"));
const importsTransport = (file: RepositoryFile) =>
  inSpark(file.path) &&
  moduleNames(file.sf).some((specifier) => {
    const target = reached(specifier, file.path);
    return target !== undefined && (target === "src/lib/db/grpc" || target.startsWith("src/lib/db/grpc/"));
  });

/** A string, other than a module name, whose last path segment is `descriptor.ts`. */
function namesDescriptorFile(file: RepositoryFile): boolean {
  const modules = new Set(moduleNames(file.sf));
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !modules.has(node.text) &&
      /(?:^|[/\\])descriptor\.ts$/.test(node.text)
    )
      found = true;
    if (ts.isTemplateExpression(node) && /descriptor\.ts$/.test(node.getText(file.sf).slice(0, -1))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file.sf);
  return found;
}

interface Rule {
  readonly name: string;
  readonly named: readonly string[];
  readonly holds: (file: RepositoryFile) => boolean;
}

const inSpark = (path: string) => path === SPARK || path.startsWith(`${SPARK}/`);

/** The repository path a module name reaches from the file at `from`, or undefined for a package. */
function reached(specifier: string, from: string): string | undefined {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    return posix.normalize(posix.join(posix.dirname(from), specifier));
  return undefined;
}

const RULES: readonly Rule[] = [
  { name: "@grpc/grpc-js importers", named: GRPC_IMPORTERS, holds: importsPackage("@grpc/grpc-js") },
  { name: "@grpc/proto-loader importers", named: PROTO_LOADER_IMPORTERS, holds: importsPackage("@grpc/proto-loader") },
  { name: "descriptor importers", named: DESCRIPTOR_IMPORTERS, holds: importsDescriptor },
  { name: "descriptor readers", named: DESCRIPTOR_READERS, holds: namesDescriptorFile },
  { name: "generator importers", named: GENERATOR_IMPORTERS, holds: importsGenerator },
  { name: "transport importers", named: TRANSPORT_IMPORTERS, holds: importsTransport },
];

function findings(rule: Rule, files: readonly RepositoryFile[]): string[] {
  const found = new Set(files.filter(rule.holds).map((file) => file.path));
  const listed = new Set(files.map((file) => file.path));
  return [
    ...[...found].filter((path) => !rule.named.includes(path)).map((path) => `${rule.name}: ${path} is not named`),
    ...rule.named
      .filter((path) => !found.has(path))
      .map((path) =>
        listed.has(path)
          ? `${rule.name}: ${path} is named and no longer qualifies`
          : `${rule.name}: ${path} is named and missing`,
      ),
  ];
}

function providerImportFindings(files: readonly RepositoryFile[]): string[] {
  return files
    .filter((file) => inSpark(file.path))
    .flatMap((file) =>
      moduleNames(file.sf)
        .filter((specifier) => {
          const target = reached(specifier, file.path)?.replace(/\.(ts|tsx|js|mjs)$/, "");
          return (
            target !== undefined &&
            target.startsWith("src/lib/db/providers/") &&
            !inSpark(target) &&
            target !== SQL_BASE
          );
        })
        .map((specifier) => `${file.path} imports ${specifier}, a provider module outside ${SPARK}`),
    );
}

function outsideImportFindings(files: readonly RepositoryFile[]): string[] {
  return files
    .filter(
      (file) => file.path.startsWith("src/") && !inSpark(file.path) && !OUTSIDE_IMPORTERS_ALLOWED.includes(file.path),
    )
    .flatMap((file) =>
      moduleNames(file.sf)
        .filter((specifier) => {
          const target = reached(specifier, file.path);
          return target !== undefined && inSpark(target);
        })
        .map((specifier) => `${file.path} imports ${specifier}, a Spark module`),
    );
}

function pureFindings(files: readonly RepositoryFile[]): string[] {
  const out: string[] = [];
  for (const path of PURE_MODULES) {
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      out.push(`${path} is a pure module and missing`);
      continue;
    }
    for (const specifier of moduleNames(file.sf)) {
      const target = reached(specifier, path);
      if (IO_MODULE.test(specifier) || (target !== undefined && NO_IO_TARGET.test(target)))
        out.push(`${path} imports ${specifier}`);
    }
    let consoled = false;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "console")
        consoled = true;
      ts.forEachChild(node, visit);
    };
    visit(file.sf);
    if (consoled) out.push(`${path} writes to the console`);
  }
  return out;
}

const replaced = (files: readonly RepositoryFile[], path: string, text: string) => [
  ...files.filter((file) => file.path !== path),
  { path, sf: parse(path, text) },
];

describe("the import lists hold, among the files this guard holds", () => {
  test.each(RULES.map((rule) => [rule.name, rule] as const))("%s: the real sources pass", (_name, rule) => {
    expect(findings(rule, HELD)).toEqual([]);
  });

  test.each([
    ["@grpc/grpc-js importers", `${SPARK}/stray.ts`, 'import { Client } from "@grpc/grpc-js";\n'],
    ["@grpc/grpc-js importers", `${SPARK}/stray.ts`, 'const grpc = require("@grpc/grpc-js/build/src/index.js");\n'],
    [
      "@grpc/proto-loader importers",
      "tests/unit/db/spark/stray.test.ts",
      'import { fromJSON } from "@grpc/proto-loader";\n',
    ],
    ["descriptor importers", `${SPARK}/index.ts`, 'import { SPARK_DESCRIPTOR } from "./proto/descriptor";\n'],
    [
      "descriptor readers",
      "tests/unit/db/spark/stray.test.ts",
      'const text = readFileSync("src/lib/db/providers/sql/spark/proto/descriptor.ts");\n',
    ],
    [
      "generator importers",
      "tests/unit/db/spark/stray.test.ts",
      'import { loadSparkDescriptor } from "../../../../scripts/generate-spark-descriptor.mjs";\n',
    ],
    ["transport importers", `${SPARK}/namespace.ts`, 'import type { GrpcTlsOptions } from "@/lib/db/grpc/tls";\n'],
  ] as const)("%s: a planted %s fails by name", (name, path, text) => {
    const rule = RULES.find((candidate) => candidate.name === name) as Rule;
    expect(findings(rule, replaced(HELD, path, text))).toEqual([`${name}: ${path} is not named`]);
  });

  test("a named file that stops importing fails by name", () => {
    const rule = RULES.find((candidate) => candidate.name === "@grpc/proto-loader importers") as Rule;
    expect(findings(rule, replaced(HELD, DESCRIPTOR_TEST, "export {};\n"))).toEqual([
      `@grpc/proto-loader importers: ${DESCRIPTOR_TEST} is named and no longer qualifies`,
    ]);
  });
});

describe("isolation", () => {
  test("no Spark file imports a provider module outside its directory but ../sql-base", () => {
    expect(providerImportFindings(HELD)).toEqual([]);
  });

  test("a planted import of another provider fails by name, and ../sql-base and the directory's own modules pass", () => {
    const planted = 'import { SnowflakeProvider } from "../snowflake";\n';
    expect(providerImportFindings(replaced(HELD, `${SPARK}/stray.ts`, planted))).toEqual([
      `${SPARK}/stray.ts imports ../snowflake, a provider module outside ${SPARK}`,
    ]);
    const aliased = 'import { MILVUS_DEFAULT_PORT } from "@/lib/db/providers/vector/milvus/connection-options";\n';
    expect(providerImportFindings(replaced(HELD, `${SPARK}/stray.ts`, aliased))).toEqual([
      `${SPARK}/stray.ts imports @/lib/db/providers/vector/milvus/connection-options, a provider module outside ${SPARK}`,
    ]);
    const allowed = 'import { SQLBaseProvider } from "../sql-base";\nimport { x } from "./constants";\n';
    expect(providerImportFindings(replaced(HELD, `${SPARK}/stray.ts`, allowed))).toEqual([]);
  });

  test("no file under src/ outside the directory but the factory and the parser imports a Spark module", () => {
    expect(outsideImportFindings(SOURCES)).toEqual([]);
  });

  test("a planted importer under src/ fails by name, and the factory may import", () => {
    const planted = 'import { quoteSparkName } from "@/lib/db/providers/sql/spark/namespace";\n';
    expect(outsideImportFindings(replaced(SOURCES, "src/lib/stray.ts", planted))).toEqual([
      "src/lib/stray.ts imports @/lib/db/providers/sql/spark/namespace, a Spark module",
    ]);
    const relative = 'export { SPARK_DEFAULT_PORT } from "./providers/sql/spark/constants";\n';
    expect(outsideImportFindings(replaced(SOURCES, "src/lib/db/stray.ts", relative))).toEqual([
      "src/lib/db/stray.ts imports ./providers/sql/spark/constants, a Spark module",
    ]);
    const factory = 'const load = () => import("./providers/sql/spark");\n';
    expect(outsideImportFindings(replaced(SOURCES, "src/lib/db/factory.ts", factory))).toEqual([]);
  });
});

describe("pure modules import no I/O, no logger and no transport", () => {
  test("the real sources pass", () => {
    expect(pureFindings(HELD)).toEqual([]);
  });

  test.each([
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    ['import { logger } from "@/lib/logger";\n', "@/lib/logger"],
    ['import type { GrpcTlsOptions } from "../../../grpc/tls";\n', "../../../grpc/tls"],
    ['import { openGrpcChannel } from "@/lib/db/grpc/channel";\n', "@/lib/db/grpc/channel"],
    ['import { credentials } from "@grpc/grpc-js";\n', "@grpc/grpc-js"],
  ] as const)("a planted %p fails by name", (text, specifier) => {
    expect(pureFindings(replaced(HELD, `${SPARK}/namespace.ts`, text))).toEqual([
      `${SPARK}/namespace.ts imports ${specifier}`,
    ]);
  });

  test("a planted console call fails by name", () => {
    expect(pureFindings(replaced(HELD, `${SPARK}/constants.ts`, "console.log(1);\n"))).toEqual([
      `${SPARK}/constants.ts writes to the console`,
    ]);
  });
});

/**
 * Every string and every identifier in `sf` that names one of `rpcs` off SPARK_ALLOWLISTED_RPCS, so an RPC read by a
 * property access or a destructuring is found as one named in a string is. Syntactic: a name built at run time is not
 * chased.
 */
function offAllowlist(sf: ts.SourceFile, rpcs: readonly string[]): string[] {
  const allowed: readonly string[] = SPARK_ALLOWLISTED_RPCS;
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isIdentifier(node))
      names.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names.filter((text) => rpcs.includes(text) && !allowed.includes(text));
}

describe("the allowlist", () => {
  const proto = readFileSync(join(ROOT, SPARK, "proto", "spark", "connect", "base.proto"), "utf8");
  const block = proto.slice(proto.indexOf("service SparkConnectService {"));
  const rpcs = [...block.matchAll(/^\s*rpc (\w+)\(/gm)].map((match) => match[1] as string);

  test("grpc-client.ts names no SparkConnectService RPC off SPARK_ALLOWLISTED_RPCS", () => {
    expect(rpcs).toHaveLength(12);
    const adapter = HELD.find((file) => file.path === ADAPTER) as RepositoryFile;
    expect(offAllowlist(adapter.sf, rpcs)).toStrictEqual([]);
  });

  test.each([
    ["a string", 'const rpc = "ReattachExecute";\n'],
    ["a property access", "declare const full: Record<string, unknown>;\nfull.ReattachExecute;\n"],
    [
      "a destructured property",
      "declare const full: Record<string, unknown>;\nconst { ReattachExecute: reattach } = full;\n",
    ],
  ])("an RPC off the allowlist named by %s fails by name", (_form, text) => {
    expect(offAllowlist(parse(ADAPTER, text), rpcs)).toStrictEqual(["ReattachExecute"]);
  });
});
