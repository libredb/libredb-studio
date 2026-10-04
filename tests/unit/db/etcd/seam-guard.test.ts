/**
 * The etcd provider's seam guard (spec E11, 3.1, 3.2).
 *
 * The provider reaches etcd through one narrow seam, and this file keeps the seam where it is. It parses source
 * files from disk and fails the build when an ordinary edit crosses a line spec E11 draws:
 *
 * - who imports @grpc/grpc-js (the gate-4 evidence harness and the adapter's two transport tests),
 *   who imports the generated descriptor, who names its file to read it, who imports @grpc/proto-loader, and who
 *   imports the descriptor's generator, each list held exactly, so a named file that stops importing fails too;
 * - what each module of spec 3.1's pure set imports (other members, the shared types, the repository's error
 *   classes, and types, and only types, from client.ts), and that the four shipped to the browser import no
 *   server-side member;
 * - that every module name in the provider directory is a plain string, and that no file there calls require;
 * - that the adapter builds an AlarmRequest only as GET or DEACTIVATE, and names no RPC off the allowlist;
 * - that the 42 RPCs of rpc.proto are each classified as read, write or forbidden, equal to the vendored
 *   descriptor's services, that the allowlist is exactly the read and write classes, and that the seam's methods
 *   send only those;
 * - that every write the adapter can send is one E6 knows and one surface gates: an editor command classified by
 *   guard.ts with its Gate of spec 5.1.3, or a maintenance operation whose words the editor's table and its parser
 *   refuse by name, pointing at the card of spec 7.2 by that card's label (E7), whose card maintenance.ts declares
 *   under that label, global, never per entity and typed-confirmed, and which E6 refuses when read-only.
 *
 * It reads the repository's files through git's own lists (tracked, and untracked but not ignored), so a new
 * directory is read too, and resolves module names as TypeScript does, with the repository's tsconfig, so a path or
 * an alias that reaches the descriptor counts as well as its plain name. Each rule is proven both ways: the real
 * sources pass it, and a violation planted in a temporary copy, or in a temporary repository, fails it by name.
 *
 * The guard is syntactic, as Kafka's is (tests/unit/db/kafka/seam-guard.test.ts): forms written to hide a load are
 * stated, not chased. It does not see a module name built at run time outside the provider directory, a require
 * function reached under another name outside it, a file read by a path built from pieces, a method path handed
 * to grpc-js from outside the adapter, or text run as code. E15, the live harness's snapshot of the key space before
 * and after every run, is the behavioural check.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { ETCD_CLIENT_METHODS } from "@/lib/db/providers/keyvalue/etcd/client";
import { ETCD_REFUSED_COMMANDS, parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { assessCommand, type CommandAssessment } from "@/lib/db/providers/keyvalue/etcd/guard";
import { ETCD_MAINTENANCE_SPECS } from "@/lib/db/providers/keyvalue/etcd/maintenance";
import { refuseBeforeSend, refuseReadOnly } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import { heldByAnotherGuard } from "../../../helpers/grpc-seam-holdings";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ETCD_PATH = "src/lib/db/providers/keyvalue/etcd";
const ADAPTER = `${ETCD_PATH}/grpc-client.ts`;
const DESCRIPTOR = `${ETCD_PATH}/proto/descriptor.ts`;
const GENERATOR = "scripts/generate-etcd-descriptor.mjs";
const HARNESS = "tests/live/etcd-evidence.ts";
const ADAPTER_TEST = "tests/unit/db/etcd/grpc-client.test.ts";
const TLS_TEST = "tests/unit/db/etcd/tls-handshake.test.ts";
const DESCRIPTOR_TEST = "tests/unit/db/etcd/descriptor.test.ts";
const WIRE_FIELDS_TEST = "tests/unit/db/etcd/wire-fields.test.ts";
const THIS_FILE = "tests/unit/db/etcd/seam-guard.test.ts";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

const GRPC_JS = "@grpc/grpc-js";
const PROTO_LOADER = "@grpc/proto-loader";

// -- reading files ------------------------------------------------------------------------------------------------

/** A parsed source file of a repository, by its path relative to the root with `/` on every platform. */
interface RepositoryFile {
  readonly path: string;
  readonly sf: ts.SourceFile;
}

/** Every source file git lists in the repository at `root`: tracked, or untracked and not ignored. */
function repositoryFiles(root: string, env?: NodeJS.ProcessEnv): RepositoryFile[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return [...new Set(listed.split("\0"))]
    .filter((path) => SOURCE_FILE.test(path) && existsSync(join(root, path)))
    .sort()
    .map((path) => ({ path, sf: parse(path, readFileSync(join(root, path), "utf8")) }));
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/** Each repository's files, parsed once for every rule of a run. */
const parsedRepositories = new Map<string, RepositoryFile[]>();
function filesOf(root: string, env?: NodeJS.ProcessEnv): RepositoryFile[] {
  let files = parsedRepositories.get(root);
  if (files === undefined) {
    files = repositoryFiles(root, env);
    parsedRepositories.set(root, files);
  }
  return files;
}

// Reading and parsing every file of the repository is this file's one costly step, and filesOf keeps
// the result: pay it once here, under its own budget, so the first test that reads the repository
// does not spend bun's per-test budget on it. Measured under load (eight busy loops on two cores):
// the first importer test took over 5,000 ms and timed out in 3 runs of 3 before this hook.
beforeAll(() => {
  filesOf(ROOT);
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

/** Whether a module name written in `containing` names the file at `target` of the repository at `root`. */
function resolvesTo(specifier: string, containing: string, root: string, target: string): boolean {
  const file = join(root, target);
  return existsSync(file) && resolvedFile(specifier, containing, root) === canonical(file);
}

/** Whether a module name loads the package `name`: it names it, or resolves inside its directory. */
function loadsPackage(name: string, specifier: string, containing: string, root: string): boolean {
  if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  return resolvedFile(specifier, containing, root)?.includes(`/node_modules/${name}/`) === true;
}

// -- module references ----------------------------------------------------------------------------------------------

/** A module a file loads, and how. */
interface ModuleReference {
  readonly node: ts.Node;
  /** The module name, or undefined when it is not written as a plain string. */
  readonly specifier: string | undefined;
  /** True when it loads nothing at run time: `import type`, every name marked `type`, or an import type. */
  readonly typeOnly: boolean;
}

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

/** Every module a file loads: an import, a re-export, an import-equals, an import type, import() and require(). */
function moduleReferences(sf: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)));
      references.push({ node, specifier: plainString(node.moduleSpecifier), typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      references.push({ node, specifier: plainString(node.moduleSpecifier), typeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      references.push({ node, specifier: plainString(node.moduleReference.expression), typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) ? plainString(argument.literal) : undefined;
      references.push({ node, specifier, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireCall(node))
    ) {
      references.push({ node, specifier: plainString(node.arguments[0]), typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return references;
}

/** The nodes that write a module name, which are imports, not reads of a file's text. */
function moduleNameNodes(sf: ts.SourceFile): Set<ts.Node> {
  const names = new Set<ts.Node>();
  for (const { node } of moduleReferences(sf)) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) names.add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments[0] !== undefined) {
      names.add(node.arguments[0]);
    }
  }
  return names;
}

/** A name, a string or a template chunk a file writes, with its 1-based line. */
interface Spelling {
  readonly node: ts.Node;
  readonly text: string;
  readonly isString: boolean;
  readonly line: number;
}

/** Every identifier, string literal and template chunk of a file. Comments are trivia, so prose is free. */
function spellings(sf: ts.SourceFile): Spelling[] {
  const found: Spelling[] = [];
  const visit = (node: ts.Node) => {
    const isString =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node);
    if (isString || ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push({ node, text: (node as ts.Identifier | ts.StringLiteral).text, isString, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// -- spec E11: who may import the client packages, the descriptor and its generator ----------------------------------

interface ImportRule {
  /** The rule's name, which every finding of it starts with. */
  readonly name: string;
  /** What the named files reach, as a finding words it. */
  readonly what: string;
  readonly verb: "imports" | "names the file of";
  /** Exactly the files that may, and must: a named file that stops is a finding too. */
  readonly named: readonly string[];
  readonly holds: (file: RepositoryFile, root: string) => boolean;
}

const importsPackage =
  (name: string) =>
  ({ path, sf }: RepositoryFile, root: string): boolean =>
    moduleReferences(sf).some(
      ({ specifier }) => specifier !== undefined && loadsPackage(name, specifier, join(root, path), root),
    );

const importsFile =
  (target: string) =>
  ({ path, sf }: RepositoryFile, root: string): boolean =>
    moduleReferences(sf).some(
      ({ specifier }) => specifier !== undefined && resolvesTo(specifier, join(root, path), root, target),
    );

/** A string, other than a module name, whose last path segment is the descriptor's file name. */
function namesDescriptorFile({ sf }: RepositoryFile): boolean {
  const moduleNames = moduleNameNodes(sf);
  return spellings(sf).some(
    ({ node, text, isString }) => isString && !moduleNames.has(node) && /(?:^|[/\\])descriptor\.ts$/.test(text),
  );
}

/** Spec E11 and the plan's Global Constraints, list by list. */
const IMPORT_RULES: readonly ImportRule[] = [
  {
    name: "@grpc/grpc-js importers",
    what: GRPC_JS,
    verb: "imports",
    named: [HARNESS, ADAPTER_TEST, TLS_TEST],
    holds: importsPackage(GRPC_JS),
  },
  {
    name: "descriptor importers",
    what: DESCRIPTOR,
    verb: "imports",
    named: [ADAPTER, ADAPTER_TEST, TLS_TEST],
    holds: importsFile(DESCRIPTOR),
  },
  {
    name: "descriptor readers",
    what: "the descriptor",
    verb: "names the file of",
    named: [GENERATOR, DESCRIPTOR_TEST, WIRE_FIELDS_TEST, THIS_FILE],
    holds: namesDescriptorFile,
  },
  {
    name: "@grpc/proto-loader importers",
    what: PROTO_LOADER,
    verb: "imports",
    // The files allowed @grpc/grpc-js, the descriptor's own type-only import, the generator and its test.
    named: [ADAPTER, HARNESS, ADAPTER_TEST, TLS_TEST, DESCRIPTOR, GENERATOR, DESCRIPTOR_TEST],
    holds: importsPackage(PROTO_LOADER),
  },
  {
    name: "generator importers",
    what: GENERATOR,
    verb: "imports",
    named: [HARNESS, DESCRIPTOR_TEST],
    holds: importsFile(GENERATOR),
  },
];

/** The rule's findings over the repository at `root`: every file it does not name, then every named file it misses. */
function importRuleFindings(rule: ImportRule, root: string, env?: NodeJS.ProcessEnv): string[] {
  const files = filesOf(root, env);
  const found = new Set(
    files.filter((file) => !heldByAnotherGuard(file.path) && rule.holds(file, root)).map((file) => file.path),
  );
  const listed = new Set(files.map((file) => file.path));
  return [
    ...[...found]
      .filter((path) => !rule.named.includes(path))
      .map((path) => `${rule.name}: ${path} ${rule.verb} ${rule.what}, and spec E11 does not name it`),
    ...rule.named
      .filter((path) => !found.has(path))
      .map((path) =>
        listed.has(path)
          ? `${rule.name}: ${path} is named, and no longer ${rule.verb} ${rule.what}`
          : `${rule.name}: ${path} is named, and is not in the repository`,
      ),
  ];
}

// -- spec 3.1: the pure set ----------------------------------------------------------------------------------------

const PURE_SET = [
  "lexer.ts",
  "commands.ts",
  "keys.ts",
  "permissions.ts",
  "guard.ts",
  "write-policy.ts",
  "values.ts",
  "results.ts",
  "monitoring.ts",
] as const;
/** Read by the confirmation gate, the generators and the editor's tokens provider, all shipped to the browser. */
const BROWSER_SHIPPED: ReadonlySet<string> = new Set(["lexer.ts", "commands.ts", "keys.ts", "guard.ts"]);
/** The shared types, and the repository's error classes for the ones spec 5.6 raises. */
const SHARED_MODULES = ["src/lib/db/types.ts", "src/lib/types.ts", "src/lib/db/errors.ts"];

/** The members of the pure set in the provider directory of `root` today, which is every member the rule covers. */
function pureMembers(root: string): string[] {
  return PURE_SET.filter((member) => existsSync(join(root, ETCD_PATH, member)));
}

/** What one pure member's text imports that spec 3.1 does not allow it, as findings. */
function pureSetFindings(member: string, text: string, root: string): string[] {
  const containing = join(root, ETCD_PATH, member);
  const canonicalOf = (path: string) => (existsSync(join(root, path)) ? canonical(join(root, path)) : undefined);
  const members = new Map(pureMembers(root).map((name) => [canonicalOf(`${ETCD_PATH}/${name}`), name]));
  const shared = new Set(SHARED_MODULES.map(canonicalOf));
  const client = canonicalOf(`${ETCD_PATH}/client.ts`);
  const findings: string[] = [];
  for (const { specifier, typeOnly } of moduleReferences(parse(member, text))) {
    if (specifier === undefined) {
      findings.push(`pure set: ${member} imports a module whose name is not a plain string`);
      continue;
    }
    const target = resolvedFile(specifier, containing, root);
    const imported = target === undefined ? undefined : members.get(target);
    if (target !== undefined && target === client) {
      if (!typeOnly) {
        findings.push(
          `pure set: ${member} imports a value from ${specifier}; a pure module takes types, and only types, from client.ts`,
        );
      }
    } else if (imported !== undefined) {
      if (BROWSER_SHIPPED.has(member) && !BROWSER_SHIPPED.has(imported)) {
        findings.push(
          `pure set: ${member} is shipped to the browser and imports ${specifier}, a server-side member of the pure set`,
        );
      }
    } else if (target === undefined || !shared.has(target)) {
      findings.push(`pure set: ${member} imports ${specifier}, which spec 3.1 does not allow a pure module`);
    }
  }
  return findings;
}

// -- the provider directory: plain module names, no require ---------------------------------------------------------

function moduleNameFindings(file: string, text: string): string[] {
  const sf = parse(file, text);
  const findings: string[] = [];
  for (const { node, specifier } of moduleReferences(sf)) {
    if (specifier !== undefined) continue;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    findings.push(`module names: ${file}:${line} loads a module whose name is not a plain string`);
  }
  for (const { node, text: name, isString, line } of spellings(sf)) {
    if (!isString && (name === "require" || name === "createRequire") && !declaresMember(node)) {
      findings.push(`module names: ${file}:${line} names ${name}, which loads a module past the plain-string rule`);
    }
  }
  return findings;
}

/** Whether a name is the key a member is declared under, as the SSL mode `require` is a key of a table, not a load. */
function declaresMember(node: ts.Node): boolean {
  const { parent } = node;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  );
}

// -- spec E11: the adapter's alarm actions and RPC names --------------------------------------------------------------

/** The Alarm method's actions the adapter may send: a GET, and a DEACTIVATE of the pair a GET answered (spec 7.2). */
const ALARM_ACTIONS: ReadonlySet<string> = new Set(["GET", "DEACTIVATE"]);

function alarmActionFindings(text: string): string[] {
  const sf = parse("grpc-client.ts", text);
  const findings: string[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const { text: name, line } of spellings(sf)) {
    if (name === "ACTIVATE") {
      findings.push(`alarm actions: grpc-client.ts:${line} names ACTIVATE, which raises an alarm (spec E11)`);
    }
  }
  const check = (node: ts.Node, value: ts.Node | undefined) => {
    const written = value === undefined ? undefined : plainString(value);
    if (written === undefined || !ALARM_ACTIONS.has(written)) {
      const shown = value === undefined ? "a shorthand" : value.getText(sf);
      findings.push(
        `alarm actions: grpc-client.ts:${lineOf(node)} sets action to ${shown}, which is neither GET nor DEACTIVATE (spec E11)`,
      );
    }
  };
  /** A property's name when it is written plainly: `action`, `"action"` or `["action"]`. */
  const propertyName = (name: ts.PropertyName) =>
    ts.isIdentifier(name)
      ? name.text
      : ts.isComputedPropertyName(name)
        ? plainString(name.expression)
        : plainString(name);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "action") check(node, node.initializer);
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "action") check(node, undefined);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === "action") ||
        (ts.isElementAccessExpression(node.left) && plainString(node.left.argumentExpression) === "action"))
    ) {
      check(node, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

type RpcClass = "read" | "write" | "forbidden";

/**
 * The 42 RPCs of rpc.proto at etcd v3.7.2, each classified (spec E11). The read and write classes are the
 * allowlist; Maintenance/Alarm is a write because one of its actions deactivates an alarm, and the adapter sends it
 * only as GET or DEACTIVATE. KV/Put is forbidden as a direct call: a top-level single-key put is E8's guarded Txn, a
 * value edit is a Txn, and a put in a txn body is a request inside the Txn. RangeStream stays out (spec 3.2).
 */
const RPC_CLASSES: Readonly<Record<string, RpcClass>> = {
  "KV/Range": "read",
  "KV/RangeStream": "forbidden",
  "KV/Put": "forbidden",
  "KV/DeleteRange": "write",
  "KV/Txn": "write",
  "KV/Compact": "write",
  "Watch/Watch": "read",
  "Lease/LeaseGrant": "write",
  "Lease/LeaseRevoke": "write",
  "Lease/LeaseKeepAlive": "write",
  "Lease/LeaseTimeToLive": "read",
  "Lease/LeaseLeases": "read",
  "Cluster/MemberAdd": "forbidden",
  "Cluster/MemberRemove": "forbidden",
  "Cluster/MemberUpdate": "forbidden",
  "Cluster/MemberList": "read",
  "Cluster/MemberPromote": "forbidden",
  "Maintenance/Alarm": "write",
  "Maintenance/Status": "read",
  "Maintenance/Defragment": "write",
  "Maintenance/Hash": "forbidden",
  "Maintenance/HashKV": "forbidden",
  "Maintenance/Snapshot": "forbidden",
  "Maintenance/MoveLeader": "forbidden",
  "Maintenance/Downgrade": "forbidden",
  "Auth/AuthEnable": "forbidden",
  "Auth/AuthDisable": "forbidden",
  "Auth/AuthStatus": "read",
  "Auth/Authenticate": "read",
  "Auth/UserAdd": "forbidden",
  "Auth/UserGet": "read",
  "Auth/UserList": "read",
  "Auth/UserDelete": "forbidden",
  "Auth/UserChangePassword": "forbidden",
  "Auth/UserGrantRole": "forbidden",
  "Auth/UserRevokeRole": "forbidden",
  "Auth/RoleAdd": "forbidden",
  "Auth/RoleGet": "read",
  "Auth/RoleList": "read",
  "Auth/RoleDelete": "forbidden",
  "Auth/RoleGrantPermission": "forbidden",
  "Auth/RoleRevokePermission": "forbidden",
};

const rpcsOf = (rpcClass: RpcClass, classes = RPC_CLASSES) =>
  Object.keys(classes).filter((rpc) => classes[rpc] === rpcClass);

/**
 * The methods the adapter may not name, as a name or a string: every forbidden RPC's method, and the methods of the
 * Lock and Election services, which rpc.proto does not reach (v3lockpb, v3electionpb). Also refused: grpc-js's two
 * calls for a stream in one direction, the only way to send RangeStream or Snapshot, whose answers stream alone, and
 * its three constructors of a service client, whose methods carry every RPC of a service under a lower-camel-case
 * name as well (`put`, `memberAdd`), which no name check can tell from the adapter's own words.
 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  ...rpcsOf("forbidden").map((rpc) => rpc.split("/")[1]),
  "Lock",
  "Unlock",
  "Campaign",
  "Proclaim",
  "Leader",
  "Observe",
  "Resign",
  "makeServerStreamRequest",
  "makeClientStreamRequest",
  "loadPackageDefinition",
  "makeClientConstructor",
  "makeGenericClientConstructor",
]);
const RPC_TEXT = /^[A-Z][A-Za-z]*\/[A-Z][A-Za-z]*$/;

function rpcNameFindings(text: string): string[] {
  const allowed = new Set([...rpcsOf("read"), ...rpcsOf("write")]);
  const findings: string[] = [];
  for (const { text: written, isString, line } of spellings(parse("grpc-client.ts", text))) {
    const at = `RPC names: grpc-client.ts:${line}`;
    if (FORBIDDEN_NAMES.has(written)) findings.push(`${at} names ${written}, which spec E11 forbids`);
    if (!isString) continue;
    if (RPC_TEXT.test(written) && !allowed.has(written)) {
      findings.push(`${at} names the RPC ${written}, which is not on spec E11's allowlist`);
    }
    if (/v3lockpb|v3electionpb/.test(written)) {
      findings.push(`${at} names the Lock or Election service, which spec E11 forbids`);
    }
    if (written.includes("/etcdserverpb.")) {
      findings.push(`${at} writes a method path by hand, where the adapter takes each from the descriptor`);
    }
  }
  return findings;
}

// -- spec E11: the 42 RPCs, the allowlist and the seam ----------------------------------------------------------------

interface DescriptorNamespace {
  readonly nested?: Readonly<Record<string, DescriptorNamespace>>;
  readonly methods?: Readonly<Record<string, unknown>>;
}

/**
 * Every RPC of the descriptor, read as a file (spec 3.2): an etcdserverpb service's as "<Service>/<Method>", any
 * other package's with the package's name, so an RPC outside etcdserverpb can never match a classified one.
 */
function descriptorRpcs(text: string): string[] {
  const source = parse("descriptor.ts", text);
  let literal: string | undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const [declaration] = statement.declarationList.declarations;
    const initializer = declaration.initializer;
    if (declaration.name.getText(source) === "ETCD_DESCRIPTOR" && initializer !== undefined) {
      if (!ts.isAsExpression(initializer)) throw new Error("ETCD_DESCRIPTOR is not an asserted literal");
      literal = initializer.expression.getText(source);
    }
  }
  if (literal === undefined) throw new Error("proto/descriptor.ts declares no ETCD_DESCRIPTOR");
  const rpcs: string[] = [];
  const walk = (namespace: DescriptorNamespace, path: readonly string[]) => {
    for (const [name, child] of Object.entries(namespace.nested ?? {})) {
      if (child.methods !== undefined) {
        const service = path.join(".") === "etcdserverpb" ? name : [...path, name].join(".");
        for (const method of Object.keys(child.methods)) rpcs.push(`${service}/${method}`);
      }
      walk(child, [...path, name]);
    }
  };
  walk(JSON.parse(literal) as DescriptorNamespace, []);
  return rpcs.sort();
}

function classificationFindings(rpcs: readonly string[]): string[] {
  const classified = Object.keys(RPC_CLASSES);
  return [
    ...rpcs
      .filter((rpc) => !classified.includes(rpc))
      .map((rpc) => `RPC classification: ${rpc} is in the descriptor and not classified as read, write or forbidden`),
    ...classified
      .filter((rpc) => !rpcs.includes(rpc))
      .map((rpc) => `RPC classification: ${rpc} is classified and not in the descriptor`),
  ];
}

/** An expression without the `as const` and `satisfies` around the literal it writes. */
function unwrapped(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrapped(node.expression)
    : node;
}

/** ETCD_ALLOWLISTED_RPCS and the two RPC unions, as grpc-client.ts writes them. */
function adapterLists(text: string): { readonly allowlist: string[]; readonly unions: string[] } {
  const sf = parse("grpc-client.ts", text);
  let allowlist: string[] | undefined;
  const unions: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(sf) !== "ETCD_ALLOWLISTED_RPCS" || declaration.initializer === undefined) continue;
        const list = unwrapped(declaration.initializer);
        if (!ts.isArrayLiteralExpression(list)) throw new Error("ETCD_ALLOWLISTED_RPCS is not an array literal");
        allowlist = list.elements.map((element) => {
          const rpc = plainString(element);
          if (rpc === undefined) throw new Error(`ETCD_ALLOWLISTED_RPCS holds ${element.getText(sf)}, not a string`);
          return rpc;
        });
      }
    }
    if (ts.isTypeAliasDeclaration(statement) && ["EtcdUnaryRpc", "EtcdStreamRpc"].includes(statement.name.text)) {
      const members = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type];
      for (const member of members) {
        if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) unions.push(member.literal.text);
      }
    }
  }
  if (allowlist === undefined) throw new Error("grpc-client.ts declares no ETCD_ALLOWLISTED_RPCS");
  return { allowlist, unions };
}

function allowlistFindings(text: string): string[] {
  const { allowlist, unions } = adapterLists(text);
  const allowed = [...rpcsOf("read"), ...rpcsOf("write")];
  return [
    ...allowlist
      .filter((rpc) => !allowed.includes(rpc))
      .map((rpc) =>
        RPC_CLASSES[rpc] === "forbidden"
          ? `allowlist: ${rpc} is on ETCD_ALLOWLISTED_RPCS, and spec E11 forbids it`
          : `allowlist: ${rpc} is on ETCD_ALLOWLISTED_RPCS, and is not one of the 42 RPCs`,
      ),
    ...allowed
      .filter((rpc) => !allowlist.includes(rpc))
      .map((rpc) => `allowlist: ${rpc} is classified ${RPC_CLASSES[rpc]}, and is not on ETCD_ALLOWLISTED_RPCS`),
    ...unions
      .filter((rpc) => !allowlist.includes(rpc))
      .map((rpc) => `allowlist: EtcdUnaryRpc or EtcdStreamRpc names ${rpc}, which ETCD_ALLOWLISTED_RPCS does not`),
    ...allowlist
      .filter((rpc) => !unions.includes(rpc))
      .map(
        (rpc) => `allowlist: ${rpc} is on ETCD_ALLOWLISTED_RPCS, and neither EtcdUnaryRpc nor EtcdStreamRpc names it`,
      ),
  ];
}

/** The RPC each method of the seam sends (spec E11), `close()` none; a method added to the seam fails until listed. */
const SEAM_RPCS: Readonly<Record<string, readonly string[]>> = {
  range: ["KV/Range"],
  deleteRange: ["KV/DeleteRange"],
  txn: ["KV/Txn"],
  watch: ["Watch/Watch"],
  leaseGrant: ["Lease/LeaseGrant"],
  leaseRevoke: ["Lease/LeaseRevoke"],
  leaseKeepAliveOnce: ["Lease/LeaseKeepAlive"],
  leaseTimeToLive: ["Lease/LeaseTimeToLive"],
  leaseLeases: ["Lease/LeaseLeases"],
  memberList: ["Cluster/MemberList"],
  status: ["Maintenance/Status"],
  alarmList: ["Maintenance/Alarm"],
  alarmDisarm: ["Maintenance/Alarm"],
  compact: ["KV/Compact"],
  defragment: ["Maintenance/Defragment"],
  authStatus: ["Auth/AuthStatus"],
  authenticate: ["Auth/Authenticate"],
  userList: ["Auth/UserList"],
  userGet: ["Auth/UserGet"],
  roleList: ["Auth/RoleList"],
  roleGet: ["Auth/RoleGet"],
  close: [],
};

function seamFindings(methods: readonly string[]): string[] {
  const sent = new Set(methods.flatMap((method) => SEAM_RPCS[method] ?? []));
  return [
    ...methods
      .filter((method) => SEAM_RPCS[method] === undefined)
      .map((method) => `seam methods: ${method} is on the seam, and sends no RPC spec E11 allows`),
    ...Object.keys(SEAM_RPCS)
      .filter((method) => !methods.includes(method))
      .map((method) => `seam methods: ${method} is spec E11's, and is not on the seam`),
    ...[...rpcsOf("read"), ...rpcsOf("write")]
      .filter((rpc) => !sent.has(rpc))
      .map((rpc) => `seam methods: ${rpc} is allowed, and no seam method sends it`),
  ];
}

// -- spec E11: every write is one E6 knows and one surface gates -----------------------------------------------------

/** An editor command that sends a write RPC, with the class and Gate spec 5.1.3 gives it. */
interface EditorWrite {
  readonly rpc: string;
  readonly text: string;
  readonly destructive: boolean;
  readonly gate: "none" | "one-click" | "typed";
  /** The typed text of spec 5.5, for a typed gate. */
  readonly typed?: string;
}

const EDITOR_WRITES: readonly EditorWrite[] = [
  { rpc: "KV/DeleteRange", text: "del /app/ --prefix", destructive: true, gate: "typed", typed: "/app/" },
  { rpc: "KV/DeleteRange", text: "del /app/a /app/z", destructive: true, gate: "typed", typed: "/app/a" },
  // A --from-key delete runs to the end of the key space, so this one starts past every protected root of E8.
  { rpc: "KV/DeleteRange", text: "del zz --from-key", destructive: true, gate: "typed", typed: "zz" },
  // A top-level single-key put or del is E8's guarded Txn.
  { rpc: "KV/Txn", text: "put /app/cfg v", destructive: false, gate: "one-click" },
  { rpc: "KV/Txn", text: "del /app/cfg", destructive: false, gate: "one-click" },
  { rpc: "KV/Txn", text: "txn\n\nput /app/cfg v\n\n", destructive: false, gate: "one-click" },
  { rpc: "KV/Txn", text: "txn\n\ndel /app/ --prefix\n\n", destructive: true, gate: "typed", typed: "/app/" },
  { rpc: "Lease/LeaseGrant", text: "lease grant 60", destructive: false, gate: "none" },
  {
    rpc: "Lease/LeaseRevoke",
    text: "lease revoke 694d8147df1dc4c8",
    destructive: true,
    gate: "typed",
    typed: "694d8147df1dc4c8",
  },
  { rpc: "Lease/LeaseKeepAlive", text: "lease keep-alive --once 694d8147df1dc4c8", destructive: false, gate: "none" },
];

/** The parse limits of a caller with no connection, as the confirmation gate parses (C2's EtcdParseLimits). */
const NO_CAPS = {
  maxLimit: Number.POSITIVE_INFINITY,
  txnRangeLimit: Number.POSITIVE_INFINITY,
  maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
  maxWatchWindowMs: Number.POSITIVE_INFINITY,
};

function assessText(text: string): CommandAssessment | string {
  const parsed = parseEtcdCommand(text, NO_CAPS);
  return parsed.ok ? assessCommand(parsed.parsed.command) : parsed.refusal.message;
}

function editorWriteFindings(
  rows: readonly EditorWrite[],
  assess: (text: string) => CommandAssessment | string,
  refuse: typeof refuseBeforeSend,
): string[] {
  const findings: string[] = [];
  for (const row of rows) {
    const named = `editor writes: ${JSON.stringify(row.text)} (${row.rpc})`;
    const assessment = assess(row.text);
    if (typeof assessment === "string") {
      findings.push(`${named} does not parse: ${assessment}`);
      continue;
    }
    const typed = row.typed === undefined ? undefined : { type: "text", text: row.typed };
    const found = {
      class: assessment.class,
      destructive: assessment.destructive,
      gate: assessment.gate,
      typed: assessment.typedConfirmation,
    };
    const expected = { class: "write", destructive: row.destructive, gate: row.gate, typed };
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      findings.push(
        `${named} is ${JSON.stringify(found)} in guard.ts, and spec 5.1.3 says ${JSON.stringify(expected)}`,
      );
    }
    if (refuse(assessment, { readOnly: "connection" })?.reason !== "read-only") {
      findings.push(`${named} is not refused by E6 on a read-only connection`);
    }
    if (refuse(assessment, {}) !== undefined) findings.push(`${named} is refused on a read-write connection`);
  }
  return findings;
}

/**
 * Each maintenance RPC, the card maintenance.ts declares for it, the label spec 7.2 gives that card, and the words
 * the editor refuses for it (spec E7).
 */
interface MaintenanceCard {
  readonly rpc: string;
  /** The operation whose card maintenance.ts declares in ETCD_MAINTENANCE_SPECS. */
  readonly operation: keyof typeof ETCD_MAINTENANCE_SPECS;
  /**
   * The card's label in spec 7.2's table: the label maintenance.ts declares the card under, and the one the editor's
   * refusal of the words points at by name.
   */
  readonly card: string;
  readonly words: readonly string[];
}

const MAINTENANCE_CARDS: readonly MaintenanceCard[] = [
  { rpc: "KV/Compact", operation: "compact", card: "Compact history", words: ["compaction"] },
  { rpc: "Maintenance/Defragment", operation: "defragment", card: "Defragment", words: ["defrag"] },
  { rpc: "Maintenance/Alarm", operation: "disarm", card: "Disarm alarms", words: ["alarm", "disarm"] },
];

function maintenanceFindings(
  cards: readonly MaintenanceCard[],
  refused: typeof ETCD_REFUSED_COMMANDS,
  refuse: typeof refuseReadOnly,
  parse: typeof parseEtcdCommand,
  specs: typeof ETCD_MAINTENANCE_SPECS,
): string[] {
  const findings: string[] = [];
  for (const { rpc, operation, card, words } of cards) {
    const named = `maintenance cards: ${words.join(" ")} (${rpc})`;
    const entry = refused.find((candidate) => candidate.words.join(" ") === words.join(" "));
    if (entry === undefined) {
      findings.push(`${named} is not refused by name in the editor (spec E7)`);
    } else if (entry.code !== "maintenance-command" || !entry.message.includes(`the ${card} card`)) {
      findings.push(`${named} is refused without pointing at the ${card} card of spec 7.2: ${entry.message}`);
    }
    const parsed = parse(words.join(" "), NO_CAPS);
    if (parsed.ok || parsed.refusal.code !== "maintenance-command") {
      findings.push(`${named} is not refused as a maintenance command by the parser`);
    }
    const spec = specs[operation];
    if (spec === undefined) {
      findings.push(`${named} has no declared card in maintenance.ts (spec 7.2)`);
    } else {
      const found = {
        label: spec.label,
        global: spec.global,
        perEntity: spec.perEntity,
        confirmation: spec.confirmation,
      };
      const expected = { label: card, global: true, perEntity: false, confirmation: "typed" };
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        findings.push(
          `${named} is declared as ${JSON.stringify(found)} in maintenance.ts, and spec 7.2 says ${JSON.stringify(expected)}`,
        );
      }
    }
  }
  if (refuse({ readOnly: "connection" })?.reason !== "read-only") {
    findings.push("maintenance cards: a maintenance operation is not refused by E6 on a read-only connection");
  }
  return findings;
}

/** Every write RPC is gated: an editor command's class and Gate, or a maintenance card (spec E11). */
function writeCoverageFindings(classes: Readonly<Record<string, RpcClass>>): string[] {
  const gated = new Set([...EDITOR_WRITES.map((row) => row.rpc), ...MAINTENANCE_CARDS.map((card) => card.rpc)]);
  return [
    ...rpcsOf("write", classes)
      .filter((rpc) => !gated.has(rpc))
      .map((rpc) => `write coverage: ${rpc} is a write that no editor command or maintenance card gates`),
    ...[...gated]
      .filter((rpc) => classes[rpc] !== "write")
      .map((rpc) => `write coverage: ${rpc} is gated as a write, and classified ${classes[rpc] ?? "nowhere"}`),
  ];
}

// -- the guard over the repository -----------------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("spec E11: who may import the client packages, the descriptor and its generator", () => {
  test.each(IMPORT_RULES.map((rule) => [rule.name, rule] as const))(
    "%s: exactly the files spec E11 names",
    (_name, rule) => {
      expect(importRuleFindings(rule, ROOT)).toEqual([]);
    },
  );

  test("the detector reads real code: each named file holds its rule, and the lists overlap as E11 says", () => {
    const files = filesOf(ROOT);
    const holding = (rule: ImportRule) =>
      files.filter((file) => !heldByAnotherGuard(file.path) && rule.holds(file, ROOT)).map((file) => file.path);
    expect(holding(IMPORT_RULES[0])).toEqual([...IMPORT_RULES[0].named].sort());
    expect(files.length).toBeGreaterThan(1000);
    // The evidence harness builds its definition from the generator, never from an import of the descriptor.
    expect(IMPORT_RULES[1].named).not.toContain(HARNESS);
  });
});

describe("spec 3.1: the pure set imports only what 3.1 allows", () => {
  test("every member of the pure set that exists holds the rule, and Tasks 8 to 10's eight all exist", () => {
    const members = pureMembers(ROOT);
    expect(members).toEqual(expect.arrayContaining(PURE_SET.filter((member) => member !== "monitoring.ts")));
    expect(members.flatMap((member) => pureSetFindings(member, read(`${ETCD_PATH}/${member}`), ROOT))).toEqual([]);
  });

  test("the detector reads real code: keys.ts takes types from client.ts, and write-policy.ts imports guard.ts", () => {
    const references = (member: string) =>
      moduleReferences(parse(member, read(`${ETCD_PATH}/${member}`))).map(({ specifier, typeOnly }) => ({
        specifier,
        typeOnly,
      }));
    expect(references("keys.ts")).toContainEqual({ specifier: "./client", typeOnly: true });
    expect(references("write-policy.ts")).toContainEqual({ specifier: "./guard", typeOnly: true });
  });
});

describe("the provider directory: plain module names, and no require (spec E11)", () => {
  test("every file of the provider directory names its modules as plain strings", () => {
    const files = filesOf(ROOT).filter((file) => file.path.startsWith(`${ETCD_PATH}/`));
    expect(files.map((file) => file.path)).toContain(ADAPTER);
    expect(files.flatMap((file) => moduleNameFindings(file.path, file.sf.text))).toEqual([]);
  });
});

describe("spec E11: the adapter's alarm actions and RPC names", () => {
  const adapter = read(ADAPTER);

  test("the adapter sends Alarm only as GET or DEACTIVATE, and never names ACTIVATE", () => {
    expect(alarmActionFindings(adapter)).toEqual([]);
    // The detector reads real code: the adapter writes both actions it may.
    const actions = spellings(parse("grpc-client.ts", adapter)).filter(
      ({ text, isString }) => isString && ALARM_ACTIONS.has(text),
    );
    expect(new Set(actions.map(({ text }) => text))).toEqual(new Set(["GET", "DEACTIVATE"]));
  });

  test("the adapter names no RPC off the allowlist, and no forbidden method", () => {
    expect(rpcNameFindings(adapter)).toEqual([]);
  });
});

describe("spec E11: the 42 RPCs of rpc.proto, the allowlist and the seam", () => {
  test("the classification holds 42 RPCs, 20 of them allowed and 22 forbidden, equal to the descriptor's services", () => {
    const rpcs = descriptorRpcs(read(DESCRIPTOR));
    expect(rpcs).toHaveLength(42);
    expect(classificationFindings(rpcs)).toEqual([]);
    expect([rpcsOf("read").length, rpcsOf("write").length, rpcsOf("forbidden").length]).toEqual([12, 8, 22]);
  });

  test("ETCD_ALLOWLISTED_RPCS is exactly the read and write classes, in spec E11's order, and so are the RPC unions", () => {
    const adapter = read(ADAPTER);
    expect(allowlistFindings(adapter)).toEqual([]);
    expect(adapterLists(adapter).allowlist).toEqual([
      "KV/Range",
      "KV/DeleteRange",
      "KV/Txn",
      "Watch/Watch",
      "Lease/LeaseGrant",
      "Lease/LeaseRevoke",
      "Lease/LeaseKeepAlive",
      "Lease/LeaseTimeToLive",
      "Lease/LeaseLeases",
      "Cluster/MemberList",
      "Maintenance/Status",
      "Maintenance/Alarm",
      "KV/Compact",
      "Maintenance/Defragment",
      "Auth/AuthStatus",
      "Auth/Authenticate",
      "Auth/UserList",
      "Auth/UserGet",
      "Auth/RoleList",
      "Auth/RoleGet",
    ]);
  });

  test("the seam's methods send only allowed RPCs, and no method sends Put", () => {
    expect(seamFindings(ETCD_CLIENT_METHODS)).toEqual([]);
    expect(ETCD_CLIENT_METHODS).not.toContain("put");
    expect(RPC_CLASSES["KV/Put"]).toBe("forbidden");
  });
});

describe("spec E11: every write the adapter can send is one E6 knows and one surface gates", () => {
  test("each editor write RPC is tied to its class and Gate in guard.ts, and E6 refuses it on a read-only connection", () => {
    expect(editorWriteFindings(EDITOR_WRITES, assessText, refuseBeforeSend)).toEqual([]);
  });

  test("each maintenance RPC is tied to its card of 7.2: refused by name in the editor and its parser, and by E6 when read-only", () => {
    expect(
      maintenanceFindings(
        MAINTENANCE_CARDS,
        ETCD_REFUSED_COMMANDS,
        refuseReadOnly,
        parseEtcdCommand,
        ETCD_MAINTENANCE_SPECS,
      ),
    ).toEqual([]);
  });

  test("every write RPC is gated by an editor command or a maintenance card, and nothing else is", () => {
    expect(writeCoverageFindings(RPC_CLASSES)).toEqual([]);
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
  const home = mkdtempSync(join(tmpdir(), "etcd-seam-guard-"));
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

/** Each import rule's named files, each holding the rule, as a planted repository starts. */
const HOLDING: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "@grpc/grpc-js importers": Object.fromEntries(
    [HARNESS, ADAPTER_TEST, TLS_TEST].map((path) => [path, `import * as grpc from "${GRPC_JS}";\n`]),
  ),
  "descriptor importers": {
    [DESCRIPTOR]: "export const ETCD_DESCRIPTOR = {};\n",
    [ADAPTER]: 'import { ETCD_DESCRIPTOR } from "./proto/descriptor";\n',
    [ADAPTER_TEST]: 'import { ETCD_DESCRIPTOR } from "@/lib/db/providers/keyvalue/etcd/proto/descriptor";\n',
    [TLS_TEST]: 'import { ETCD_DESCRIPTOR } from "@/lib/db/providers/keyvalue/etcd/proto/descriptor";\n',
  },
  "descriptor readers": Object.fromEntries(
    [GENERATOR, DESCRIPTOR_TEST, WIRE_FIELDS_TEST, THIS_FILE].map((path) => [
      path,
      'const file = join(dir, "proto", "descriptor.ts");\n',
    ]),
  ),
  "@grpc/proto-loader importers": Object.fromEntries(
    [ADAPTER, HARNESS, ADAPTER_TEST, TLS_TEST, DESCRIPTOR, GENERATOR, DESCRIPTOR_TEST].map((path) => [
      path,
      `import { fromJSON } from "${PROTO_LOADER}";\n`,
    ]),
  ),
  "generator importers": {
    [GENERATOR]: "export function loadEtcdDescriptor() {}\n",
    [HARNESS]: 'import { loadEtcdDescriptor } from "../../scripts/generate-etcd-descriptor.mjs";\n',
    [DESCRIPTOR_TEST]: 'import { loadEtcdDescriptor } from "../../../../scripts/generate-etcd-descriptor.mjs";\n',
  },
};

const ruleNamed = (name: string) => {
  const rule = IMPORT_RULES.find((candidate) => candidate.name === name);
  if (rule === undefined) throw new Error(`No import rule is named ${name}`);
  return rule;
};

describe("planted violations: spec E11's import lists fail by name", () => {
  test.each(IMPORT_RULES.map((rule) => rule.name))("%s: the named files alone pass", (name) => {
    expect(inPlantedRepository(HOLDING[name], (root, env) => importRuleFindings(ruleNamed(name), root, env))).toEqual(
      [],
    );
  });

  const STRAY = "tests/unit/db/etcd/stray.test.ts";
  test.each([
    [
      "@grpc/grpc-js importers",
      { [STRAY]: `import { Client } from "${GRPC_JS}";\n` },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      {
        "src/lib/db/providers/keyvalue/etcd/index.ts": `const grpc = await import("${GRPC_JS}/build/src/index.js");\n`,
      },
      "@grpc/grpc-js importers: src/lib/db/providers/keyvalue/etcd/index.ts imports @grpc/grpc-js, and spec E11 does not name it",
    ],
    [
      "@grpc/grpc-js importers",
      { [STRAY]: `const grpc = require("${GRPC_JS}");\n` },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      { [STRAY]: `export * from "${GRPC_JS}";\n` },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      { [STRAY]: `import grpc = require("${GRPC_JS}");\n` },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      { [STRAY]: `const g = module.require("${GRPC_JS}");\n` },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      { [STRAY]: `const g = createRequire(import.meta.url)("${GRPC_JS}");\n` },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      // A path into the package's directory loads it as surely as the package's name does.
      {
        [`node_modules/${GRPC_JS}/index.js`]: "module.exports = {};\n",
        [STRAY]: `import * as grpc from "../../../../node_modules/${GRPC_JS}/index.js";\n`,
      },
      `@grpc/grpc-js importers: ${STRAY} imports @grpc/grpc-js, and spec E11 does not name it`,
    ],
    [
      "@grpc/grpc-js importers",
      { [TLS_TEST]: "export {};\n" },
      `@grpc/grpc-js importers: ${TLS_TEST} is named, and no longer imports @grpc/grpc-js`,
    ],
    [
      "descriptor importers",
      { "src/lib/db/providers/keyvalue/etcd/index.ts": 'import { ETCD_DESCRIPTOR } from "./proto/descriptor";\n' },
      `descriptor importers: src/lib/db/providers/keyvalue/etcd/index.ts imports ${DESCRIPTOR}, and spec E11 does not name it`,
    ],
    [
      "descriptor importers",
      {
        [STRAY]:
          'type Descriptor = typeof import("../../../../src/lib/db/providers/keyvalue/etcd/proto/descriptor");\n',
      },
      `descriptor importers: ${STRAY} imports ${DESCRIPTOR}, and spec E11 does not name it`,
    ],
    [
      "descriptor readers",
      { [STRAY]: 'const text = readFileSync("src/lib/db/providers/keyvalue/etcd/proto/descriptor.ts", "utf8");\n' },
      `descriptor readers: ${STRAY} names the file of the descriptor, and spec E11 does not name it`,
    ],
    [
      "descriptor readers",
      { [WIRE_FIELDS_TEST]: "export {};\n" },
      `descriptor readers: ${WIRE_FIELDS_TEST} is named, and no longer names the file of the descriptor`,
    ],
    [
      "@grpc/proto-loader importers",
      { [STRAY]: `import { fromJSON } from "${PROTO_LOADER}";\n` },
      `@grpc/proto-loader importers: ${STRAY} imports @grpc/proto-loader, and spec E11 does not name it`,
    ],
    [
      "generator importers",
      { [STRAY]: 'import { loadEtcdDescriptor } from "../../../../scripts/generate-etcd-descriptor.mjs";\n' },
      `generator importers: ${STRAY} imports ${GENERATOR}, and spec E11 does not name it`,
    ],
  ] as const)("%s: %j planted fails by name", (name, planted, finding) => {
    expect(
      inPlantedRepository({ ...HOLDING[name], ...planted }, (root, env) =>
        importRuleFindings(ruleNamed(name), root, env),
      ),
    ).toEqual([finding]);
  });

  test("a named file removed from the repository fails by name", () => {
    const rest = Object.fromEntries(
      Object.entries(HOLDING["@grpc/grpc-js importers"]).filter(([path]) => path !== ADAPTER_TEST),
    );
    expect(
      inPlantedRepository(rest, (root, env) => importRuleFindings(ruleNamed("@grpc/grpc-js importers"), root, env)),
    ).toEqual([`@grpc/grpc-js importers: ${ADAPTER_TEST} is named, and is not in the repository`]);
  });

  test("the Milvus provider's files are the Milvus seam guard's, while any other stray still fails by name", () => {
    const milvusFiles = {
      "src/lib/db/providers/vector/milvus/grpc-client.ts": `import * as grpc from "${GRPC_JS}";\n`,
      "tests/live/milvus-evidence.ts": `import * as grpc from "${GRPC_JS}";\n`,
      "tests/unit/db/milvus/grpc-client.test.ts": `import * as grpc from "${GRPC_JS}";\n`,
      "tests/helpers/milvus-wire.ts": `import * as grpc from "${GRPC_JS}";\n`,
      "scripts/generate-milvus-descriptor.mjs": `import "${PROTO_LOADER}";\n`,
    };
    const findings = (name: string, planted: Readonly<Record<string, string>>) =>
      inPlantedRepository({ ...HOLDING[name], ...planted }, (root, env) =>
        importRuleFindings(ruleNamed(name), root, env),
      );
    expect(findings("@grpc/grpc-js importers", milvusFiles)).toEqual([]);
    expect(findings("@grpc/proto-loader importers", milvusFiles)).toEqual([]);
    expect(
      findings("descriptor readers", {
        "tests/unit/db/milvus/wire-fields.test.ts": 'const file = join(dir, "proto", "descriptor.ts");\n',
      }),
    ).toEqual([]);
    // A provider directory beside Milvus's is no one else's: the rule still names it.
    const stray = "src/lib/db/providers/vector/qdrant/transport.ts";
    expect(findings("@grpc/grpc-js importers", { [stray]: `import * as grpc from "${GRPC_JS}";\n` })).toEqual([
      `@grpc/grpc-js importers: ${stray} imports @grpc/grpc-js, and spec E11 does not name it`,
    ]);
  });

  test("the shared transport's files are the transport guard's", () => {
    const findings = (name: string, planted: Readonly<Record<string, string>>) =>
      inPlantedRepository({ ...HOLDING[name], ...planted }, (root, env) =>
        importRuleFindings(ruleNamed(name), root, env),
      );
    expect(
      findings("@grpc/grpc-js importers", {
        "src/lib/db/grpc/channel.ts": `import * as grpc from "${GRPC_JS}";\n`,
        "tests/unit/db/grpc/channel.test.ts": `import * as grpc from "${GRPC_JS}";\n`,
      }),
    ).toEqual([]);
    expect(
      findings("@grpc/proto-loader importers", {
        "src/lib/db/grpc/channel.ts": `import type { PackageDefinition } from "${PROTO_LOADER}";\n`,
      }),
    ).toEqual([]);
  });
});

describe("planted violations: the text rules fail by name", () => {
  const adapter = read(ADAPTER);
  const plantedIn = (text: string, from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`The planted edit's anchor is not in the file: ${from}`);
    return text.replace(from, to);
  };
  const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split("\n").length;

  test.each([
    [
      "keys.ts",
      'import { EtcdError } from "./client";\n',
      "pure set: keys.ts imports a value from ./client; a pure module takes types, and only types, from client.ts",
    ],
    [
      "guard.ts",
      'import { viewValue } from "./values";\n',
      "pure set: guard.ts is shipped to the browser and imports ./values, a server-side member of the pure set",
    ],
    // Spec 3.1 says none of the four imports a server-side member, so a type counts as well as a value.
    [
      "guard.ts",
      'import type { ValueView } from "./values";\n',
      "pure set: guard.ts is shipped to the browser and imports ./values, a server-side member of the pure set",
    ],
    [
      "keys.ts",
      'import C = require("./client");\n',
      "pure set: keys.ts imports a value from ./client; a pure module takes types, and only types, from client.ts",
    ],
    [
      "values.ts",
      'import { readFileSync } from "node:fs";\n',
      "pure set: values.ts imports node:fs, which spec 3.1 does not allow a pure module",
    ],
    [
      "results.ts",
      'import { toEtcdError } from "./errors";\n',
      "pure set: results.ts imports ./errors, which spec 3.1 does not allow a pure module",
    ],
    [
      "permissions.ts",
      'const values = await import(["./val", "ues"].join(""));\n',
      "pure set: permissions.ts imports a module whose name is not a plain string",
    ],
  ])("pure set: %s with %p fails", (member, planted, finding) => {
    expect(pureSetFindings(member, planted + read(`${ETCD_PATH}/${member}`), ROOT)).toEqual([finding]);
  });

  // Types, and only types, pass from client.ts in the two other forms a type-only load takes.
  test.each([
    ["keys.ts", 'export type { EtcdBytes } from "./client";\n'],
    ["keys.ts", 'import type C = require("./client");\n'],
  ])("pure set: %s with %p passes", (member, planted) => {
    expect(pureSetFindings(member, planted + read(`${ETCD_PATH}/${member}`), ROOT)).toEqual([]);
  });

  test("module names: a computed import() and a require in the provider directory each fail", () => {
    const planted = `${adapter}\nconst name = ["@grpc", "grpc-js"].join("/");\nvoid import(name);\nconst lib = require("./keys");\nconst modes = { require: 1 };\n`;
    const lines = planted.split("\n").length;
    // The last planted line is the control: a key named require, as connection-options.ts's SSL mode table has one.
    expect(moduleNameFindings("grpc-client.ts", planted)).toEqual([
      `module names: grpc-client.ts:${lines - 3} loads a module whose name is not a plain string`,
      `module names: grpc-client.ts:${lines - 2} names require, which loads a module past the plain-string rule`,
    ]);
  });

  test("alarm actions: ACTIVATE and an action of 1 each fail", () => {
    const activated = plantedIn(adapter, 'action: "DEACTIVATE",', 'action: "ACTIVATE",');
    const at = lineOf(activated, 'action: "ACTIVATE",');
    expect(alarmActionFindings(activated)).toEqual([
      `alarm actions: grpc-client.ts:${at} names ACTIVATE, which raises an alarm (spec E11)`,
      `alarm actions: grpc-client.ts:${at} sets action to "ACTIVATE", which is neither GET nor DEACTIVATE (spec E11)`,
    ]);
    const numbered = plantedIn(adapter, '{ action: "GET" }', "{ action: 1 }");
    expect(alarmActionFindings(numbered)).toEqual([
      `alarm actions: grpc-client.ts:${lineOf(numbered, "{ action: 1 }")} sets action to 1, which is neither GET nor DEACTIVATE (spec E11)`,
    ]);
    // The same property under a computed name, a quoted name, a shorthand, an assignment and an indexed assignment.
    const spelled = `${adapter}\nconst a = { ["action"]: 1 };\nconst b = { "action": 1 };\nconst c = { action };\nrequest.action = 1;\nrequest["action"] = 1;\n`;
    const lines = spelled.split("\n").length;
    expect(alarmActionFindings(spelled)).toEqual([
      `alarm actions: grpc-client.ts:${lines - 5} sets action to 1, which is neither GET nor DEACTIVATE (spec E11)`,
      `alarm actions: grpc-client.ts:${lines - 4} sets action to 1, which is neither GET nor DEACTIVATE (spec E11)`,
      `alarm actions: grpc-client.ts:${lines - 3} sets action to a shorthand, which is neither GET nor DEACTIVATE (spec E11)`,
      `alarm actions: grpc-client.ts:${lines - 2} sets action to 1, which is neither GET nor DEACTIVATE (spec E11)`,
      `alarm actions: grpc-client.ts:${lines - 1} sets action to 1, which is neither GET nor DEACTIVATE (spec E11)`,
    ]);
  });

  test("RPC names: a forbidden RPC, a forbidden method, the Lock service and a hand-written path each fail", () => {
    const planted = `${adapter}\nconst put = "KV/Put";\nconst MemberAdd = 1;\nconst lock = "/v3lockpb.Lock/Lock";\nconst path = "/etcdserverpb.KV/Range";\n`;
    const lines = planted.split("\n").length;
    expect(rpcNameFindings(planted)).toEqual([
      `RPC names: grpc-client.ts:${lines - 4} names the RPC KV/Put, which is not on spec E11's allowlist`,
      `RPC names: grpc-client.ts:${lines - 3} names MemberAdd, which spec E11 forbids`,
      `RPC names: grpc-client.ts:${lines - 2} names the Lock or Election service, which spec E11 forbids`,
      `RPC names: grpc-client.ts:${lines - 1} writes a method path by hand, where the adapter takes each from the descriptor`,
    ]);
    const streamed = plantedIn(adapter, "channel.bidiStream(", "channel.makeServerStreamRequest(");
    expect(rpcNameFindings(streamed)).toEqual([
      `RPC names: grpc-client.ts:${lineOf(streamed, "channel.makeServerStreamRequest(")} names makeServerStreamRequest, which spec E11 forbids`,
    ]);
    // A service client answers every RPC under a lower-camel-case name too, so no client may be built from the definition.
    const loader = 'import { fromJSON, type MethodDefinition, type ServiceDefinition } from "@grpc/proto-loader";\n';
    const constructed = plantedIn(adapter, loader, `${loader}import { loadPackageDefinition } from "@grpc/grpc-js";\n`);
    expect(rpcNameFindings(constructed)).toEqual([
      `RPC names: grpc-client.ts:${lineOf(constructed, "import { loadPackageDefinition }")} names loadPackageDefinition, which spec E11 forbids`,
    ]);
  });

  test("RPC classification: an RPC a proto upgrade adds, and one it drops, each fail", () => {
    const rpcs = descriptorRpcs(read(DESCRIPTOR));
    expect(classificationFindings([...rpcs.filter((rpc) => rpc !== "Auth/UserAdd"), "KV/Frobnicate"])).toEqual([
      "RPC classification: KV/Frobnicate is in the descriptor and not classified as read, write or forbidden",
      "RPC classification: Auth/UserAdd is classified and not in the descriptor",
    ]);
    expect(classificationFindings([...rpcs, "v3lockpb.Lock/Lock"])).toEqual([
      "RPC classification: v3lockpb.Lock/Lock is in the descriptor and not classified as read, write or forbidden",
    ]);
  });

  test("allowlist: a forbidden RPC on the list, an allowed one off it, and a union member off it each fail", () => {
    const forbidden = plantedIn(adapter, '  "Auth/RoleGet",\n] as const', '  "Auth/RoleGet",\n  "KV/Put",\n] as const');
    expect(allowlistFindings(forbidden)).toEqual([
      "allowlist: KV/Put is on ETCD_ALLOWLISTED_RPCS, and spec E11 forbids it",
      "allowlist: KV/Put is on ETCD_ALLOWLISTED_RPCS, and neither EtcdUnaryRpc nor EtcdStreamRpc names it",
    ]);
    const dropped = plantedIn(adapter, '  "Auth/RoleGet",\n] as const', "] as const");
    expect(allowlistFindings(dropped)).toEqual([
      "allowlist: Auth/RoleGet is classified read, and is not on ETCD_ALLOWLISTED_RPCS",
      "allowlist: EtcdUnaryRpc or EtcdStreamRpc names Auth/RoleGet, which ETCD_ALLOWLISTED_RPCS does not",
    ]);
  });

  test("seam methods: put back on the seam, and a method left off it, each fail", () => {
    expect(seamFindings([...ETCD_CLIENT_METHODS, "put"])).toEqual([
      "seam methods: put is on the seam, and sends no RPC spec E11 allows",
    ]);
    expect(seamFindings(ETCD_CLIENT_METHODS.filter((method) => method !== "roleGet"))).toEqual([
      "seam methods: roleGet is spec E11's, and is not on the seam",
      "seam methods: Auth/RoleGet is allowed, and no seam method sends it",
    ]);
  });

  test("editor writes: a Gate that no longer matches, a write E6 does not refuse read-only or refuses read-write, and one that does not parse, each fail", () => {
    const [row] = EDITOR_WRITES;
    const oneClick = (text: string) => {
      const assessment = assessText(text);
      return typeof assessment === "string" ? assessment : { ...assessment, gate: "one-click" as const };
    };
    expect(editorWriteFindings([row], oneClick, refuseBeforeSend)).toEqual([
      `editor writes: "del /app/ --prefix" (KV/DeleteRange) is {"class":"write","destructive":true,"gate":"one-click","typed":{"type":"text","text":"/app/"}} in guard.ts, and spec 5.1.3 says {"class":"write","destructive":true,"gate":"typed","typed":{"type":"text","text":"/app/"}}`,
    ]);
    expect(editorWriteFindings([row], assessText, () => undefined)).toEqual([
      'editor writes: "del /app/ --prefix" (KV/DeleteRange) is not refused by E6 on a read-only connection',
    ]);
    const alwaysReadOnly: typeof refuseBeforeSend = (assessment) =>
      refuseBeforeSend(assessment, { readOnly: "connection" });
    expect(editorWriteFindings([row], assessText, alwaysReadOnly)).toEqual([
      'editor writes: "del /app/ --prefix" (KV/DeleteRange) is refused on a read-write connection',
    ]);
    // The parser's own refusal, of a flag the command does not take, stands in for a write that stopped parsing.
    const unparsed = (text: string) => assessText(`${text} --no-such-flag`);
    const refusal = unparsed(row.text);
    if (typeof refusal !== "string") throw new Error(`${row.text} --no-such-flag parses`);
    expect(editorWriteFindings([row], unparsed, refuseBeforeSend)).toEqual([
      `editor writes: "del /app/ --prefix" (KV/DeleteRange) does not parse: ${refusal}`,
    ]);
  });

  test("maintenance cards: a refusal pointing at another card, a word the table no longer refuses, one the parser reads as another command, and E6 letting maintenance through, each fail", () => {
    const moved = ETCD_REFUSED_COMMANDS.map((entry) =>
      entry.words.join(" ") === "compaction"
        ? { ...entry, message: entry.message.replace("the Compact history card", "the Defragment card") }
        : entry,
    );
    const findings = maintenanceFindings(
      MAINTENANCE_CARDS,
      moved,
      refuseReadOnly,
      parseEtcdCommand,
      ETCD_MAINTENANCE_SPECS,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toStartWith(
      "maintenance cards: compaction (KV/Compact) is refused without pointing at the Compact history card of spec 7.2: ",
    );
    expect(
      maintenanceFindings(
        MAINTENANCE_CARDS,
        ETCD_REFUSED_COMMANDS,
        () => undefined,
        parseEtcdCommand,
        ETCD_MAINTENANCE_SPECS,
      ),
    ).toEqual(["maintenance cards: a maintenance operation is not refused by E6 on a read-only connection"]);
    const unrefused = ETCD_REFUSED_COMMANDS.filter((entry) => entry.words.join(" ") !== "compaction");
    expect(
      maintenanceFindings(MAINTENANCE_CARDS, unrefused, refuseReadOnly, parseEtcdCommand, ETCD_MAINTENANCE_SPECS),
    ).toEqual(["maintenance cards: compaction (KV/Compact) is not refused by name in the editor (spec E7)"]);
    // A parser that reads the words as another command: one it accepts, and one it refuses as not offered.
    const parsedAs =
      (words: string, instead: string): typeof parseEtcdCommand =>
      (text, limits) =>
        parseEtcdCommand(text === words ? instead : text, limits);
    expect(
      maintenanceFindings(
        MAINTENANCE_CARDS,
        ETCD_REFUSED_COMMANDS,
        refuseReadOnly,
        parsedAs("compaction", "get /a"),
        ETCD_MAINTENANCE_SPECS,
      ),
    ).toEqual(["maintenance cards: compaction (KV/Compact) is not refused as a maintenance command by the parser"]);
    expect(
      maintenanceFindings(
        MAINTENANCE_CARDS,
        ETCD_REFUSED_COMMANDS,
        refuseReadOnly,
        parsedAs("defrag", "move-leader"),
        ETCD_MAINTENANCE_SPECS,
      ),
    ).toEqual([
      "maintenance cards: defrag (Maintenance/Defragment) is not refused as a maintenance command by the parser",
    ]);
    // A card maintenance.ts does not declare, and one it declares under another label.
    const uncompacted = { ...ETCD_MAINTENANCE_SPECS, compact: undefined };
    expect(
      maintenanceFindings(MAINTENANCE_CARDS, ETCD_REFUSED_COMMANDS, refuseReadOnly, parseEtcdCommand, uncompacted),
    ).toEqual(["maintenance cards: compaction (KV/Compact) has no declared card in maintenance.ts (spec 7.2)"]);
    const relabelled = {
      ...ETCD_MAINTENANCE_SPECS,
      defragment: { ...ETCD_MAINTENANCE_SPECS.defragment!, label: "Defrag" },
    };
    expect(
      maintenanceFindings(MAINTENANCE_CARDS, ETCD_REFUSED_COMMANDS, refuseReadOnly, parseEtcdCommand, relabelled),
    ).toEqual([
      'maintenance cards: defrag (Maintenance/Defragment) is declared as {"label":"Defrag","global":true,"perEntity":false,"confirmation":"typed"} in maintenance.ts, and spec 7.2 says {"label":"Defragment","global":true,"perEntity":false,"confirmation":"typed"}',
    ]);
    // A card that is not global, one declared per entity, and one with a plain confirmation each fail on their own.
    for (const disarm of [
      { ...ETCD_MAINTENANCE_SPECS.disarm!, global: false },
      { ...ETCD_MAINTENANCE_SPECS.disarm!, perEntity: true },
      { ...ETCD_MAINTENANCE_SPECS.disarm!, confirmation: undefined },
    ]) {
      const findings = maintenanceFindings(MAINTENANCE_CARDS, ETCD_REFUSED_COMMANDS, refuseReadOnly, parseEtcdCommand, {
        ...ETCD_MAINTENANCE_SPECS,
        disarm,
      });
      expect(findings).toEqual([
        `maintenance cards: alarm disarm (Maintenance/Alarm) is declared as ${JSON.stringify({ label: disarm.label, global: disarm.global, perEntity: disarm.perEntity, confirmation: disarm.confirmation })} in maintenance.ts, and spec 7.2 says {"label":"Disarm alarms","global":true,"perEntity":false,"confirmation":"typed"}`,
      ]);
    }
  });

  test("write coverage: a write no surface gates, and a gated RPC that is not a write, each fail", () => {
    expect(
      writeCoverageFindings({ ...RPC_CLASSES, "Lease/LeaseFrobnicate": "write", "Lease/LeaseGrant": "read" }),
    ).toEqual([
      "write coverage: Lease/LeaseFrobnicate is a write that no editor command or maintenance card gates",
      "write coverage: Lease/LeaseGrant is gated as a write, and classified read",
    ]);
  });
});

/**
 * Spec 3.1's module table, the provider directory's contents exactly (#1089, spec 3.1): every file the table
 * names and the vendored `proto/` directory, and nothing else, so a module added without its row, or a row
 * whose module was folded into another, fails here by name.
 */
const SPEC_3_1_MODULES: readonly string[] = [
  "client.ts",
  "grpc-client.ts",
  "proto",
  "connection-options.ts",
  "lexer.ts",
  "commands.ts",
  "keys.ts",
  "permissions.ts",
  "guard.ts",
  "write-policy.ts",
  "execute.ts",
  "watch.ts",
  "values.ts",
  "results.ts",
  "objects.ts",
  "edit.ts",
  "key-scan.ts",
  "monitoring.ts",
  "monitoring-reads.ts",
  "maintenance.ts",
  "errors.ts",
  "labels.ts",
  "index.ts",
];

const SPEC_3_1_DIRECTORY = join(import.meta.dir, "../../../../src/lib/db/providers/keyvalue/etcd");

/** Each entry of `directory` the table does not name, then each entry the table names that is missing. */
function moduleTableViolations(directory: string): string[] {
  const present = readdirSync(directory);
  const named = new Set(SPEC_3_1_MODULES);
  return [
    ...present
      .filter((entry) => !named.has(entry))
      .map((entry) => `${entry} is in the provider directory and not in spec 3.1's module table`),
    ...SPEC_3_1_MODULES.filter((entry) => !present.includes(entry)).map(
      (entry) => `${entry} is in spec 3.1's module table and not in the provider directory`,
    ),
  ];
}

describe("the provider directory is spec 3.1's module table (spec 3.1)", () => {
  test("it holds exactly the table's modules and proto/", () => {
    expect(moduleTableViolations(SPEC_3_1_DIRECTORY)).toEqual([]);
    // The control that the read reached the directory: both ends of the table are in it.
    expect(readdirSync(SPEC_3_1_DIRECTORY)).toContain("client.ts");
    expect(readdirSync(SPEC_3_1_DIRECTORY)).toContain("index.ts");
  });

  test("a planted module the table does not name fails by name, and so does a missing one", () => {
    const planted = mkdtempSync(join(tmpdir(), "etcd-module-table-"));
    try {
      for (const entry of SPEC_3_1_MODULES) {
        if (entry === "proto") mkdirSync(join(planted, entry));
        else if (entry !== "labels.ts") writeFileSync(join(planted, entry), "");
      }
      writeFileSync(join(planted, "helpers.ts"), "");
      expect(moduleTableViolations(planted)).toEqual([
        "helpers.ts is in the provider directory and not in spec 3.1's module table",
        "labels.ts is in spec 3.1's module table and not in the provider directory",
      ]);
    } finally {
      rmSync(planted, { recursive: true, force: true });
    }
  });
});
