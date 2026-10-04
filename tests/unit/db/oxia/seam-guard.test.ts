/**
 * The Oxia provider's seam guard (SB1-2.4, rule 3), on the Milvus guard's shape.
 *
 * Among the files of the `oxia` row of tests/helpers/grpc-seam-holdings.ts (the provider directory, its descriptor
 * generator, its tests and helpers, and the live tools under tests/live/oxia-, which
 * tests/unit/db/etcd/seam-guard.test.ts hands over), each list below is held exactly:
 * who loads @grpc/grpc-js, who loads @grpc/proto-loader, who imports the generated descriptor, and who imports its
 * generator. A stray importer fails by name, and so does a named file that stops importing or is gone. Every rule is
 * proven both ways: the real sources pass it and a planted file fails it by name.
 *
 * Rules 1, 2 and 4 hold the adapter's allowlist: the filtered stubs carry exactly the read RPCs and their paths, and no
 * string in grpc-client.ts names an RPC of the vendored protos that is off the allowlist (C9).
 *
 * The guard is syntactic, as the etcd and Milvus guards are: a module name built at run time or a require reached
 * under another name is stated, not chased. The transport's own rules are tests/unit/db/grpc/seam-guard.test.ts's.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { OXIA_ALLOWLISTED_RPCS, OXIA_HEALTH_RPCS } from "@/lib/db/providers/keyvalue/oxia/client";
import { allowlistedServices, allowlistFindings } from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { GRPC_SEAM_HOLDINGS } from "../../../helpers/grpc-seam-holdings";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OXIA = "src/lib/db/providers/keyvalue/oxia";
const DESCRIPTOR = `${OXIA}/proto/descriptor.ts`;
const GENERATOR = "scripts/generate-oxia-descriptor.mjs";
const DESCRIPTOR_TEST = "tests/unit/db/oxia/descriptor.test.ts";
const THIS_FILE = "tests/unit/db/oxia/seam-guard.test.ts";
const ADAPTER = `${OXIA}/grpc-client.ts`;
const ADAPTER_TEST = "tests/unit/db/oxia/grpc-client.test.ts";
const RAW_SEEDER = "tests/live/oxia-seed-raw.ts";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

/** The files this guard holds; the etcd guard skips exactly these. */
const OXIA_HELD: readonly RegExp[] = GRPC_SEAM_HOLDINGS.oxia.held;

const GRPC_IMPORTERS: readonly string[] = [ADAPTER_TEST, RAW_SEEDER];
const PROTO_LOADER_IMPORTERS: readonly string[] = [GENERATOR, DESCRIPTOR, DESCRIPTOR_TEST, ADAPTER, RAW_SEEDER];
const DESCRIPTOR_IMPORTERS: readonly string[] = [DESCRIPTOR_TEST, ADAPTER];
const GENERATOR_IMPORTERS: readonly string[] = [DESCRIPTOR_TEST];

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
        SOURCE_FILE.test(path) && OXIA_HELD.some((pattern) => pattern.test(path)) && existsSync(join(ROOT, path)),
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
  moduleNames(file.sf).some((specifier) => specifier.endsWith("generate-oxia-descriptor.mjs"));

interface Rule {
  readonly name: string;
  readonly named: readonly string[];
  readonly holds: (file: RepositoryFile) => boolean;
}

const RULES: readonly Rule[] = [
  { name: "@grpc/grpc-js importers", named: GRPC_IMPORTERS, holds: importsPackage("@grpc/grpc-js") },
  { name: "@grpc/proto-loader importers", named: PROTO_LOADER_IMPORTERS, holds: importsPackage("@grpc/proto-loader") },
  { name: "descriptor importers", named: DESCRIPTOR_IMPORTERS, holds: importsDescriptor },
  { name: "generator importers", named: GENERATOR_IMPORTERS, holds: importsGenerator },
];

const ruleNamed = (name: string) => RULES.find((candidate) => candidate.name === name) as Rule;

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

const REAL = heldFiles();
const replaced = (path: string, text: string) => [
  ...REAL.filter((file) => file.path !== path),
  { path, sf: parse(path, text) },
];

describe("the import lists hold, among the files this guard holds (SB1-2.4 rule 3)", () => {
  test.each(RULES.map((rule) => [rule.name, rule] as const))("%s: the real sources pass", (_name, rule) => {
    expect(findings(rule, REAL)).toEqual([]);
  });

  test("the guard reads files, so no rule passes over nothing", () => {
    const paths = REAL.map((file) => file.path);
    for (const path of [
      DESCRIPTOR,
      GENERATOR,
      DESCRIPTOR_TEST,
      ADAPTER,
      ADAPTER_TEST,
      RAW_SEEDER,
      `${OXIA}/client.ts`,
      `${OXIA}/constants.ts`,
      THIS_FILE,
    ])
      expect(paths).toContain(path);
  });

  test.each([
    ["@grpc/grpc-js importers", `${OXIA}/stray.ts`, 'import { Client } from "@grpc/grpc-js";\n'],
    ["@grpc/grpc-js importers", `${OXIA}/stray.ts`, 'const grpc = require("@grpc/grpc-js/build/src/index.js");\n'],
    [
      "@grpc/proto-loader importers",
      `${OXIA}/client.ts`,
      'import type { PackageDefinition } from "@grpc/proto-loader";\n',
    ],
    ["descriptor importers", `${OXIA}/client.ts`, 'import { OXIA_DESCRIPTOR } from "./proto/descriptor";\n'],
    ["descriptor importers", `${OXIA}/walks.ts`, 'import { OXIA_DESCRIPTOR } from "./proto/descriptor";\n'],
    [
      "generator importers",
      "tests/unit/db/oxia/stray.test.ts",
      'import { loadOxiaDescriptor } from "../../../../scripts/generate-oxia-descriptor.mjs";\n',
    ],
  ] as const)("%s: a planted %s fails by name", (name, path, text) => {
    expect(findings(ruleNamed(name), replaced(path, text))).toEqual([`${name}: ${path} is not named`]);
  });

  test("a named file that stops importing fails by name", () => {
    expect(
      findings(ruleNamed("@grpc/proto-loader importers"), replaced(DESCRIPTOR, "export const OXIA_DESCRIPTOR = {};\n")),
    ).toEqual([`@grpc/proto-loader importers: ${DESCRIPTOR} is named and no longer qualifies`]);
    const emptied = replaced(DESCRIPTOR_TEST, "export {};\n");
    for (const name of ["descriptor importers", "generator importers", "@grpc/proto-loader importers"]) {
      expect(findings(ruleNamed(name), emptied)).toEqual([
        `${name}: ${DESCRIPTOR_TEST} is named and no longer qualifies`,
      ]);
    }
  });

  test("the adapter's test that stops importing grpc-js fails by name", () => {
    expect(findings(ruleNamed("@grpc/grpc-js importers"), replaced(ADAPTER_TEST, "export {};\n"))).toEqual([
      `@grpc/grpc-js importers: ${ADAPTER_TEST} is named and no longer qualifies`,
    ]);
  });

  test("the raw seeder that stops importing grpc-js or the proto loader fails by name", () => {
    const emptied = replaced(RAW_SEEDER, "export {};\n");
    for (const name of ["@grpc/grpc-js importers", "@grpc/proto-loader importers"]) {
      expect(findings(ruleNamed(name), emptied)).toEqual([`${name}: ${RAW_SEEDER} is named and no longer qualifies`]);
    }
  });

  test("a planted tests/live/oxia- file that loads grpc-js fails by name", () => {
    const path = "tests/live/oxia-evidence.ts";
    expect(
      findings(ruleNamed("@grpc/grpc-js importers"), replaced(path, 'import * as grpc from "@grpc/grpc-js";\n')),
    ).toEqual([`@grpc/grpc-js importers: ${path} is not named`]);
  });

  test("a named file that is gone fails by name", () => {
    const gone = REAL.filter((file) => file.path !== DESCRIPTOR_TEST);
    expect(findings(ruleNamed("generator importers"), gone)).toEqual([
      `generator importers: ${DESCRIPTOR_TEST} is named and missing`,
    ]);
  });
});

// -- the allowlist (SB1-2.4 rules 1, 2 and 4) ------------------------------------------------------------------------

/** The RPC names grpc-client.ts may not spell: every RPC of both vendored services off the allowlist. */
const FORBIDDEN_RPC_NAMES: readonly string[] = [
  "Write",
  "WriteStream",
  "CreateSession",
  "KeepAlive",
  "CloseSession",
  "GetNotifications",
  "GetSequenceUpdates",
  "Watch",
];

/** Every `rpc <Name>(` of one service of a vendored proto. */
function protoRpcs(file: string, service: string): string[] {
  const text = readFileSync(join(ROOT, OXIA, "proto", file), "utf8");
  const start = text.indexOf(`service ${service} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = text.slice(start, text.indexOf("\n}", start));
  return [...body.matchAll(/^\s*rpc (\w+)\(/gm)].map((match) => match[1] as string);
}

/** Every string literal and no-substitution template of a file that names a forbidden RPC, by file. */
function rpcNameFindings(file: RepositoryFile): string[] {
  const named: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      FORBIDDEN_RPC_NAMES.includes(node.text)
    )
      named.push(`${file.path} names ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(file.sf);
  return named;
}

describe("the adapter's allowlist (SB1-2.4 rules 1, 2 and 4)", () => {
  test("rule 1: the filtered stubs hold the allowlist and nothing else", () => {
    const { client, health } = allowlistedServices();
    expect(allowlistFindings([...Object.keys(client), ...Object.keys(health).map((name) => `Health/${name}`)])).toEqual(
      [],
    );
  });

  test("rule 2: the method paths of both filtered services", () => {
    const { client, health } = allowlistedServices();
    const paths = [...Object.values(client), ...Object.values(health)].map((method) => method.path);
    expect(paths).toEqual([
      "/io.oxia.proto.v1.OxiaClient/GetShardAssignments",
      "/io.oxia.proto.v1.OxiaClient/Read",
      "/io.oxia.proto.v1.OxiaClient/List",
      "/io.oxia.proto.v1.OxiaClient/RangeScan",
      "/grpc.health.v1.Health/Check",
    ]);
  });

  test("rule 4: the forbidden names are every RPC of the vendored protos off the allowlist", () => {
    const allowed: readonly string[] = OXIA_ALLOWLISTED_RPCS;
    const healthAllowed: readonly string[] = OXIA_HEALTH_RPCS;
    const clientOff = protoRpcs("client.proto", "OxiaClient").filter((rpc) => !allowed.includes(rpc));
    const healthOff = protoRpcs("grpc/health/v1/health.proto", "Health").filter((rpc) => !healthAllowed.includes(rpc));
    // Health/List is off the allowlist, but as a string it is OxiaClient's allowlisted List, which the adapter names.
    expect(healthOff).toContain("List");
    const spelled = [...clientOff, ...healthOff.filter((rpc) => !allowed.includes(rpc))];
    expect([...new Set(spelled)].sort()).toEqual([...FORBIDDEN_RPC_NAMES].sort());
  });

  test("rule 4: no string of grpc-client.ts names a forbidden RPC", () => {
    const adapter = REAL.find((file) => file.path === ADAPTER) as RepositoryFile;
    expect(adapter).toBeDefined();
    expect(rpcNameFindings(adapter)).toEqual([]);
  });

  test("rule 4: a planted adapter text naming Write fails by name", () => {
    const planted = { path: ADAPTER, sf: parse(ADAPTER, 'const rpc = "Write";\nconst other = `Watch`;\n') };
    expect(rpcNameFindings(planted)).toEqual([`${ADAPTER} names Write`, `${ADAPTER} names Watch`]);
  });
});
