/**
 * The Milvus provider's seam guard (vector-family spec E3, E15, E19, 5.11), on the etcd guard's shape.
 *
 * Among the files this guard holds (the provider directory, its generator, its tests, helpers and live harnesses,
 * which tests/unit/db/etcd/seam-guard.test.ts hands over), each list below is held exactly, so a stray importer fails
 * by name and a named file that stops importing fails too: who imports @grpc/grpc-js, who imports @grpc/proto-loader,
 * who imports the generated descriptor, who names its file, and who imports the generator. The modules part A builds
 * hold no logger and write nothing to the console (E19); the client's method set is E15's allowlist, mapped one to one
 * onto the RPCs the stub holds, with no Connect and no telemetry method (E3); and grpc-client.ts names no MilvusService
 * RPC off the allowlist. Every rule is proven both ways: the real sources pass it and a planted file fails it by name.
 *
 * The guard is syntactic: a module name built at run time, a require reached under another name, or a file read by a
 * path built from pieces is stated, not chased. Part B adds the browser-safe set of 5.11 when its modules exist.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MILVUS_CLIENT_METHODS } from "@/lib/db/providers/vector/milvus/client";
import { MILVUS_ALLOWLISTED_RPCS } from "@/lib/db/providers/vector/milvus/grpc-client";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MILVUS = "src/lib/db/providers/vector/milvus";
const ADAPTER = `${MILVUS}/grpc-client.ts`;
const DESCRIPTOR = `${MILVUS}/proto/descriptor.ts`;
const GENERATOR = "scripts/generate-milvus-descriptor.mjs";
const HARNESS = "tests/live/milvus-evidence.ts";
const ADAPTER_TEST = "tests/unit/db/milvus/grpc-client.test.ts";
const TLS_TEST = "tests/unit/db/milvus/tls-handshake.test.ts";
const HANDSHAKE_CASES = "tests/helpers/milvus-handshake-cases.ts";
const DESCRIPTOR_TEST = "tests/unit/db/milvus/descriptor.test.ts";
const WIRE_FIELDS_TEST = "tests/unit/db/milvus/wire-fields.test.ts";
const THIS_FILE = "tests/unit/db/milvus/seam-guard.test.ts";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

/** The files this guard holds; the etcd guard skips exactly these. */
const MILVUS_HELD: readonly RegExp[] = [
  /^src\/lib\/db\/providers\/vector\/milvus\//,
  /^scripts\/generate-milvus-descriptor\.mjs$/,
  /^tests\/unit\/db\/milvus\//,
  /^tests\/helpers\/milvus-/,
  /^tests\/live\/milvus-/,
];

const GRPC_IMPORTERS = [ADAPTER, HARNESS, ADAPTER_TEST, TLS_TEST, HANDSHAKE_CASES];
const PROTO_LOADER_IMPORTERS = [
  ADAPTER,
  HARNESS,
  ADAPTER_TEST,
  HANDSHAKE_CASES,
  DESCRIPTOR,
  GENERATOR,
  DESCRIPTOR_TEST,
];
const DESCRIPTOR_IMPORTERS = [ADAPTER];
const DESCRIPTOR_READERS = [GENERATOR, DESCRIPTOR_TEST, WIRE_FIELDS_TEST, THIS_FILE];
const GENERATOR_IMPORTERS = [HARNESS, DESCRIPTOR_TEST];
/** The modules with no logger and no console output (E19). */
const NO_LOGGER = [
  `${MILVUS}/client.ts`,
  `${MILVUS}/versions.ts`,
  `${MILVUS}/errors.ts`,
  `${MILVUS}/connection-options.ts`,
  ADAPTER,
  `${MILVUS}/schema.ts`,
  `${MILVUS}/type-spelling.ts`,
  `${MILVUS}/execute.ts`,
  `${MILVUS}/objects.ts`,
  `${MILVUS}/source.ts`,
  `${MILVUS}/labels.ts`,
  `${MILVUS}/generators.ts`,
  `${MILVUS}/monitoring.ts`,
  `${MILVUS}/monitoring-reads.ts`,
  `${MILVUS}/maintenance.ts`,
  `${MILVUS}/write-policy.ts`,
  `${MILVUS}/index.ts`,
];

interface RepositoryFile {
  readonly path: string;
  readonly sf: ts.SourceFile;
}

const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

function heldFiles(): RepositoryFile[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return [...new Set(listed.split("\0"))]
    .filter(
      (path) =>
        SOURCE_FILE.test(path) && MILVUS_HELD.some((pattern) => pattern.test(path)) && existsSync(join(ROOT, path)),
    )
    .sort()
    .map((path) => ({ path, sf: parse(path, readFileSync(join(ROOT, path), "utf8")) }));
}

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
  moduleNames(file.sf).some((specifier) => specifier.endsWith("generate-milvus-descriptor.mjs"));

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

const RULES: readonly Rule[] = [
  { name: "@grpc/grpc-js importers", named: GRPC_IMPORTERS, holds: importsPackage("@grpc/grpc-js") },
  { name: "@grpc/proto-loader importers", named: PROTO_LOADER_IMPORTERS, holds: importsPackage("@grpc/proto-loader") },
  { name: "descriptor importers", named: DESCRIPTOR_IMPORTERS, holds: importsDescriptor },
  { name: "descriptor readers", named: DESCRIPTOR_READERS, holds: namesDescriptorFile },
  { name: "generator importers", named: GENERATOR_IMPORTERS, holds: importsGenerator },
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

/** A file reaching a logger or the console: an import of @/lib/logger or any `console.` member. */
function loggerFindings(files: readonly RepositoryFile[]): string[] {
  const out: string[] = [];
  for (const file of files.filter((candidate) => NO_LOGGER.includes(candidate.path))) {
    if (moduleNames(file.sf).some((specifier) => /logger/.test(specifier))) out.push(`${file.path} imports a logger`);
    let consoled = false;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "console")
        consoled = true;
      ts.forEachChild(node, visit);
    };
    visit(file.sf);
    if (consoled) out.push(`${file.path} writes to the console`);
  }
  return out;
}

const REAL = heldFiles();
const replaced = (path: string, text: string) => [
  ...REAL.filter((file) => file.path !== path),
  { path, sf: parse(path, text) },
];

describe("the import lists hold, among the files this guard holds (E15)", () => {
  test.each(RULES.map((rule) => [rule.name, rule] as const))("%s: the real sources pass", (_name, rule) => {
    expect(findings(rule, REAL)).toEqual([]);
  });

  test.each([
    ["@grpc/grpc-js importers", `${MILVUS}/stray.ts`, 'import { Client } from "@grpc/grpc-js";\n'],
    ["@grpc/grpc-js importers", `${MILVUS}/stray.ts`, 'const grpc = require("@grpc/grpc-js/build/src/index.js");\n'],
    [
      "@grpc/proto-loader importers",
      "tests/unit/db/milvus/stray.test.ts",
      'import { fromJSON } from "@grpc/proto-loader";\n',
    ],
    ["descriptor importers", `${MILVUS}/index.ts`, 'import { MILVUS_DESCRIPTOR } from "./proto/descriptor";\n'],
    [
      "descriptor readers",
      "tests/unit/db/milvus/stray.test.ts",
      'const text = readFileSync("src/lib/db/providers/vector/milvus/proto/descriptor.ts");\n',
    ],
    [
      "generator importers",
      "tests/unit/db/milvus/stray.test.ts",
      'import { loadMilvusDescriptor } from "../../../../scripts/generate-milvus-descriptor.mjs";\n',
    ],
  ] as const)("%s: a planted %s fails by name", (name, path, text) => {
    const rule = RULES.find((candidate) => candidate.name === name) as Rule;
    expect(findings(rule, replaced(path, text))).toEqual([`${name}: ${path} is not named`]);
  });

  test("a named file that stops importing fails by name", () => {
    const rule = RULES[0] as Rule;
    expect(findings(rule, replaced(TLS_TEST, "export {};\n"))).toEqual([
      `@grpc/grpc-js importers: ${TLS_TEST} is named and no longer qualifies`,
    ]);
  });
});

describe("E19: no logger and no console in the client's modules", () => {
  test("the real sources pass", () => {
    expect(loggerFindings(REAL)).toEqual([]);
    for (const path of NO_LOGGER) expect(REAL.some((file) => file.path === path)).toBe(true);
  });

  test("a planted logger import and a planted console call fail by name", () => {
    expect(loggerFindings(replaced(ADAPTER, 'import { logger } from "@/lib/logger";\n'))).toEqual([
      `${ADAPTER} imports a logger`,
    ]);
    expect(loggerFindings(replaced(`${MILVUS}/errors.ts`, "console.debug('x');\n"))).toEqual([
      `${MILVUS}/errors.ts writes to the console`,
    ]);
  });
});

describe("E3 and E15: the method set", () => {
  const toRpc = (method: string) =>
    method === "getMetricsSystemInfo" ? "GetMetrics" : method[0].toUpperCase() + method.slice(1);

  test("the client's methods, without close(), are the stub's RPCs one to one, in order", () => {
    expect(MILVUS_CLIENT_METHODS.filter((method) => method !== "close").map(toRpc)).toEqual([
      ...MILVUS_ALLOWLISTED_RPCS,
    ]);
  });

  test("grpc-client.ts names no MilvusService RPC off the allowlist, Connect among them", () => {
    const proto = readFileSync(join(ROOT, MILVUS, "proto", "milvus.proto"), "utf8");
    const service = proto.slice(
      proto.indexOf("service MilvusService {"),
      proto.indexOf("service ClientTelemetryService {"),
    );
    const rpcs = [...service.matchAll(/^\s*rpc (\w+)\(/gm)].map((match) => match[1] as string);
    expect(rpcs).toContain("Connect");
    const allowed: readonly string[] = MILVUS_ALLOWLISTED_RPCS;
    const adapter = REAL.find((file) => file.path === ADAPTER) as RepositoryFile;
    const strings: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) strings.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(adapter.sf);
    expect(strings.filter((text) => rpcs.includes(text) && !allowed.includes(text))).toEqual([]);
    const telemetry = ["ClientHeartbeat", "GetClientTelemetry", "PushClientCommand", "DeleteClientCommand", "Connect"];
    expect(strings.filter((text) => telemetry.includes(text))).toEqual([]);
  });
});

/**
 * Who may name each narrow client method: the seam that declares it, the adapter that implements it, and its one
 * consumer. Load and Release are maintenance.ts's alone, the bulk describe is objects.ts's alone, and GetMetrics is
 * read by the Load preview alone, so no other module can send any of them.
 */
const METHOD_HOLDERS: Readonly<Record<string, readonly string[]>> = {
  loadCollection: [`${MILVUS}/client.ts`, ADAPTER, `${MILVUS}/maintenance.ts`],
  releaseCollection: [`${MILVUS}/client.ts`, ADAPTER, `${MILVUS}/maintenance.ts`],
  batchDescribeCollection: [`${MILVUS}/client.ts`, ADAPTER, `${MILVUS}/objects.ts`],
  getMetricsSystemInfo: [`${MILVUS}/client.ts`, ADAPTER, `${MILVUS}/maintenance.ts`],
};

/** Whether a file names `method` as an identifier or as a string, which is how a `Pick<MilvusClient, "x">` names it. */
function namesMethod(file: RepositoryFile, method: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === method
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sf);
  return found;
}

function holderFindings(files: readonly RepositoryFile[]): string[] {
  const modules = files.filter(
    (file) => file.path.startsWith(`${MILVUS}/`) && !file.path.startsWith(`${MILVUS}/proto/`),
  );
  return Object.entries(METHOD_HOLDERS).flatMap(([method, holders]) => {
    const naming = modules.filter((file) => namesMethod(file, method)).map((file) => file.path);
    return [
      ...naming
        .filter((path) => !holders.includes(path))
        .map((path) => `${method}: ${path} names it and is not one of its holders`),
      ...holders
        .filter((path) => !naming.includes(path))
        .map((path) => `${method}: ${path} is a holder and does not name it`),
    ];
  });
}

describe("only the modules that own them hold the narrow client methods", () => {
  test("the real sources pass", () => {
    expect(holderFindings(REAL)).toEqual([]);
  });

  test("a planted call fails by name", () => {
    const planted = "export const run = (client: { loadCollection(): void }) => client.loadCollection();\n";
    expect(holderFindings(replaced(`${MILVUS}/monitoring-reads.ts`, planted))).toEqual([
      `loadCollection: ${MILVUS}/monitoring-reads.ts names it and is not one of its holders`,
    ]);
  });

  test("a planted slice fails by name, and a holder that stops naming its method fails too", () => {
    const slice = 'export type Wide = Pick<{ batchDescribeCollection(): void }, "batchDescribeCollection">;\n';
    expect(holderFindings(replaced(`${MILVUS}/source.ts`, slice))).toEqual([
      `batchDescribeCollection: ${MILVUS}/source.ts names it and is not one of its holders`,
    ]);
    expect(holderFindings(replaced(`${MILVUS}/objects.ts`, "export {};\n"))).toEqual([
      `batchDescribeCollection: ${MILVUS}/objects.ts is a holder and does not name it`,
    ]);
  });
});

describe("the surfaces hold no logger and write nothing to the console", () => {
  test.each([
    "schema.ts",
    "type-spelling.ts",
    "execute.ts",
    "objects.ts",
    "source.ts",
    "labels.ts",
    "generators.ts",
    "monitoring.ts",
    "monitoring-reads.ts",
    "maintenance.ts",
    "write-policy.ts",
    "index.ts",
  ])("%s is held by the no-logger rule", (module) => {
    expect(NO_LOGGER).toContain(`${MILVUS}/${module}`);
  });
});
