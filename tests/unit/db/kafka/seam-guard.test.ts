/**
 * Kafka read-only seam guard (spec 3.6 K4).
 *
 * The read-only promise rests on facts this test keeps true: the client library is
 * imported by exactly one provider file, and elsewhere in the repository only by the
 * fixture seed, which no file loads, since its top level writes with the library's
 * Producer; that file declares a fixed, narrow shape of the library's objects; and it
 * calls only read methods on them. It parses every source file under the provider
 * directory from disk, so it holds as the provider grows. Both directions are proven:
 * the detector must fire on a sample that breaks each rule, and stay silent on the real
 * sources. An import counts by what it loads: the package's name, a path, a file URL or a
 * tsconfig alias that reaches the package's files, and a require function called on one,
 * directly, through call or apply, or as a bind fixed it. The adapter and the seed are the
 * files module names resolve to, never files whose names a module name's text spells.
 *
 * The declared shapes are the part tsc enforces: it refuses a member they do not declare,
 * on the adapter's names for its library objects and on every other name typed with a
 * shape. So each shape is pinned member by member, signature included, and the adapter is
 * refused these ways past the shapes: a type assertion or a type predicate other than the
 * ones pinned here, the type any written out, an overload or ambient signature, a class
 * that extends anything, a module or namespace declaration (in every provider file, and a
 * global augmentation of Object or Function in any file of the repository), a computed
 * member of a library object, a constructor or prototype read, which leads to the members
 * of the library's classes, and a comment that switches tsc off. The library reaches the
 * adapter through loadPlatformatic() alone, which is pinned whole, leaves it through the
 * pinned exports alone, and goes from there straight into the adapter's own
 * createPlatformaticClient(); outside the provider, only the pinned test files take it.
 *
 * The guard is syntactic: it fails the build when an ordinary edit reaches the library
 * outside the adapter or calls a member outside the allowlist. Code written to get past it
 * can, in the ways below, which are stated rather than chased, since closing one form of a
 * class leaves the next; the broker-side diff of the live check, the second check K4
 * requires, is what sees their effect on the state it compares (the topic and group lists,
 * every partition's offsets, every group's committed offsets, the topic and broker configs,
 * and the ACLs on kafka-auth) wherever the live check runs such code. What the guard does
 * not refuse: TypeScript typing a value past its shape with no assertion, through an any
 * that a standard-library type answers for a value handed to it (a promise's rejection
 * reason, a Map built without type arguments, the arguments object, eval, and reflection
 * such as Reflect.get, Object.getPrototypeOf or Object.create), through TypeScript's unsound
 * variance, where an array, a mutable property or a method parameter hands the object on
 * under another type, and, in the adapter, through narrowing, where a member of a library
 * object widened to object and found with `in`, or of one handed to a function whose pinned
 * cast types what it holds, such as walk(), is narrowed by a typeof check to a function,
 * whose call then runs it on the object; a library object or class that leaves the adapter
 * through no export, as a global property or a thrown value, and is typed in another
 * provider file by a cast or a type predicate, which the guard pins in the adapter alone; a
 * global augmentation of Object or Function in a declaration tsc reads from a file git does
 * not list, such as one git ignores that tsconfig's include takes in, or a package's own
 * types; a name built at run time by other means than a computed property name (a joined
 * string handed to reflection, Object.fromEntries, Object.assign, Reflect.set, an index
 * write), which can reach any member or set any option through those; a require function
 * reached at run time, module.require and import.meta.require alike, kept in an object or an
 * array or answered by a function and read back, handed in from another file, or reached by
 * reflection; outside the provider, whose files alone are refused a module name that is not
 * a plain string and every call of a require function the guard sees, a module name computed
 * or fixed by a bind that a name then calls; a package that loads the library itself; and
 * text another process runs. The provider may not spell a write or a pinned option as a
 * name, a string or a computed property name.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
/** The provider's directory in the repository, as git lists its files. */
const PROVIDER_PATH = "src/lib/db/providers/stream/kafka";
const PROVIDER_DIR = join(ROOT, PROVIDER_PATH);
const ADAPTER = "platformatic-client.ts";
const LIBRARY = "@platformatic/kafka";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

/** The only files in the repository that may import the library: the adapter, and the fixture seed. */
const IMPORTERS = ["docker/kafka/seed-binary.ts", "src/lib/db/providers/stream/kafka/platformatic-client.ts"];
/**
 * The files outside the provider that take the adapter's loader, loadPlatformatic(), and so the
 * real library: the adapter's own tests, the real TLS handshakes, and the provider's integration
 * test. Another file that imports loadPlatformatic, or the whole adapter module, fails the guard,
 * and so does a file listed here that no longer takes it.
 */
const LOADER_TAKERS = [
  "tests/integration/db/kafka-provider.test.ts",
  "tests/unit/db/kafka/platformatic-client.test.ts",
  "tests/unit/db/kafka/tls-handshake.test.ts",
];
/** The fixture seed, a script whose top level writes records and transactions with the library's Producer. */
const SEED = "docker/kafka/seed-binary.ts";
/**
 * The files that may load the fixture seed: none. It runs from the command line and is never
 * imported, because loading it runs its writes, so a provider file or a test that loaded it would
 * reach the library's write path. A test of the seed itself would be the one file listed here.
 */
const SEED_TAKERS: string[] = [];

/** Members the adapter may call on the library's objects (spec 3.6 K4). */
const ALLOWED = new Set([
  "metadata",
  "listTopics",
  "describeConfigs",
  "listGroups",
  "describeGroups",
  "listConsumerGroupOffsets",
  "listOffsets",
  "listOffsetsWithTimestamps",
  "describeLogDirs",
  "findCoordinator",
  "listApis",
  "close",
  "connect",
  "get",
]);
/** Receivers that hold library objects in the adapter, by the adapter's own naming. */
const LIBRARY_RECEIVERS = new Set(["admin", "consumer", "connection", "fetchPool", "lib"]);
/** The two raw protocol calls the adapter makes, ConsumerGroupDescribe (spec 4.3) and its own Fetch (spec 3.6 K8). */
const RAW_CALLS = new Set(["lib.consumerGroupDescribeV0.api.async", "lib.fetchV13.api.async"]);
const RAW_MODULES = new Set(["consumerGroupDescribeV0", "fetchV13"]);
/** A raw protocol module export: a lower-camel API name ending in its version, such as offsetCommitV9. */
const RAW_MODULE_NAME = /^[a-z][A-Za-z0-9]*V\d+$/;
/**
 * The library shapes the adapter declares, member by member and signature by signature, as
 * the TypeScript printer writes each member with its comments removed. A signature is pinned
 * as well as a name because a type decides what tsc lets through: a `get` that answered a
 * connection with one more member would reach the raw socket with no cast. A change here is
 * a K4 decision.
 */
const DECLARED_SHAPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  PlatformaticLib: {
    Admin: "readonly Admin: new (options: object) => AdminLike;",
    Connection: "readonly Connection: new (clientId: string, options: object) => ConnectionLike;",
    ConnectionPool: "readonly ConnectionPool: new (clientId: string, options: object) => ConnectionPoolLike;",
    Consumer: "readonly Consumer: new (options: object) => ConsumerLike;",
    consumerGroupDescribeV0:
      "readonly consumerGroupDescribeV0: { readonly api: { readonly async: (connection: ConnectionLike, groupIds: string[], includeAuthorizedOperations: boolean) => Promise<unknown>; }; };",
    fetchV13:
      "readonly fetchV13: { readonly api: { readonly async: (connection: ConnectionLike, maxWaitMs: number, minBytes: number, maxBytes: number, isolationLevel: number, sessionId: number, sessionEpoch: number, topics: LibFetchRequestTopic[], forgottenTopicsData: never[], rackId: string) => Promise<LibFetchResponse>; }; };",
  },
  AdminLike: {
    close: "close(): Promise<void>;",
    describeConfigs: "describeConfigs(o: object): Promise<LibConfigResource[]>;",
    describeGroups: "describeGroups(o: object): Promise<Map<string, LibClassicGroup>>;",
    describeLogDirs: "describeLogDirs(o: object): Promise<LibBrokerLogDirs[]>;",
    findCoordinator:
      "findCoordinator(o: object): Promise<Array<{ key: string; nodeId: number; host: string; port: number; }>>;",
    listApis: "listApis(): Promise<Array<{ apiKey: number; name: string; minVersion: number; maxVersion: number; }>>;",
    listConsumerGroupOffsets: "listConsumerGroupOffsets(o: object): Promise<LibGroupOffsets[]>;",
    listGroups:
      "listGroups(o: object): Promise<Map<string, { id: string; state: string; groupType?: string; protocolType: string; }>>;",
    listTopics: "listTopics(o?: object): Promise<string[]>;",
    metadata: "metadata(o: object): Promise<LibMetadata>;",
  },
  ConsumerLike: {
    close: "close(): Promise<void>;",
    listOffsets: "listOffsets(o: object): Promise<Map<string, bigint[]>>;",
    listOffsetsWithTimestamps:
      "listOffsetsWithTimestamps(o: object): Promise<Map<string, Map<number, { offset: bigint; timestamp: bigint; }>>>;",
  },
  ConnectionLike: {
    close: "close(): Promise<void>;",
    connect: "connect(host: string, port: number): Promise<void>;",
  },
  ConnectionPoolLike: {
    close: "close(): Promise<void>;",
    get: "get(broker: { host: string; port: number; }): Promise<ConnectionLike>;",
  },
};
/**
 * loadPlatformatic() as the printer writes it without comments, on one line. It is where the
 * library enters with its own full types and its members are cast to the pinned shapes, so it is
 * pinned whole: a call, an object built, or a library member kept in a name outside it would leave
 * no trace any other rule reads. A change here is a K4 decision.
 */
const PINNED_LOADER =
  'export async function loadPlatformatic(load: () => Promise<typeof import("@platformatic/kafka")> = () => import("@platformatic/kafka")): Promise<PlatformaticLib> { const lib = await load(); const protocolLog = lib.loggers.protocol; if (protocolLog === undefined) throw new Error("@platformatic/kafka no longer exports loggers.protocol; re-check spec 3.6 K3"); protocolLog.enabled = false; return { Admin: lib.Admin as never, Consumer: lib.Consumer as never, Connection: lib.Connection as never, ConnectionPool: lib.ConnectionPool as never, consumerGroupDescribeV0: lib.consumerGroupDescribeV0 as never, fetchV13: lib.fetchV13 as never, }; }';
/**
 * The adapter's type predicates and, outside loadPlatformatic(), its type assertions, as the
 * printer writes each one, and as many times as each is written. Each gives a value a type its
 * expression does not have, which is how a name could reach a member no shape declares, so each
 * is a K4 decision; every one here types a failure, an answer or a plain value, never a library
 * object.
 */
const PINNED_PREDICATES = ["code is string", "id is string", "value is LibRawMetadata"];
const PINNED_CASTS = [
  "(await lib.consumerGroupDescribeV0.api.async(connection, [listing.groupId], false)) as LibGroupDescribeResponse",
  "e.apiId as string",
  "e.errors as unknown[] | undefined",
  "error as Record<string, unknown>",
  "error as { response?: LibGroupDescribeResponse; }",
  "tls.code as string",
  "value as LibRawMetadata",
  "value as LibRawMetadata",
];
/**
 * Write or membership vocabulary that may not appear anywhere in the provider, as a name or as
 * a string. It holds every write of the library's Admin and Consumer, the two Consumer members
 * that ask the broker about the Consumer's own group, the sentinel
 * (dist/clients/consumer/consumer.js: #performFindGroupCoordinator and #listCommittedOffsets send
 * its groupId, and a first coordinator lookup creates __consumer_offsets), and `socket`, a
 * connection's raw transport, which would write any request's bytes.
 */
const FORBIDDEN = [
  "consume",
  "commit",
  "joinGroup",
  "leaveGroup",
  "Producer",
  "createTopics",
  "deleteTopics",
  "createPartitions",
  "alterConfigs",
  "incrementalAlterConfigs",
  "alterConsumerGroupOffsets",
  "deleteConsumerGroupOffsets",
  "deleteRecords",
  "deleteGroups",
  "removeMembersFromConsumerGroup",
  "createAcls",
  "deleteAcls",
  "alterClientQuotas",
  "findGroupCoordinator",
  "listCommittedOffsets",
  "send",
  "socket",
];
/**
 * The installed library's declarations, under dist/, of the classes whose instances the adapter
 * holds and of every library class they extend: each named member is allowed, forbidden or left
 * unused, so a version that adds a member fails the guard until someone classifies it. Which
 * classes these are is itself checked, from the adapter's constructors and each class's heritage.
 */
const LIBRARY_CLASS_FILES = [
  "clients/base/base.d.ts",
  "clients/admin/admin.d.ts",
  "clients/consumer/consumer.d.ts",
  "events.d.ts",
  "network/connection.d.ts",
  "network/connection-pool.d.ts",
];
/**
 * Members of those classes the adapter neither calls nor forbids: reads, state, event listeners
 * and bookkeeping, none of which writes or names a group to the broker (read in the 2.11.0 dist
 * on 2026-09-25; Consumer.getLag asks listOffsets, and takes committed offsets from the Consumer's
 * own streams, in memory; a pool's iterator yields the connections get() hands out).
 */
const UNUSED_MEMBERS = new Set([
  "[Symbol.iterator]",
  "addListener",
  "assignments",
  "clearMetadata",
  "clientId",
  "closed",
  "connectToBrokers",
  "connections",
  "context",
  "coordinatorId",
  "currentMetadata",
  "describeAcls",
  "describeClientQuotas",
  "emitWithDebug",
  "fetch",
  "generationId",
  "getEstablishedConnection",
  "getFirstAvailable",
  "getLag",
  "groupId",
  "groupInstanceId",
  "has",
  "host",
  "instanceId",
  "isActive",
  "isConnected",
  "lastHeartbeat",
  "memberId",
  "off",
  "on",
  "once",
  "ownerId",
  "port",
  "prependListener",
  "prependeOnceListener",
  "ready",
  "reauthenticate",
  "removeAllListeners",
  "removeListener",
  "startLagMonitoring",
  "status",
  "stopLagMonitoring",
  "streamContext",
  "streamsCount",
  "topics",
  "type",
]);
/** The adapter's exports, none of which holds the library: it leaves only as loadPlatformatic()'s pinned answer. */
const ADAPTER_EXPORTS = new Set([
  "KAFKA_SENTINEL_GROUP_ID",
  "PlatformaticLib",
  "createPlatformaticClient",
  "loadPlatformatic",
  "translateError",
]);
/**
 * Options the provider writes as one literal and no other way (spec 3.6 K4, 4.5): any other
 * value lets the broker create a topic, or lets the Consumer keep a KIP-848 group alive.
 */
const PINNED_OPTIONS: ReadonlyMap<string, { literal: string; holds: (value: ts.Expression) => boolean }> = new Map([
  ["autocreateTopics", { literal: "false", holds: (value) => value.kind === ts.SyntaxKind.FalseKeyword }],
  ["groupProtocol", { literal: '"classic"', holds: (value) => ts.isStringLiteral(value) && value.text === "classic" }],
]);
/**
 * Names tsc lets the adapter read off any object or function that lead to the members of the
 * library's classes: an instance's constructor, and a class's prototype, which tsc types any.
 * The other two it allows on a class, arguments and caller, throw on every library class and
 * function under Bun 1.4.2 and Node 24.14.0 (measured on 2026-09-25).
 */
const READS_PAST_THE_SHAPES = new Set(["constructor", "prototype"]);
/** Global interfaces whose augmentation gives every object or function a member its own type does not declare. */
const GLOBAL_TYPES = new Set(["Object", "Function", "CallableFunction", "NewableFunction"]);
/** TypeScript's three comments that switch its checks off for a line or for a file. */
const TSC_DIRECTIVE = /@ts-(?:ignore|expect-error|nocheck)\b/g;
const PRINTER = ts.createPrinter({ removeComments: true });

/** Every source file under a directory and its subdirectories, relative to it with `/` on every platform, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => SOURCE_FILE.test(entry))
    .map((entry) => entry.split("\\").join("/"))
    .sort();
}

function sources(): Array<[string, string]> {
  return filesUnder(PROVIDER_DIR).map((f) => [f, readFileSync(join(PROVIDER_DIR, f), "utf8")]);
}

/**
 * Every source file of the repository at `root`: what git tracks, or would take in because
 * nothing ignores it, and that is in the working tree. Git's own lists, not a list of
 * directories kept here, so a new directory and the root's own files are read too. Git runs in
 * the caller's environment unless `env` gives another.
 */
function repositorySources(root: string, env?: NodeJS.ProcessEnv): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return [...new Set(listed.split("\0"))]
    .filter((path) => SOURCE_FILE.test(path) && existsSync(join(root, path)))
    .sort();
}

/** The repository's source files, each parsed once for every repository-wide check of a run. */
const parsedRepositories = new Map<string, Array<{ path: string; sf: ts.SourceFile }>>();
function repositoryFiles(root: string, env?: NodeJS.ProcessEnv): Array<{ path: string; sf: ts.SourceFile }> {
  let files = parsedRepositories.get(root);
  if (files === undefined) {
    files = repositorySources(root, env).map((path) => ({
      path,
      sf: ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, false),
    }));
    parsedRepositories.set(root, files);
  }
  return files;
}

/** How TypeScript resolves a module name in the repository at `root`: its tsconfig.json's options, when it has one. */
const resolvers = new Map<string, { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }>();
function resolverFor(root: string): { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache } {
  let resolver = resolvers.get(root);
  if (resolver === undefined) {
    const config = join(root, "tsconfig.json");
    const options = existsSync(config)
      ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, root).options
      : { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
    resolver = { options, cache: ts.createModuleResolutionCache(root, (name) => name, options) };
    resolvers.set(root, resolver);
  }
  return resolver;
}

/**
 * A file's one name: symlinks followed and letter case as the file system holds it (the native
 * realpath, since Windows and macOS compare names without case), with `/` separators.
 */
function canonical(path: string): string {
  return realpathSync.native(path).split("\\").join("/");
}

/** The file a module name written in `containing` resolves to, by its canonical name. */
function resolvedFile(specifier: string, containing: string, root: string): string | undefined {
  const { options, cache } = resolverFor(root);
  const resolved = ts.resolveModuleName(specifier, containing, options, ts.sys, cache).resolvedModule;
  return resolved === undefined ? undefined : canonical(resolved.resolvedFileName);
}

/**
 * Whether a path lies inside the library's own package: under a node_modules directory named for
 * it, or in a package whose manifest gives its name, which an aliased install does.
 */
function inLibraryPackage(path: string): boolean {
  const normalized = path.split("\\").join("/");
  if (`${normalized}/`.includes(`/node_modules/${LIBRARY}/`)) return true;
  const at = normalized.lastIndexOf("/node_modules/");
  if (at < 0) return false;
  const segments = normalized.slice(at + "/node_modules/".length).split("/");
  const name = segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  const manifest = join(normalized.slice(0, at), "node_modules", name, "package.json");
  return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === LIBRARY;
}

/**
 * Whether a module name written in `containing` loads the library: it names the package, or what
 * it names lies inside the package, as TypeScript resolves it (a relative or absolute path, a
 * tsconfig alias, an aliased install) or, for a path or a file URL, as it is written.
 */
function loadsLibrary(specifier: string, containing: string, root: string): boolean {
  if (specifier === LIBRARY || specifier.startsWith(`${LIBRARY}/`)) return true;
  const resolved = resolvedFile(specifier, containing, root);
  if (resolved !== undefined && inLibraryPackage(resolved)) return true;
  const written = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : specifier.startsWith(".") || isAbsolute(specifier)
      ? resolve(dirname(containing), specifier)
      : undefined;
  return written !== undefined && inLibraryPackage(written);
}

/**
 * Whether a module name written in `containing` names the file at `target`: TypeScript resolves it
 * there, or it is a file URL of it, the one spelling of a file TypeScript resolves to nothing.
 */
function resolvesTo(specifier: string, containing: string, root: string, target: string): boolean {
  if (resolvedFile(specifier, containing, root) === canonical(target)) return true;
  const written = specifier.startsWith("file:") ? fileURLToPath(specifier) : undefined;
  return written !== undefined && existsSync(written) && canonical(written) === canonical(target);
}

/** The leftmost identifier of `a.b.c(...)`, `a[b]`, `new a.B()`, `await a.b()` or `(a as T)`. */
function receiverRoot(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node)
  )
    return receiverRoot(node.expression);
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  )
    return receiverRoot(node.expression);
  return undefined;
}

/** The name a member is read off: `x` in `x.m` and in `y.x.m`. */
function receiverName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

/** An expression without the parentheses, assertions and comma operators around what it evaluates to. */
function bare(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return bare(node.expression);
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken ? bare(node.right) : node;
}

/** The member an expression reads, by name or by a string key: `m` in `a.m` and in `a["m"]`. */
function memberRead(node: ts.Expression): string | undefined {
  const expression = bare(node);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
    ? expression.argumentExpression.text
    : undefined;
}

/** What an expression reads the member `name` off, by name or by a string key: `a` in `a.m` and in `a["m"]`. */
function readOff(node: ts.Expression, name: string): ts.Expression | undefined {
  const expression = bare(node);
  return (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    memberRead(expression) === name
    ? expression.expression
    : undefined;
}

/** The function a bind is read off: `f` in `f.bind(t, a)`. */
function boundFunction(node: ts.Expression): ts.Expression | undefined {
  const expression = bare(node);
  return ts.isCallExpression(expression) ? readOff(expression.expression, "bind") : undefined;
}

/** The function a call calls: its callee, or `f` in `f.call(t, a)` and `f.apply(t, [a])`. */
function calledFunction(call: ts.CallExpression): ts.Expression {
  return readOff(call.expression, "call") ?? readOff(call.expression, "apply") ?? call.expression;
}

function insideFunctionNamed(node: ts.Node, name: string): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name?.text === name) return true;
  }
  return false;
}

/** A module a file loads, and how. */
interface ModuleReference {
  /** The node that makes the reference. */
  readonly node: ts.Node;
  /** The module name, or undefined when it is not written as a plain string. */
  readonly specifier: string | undefined;
  /** For a require-family call, the loader it calls, as written; undefined for an import or an export. */
  readonly loader: string | undefined;
  /**
   * The members it takes by name, or undefined for the whole module; none for a type-only reference
   * or a bare import, and a default import takes none by name.
   */
  readonly names: readonly string[] | undefined;
}

/**
 * Which expressions of a file evaluate to a require function: `require`, a member named require
 * (module.require, import.meta.require), what createRequire answers, called directly or through
 * call or apply, a bind of any of those, and a name the file binds to one of those or to
 * createRequire itself, or to a bind of it, through a declaration, a parameter's default, an
 * assignment, an import or a destructuring, followed until nothing new is bound.
 */
function requireFunctions(sf: ts.SourceFile): (node: ts.Expression) => boolean {
  const loaders = new Set(["require"]);
  const makers = new Set(["createRequire"]);
  const isMaker = (node: ts.Expression): boolean => {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return makers.has(expression.text);
    const bound = boundFunction(expression);
    return bound === undefined ? memberRead(expression) === "createRequire" : isMaker(bound);
  };
  const isLoader = (node: ts.Expression): boolean => {
    const expression = bare(node);
    if (ts.isIdentifier(expression)) return loaders.has(expression.text);
    const bound = boundFunction(expression);
    if (bound !== undefined) return isLoader(bound);
    return (
      memberRead(expression) === "require" || (ts.isCallExpression(expression) && isMaker(calledFunction(expression)))
    );
  };
  for (let grew = true; grew; ) {
    grew = false;
    const bind = (name: string, into: Set<string>) => {
      if (into.has(name)) return;
      into.add(name);
      grew = true;
    };
    const visit = (node: ts.Node) => {
      const bound =
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)
          ? { name: node.name.text, value: node.initializer }
          : ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(node.left)
            ? { name: node.left.text, value: node.right }
            : undefined;
      if (bound?.value !== undefined) {
        if (isLoader(bound.value)) bind(bound.name, loaders);
        else if (isMaker(bound.value)) bind(bound.name, makers);
      }
      if ((ts.isImportSpecifier(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
        const property = node.propertyName;
        const taken =
          property !== undefined && (ts.isIdentifier(property) || ts.isStringLiteral(property))
            ? property.text
            : node.name.text;
        if (taken === "createRequire") bind(node.name.text, makers);
        if (taken === "require") bind(node.name.text, loaders);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return isLoader;
}

/**
 * The arguments a call hands the require function it calls, or undefined when it calls none: a
 * call of one, directly or through call or apply, and of a bind of one, whose fixed arguments come
 * first. An apply whose list is not written out hands none the text holds.
 */
function loaderArguments(
  call: ts.CallExpression,
  isLoader: (node: ts.Expression) => boolean,
): ts.Expression[] | undefined {
  const fixed = (loader: ts.Expression): ts.Expression[] => {
    const expression = bare(loader);
    const bound = boundFunction(expression);
    return bound === undefined || !ts.isCallExpression(expression)
      ? []
      : [...fixed(bound), ...expression.arguments.slice(1)];
  };
  if (isLoader(call.expression)) return [...fixed(call.expression), ...call.arguments];
  const through = readOff(call.expression, "call");
  if (through !== undefined && isLoader(through)) return [...fixed(through), ...call.arguments.slice(1)];
  const applied = readOff(call.expression, "apply");
  if (applied === undefined || !isLoader(applied)) return undefined;
  const list = call.arguments[1];
  return [...fixed(applied), ...(list !== undefined && ts.isArrayLiteralExpression(list) ? list.elements : [])];
}

/**
 * Every module a file loads: an import, an export from another module, an import-equals, an
 * import in a type position, an import() call, and a call of a require function, whether it is
 * `require` itself, a member named require (module.require, import.meta.require), a createRequire
 * loader called in place, or a name the file binds to one of those, called directly, through call
 * or apply, or as a bind fixed it.
 */
function moduleReferences(sf: ts.SourceFile): ModuleReference[] {
  const isRequireFunction = requireFunctions(sf);
  const references: ModuleReference[] = [];
  const written = (node: ts.Node | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names =
        clause === undefined || clause.isTypeOnly
          ? []
          : bindings !== undefined && ts.isNamespaceImport(bindings)
            ? undefined
            : (bindings?.elements ?? []).filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
      references.push({ node, specifier: written(node.moduleSpecifier), loader: undefined, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      const names = node.isTypeOnly
        ? []
        : clause === undefined || ts.isNamespaceExport(clause)
          ? undefined
          : clause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
      references.push({ node, specifier: written(node.moduleSpecifier), loader: undefined, names });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const names = node.isTypeOnly ? [] : undefined;
      references.push({ node, specifier: written(node.moduleReference.expression), loader: undefined, names });
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument) ? written(node.argument.literal) : undefined;
      references.push({ node, specifier, loader: undefined, names: [] });
    } else if (ts.isCallExpression(node)) {
      const handed = loaderArguments(node, isRequireFunction);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || handed !== undefined) {
        const loader = handed === undefined ? undefined : node.expression.getText(sf).replace(/\s+/g, " ");
        references.push({ node, specifier: written((handed ?? node.arguments)[0]), loader, names: undefined });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return references;
}

/** The names a module exports, as a module importing it would write them. */
function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) names.push("*");
      else if (ts.isNamespaceExport(clause)) names.push(clause.name.text);
      else for (const specifier of clause.elements) names.push(specifier.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.push(statement.isExportEquals ? "=" : "default");
    } else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) names.push(declaration.name.getText(sf));
      } else {
        names.push((statement as ts.DeclarationStatement).name?.getText(sf) ?? "default");
      }
    }
  }
  return names;
}

/** Whether an identifier is the name a declaration binds, as opposed to a use of one. */
function bindsName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === node
  );
}

/** An interface member as the pin writes it: printed without comments, on one line. */
function printed(member: ts.Node, sf: ts.SourceFile): string {
  return PRINTER.printNode(ts.EmitHint.Unspecified, member, sf).replace(/\s+/g, " ");
}

/** How many times a pin holds each text. */
function pinCounts(pinned: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of pinned) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

/** Whether a text is one the pin still holds, taking it if so. */
function takesPin(left: Map<string, number>, text: string): boolean {
  const count = left.get(text) ?? 0;
  left.set(text, count - 1);
  return count > 0;
}

function violations(file: string, text: string): string[] {
  const found: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const path = join(PROVIDER_DIR, file);
  const adapterPath = join(PROVIDER_DIR, ADAPTER);
  const adapter = file === ADAPTER;
  const references = new Map(moduleReferences(sf).map((reference) => [reference.node, reference]));
  // Outside the adapter, loadPlatformatic and createPlatformaticClient are bound only by their
  // imports from the adapter under their own names, so a call of either can only be the adapter's.
  const fromAdapter = (specifier: ts.ImportSpecifier) => {
    const { moduleSpecifier } = specifier.parent.parent.parent;
    return ts.isStringLiteralLike(moduleSpecifier) && resolvesTo(moduleSpecifier.text, path, ROOT, adapterPath);
  };
  const ownImport = (node: ts.Identifier) =>
    ts.isImportSpecifier(node.parent) && node.parent.propertyName === undefined && fromAdapter(node.parent);
  const bindings = { createPlatformaticClient: { own: 0, other: 0 }, loadPlatformatic: { own: 0, other: 0 } };
  const count = (node: ts.Node) => {
    if (ts.isIdentifier(node) && Object.hasOwn(bindings, node.text) && bindsName(node)) {
      bindings[node.text as keyof typeof bindings][ownImport(node) ? "own" : "other"]++;
    }
    ts.forEachChild(node, count);
  };
  count(sf);
  const boundByTheAdapter = (name: keyof typeof bindings) => bindings[name].own > 0 && bindings[name].other === 0;
  /**
   * Whether `loadPlatformatic` is named the one way the provider may name it outside the adapter:
   * imported from the adapter under its own name, or called with its answer awaited straight into
   * the adapter's own createPlatformaticClient(), so no other provider file ever holds the library.
   */
  const handsTheLibraryOn = (node: ts.Identifier | ts.StringLiteralLike) => {
    if (!ts.isIdentifier(node)) return false;
    const { parent } = node;
    if (ts.isImportSpecifier(parent)) return ownImport(node);
    if (!(ts.isCallExpression(parent) && parent.expression === node && ts.isAwaitExpression(parent.parent)))
      return false;
    // An await whose parent is a call is one of its arguments: as a callee it would sit in parentheses.
    const client = parent.parent.parent;
    return (
      boundByTheAdapter("loadPlatformatic") &&
      boundByTheAdapter("createPlatformaticClient") &&
      ts.isCallExpression(client) &&
      ts.isIdentifier(client.expression) &&
      client.expression.text === "createPlatformaticClient"
    );
  };
  // Each pinned assertion and predicate is taken once, in the order the file writes them.
  const castsLeft = pinCounts(PINNED_CASTS);
  const predicatesLeft = pinCounts(PINNED_PREDICATES);
  const visit = (node: ts.Node) => {
    const reference = references.get(node);
    if (reference !== undefined) {
      // A provider file loads modules through import and export alone.
      if (reference.loader !== undefined) found.push(`${file} loads a module through ${reference.loader}`);
      if (reference.specifier === undefined) found.push(`${file} imports a computed module name`);
      else if (loadsLibrary(reference.specifier, path, ROOT)) {
        if (!adapter) found.push(`${file} imports ${LIBRARY}`);
        // In the adapter too, the library comes in through loadPlatformatic() alone, whose answer
        // holds the pinned members only: an import anywhere else, a re-export included, is refused.
        else if (!insideFunctionNamed(node, "loadPlatformatic"))
          found.push(`${file} imports ${LIBRARY} outside loadPlatformatic()`);
      }
      if (
        !adapter &&
        ts.isExportDeclaration(node) &&
        reference.names === undefined &&
        reference.specifier !== undefined &&
        resolvesTo(reference.specifier, path, ROOT, adapterPath)
      )
        found.push(`${file} re-exports the adapter`);
    }

    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && FORBIDDEN.includes(node.text))
      found.push(`${file} names ${node.text}`);
    if (ts.isIdentifier(node) && RAW_MODULE_NAME.test(node.text) && !RAW_MODULES.has(node.text))
      found.push(`${file} names raw API ${node.text}`);
    if (
      !adapter &&
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === "loadPlatformatic" &&
      !handsTheLibraryOn(node)
    )
      found.push(
        `${file} takes the library from loadPlatformatic() other than straight into createPlatformaticClient()`,
      );
    if (
      !adapter &&
      ts.isIdentifier(node) &&
      node.text === "createPlatformaticClient" &&
      bindsName(node) &&
      !ownImport(node)
    )
      found.push(`${file} declares createPlatformaticClient other than as its import from the adapter`);

    // A pinned option is written as its literal, under its plain name, or not at all.
    const pinned = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? PINNED_OPTIONS.get(node.text) : undefined;
    if (pinned !== undefined) {
      const option = (node as ts.Identifier | ts.StringLiteralLike).text;
      const { parent } = node;
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        found.push(`${file} sets ${option} from a variable`);
      } else if (ts.isPropertyAssignment(parent) && parent.name === node) {
        if (!pinned.holds(parent.initializer))
          found.push(`${file} sets ${option} to something other than ${pinned.literal}`);
      } else {
        found.push(`${file} names ${option} other than as a property set to ${pinned.literal}`);
      }
    }
    // A property name computed at run time could spell any option or member the rules above refuse.
    if (
      ts.isComputedPropertyName(node) &&
      !(ts.isStringLiteralLike(node.expression) || ts.isNumericLiteral(node.expression))
    )
      found.push(`${file} computes a property name that is not a literal`);
    // A module, a namespace or declare global can merge members into any type, the library's included.
    if (ts.isModuleDeclaration(node)) found.push(`${file} declares the module or namespace ${node.name.getText(sf)}`);

    if (adapter && ts.isCallExpression(node)) {
      // Without whitespace, so a call the formatter breaks across lines is read as the one it is.
      const callee = node.expression.getText(sf).replace(/\s+/g, "");
      if (/\.api(\.async)?$/.test(callee) && !RAW_CALLS.has(callee)) found.push(`${file} calls ${callee}`);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = receiverName(node.expression.expression);
        const name = node.expression.name.text;
        if (receiver !== undefined && LIBRARY_RECEIVERS.has(receiver) && !ALLOWED.has(name)) {
          found.push(`${file} calls ${receiver}.${name}`);
        }
      }
    }
    // tsc allows `constructor` on every object, and types a class's `prototype` any: either leads to
    // every member the library's classes have, so the adapter names neither, in any position.
    if (adapter && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && READS_PAST_THE_SHAPES.has(node.text)) {
      const { parent } = node;
      const owner =
        ts.isPropertyAccessExpression(parent) && parent.name === node
          ? parent.expression
          : ts.isElementAccessExpression(parent) && parent.argumentExpression === node
            ? parent.expression
            : undefined;
      found.push(
        owner === undefined ? `${file} names ${node.text}` : `${file} reads the ${node.text} of ${owner.getText(sf)}`,
      );
    }
    if (adapter && ts.isElementAccessExpression(node)) {
      const root = receiverRoot(node.expression);
      if (root !== undefined && LIBRARY_RECEIVERS.has(root)) found.push(`${file} reads a computed member of ${root}`);
    }
    // Outside loadPlatformatic(), whose members are cast to the shapes, every assertion and every
    // predicate is one of the pinned ones.
    if (
      adapter &&
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      !insideFunctionNamed(node, "loadPlatformatic") &&
      !takesPin(castsLeft, printed(node, sf))
    ) {
      found.push(`${file} casts ${node.expression.getText(sf)} past its declared shape`);
    }
    if (adapter && ts.isTypePredicateNode(node) && !takesPin(predicatesLeft, printed(node, sf)))
      found.push(`${file} declares the type predicate ${printed(node, sf)}`);
    // A name typed any holds a library object as freely as a cast does, with no cast to see.
    if (adapter && node.kind === ts.SyntaxKind.AnyKeyword) found.push(`${file} writes the type any`);
    // An overload or an ambient declaration gives a value a type no expression checks.
    if (
      adapter &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
      node.body === undefined
    )
      found.push(`${file} declares ${node.name?.getText(sf) ?? "a constructor"} without a body`);
    if (
      adapter &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
    )
      found.push(`${file} writes a declare modifier`);
    // A class that extends a library class gets its members, and can declare any of them.
    if (adapter && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword)
          for (const base of clause.types) found.push(`${file} declares a class that extends ${base.getText(sf)}`);
      }
    }
    if (adapter && ts.isFunctionDeclaration(node) && node.name?.text === "loadPlatformatic") {
      if (printed(node, sf) !== PINNED_LOADER) found.push(`${file} writes loadPlatformatic() other than as pinned`);
    }
    if (adapter && ts.isInterfaceDeclaration(node) && Object.hasOwn(DECLARED_SHAPES, node.name.text)) {
      const shape = node.name.text;
      const pinnedMembers = DECLARED_SHAPES[shape];
      const members = node.members.map((m) => ({ name: m.name?.getText(sf) ?? printed(m, sf), text: printed(m, sf) }));
      const names = members.map((m) => m.name).sort();
      if (names.join() !== Object.keys(pinnedMembers).sort().join()) {
        found.push(`${file} declares ${shape} as ${names.join(", ")}`);
      } else {
        for (const m of members) {
          if (m.text !== pinnedMembers[m.name]) found.push(`${file} declares ${shape}.${m.name} as ${m.text}`);
        }
      }
      // An inherited member is declared all the same, where the member pin never looks.
      for (const clause of node.heritageClauses ?? []) found.push(`${file} declares ${shape} ${clause.getText(sf)}`);
    }
    // A type alias takes a pinned name out of the pin's reach, and a class of that name merges its
    // members into the interface (an enum tsc refuses to merge with one).
    if (
      adapter &&
      (ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      Object.hasOwn(DECLARED_SHAPES, node.name.text)
    ) {
      found.push(`${file} declares ${node.name.text} other than as an interface`);
    }
    if (
      adapter &&
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isObjectLiteralExpression(node.expression) &&
      insideFunctionNamed(node, "loadPlatformatic")
    ) {
      const keys = node.expression.properties.map((p) => p.name?.getText(sf) ?? "").sort();
      if (keys.join() !== Object.keys(DECLARED_SHAPES.PlatformaticLib).sort().join())
        found.push(`${file} loads ${keys.join(", ")}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (adapter) {
    // An export beyond the pinned ones could hand the library, or one of its objects, to any file.
    for (const name of exportedNames(sf)) if (!ADAPTER_EXPORTS.has(name)) found.push(`${file} exports ${name}`);
    // tsc is what makes the declared shapes binding, so nothing in the adapter may switch it off.
    for (const [directive] of text.matchAll(TSC_DIRECTIVE)) found.push(`${file} switches tsc off with ${directive}`);
  }
  return found;
}

/** Whether a parsed file loads the library, where `containing` is its path and `root` the repository it is in. */
function loadsTheLibrary(sf: ts.SourceFile, containing: string, root: string): boolean {
  return moduleReferences(sf).some((reference) => {
    const { specifier } = reference;
    return specifier !== undefined && loadsLibrary(specifier, containing, root);
  });
}

/**
 * The files of the repository at `root` that import the library. Every source file is parsed:
 * a search of the text for the name would pass over a specifier spelled with escapes.
 */
function importersIn(root: string, env?: NodeJS.ProcessEnv): string[] {
  return repositoryFiles(root, env)
    .filter(({ path, sf }) => loadsTheLibrary(sf, join(root, path), root))
    .map(({ path }) => path);
}

/**
 * Whether a file imports the library, by parsing it, so a mention in a string or a comment does
 * not count, while a specifier spelled with escapes, which names the library without its text
 * holding the name, does, and so do a path, an alias and a require function that reach it. `file`
 * is where the text lies in the repository at `root`, which decides where its paths lead.
 */
function importsLibrary(file: string, text: string, root = ROOT): boolean {
  return loadsTheLibrary(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), join(root, file), root);
}

/**
 * Whether a file takes the adapter's loader: it imports loadPlatformatic from the adapter, or the
 * whole adapter module (as a namespace, through import-equals, require or import(), or as a
 * re-export of every name). The adapter is the one in the provider directory of the repository at
 * `root`, whatever path or alias names it.
 */
function takesTheLoader(file: string, sf: ts.SourceFile, root: string): boolean {
  const adapterPath = join(root, PROVIDER_PATH, ADAPTER);
  return moduleReferences(sf).some(
    ({ specifier, names }) =>
      specifier !== undefined &&
      (names === undefined || names.includes("loadPlatformatic")) &&
      resolvesTo(specifier, join(root, file), root, adapterPath),
  );
}

/** The files of the repository at `root` outside the provider that take the adapter's loader. */
function loaderTakersIn(root: string, env?: NodeJS.ProcessEnv): string[] {
  return repositoryFiles(root, env)
    .filter(({ path, sf }) => !path.startsWith(`${PROVIDER_PATH}/`) && takesTheLoader(path, sf, root))
    .map(({ path }) => path);
}

/**
 * The files of the repository at `root` that load its fixture seed: any module reference, one in a
 * type position included, that names the seed's file, as TypeScript resolves it or as a file URL.
 */
function seedTakersIn(root: string, env?: NodeJS.ProcessEnv): string[] {
  const seed = join(root, SEED);
  return repositoryFiles(root, env)
    .filter(({ path, sf }) =>
      moduleReferences(sf).some(
        ({ specifier }) => specifier !== undefined && resolvesTo(specifier, join(root, path), root, seed),
      ),
    )
    .map(({ path }) => path);
}

/**
 * The pinned assertions and predicates an adapter's text does not write as often as the pin holds
 * them, in the pin's order. A pin the adapter no longer writes would let a new one of that text in.
 * loadPlatformatic()'s casts count here too: it is pinned whole, and none of its casts is pinned.
 */
function unwrittenPins(text: string): string[] {
  const sf = ts.createSourceFile(ADAPTER, text, ts.ScriptTarget.Latest, true);
  const written = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isTypePredicateNode(node)) {
      const printedText = printed(node, sf);
      written.set(printedText, (written.get(printedText) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...PINNED_CASTS, ...PINNED_PREDICATES].filter((text) => !takesPin(written, text));
}

/**
 * How three disjoint lists classify the members of `classes`: each member no list names, each
 * name two lists hold, and each allowed or unused entry no class has, which would classify ahead
 * of time a member a later version adds.
 */
function classificationGaps(
  classes: ReadonlyMap<string, { members: readonly string[] }>,
  lists: { allowed: ReadonlySet<string>; forbidden: readonly string[]; unused: ReadonlySet<string> } = {
    allowed: ALLOWED,
    forbidden: FORBIDDEN,
    unused: UNUSED_MEMBERS,
  },
): { unclassified: string[]; overlapping: string[]; stale: string[] } {
  const { allowed, forbidden, unused } = lists;
  const members = new Set([...classes.values()].flatMap((c) => c.members));
  return {
    unclassified: [...classes].flatMap(([name, c]) =>
      c.members.filter((m) => !allowed.has(m) && !forbidden.includes(m) && !unused.has(m)).map((m) => `${name}.${m}`),
    ),
    overlapping: [
      ...[...unused].filter((m) => allowed.has(m) || forbidden.includes(m)),
      ...[...allowed].filter((m) => forbidden.includes(m)),
    ],
    stale: [...unused, ...allowed].filter((m) => !members.has(m)),
  };
}

/**
 * The global types a file augments among GLOBAL_TYPES: an interface of that name inside declare
 * global, or at the top of a script, whose declarations are global. A module's own interface of
 * that name, or one inside a namespace or a module declaration, merges with nothing global.
 */
function globalAugmentations(file: string, sf: ts.SourceFile): string[] {
  const found: string[] = [];
  const scan = (statements: readonly ts.Statement[], global: boolean) => {
    for (const statement of statements) {
      if (global && ts.isInterfaceDeclaration(statement) && GLOBAL_TYPES.has(statement.name.text))
        found.push(`${file} augments the global ${statement.name.text}`);
      if (ts.isModuleDeclaration(statement)) scanModule(statement);
    }
  };
  // tsc takes declare global only at the top of a module or in a `declare module "name"` block
  // (TS2669), so the inner body of a dotted namespace is not read.
  const scanModule = (declaration: ts.ModuleDeclaration) => {
    const { body } = declaration;
    const global = (declaration.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
    if (body !== undefined && ts.isModuleBlock(body)) scan(body.statements, global);
  };
  scan(sf.statements, !ts.isExternalModule(sf));
  return found;
}

/** Every global augmentation among GLOBAL_TYPES in the repository at `root`. */
function globalAugmentationsIn(root: string): string[] {
  return repositoryFiles(root).flatMap(({ path, sf }) => globalAugmentations(path, sf));
}

/**
 * A member of a library class by the name the classification gives it: its own, or `[Symbol.x]`
 * for a well-known symbol, which every module holds. A member keyed by one of the library's own
 * symbols is reached only through them, which only an import of the library or reflection holds,
 * and a #private one not at all, so neither is named.
 */
function memberName(member: ts.ClassElement): string | undefined {
  const { name } = member;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  const key = ts.isComputedPropertyName(name) ? name.expression : undefined;
  if (key !== undefined && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) return key.text;
  return key !== undefined &&
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Symbol"
    ? `[Symbol.${key.name.text}]`
    : undefined;
}

/**
 * The classes the declaration `files` under `dist` declare (LIBRARY_CLASS_FILES in the installed
 * library, unless a test gives others), each with its named members and the class it extends, and
 * whether that class is the library's own: declared in the same file, or imported from one of the
 * library's modules rather than from a package or a runtime module.
 */
function libraryClasses(
  dist = join(ROOT, "node_modules", ...LIBRARY.split("/"), "dist"),
  files: readonly string[] = LIBRARY_CLASS_FILES,
): Map<string, { members: string[]; base: { name: string; fromLibrary: boolean } | undefined }> {
  const classes = new Map<string, { members: string[]; base: { name: string; fromLibrary: boolean } | undefined }>();
  for (const file of files) {
    const path = join(dist, ...file.split("/"));
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const importedFrom = new Map<string, string>();
    for (const statement of sf.statements.filter(ts.isImportDeclaration)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings) && ts.isStringLiteral(statement.moduleSpecifier))
        for (const element of bindings.elements) importedFrom.set(element.name.text, statement.moduleSpecifier.text);
    }
    const declarations = sf.statements.filter(ts.isClassDeclaration);
    const declaredHere = new Set(declarations.map((declaration) => declaration.name?.text));
    for (const declaration of declarations) {
      const name = declaration.name?.text ?? "default";
      const extended = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0]?.expression;
      const base =
        extended !== undefined && ts.isIdentifier(extended)
          ? {
              name: extended.text,
              fromLibrary:
                declaredHere.has(extended.text) || (importedFrom.get(extended.text)?.startsWith(".") ?? false),
            }
          : undefined;
      if (classes.has(name)) throw new Error(`${file} declares ${name} again`);
      const members = declaration.members.map(memberName).filter((member) => member !== undefined);
      classes.set(name, { members, base });
    }
  }
  return classes;
}

/**
 * The environment git runs in for a throwaway repository: `base` without any GIT_ variable, which
 * can carry configuration, and with the user's global configuration, its default ignore file and
 * the system's configuration replaced by nothing, so what the repository lists is its own.
 */
function isolatedGitEnvironment(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "gitconfig"), "");
  const env = { ...base };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.XDG_CONFIG_HOME = home;
  return env;
}

/**
 * Makes the test process the environment of a user whose own git configuration ignores `ignored`
 * (as common global ignore templates ignore bin/), in each place git reads it from: the global file,
 * the one HOME holds, the default ignore file, and configuration carried in GIT_ variables, as a
 * hook or `git -c` hands it on. So a git command run in the inherited environment lists none of it.
 * `run` runs in that environment, and the environment is restored after it, whatever it does.
 */
function asHostileGitUser<T>(home: string, ignored: readonly string[], run: () => T): T {
  const user = join(home, "user");
  const excludes = join(user, "excludes");
  const config = `[core]\n\texcludesFile = ${excludes.split("\\").join("/")}\n`;
  mkdirSync(join(user, "git"), { recursive: true });
  writeFileSync(excludes, ignored.map((pattern) => `${pattern}\n`).join(""));
  writeFileSync(join(user, "git", "ignore"), ignored.map((pattern) => `${pattern}\n`).join(""));
  writeFileSync(join(user, ".gitconfig"), config);
  writeFileSync(join(user, "gitconfig"), config);
  const hostile: Record<string, string> = {
    HOME: user,
    XDG_CONFIG_HOME: user,
    GIT_CONFIG_GLOBAL: join(user, "gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: excludes,
  };
  const saved = Object.fromEntries(Object.keys(hostile).map((name) => [name, process.env[name]]));
  Object.assign(process.env, hostile);
  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The adapter as it is, with a sample written after it: the real adapter is the control, and adds no finding. */
function withTheAdapter(source: string): string {
  return `${readFileSync(join(PROVIDER_DIR, ADAPTER), "utf8")}\n${source}`;
}

/** The adapter as it is, with a line written into loadPlatformatic(), after the logger is muted. */
function withTheLoaderChanged(line: string): string {
  const adapter = readFileSync(join(PROVIDER_DIR, ADAPTER), "utf8");
  const anchor = "  protocolLog.enabled = false;\n";
  expect(adapter.split(anchor)).toHaveLength(2);
  return adapter.replace(anchor, `${anchor}${line}\n`);
}

describe("Kafka seam guard", () => {
  test("the provider's source list is read recursively and holds the adapter", () => {
    const files = sources().map(([f]) => f);
    expect(files).toContain(ADAPTER);
    expect(files.length).toBeGreaterThan(1);
  });

  test("the real provider sources are clean", () => {
    expect(sources().flatMap(([f, t]) => violations(f, t))).toEqual([]);
  });

  test("the adapter declares each pinned shape once, as an interface, so none can move to another name", () => {
    const sf = ts.createSourceFile(
      ADAPTER,
      readFileSync(join(PROVIDER_DIR, ADAPTER), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declared = sf.statements
      .filter(ts.isInterfaceDeclaration)
      .map((declaration) => declaration.name.text)
      .filter((name) => Object.hasOwn(DECLARED_SHAPES, name));
    expect(declared.sort()).toEqual(Object.keys(DECLARED_SHAPES).sort());
  });

  test("the adapter writes each pinned assertion and predicate as often as the pin holds it, so no stale pin waits for a new one", () => {
    const adapter = readFileSync(join(PROVIDER_DIR, ADAPTER), "utf8");
    expect(unwrittenPins(adapter)).toEqual([]);
    const rewritten = adapter
      .replace("tls.code as string", "String(tls.code)")
      .replace("(value as LibRawMetadata).topics", "(value as { topics: unknown }).topics")
      .replace("(code: unknown): code is string", "(code: unknown): boolean");
    expect(unwrittenPins(rewritten)).toEqual(["tls.code as string", "value as LibRawMetadata", "code is string"]);
  });

  test("the adapter and the fixture seed are the only files in the repository that import the library", () => {
    expect(importersIn(ROOT)).toEqual(IMPORTERS);
  }, 30_000);

  test("outside the provider, only the pinned files take the adapter's loader", () => {
    expect(loaderTakersIn(ROOT)).toEqual(LOADER_TAKERS);
  }, 30_000);

  test("in a repository, the loader's takers are the files outside the provider that import it", () => {
    const repo = mkdtempSync(join(tmpdir(), "kafka-seam-guard-"));
    const home = mkdtempSync(join(tmpdir(), "kafka-seam-guard-home-"));
    try {
      asHostileGitUser(home, ["tests/"], () => {
        const env = isolatedGitEnvironment(process.env, join(home, "isolated"));
        execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repo, encoding: "utf8", env });
        const adapter = `../${PROVIDER_PATH}/platformatic-client`;
        const files: Record<string, string> = {
          [`${PROVIDER_PATH}/${ADAPTER}`]:
            "export async function loadPlatformatic() {}\nexport const translateError = 1;\n",
          // The provider's own composition, which the provider's rules govern instead.
          [`${PROVIDER_PATH}/index.ts`]:
            'import { loadPlatformatic } from "./platformatic-client";\nexport { loadPlatformatic };\n',
          "tests/taker.test.ts": `import { loadPlatformatic } from "${adapter}";\nexport { loadPlatformatic };\n`,
          "tests/other.test.ts": `import { translateError } from "${adapter}";\nexport { translateError };\n`,
        };
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(repo, path)), { recursive: true });
          writeFileSync(join(repo, path), text);
        }
        expect(loaderTakersIn(repo, env)).toEqual(["tests/taker.test.ts"]);
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no file in the repository loads the fixture seed, whose top level writes with the library's Producer", () => {
    expect(seedTakersIn(ROOT)).toEqual(SEED_TAKERS);
  }, 30_000);

  test("in a repository, the seed's takers are the files with a module reference that names its file, a file URL included", () => {
    const repo = mkdtempSync(join(tmpdir(), "kafka-seam-guard-"));
    const home = mkdtempSync(join(tmpdir(), "kafka-seam-guard-home-"));
    try {
      asHostileGitUser(home, ["tests/"], () => {
        const env = isolatedGitEnvironment(process.env, join(home, "isolated"));
        execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repo, encoding: "utf8", env });
        const seedUrl = pathToFileURL(join(repo, SEED)).href;
        const missingUrl = pathToFileURL(join(repo, "docker", "kafka", "missing.ts")).href;
        // The seed's file by another name: a directory link, a junction on Windows, which needs no privilege.
        const linkedUrl = pathToFileURL(join(repo, "linked", "kafka", "seed-binary.ts")).href;
        const files: Record<string, string> = {
          [SEED]: "export {};\n",
          "tests/fixtures/seed-binary.ts": "export {};\n",
          [`${PROVIDER_PATH}/read.ts`]: 'import "../../../../../../docker/kafka/seed-binary";\n',
          "tests/unit/by-extension.test.ts": 'await import("../../docker/kafka/seed-binary.ts");\n',
          "tests/unit/by-js-extension.test.ts": 'export * from "../../docker/kafka/seed-binary.js";\n',
          "tests/unit/by-require.test.ts": 'const seed = require("../../docker/kafka/seed-binary");\n',
          "tests/unit/by-type.test.ts": 'type Seed = typeof import("../../docker/kafka/seed-binary");\n',
          "e2e/by-url.spec.ts": `await import(${JSON.stringify(seedUrl)});\n`,
          "e2e/by-linked-url.spec.ts": `await import(${JSON.stringify(linkedUrl)});\n`,
          // Another file of the seed's name, a path whose text holds the seed's and reaches no file, a
          // file URL of no file, and a run of the seed in another process, which loads nothing here.
          "tests/unit/other-seed.test.ts": 'import "../fixtures/seed-binary";\n',
          "tests/unit/no-such-path.test.ts": 'import "./docker/kafka/seed-binary";\n',
          "tests/unit/missing-url.test.ts": `await import(${JSON.stringify(missingUrl)});\n`,
          "tests/unit/runs-it.test.ts":
            'Bun.spawnSync(["bun", "docker/kafka/seed-binary.ts"]);\n// import "../../docker/kafka/seed-binary";\n',
        };
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(repo, path)), { recursive: true });
          writeFileSync(join(repo, path), text);
        }
        symlinkSync(join(repo, "docker"), join(repo, "linked"), "junction");
        expect(seedTakersIn(repo, env)).toEqual([
          "e2e/by-linked-url.spec.ts",
          "e2e/by-url.spec.ts",
          `${PROVIDER_PATH}/read.ts`,
          "tests/unit/by-extension.test.ts",
          "tests/unit/by-js-extension.test.ts",
          "tests/unit/by-require.test.ts",
          "tests/unit/by-type.test.ts",
        ]);
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no file in the repository augments a global type every object or function has", () => {
    expect(globalAugmentationsIn(ROOT)).toEqual([]);
  }, 30_000);

  test("in a repository, the sources are what git tracks or would take in, whatever the user's git configuration, and the importers are what a parse finds", () => {
    const repo = mkdtempSync(join(tmpdir(), "kafka-seam-guard-"));
    const home = mkdtempSync(join(tmpdir(), "kafka-seam-guard-home-"));
    try {
      asHostileGitUser(home, ["bin/"], () => {
        const env = isolatedGitEnvironment(process.env, join(home, "isolated"));
        const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env });
        git(["init", "-q", "--initial-branch=main"]);
        const files: Record<string, string> = {
          ".gitignore": "ignored/\n",
          // Its text never holds the name its specifier's escapes spell.
          "tracked.ts": 'import { Admin } from "\\u0040platformatic\\u002fkafka";\n',
          "removed.ts": `import { Admin } from "${LIBRARY}";\n`,
          "nested/untracked.mts": "export {};\n",
          "bin/tool.cjs": `// require("${LIBRARY}") is prose here\n`,
          "bin/load.cjs": `const kafka = require("${LIBRARY}");\n`,
          "ui/view.tsx": `export const note = "${LIBRARY}";\n`,
          "ignored/hidden.ts": `import { Admin } from "${LIBRARY}";\n`,
          "notes.md": `import { Admin } from "${LIBRARY}";\n`,
        };
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(repo, path)), { recursive: true });
          writeFileSync(join(repo, path), text);
        }
        git(["add", "tracked.ts", "removed.ts"]);
        rmSync(join(repo, "removed.ts"));
        expect(repositorySources(repo, env)).toEqual([
          "bin/load.cjs",
          "bin/tool.cjs",
          "nested/untracked.mts",
          "tracked.ts",
          "ui/view.tsx",
        ]);
        expect(importersIn(repo, env)).toEqual(["bin/load.cjs", "tracked.ts"]);
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the hostile git user's environment is the test process's only while it runs, even when it throws", () => {
    const home = mkdtempSync(join(tmpdir(), "kafka-seam-guard-home-"));
    try {
      const names = [
        "HOME",
        "XDG_CONFIG_HOME",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
      ];
      const now = () => names.map((name) => process.env[name]);
      const before = now();
      const during = asHostileGitUser(home, ["bin/"], now);
      expect(during).toEqual([
        join(home, "user"),
        join(home, "user"),
        join(home, "user", "gitconfig"),
        "1",
        "core.excludesFile",
        join(home, "user", "excludes"),
      ]);
      expect(now()).toEqual(before);
      expect(() =>
        asHostileGitUser(home, ["bin/"], () => {
          throw new Error("the run failed");
        }),
      ).toThrow("the run failed");
      expect(now()).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a module name counts by what it loads: the package by its name or an aliased install, or a path into it", () => {
    const root = mkdtempSync(join(tmpdir(), "kafka-seam-guard-modules-"));
    try {
      // The library's own entry point is missing here, so its directory resolves to no file.
      const packages: Record<string, { name: string; main: string }> = {
        "node_modules/@platformatic/kafka": { name: LIBRARY, main: "dist/missing.js" },
        "node_modules/kafka-alias": { name: LIBRARY, main: "dist/index.js" },
        "node_modules/@scope/kafka-alias": { name: LIBRARY, main: "dist/index.js" },
        "node_modules/other/node_modules/kafka-nested": { name: LIBRARY, main: "dist/index.js" },
        "node_modules/@platformatic/kafka-admin": { name: "@platformatic/kafka-admin", main: "dist/index.js" },
        "node_modules/other": { name: "other", main: "dist/index.js" },
      };
      for (const [dir, manifest] of Object.entries(packages)) {
        mkdirSync(join(root, dir, "dist"), { recursive: true });
        writeFileSync(join(root, dir, "package.json"), JSON.stringify(manifest));
        writeFileSync(join(root, dir, "dist", "index.js"), "export {};\n");
      }
      const library = join(root, "node_modules", "@platformatic", "kafka", "dist", "index.js");
      const missing = join(root, "node_modules", "@platformatic", "kafka", "dist", "missing.js");
      const loads = (file: string, source: string) => importsLibrary(file, source, root);
      expect(loads("x.ts", 'import k from "kafka-alias";')).toBe(true);
      expect(loads("x.ts", 'import k from "@scope/kafka-alias";')).toBe(true);
      expect(loads("x.ts", 'import k from "./node_modules/other/node_modules/kafka-nested/dist/index.js";')).toBe(true);
      expect(loads("x.ts", 'import k from "./node_modules/@platformatic/kafka/dist/index.js";')).toBe(true);
      expect(loads("src/deep/x.ts", 'import k from "../../node_modules/@platformatic/kafka/dist/index.js";')).toBe(
        true,
      );
      expect(loads("x.ts", `import k from ${JSON.stringify(library)};`)).toBe(true);
      expect(loads("x.ts", `import k from ${JSON.stringify(pathToFileURL(library).href)};`)).toBe(true);
      // A path into the package that no file answers loads nothing, but names the library's files.
      expect(loads("x.ts", 'import "./node_modules/@platformatic/kafka/dist/missing.js";')).toBe(true);
      expect(loads("src/deep/x.ts", 'import "../../node_modules/@platformatic/kafka/dist/missing.js";')).toBe(true);
      expect(loads("x.ts", `import ${JSON.stringify(missing)};`)).toBe(true);
      expect(loads("x.ts", 'import "./node_modules/@platformatic/kafka";')).toBe(true);
      // Where no package is installed at all, the path alone says it is the library's.
      expect(loads("x.ts", 'import "./vendor/node_modules/@platformatic/kafka/dist/index.js";')).toBe(true);
      expect(loads("x.ts", 'import "./vendor/node_modules/@platformatic/kafka";')).toBe(true);
      expect(loads("x.ts", 'import k from "other";')).toBe(false);
      expect(loads("x.ts", 'import k from "@platformatic/kafka-admin";')).toBe(false);
      expect(loads("x.ts", 'import k from "./node_modules/@platformatic/kafka-admin/dist/index.js";')).toBe(false);
      expect(loads("x.ts", 'import k from "./node_modules/other/dist/index.js";')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the provider directory is read into its subdirectories, with the same path on every platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "kafka-seam-guard-"));
    try {
      mkdirSync(join(dir, "codecs"));
      for (const path of ["read.ts", "codecs/zstd.mts", "codecs/README.md"]) writeFileSync(join(dir, path), "");
      expect(filesUnder(dir)).toEqual(["codecs/zstd.mts", "read.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the allowlist is exactly what the pinned shapes of the library's instances declare, so neither moves alone", () => {
    const declared = ["AdminLike", "ConsumerLike", "ConnectionLike", "ConnectionPoolLike"].flatMap((shape) =>
      Object.keys(DECLARED_SHAPES[shape]),
    );
    expect([...new Set(declared)].sort()).toEqual([...ALLOWED].sort());
  });

  test("the classified classes are the ones the adapter builds and every library class they extend", () => {
    const classes = libraryClasses();
    const built = Object.entries(DECLARED_SHAPES.PlatformaticLib)
      .filter(([, signature]) => signature.includes(": new ("))
      .map(([name]) => name);
    const expected = new Set<string>();
    for (const pending = [...built]; pending.length > 0; ) {
      const name = pending.pop() as string;
      if (expected.has(name)) continue;
      expected.add(name);
      const base = classes.get(name)?.base;
      if (base?.fromLibrary) pending.push(base.name);
    }
    expect([...classes.keys()].sort()).toEqual([...expected].sort());
  });

  test("every named member of the library's classes the adapter holds is allowed, forbidden or left unused", () => {
    expect(classificationGaps(libraryClasses())).toEqual({ unclassified: [], overlapping: [], stale: [] });
  });

  test("the classification finds a member no list names, a name two lists hold, and an entry no class has", () => {
    const classes = new Map([
      ["Reader", { members: ["read", "close", "peek"] }],
      ["Writer", { members: ["write"] }],
    ]);
    const lists = {
      allowed: new Set(["read", "close", "gone"]),
      forbidden: ["write", "close"],
      unused: new Set(["read", "left"]),
    };
    expect(classificationGaps(classes, lists)).toEqual({
      unclassified: ["Reader.peek"],
      overlapping: ["read", "close"],
      stale: ["left", "gone"],
    });
  });

  test("a class's base is the library's own when the file declares it or imports it from the library, and each member is named as a module reaches it", () => {
    const dist = mkdtempSync(join(tmpdir(), "kafka-seam-guard-dist-"));
    try {
      writeFileSync(
        join(dist, "a.d.ts"),
        [
          'import { EventEmitter } from "node:events";',
          'import { Far } from "./far.ts";',
          'import { kOwn } from "./symbols.ts";',
          "export declare class Near {}",
          "export declare class Mid extends Near {",
          "  #private;",
          "  [kOwn]: number;",
          "  [Symbol.asyncIterator](): AsyncIterator<number>;",
          '  "quoted"(): void;',
          "  0: number;",
          '  ["literal"]: string;',
          "  plain(): void;",
          "}",
          "export declare class Top extends Far {}",
          "export declare class Events extends EventEmitter {}",
        ].join("\n"),
      );
      writeFileSync(join(dist, "b.d.ts"), "export declare class Near {}\n");
      expect([...libraryClasses(dist, ["a.d.ts"])]).toEqual([
        ["Near", { members: [], base: undefined }],
        [
          "Mid",
          {
            members: ["[Symbol.asyncIterator]", "quoted", "0", "literal", "plain"],
            base: { name: "Near", fromLibrary: true },
          },
        ],
        ["Top", { members: [], base: { name: "Far", fromLibrary: true } }],
        ["Events", { members: [], base: { name: "EventEmitter", fromLibrary: false } }],
      ]);
      expect(() => libraryClasses(dist, ["a.d.ts", "b.d.ts"])).toThrow("b.d.ts declares Near again");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test.each(FORBIDDEN)("the provider may not name %s, as a name or as a string", (word) => {
    expect(violations("read.ts", `const m = x.${word};`)).toEqual([`read.ts names ${word}`]);
    expect(violations("read.ts", `const m = Reflect.get(x, "${word}");`)).toEqual([`read.ts names ${word}`]);
  });

  test("the detector fires on each class of breach", () => {
    expect(violations("read.ts", `import { Admin } from "${LIBRARY}";`)).toEqual([`read.ts imports ${LIBRARY}`]);
    expect(violations("read.ts", `const k = await import(\`${LIBRARY}\`);`)).toEqual([`read.ts imports ${LIBRARY}`]);
    expect(violations("read.ts", `const k = await import("@platformatic/" + "kafka");`)).toEqual([
      "read.ts imports a computed module name",
    ]);
    expect(violations("nested/read.ts", `export * from "${LIBRARY}";`)).toEqual([`nested/read.ts imports ${LIBRARY}`]);
    expect(violations(ADAPTER, "consumer.consume({})")).toContain(`${ADAPTER} names consume`);
    expect(violations(ADAPTER, "admin.deleteTopics({})")).toContain(`${ADAPTER} calls admin.deleteTopics`);
    expect(violations(ADAPTER, "admin.describeUserScramCredentials({})")).toEqual([
      `${ADAPTER} calls admin.describeUserScramCredentials`,
    ]);
    expect(violations(ADAPTER, "const o = { autocreateTopics: true };")).toEqual([
      `${ADAPTER} sets autocreateTopics to something other than false`,
    ]);
    expect(violations(ADAPTER, "const o = { autocreateTopics: !0 };")).toEqual([
      `${ADAPTER} sets autocreateTopics to something other than false`,
    ]);
    expect(violations(ADAPTER, "const o = { autocreateTopics };")).toEqual([
      `${ADAPTER} sets autocreateTopics from a variable`,
    ]);
    expect(violations(ADAPTER, 'const o = { groupProtocol: "consumer" };')).toEqual([
      `${ADAPTER} sets groupProtocol to something other than "classic"`,
    ]);
    expect(violations(ADAPTER, 'lib.offsetCommitV9.api.async(connection, "g");')).toEqual([
      `${ADAPTER} calls lib.offsetCommitV9.api.async`,
      `${ADAPTER} names raw API offsetCommitV9`,
    ]);
    expect(violations(ADAPTER, "lib.deleteRecordsV2.api(connection, [], 5000, () => {});")).toEqual([
      `${ADAPTER} calls lib.deleteRecordsV2.api`,
      `${ADAPTER} names raw API deleteRecordsV2`,
    ]);
    expect(violations(ADAPTER, "lib.fetchV17.api.async(connection, 250);")).toEqual([
      `${ADAPTER} calls lib.fetchV17.api.async`,
      `${ADAPTER} names raw API fetchV17`,
    ]);
    expect(violations(ADAPTER, "lib.offsetCommitV9.api\n  .async(connection);")).toEqual([
      `${ADAPTER} calls lib.offsetCommitV9.api.async`,
      `${ADAPTER} names raw API offsetCommitV9`,
    ]);
    expect(violations(ADAPTER, "fetchPool.getFirstAvailable([]);")).toEqual([
      `${ADAPTER} calls fetchPool.getFirstAvailable`,
    ]);
    // The control: the adapter's own Fetch is one of the two raw calls.
    expect(violations(ADAPTER, "lib.fetchV13.api.async(connection, 250);")).toEqual([]);
    expect(violations(ADAPTER, "lib.createAdminClient({});")).toEqual([`${ADAPTER} calls lib.createAdminClient`]);
    expect(violations(ADAPTER, `import { produceV11 } from "${LIBRARY}";`)).toEqual([
      `${ADAPTER} imports ${LIBRARY} outside loadPlatformatic()`,
      `${ADAPTER} names raw API produceV11`,
    ]);
    expect(violations(ADAPTER, 'admin["deleteTopics"]({});')).toEqual([
      `${ADAPTER} reads a computed member of admin`,
      `${ADAPTER} names deleteTopics`,
    ]);
    expect(violations(ADAPTER, "const a = admin as never;")).toEqual([
      `${ADAPTER} casts admin past its declared shape`,
    ]);
    expect(
      violations(ADAPTER, "interface AdminLike { alterPartitionReassignments(o: object): Promise<void> }"),
    ).toEqual([`${ADAPTER} declares AdminLike as alterPartitionReassignments`]);
    expect(
      violations(
        ADAPTER,
        'async function loadPlatformatic() { const lib = await import("x"); return { Admin: lib.Admin, Consumer: lib.Consumer, Connection: lib.Connection, consumerGroupDescribeV0: lib.consumerGroupDescribeV0, Producer: lib.Producer }; }',
      ),
    ).toEqual([
      `${ADAPTER} writes loadPlatformatic() other than as pinned`,
      `${ADAPTER} loads Admin, Connection, Consumer, Producer, consumerGroupDescribeV0`,
      `${ADAPTER} names Producer`,
      `${ADAPTER} names Producer`,
    ]);
  });

  // Each form below compiles and passes lint in the adapter, and each reaches a member no
  // shape declares (measured with tsc, ESLint and oxlint on the adapter, 2026-09-25). Each is
  // refused on its own and written after the real adapter, which adds no finding of its own.
  test.each<[string, string, string[]]>([
    [
      "the Consumer's own fetch, which a read never takes (spec 3.6 K8)",
      "consumer.fetch({});",
      [`${ADAPTER} calls consumer.fetch`],
    ],
    [
      "a member of a connection that no shape declares",
      "connection.reauthenticate();",
      [`${ADAPTER} calls connection.reauthenticate`],
    ],
    [
      "a cast of a receiver to a wider type",
      "(admin as AdminLike & { alterPartitionReassignments(o: object): Promise<void> }).alterPartitionReassignments({});",
      [`${ADAPTER} casts admin past its declared shape`],
    ],
    ["an angle-bracket cast", "const a = <never>admin;", [`${ADAPTER} casts admin past its declared shape`]],
    [
      "a cast of an instance as it is built",
      "const w = new lib.Admin({}) as never;",
      [`${ADAPTER} casts new lib.Admin({}) past its declared shape`],
    ],
    [
      "a cast of a pooled connection, whose socket writes raw bytes",
      "const c = (await fetchPool.get(broker)) as ConnectionLike & { socket: { write(b: Uint8Array): boolean } };",
      [`${ADAPTER} casts (await fetchPool.get(broker)) past its declared shape`, `${ADAPTER} names socket`],
    ],
    [
      "a cast of an answer",
      "const m = (await admin.metadata({})) as LibMetadata;",
      [`${ADAPTER} casts (await admin.metadata({})) past its declared shape`],
    ],
    [
      "a raw call's answer put through never",
      "const r = (await lib.fetchV13.api.async(connection, 250)) as never;",
      [`${ADAPTER} casts (await lib.fetchV13.api.async(connection, 250)) past its declared shape`],
    ],
    [
      "a cast of a library object kept in another name",
      "const c = consumer;\nawait (c as unknown as { fetch(o: object): Promise<unknown> }).fetch({});",
      [`${ADAPTER} casts c as unknown past its declared shape`, `${ADAPTER} casts c past its declared shape`],
    ],
    [
      "a cast of a parameter that holds a library object",
      "const read = async (c: ConsumerLike) => (c as unknown as { fetch(o: object): Promise<unknown> }).fetch({});",
      [`${ADAPTER} casts c as unknown past its declared shape`, `${ADAPTER} casts c past its declared shape`],
    ],
    ["a name typed any", "const a: any = admin;", [`${ADAPTER} writes the type any`]],
    [
      "a cast to any",
      "const a = admin as any;",
      [`${ADAPTER} casts admin past its declared shape`, `${ADAPTER} writes the type any`],
    ],
    [
      "the constructor's prototype",
      "admin.constructor.prototype.alterPartitionReassignments.call(admin, {});",
      [`${ADAPTER} reads the constructor of admin`, `${ADAPTER} reads the prototype of admin.constructor`],
    ],
    [
      "the constructor of an alias, by a string key",
      'const a = admin;\na["constructor"].prototype.alterPartitionReassignments.call(a, {});',
      [`${ADAPTER} reads the constructor of a`, `${ADAPTER} reads the prototype of a["constructor"]`],
    ],
    [
      "the prototype of a library class, which tsc types any and which holds every member of the class",
      "await lib.Consumer.prototype.fetch.call(consumer, {});",
      [`${ADAPTER} reads the prototype of lib.Consumer`],
    ],
    [
      "a member of a prototype by a name built at run time",
      'const members = lib.Admin.prototype;\nawait members[["delete", "Topics"].join("")].call(admin, { topics: ["orders"] });',
      [`${ADAPTER} reads the prototype of lib.Admin`],
    ],
    [
      "the prototype by a string key",
      'await lib.Consumer["prototype"].fetch.call(consumer, {});',
      [`${ADAPTER} reads a computed member of lib`, `${ADAPTER} reads the prototype of lib.Consumer`],
    ],
    [
      "the prototype of a class kept in a name",
      "const Reader = lib.Consumer;\nawait Reader.prototype.fetch.call(consumer, {});",
      [`${ADAPTER} reads the prototype of Reader`],
    ],
    [
      "the prototype by destructuring",
      "const { prototype: members } = lib.Admin;\nawait members.describeAcls.call(admin, {});",
      [`${ADAPTER} names prototype`],
    ],
    ["the constructor by destructuring", "const { constructor: Admin } = admin;", [`${ADAPTER} names constructor`]],
    [
      "a call on a receiver held by another object",
      "this.admin.alterPartitionReassignments({});",
      [`${ADAPTER} calls admin.alterPartitionReassignments`],
    ],
    [
      "a type predicate that gives a name a member no shape declares",
      'function hasFetch(x: unknown): x is { fetch(options: object): Promise<unknown> } {\n  return typeof x === "object";\n}\nconst c = consumer;\nif (hasFetch(c)) await c.fetch({});',
      [`${ADAPTER} declares the type predicate x is { fetch(options: object): Promise<unknown>; }`],
    ],
    [
      "an assertion signature",
      'function assertFetch(x: unknown): asserts x is { fetch(options: object): Promise<unknown> } {\n  if (typeof x !== "object") throw new Error("no");\n}\nconst c = consumer;\nassertFetch(c);\nawait c.fetch({});',
      [`${ADAPTER} declares the type predicate asserts x is { fetch(options: object): Promise<unknown>; }`],
    ],
    [
      "an overload that answers another type",
      "function widen(x: ConsumerLike): { fetch(o: object): Promise<unknown> };\nfunction widen(x: unknown): unknown {\n  return x;\n}\nawait widen(consumer).fetch({});",
      [`${ADAPTER} declares widen without a body`],
    ],
    [
      "an ambient declaration",
      "declare const wide: { fetch(o: object): Promise<unknown> };",
      [`${ADAPTER} writes a declare modifier`],
    ],
    [
      "a class that extends a library class and declares one of its members",
      "class Reader extends lib.Consumer {\n  declare fetch: (o: object) => Promise<unknown>;\n}\nawait new Reader({}).fetch({});",
      [`${ADAPTER} declares a class that extends lib.Consumer`, `${ADAPTER} writes a declare modifier`],
    ],
    [
      "a class merged with an interface that declares a member",
      "interface Reader {\n  fetch(o: object): Promise<unknown>;\n}\nclass Reader extends lib.Consumer {}\nawait new Reader({}).fetch({});",
      [`${ADAPTER} declares a class that extends lib.Consumer`],
    ],
    [
      "a class expression that extends a library class",
      "const Reader = class extends lib.Admin {};",
      [`${ADAPTER} declares a class that extends lib.Admin`],
    ],
    [
      "a method overload",
      "class Probe {\n  read(x: ConsumerLike): { fetch(o: object): Promise<unknown> };\n  read(x: unknown): unknown {\n    return x;\n  }\n}",
      [`${ADAPTER} declares read without a body`],
    ],
    [
      "a constructor overload",
      "class Probe {\n  constructor(x: string);\n  constructor(x: unknown) {}\n}",
      [`${ADAPTER} declares a constructor without a body`],
    ],
    [
      "declare global, which adds members to every object",
      "declare global {\n  interface Object {\n    describeAcls(o: object): Promise<unknown>;\n  }\n}",
      [`${ADAPTER} declares the module or namespace global`, `${ADAPTER} writes a declare modifier`],
    ],
    [
      "a namespace",
      "namespace Wire {\n  export const raw = 1;\n}",
      [`${ADAPTER} declares the module or namespace Wire`],
    ],
    [
      "a described @ts-expect-error, which ESLint's ban-ts-comment lets through",
      "// @ts-expect-error the library has it\nawait a.alterPartitionReassignments({});",
      [`${ADAPTER} switches tsc off with @ts-expect-error`],
    ],
    ["a @ts-ignore", "/* @ts-ignore */ const x = 1;", [`${ADAPTER} switches tsc off with @ts-ignore`]],
    ["a @ts-nocheck", "// @ts-nocheck\nexport {};", [`${ADAPTER} switches tsc off with @ts-nocheck`]],
    [
      "a shape member whose signature widens what it answers",
      "interface ConnectionPoolLike { get(broker: { host: string; port: number }): Promise<ConnectionLike & { socket: unknown }>; close(): Promise<void> }",
      [
        `${ADAPTER} declares ConnectionPoolLike.get as get(broker: { host: string; port: number; }): Promise<ConnectionLike & { socket: unknown; }>;`,
        `${ADAPTER} names socket`,
      ],
    ],
    [
      "a shape that inherits members",
      "interface ConnectionLike extends Writer { connect(host: string, port: number): Promise<void>; close(): Promise<void> }",
      [`${ADAPTER} declares ConnectionLike extends Writer`],
    ],
    [
      "a shape with an index signature",
      "interface ConnectionLike { [member: string]: unknown; connect(host: string, port: number): Promise<void>; close(): Promise<void> }",
      [`${ADAPTER} declares ConnectionLike as [member: string]: unknown;, close, connect`],
    ],
    [
      "a shape declared as a type alias",
      "type ConsumerLike = { close(): Promise<void> };",
      [`${ADAPTER} declares ConsumerLike other than as an interface`],
    ],
    [
      "a class that merges members into a shape",
      "class ConnectionLike { declare reauthenticate: () => void; }",
      [`${ADAPTER} declares ConnectionLike other than as an interface`, `${ADAPTER} writes a declare modifier`],
    ],
    [
      "a computed member of a cast receiver",
      'const m = (admin as AdminLike)["metadata"];',
      [`${ADAPTER} reads a computed member of admin`, `${ADAPTER} casts admin past its declared shape`],
    ],
    [
      "a computed member of an angle-bracket cast",
      'const m = (<AdminLike>admin)["metadata"];',
      [`${ADAPTER} reads a computed member of admin`, `${ADAPTER} casts admin past its declared shape`],
    ],
    [
      "a computed member through satisfies",
      'const m = (admin satisfies AdminLike)["metadata"];',
      [`${ADAPTER} reads a computed member of admin`],
    ],
    [
      "a computed member through a non-null assertion",
      'const m = admin!["metadata"];',
      [`${ADAPTER} reads a computed member of admin`],
    ],
    ["an export of every name of another module", 'export * from "./read";', [`${ADAPTER} exports *`]],
    ["an export of another module as a namespace", 'export * as raw from "./read";', [`${ADAPTER} exports raw`]],
    ["a default export", "export default {};", [`${ADAPTER} exports default`]],
    ["an exported function beyond the pinned ones", "export function leak() {}", [`${ADAPTER} exports leak`]],
    [
      "a re-export of a library class, whose socket any provider file could then write",
      `export { Connection as KafkaConnection } from "${LIBRARY}";`,
      [`${ADAPTER} imports ${LIBRARY} outside loadPlatformatic()`, `${ADAPTER} exports KafkaConnection`],
    ],
    [
      "a second import of the library",
      `const raw = await import("${LIBRARY}");`,
      [`${ADAPTER} imports ${LIBRARY} outside loadPlatformatic()`],
    ],
    [
      "the library's own types outside loadPlatformatic()",
      `type Raw = typeof import("${LIBRARY}");`,
      [`${ADAPTER} imports ${LIBRARY} outside loadPlatformatic()`],
    ],
    ["an export beyond the pinned ones", "export let rawLibrary: unknown;", [`${ADAPTER} exports rawLibrary`]],
    [
      "a write reached by reflection",
      'await Reflect.get(admin, "deleteTopics").call(admin, {});',
      [`${ADAPTER} names deleteTopics`],
    ],
    [
      "a pooled connection's raw socket reached through a wider name and a cast",
      "const o: object = await fetchPool.get(broker);\n(o as { socket: { write(b: Uint8Array): boolean } }).socket.write(frame);",
      [`${ADAPTER} casts o past its declared shape`, `${ADAPTER} names socket`, `${ADAPTER} names socket`],
    ],
  ])("the detector refuses %s", (_label, source, expected) => {
    expect(violations(ADAPTER, source)).toEqual(expected);
    expect(violations(ADAPTER, withTheAdapter(source))).toEqual(expected);
  });

  test.each<[string, string]>([
    [
      "a raw call's answer given the response shape the adapter declares for it, as pinned",
      "const r = (await lib.consumerGroupDescribeV0.api.async(connection, [listing.groupId], false)) as LibGroupDescribeResponse;",
    ],
    ["a pinned predicate, written once", "const isCode = (code: unknown): code is string => true;"],
    [
      "a pinned option written as its literal under a quoted key",
      'const o = { "autocreateTopics": false, groupProtocol: "classic" };',
    ],
    ["a computed property name that is a literal", 'const o = { ["clientId"]: "c", [0]: 0 };'],
    ["a class that implements a type and extends nothing", "class Probe implements Iterable<number> {}"],
    ["loadPlatformatic() as pinned, which imports the library, types included, and casts its members", PINNED_LOADER],
    ["an export the adapter is pinned to", 'export const KAFKA_SENTINEL_GROUP_ID = "libredb-studio-never-joined";'],
  ])("the detector lets %s through", (_label, source) => {
    expect(violations(ADAPTER, source)).toEqual([]);
  });

  test("an assertion or a predicate written more often than the pin holds it is refused", () => {
    expect(violations(ADAPTER, "const a = e.apiId as string;\nconst b = e.apiId as string;")).toEqual([
      `${ADAPTER} casts e.apiId past its declared shape`,
    ]);
    expect(violations(ADAPTER, withTheAdapter("const again = e.apiId as string;"))).toEqual([
      `${ADAPTER} casts e.apiId past its declared shape`,
    ]);
    expect(
      violations(ADAPTER, withTheAdapter("const again = (value: unknown): value is LibRawMetadata => true;")),
    ).toEqual([`${ADAPTER} declares the type predicate value is LibRawMetadata`]);
  });

  // Inside loadPlatformatic() the library has its own full types and its members may be cast, so
  // the function is pinned whole: each line below compiles there, and each leaves it otherwise
  // unchanged (measured with tsc, ESLint and oxlint on the adapter, 2026-09-25).
  test.each<[string, string]>([
    [
      "a call on an instance built there",
      '  await new lib.Admin({ clientId: "c", bootstrapBrokers: [] }).describeAcls({ filters: {} } as never);',
    ],
    [
      "the Consumer's own fetch on an instance built there",
      '  await new lib.Consumer({ clientId: "c", bootstrapBrokers: [], groupId: KAFKA_SENTINEL_GROUP_ID }).fetch({} as never);',
    ],
    ["a library member kept in a name outside it", "  Object.assign(globalThis, { kept: lib.Admin });"],
  ])("loadPlatformatic() with %s is refused", (_label, line) => {
    expect(violations(ADAPTER, withTheLoaderChanged(line))).toEqual([
      `${ADAPTER} writes loadPlatformatic() other than as pinned`,
    ]);
  });

  const TAKES_THE_LIBRARY =
    "index.ts takes the library from loadPlatformatic() other than straight into createPlatformaticClient()";
  const DECLARES_THE_CLIENT = "index.ts declares createPlatformaticClient other than as its import from the adapter";
  test.each<[string, string, string[]]>([
    [
      "kept in a name",
      'import { loadPlatformatic } from "./platformatic-client";\nconst lib = await loadPlatformatic();',
      [TAKES_THE_LIBRARY],
    ],
    [
      "imported under another name",
      'import { loadPlatformatic as load } from "./platformatic-client";',
      [TAKES_THE_LIBRARY],
    ],
    ["imported from another module", 'import { loadPlatformatic } from "./read";', [TAKES_THE_LIBRARY]],
    [
      "reached through a namespace",
      'import * as adapter from "./platformatic-client";\nconst lib = adapter.loadPlatformatic();',
      [TAKES_THE_LIBRARY],
    ],
    [
      "reached by a string key",
      'import * as adapter from "./platformatic-client";\nconst lib = await adapter["loadPlatformatic"]();',
      [TAKES_THE_LIBRARY],
    ],
    [
      "awaited into another function",
      'import { loadPlatformatic } from "./platformatic-client";\nconst lib = keep(await loadPlatformatic());',
      [TAKES_THE_LIBRARY],
    ],
    [
      "awaited into another function beside the client's own import",
      'import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client";\nconst lib = keep(await loadPlatformatic());',
      [TAKES_THE_LIBRARY],
    ],
    [
      "handed to a createPlatformaticClient the file declares itself",
      'import { loadPlatformatic } from "./platformatic-client";\nfunction createPlatformaticClient(options: object, lib: unknown) {\n  return lib;\n}\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [DECLARES_THE_CLIENT, TAKES_THE_LIBRARY],
    ],
    [
      "handed to a createPlatformaticClient imported from another module",
      'import { createPlatformaticClient } from "./read";\nimport { loadPlatformatic } from "./platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [DECLARES_THE_CLIENT, TAKES_THE_LIBRARY],
    ],
    [
      "handed to a createPlatformaticClient a parameter shadows",
      'import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client";\nconst make = async (o: object, createPlatformaticClient: (o: object, l: unknown) => unknown) =>\n  createPlatformaticClient(o, await loadPlatformatic());',
      [DECLARES_THE_CLIENT, TAKES_THE_LIBRARY],
    ],
    [
      "handed on with a loader the file never imports",
      'import { createPlatformaticClient } from "./platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [TAKES_THE_LIBRARY],
    ],
    [
      "re-exported with every name of the adapter",
      'export * from "./platformatic-client";',
      ["index.ts re-exports the adapter"],
    ],
    [
      "re-exported with the adapter as a namespace",
      'export * as adapter from "./platformatic-client";',
      ["index.ts re-exports the adapter"],
    ],
    [
      "handed to a createPlatformaticClient the file never imports",
      'import { loadPlatformatic } from "./platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [TAKES_THE_LIBRARY],
    ],
    [
      "imported under the client's name",
      'import { loadPlatformatic as createPlatformaticClient } from "./platformatic-client";',
      [TAKES_THE_LIBRARY, DECLARES_THE_CLIENT],
    ],
    [
      "handed straight to the client, the one way it is taken",
      'import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [],
    ],
    [
      "handed straight to the client, which the file also passes on as a value",
      'import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client";\nconst make = createPlatformaticClient;\nconst read = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [],
    ],
    [
      "left beside another of the adapter's exports re-exported by name",
      'export { translateError } from "./platformatic-client";',
      [],
    ],
    // The adapter is the file its module name resolves to, never a file whose name ends as its does.
    [
      "handed to the client of a module whose name ends as the adapter's does, which is not the adapter",
      'import { createPlatformaticClient, loadPlatformatic } from "./nested/platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [DECLARES_THE_CLIENT, TAKES_THE_LIBRARY, TAKES_THE_LIBRARY],
    ],
    [
      "handed straight to the client, imported from the adapter by a name TypeScript resolves to it",
      'import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client.js";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [],
    ],
    [
      "re-exported with every name of the adapter, by a name TypeScript resolves to it",
      'export * from "./platformatic-client.js";',
      ["index.ts re-exports the adapter"],
    ],
    [
      "left alone by a re-export of every name of a module whose name ends as the adapter's does",
      'export * from "./nested/platformatic-client";',
      [],
    ],
  ])("outside the adapter, the library from loadPlatformatic() %s", (_label, source, expected) => {
    expect(violations("index.ts", source)).toEqual(expected);
  });

  // Any binding of the name but the adapter's import would make a call of it another function.
  test.each<[string, string, string[]]>([
    ["a variable", "const createPlatformaticClient = (o: object, l: unknown) => l;", [DECLARES_THE_CLIENT]],
    ["a default import", 'import createPlatformaticClient from "./read";', [DECLARES_THE_CLIENT]],
    ["a namespace import", 'import * as createPlatformaticClient from "./read";', [DECLARES_THE_CLIENT]],
    ["an import-equals", 'import createPlatformaticClient = require("./read");', [DECLARES_THE_CLIENT]],
    ["a class", "class createPlatformaticClient {}", [DECLARES_THE_CLIENT]],
    ["a class expression's own name", "const Make = class createPlatformaticClient {};", [DECLARES_THE_CLIENT]],
    ["a function expression's own name", "const make = function createPlatformaticClient() {};", [DECLARES_THE_CLIENT]],
    ["a destructuring", "const { createPlatformaticClient } = other;", [DECLARES_THE_CLIENT]],
    ["an enum", "enum createPlatformaticClient {}", [DECLARES_THE_CLIENT]],
    ["a catch variable", "try {\n  go();\n} catch (createPlatformaticClient) {}", [DECLARES_THE_CLIENT]],
    [
      "a namespace",
      "namespace createPlatformaticClient {}",
      ["index.ts declares the module or namespace createPlatformaticClient", DECLARES_THE_CLIENT],
    ],
  ])("outside the adapter, createPlatformaticClient bound by %s is refused", (_label, source, expected) => {
    expect(violations("index.ts", source)).toEqual(expected);
  });

  // The adapter is the one file of its name at the provider's root, never another whose path ends as its does.
  test.each(["nested/platformatic-client.ts", "legacy-platformatic-client.ts"])(
    "a provider file whose path ends as the adapter's does is no adapter: %s may not import the library",
    (file) => {
      expect(violations(file, `import { Admin } from "${LIBRARY}";`)).toEqual([`${file} imports ${LIBRARY}`]);
    },
  );

  test("a provider file in a subdirectory hands the library on through the adapter's own path", () => {
    expect(
      violations(
        "nested/wire.ts",
        'import { createPlatformaticClient, loadPlatformatic } from "../platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      ),
    ).toEqual([]);
  });

  test.each<[string, string, string]>([
    [
      "an assignment",
      "base.autocreateTopics = true;",
      `${ADAPTER} names autocreateTopics other than as a property set to false`,
    ],
    [
      "a computed key",
      'const o = { ["autocreateTopics"]: false };',
      `${ADAPTER} names autocreateTopics other than as a property set to false`,
    ],
    [
      "a template key",
      'const o = { [`autocreate${"Topics"}`]: true };',
      `${ADAPTER} computes a property name that is not a literal`,
    ],
    [
      "a joined key",
      'const o = { groupProtocol: "classic", ...{ [["group", "Protocol"].join("")]: "consumer" } };',
      `${ADAPTER} computes a property name that is not a literal`,
    ],
    [
      "a quoted key",
      'const o = { "autocreateTopics": true };',
      `${ADAPTER} sets autocreateTopics to something other than false`,
    ],
    ["a variable", "const o = { groupProtocol };", `${ADAPTER} sets groupProtocol from a variable`],
    [
      "a later assignment",
      'options.groupProtocol = "consumer";',
      `${ADAPTER} names groupProtocol other than as a property set to "classic"`,
    ],
  ])("a pinned option written through %s is refused", (_label, source, expected) => {
    expect(violations(ADAPTER, source)).toEqual([expected]);
  });

  test.each<[string, string]>([
    ["an object literal", "const o = { [key]: 1 };"],
    ["a destructuring", 'const { [["delete", "Topics"].join("")]: write } = admin;'],
    ["a class member", "class Reader {\n  [key]() {}\n}"],
    ["an accessor", "const o = { get [key]() {\n  return 1;\n} };"],
  ])("any provider file is refused a property name computed at run time in %s", (_label, source) => {
    expect(violations("read.ts", source)).toEqual(["read.ts computes a property name that is not a literal"]);
  });

  test.each<[string, string, string[]]>([
    ["declare module", 'declare module "x" {}', ['read.ts declares the module or namespace "x"']],
    ["a namespace", "namespace Wire {}", ["read.ts declares the module or namespace Wire"]],
    [
      "declare global",
      "export {};\ndeclare global {\n  interface Object {\n    x(): void;\n  }\n}",
      ["read.ts declares the module or namespace global"],
    ],
  ])("any provider file is refused %s, which can merge members into any type", (_label, source, expected) => {
    expect(violations("read.ts", source)).toEqual(expected);
  });

  test.each<[string, string, string[]]>([
    ["require", `const kafka = require("${LIBRARY}");`, ["read.ts loads a module through require"]],
    [
      "a createRequire loader kept in a name",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst kafka = load("${LIBRARY}");`,
      ["read.ts loads a module through load"],
    ],
    [
      "a createRequire loader called in place",
      `import { createRequire } from "node:module";\nconst kafka = createRequire(import.meta.url)("${LIBRARY}");`,
      ["read.ts loads a module through createRequire(import.meta.url)"],
    ],
    [
      "createRequire imported under another name",
      `import { createRequire as make } from "node:module";\nconst kafka = make(import.meta.url)("${LIBRARY}");`,
      ["read.ts loads a module through make(import.meta.url)"],
    ],
    [
      "createRequire read off a namespace",
      `import * as nodeModule from "node:module";\nconst kafka = nodeModule.createRequire(import.meta.url)("${LIBRARY}");`,
      ["read.ts loads a module through nodeModule.createRequire(import.meta.url)"],
    ],
    [
      "import.meta.require",
      `const kafka = import.meta.require("${LIBRARY}");`,
      ["read.ts loads a module through import.meta.require"],
    ],
    [
      "module.require",
      `const kafka = module.require("${LIBRARY}");`,
      ["read.ts loads a module through module.require"],
    ],
    [
      "require kept in another name",
      `const load = require;\nconst kafka = load("${LIBRARY}");`,
      ["read.ts loads a module through load"],
    ],
    [
      "require kept in a name bound after the one that calls it",
      `const load = alias;\nconst alias = require;\nconst kafka = load("${LIBRARY}");`,
      ["read.ts loads a module through load"],
    ],
    [
      "a createRequire loader as a parameter's default",
      `function read(load = createRequire(import.meta.url)) {\n  return load("${LIBRARY}");\n}`,
      ["read.ts loads a module through load"],
    ],
    [
      "a createRequire loader assigned to a name",
      `let load;\nload = createRequire(import.meta.url);\nconst kafka = load("${LIBRARY}");`,
      ["read.ts loads a module through load"],
    ],
    [
      "createRequire taken by destructuring",
      `const { createRequire: make } = nodeModule;\nconst kafka = make(import.meta.url)("${LIBRARY}");`,
      ["read.ts loads a module through make(import.meta.url)"],
    ],
    [
      "require taken by destructuring",
      `const { require: load } = module;\nconst kafka = load("${LIBRARY}");`,
      ["read.ts loads a module through load"],
    ],
    [
      "require behind a comma operator",
      `const kafka = (0, require)("${LIBRARY}");`,
      ["read.ts loads a module through (0, require)"],
    ],
    [
      "require behind an assertion",
      `const kafka = (require as NodeRequire)("${LIBRARY}");`,
      ["read.ts loads a module through (require as NodeRequire)"],
    ],
    [
      "require read by a string key",
      `const kafka = module["require"]("${LIBRARY}");`,
      ['read.ts loads a module through module["require"]'],
    ],
    // A require function called through call or apply, or bound by bind, loads what it is handed
    // (measured under Bun 1.4.2 and Node 24.14.0, 2026-09-25: each form below loads the library).
    [
      "require through call",
      `const kafka = require.call(null, "${LIBRARY}");`,
      ["read.ts loads a module through require.call"],
    ],
    [
      "require through apply",
      `const kafka = require.apply(null, ["${LIBRARY}"]);`,
      ["read.ts loads a module through require.apply"],
    ],
    [
      "call read by a string key",
      `const kafka = require["call"](null, "${LIBRARY}");`,
      ['read.ts loads a module through require["call"]'],
    ],
    [
      "require bound by bind at the call",
      `const kafka = require.bind(null)("${LIBRARY}");`,
      ["read.ts loads a module through require.bind(null)"],
    ],
    [
      "require bound to the module by bind",
      `const kafka = require.bind(null, "${LIBRARY}")();`,
      [`read.ts loads a module through require.bind(null, "${LIBRARY}")`],
    ],
    [
      "require bound to the module by one bind and bound again",
      `const kafka = require.bind(null, "${LIBRARY}").bind(null)();`,
      [`read.ts loads a module through require.bind(null, "${LIBRARY}").bind(null)`],
    ],
    [
      "require bound to the module by bind, in parentheses",
      `const kafka = (require.bind(null, "${LIBRARY}"))();`,
      [`read.ts loads a module through (require.bind(null, "${LIBRARY}"))`],
    ],
    [
      "require bound to the module by bind and called through call",
      `const kafka = require.bind(null, "${LIBRARY}").call(null);`,
      [`read.ts loads a module through require.bind(null, "${LIBRARY}").call`],
    ],
    [
      "require bound to the module by bind and called through apply",
      `const kafka = require.bind(null, "${LIBRARY}").apply(null, []);`,
      [`read.ts loads a module through require.bind(null, "${LIBRARY}").apply`],
    ],
    [
      "require bound by bind and kept in a name",
      `const load = require.bind(null);\nconst kafka = load("${LIBRARY}");`,
      ["read.ts loads a module through load"],
    ],
    [
      "a bound require called through call",
      `const kafka = require.bind(module).call(null, "${LIBRARY}");`,
      ["read.ts loads a module through require.bind(module).call"],
    ],
    [
      "module.require through call",
      `const kafka = module.require.call(module, "${LIBRARY}");`,
      ["read.ts loads a module through module.require.call"],
    ],
    [
      "import.meta.require through apply",
      `const kafka = import.meta.require.apply(null, ["${LIBRARY}"]);`,
      ["read.ts loads a module through import.meta.require.apply"],
    ],
    [
      "a createRequire loader through call",
      `const kafka = createRequire(import.meta.url).call(null, "${LIBRARY}");`,
      ["read.ts loads a module through createRequire(import.meta.url).call"],
    ],
    [
      "createRequire called through call",
      `const kafka = createRequire.call(null, import.meta.url)("${LIBRARY}");`,
      ["read.ts loads a module through createRequire.call(null, import.meta.url)"],
    ],
    [
      "createRequire called through apply",
      `const kafka = createRequire.apply(null, [import.meta.url])("${LIBRARY}");`,
      ["read.ts loads a module through createRequire.apply(null, [import.meta.url])"],
    ],
    [
      "createRequire bound by bind and kept in a name",
      `const make = createRequire.bind(null);\nconst kafka = make(import.meta.url)("${LIBRARY}");`,
      ["read.ts loads a module through make(import.meta.url)"],
    ],
  ])("a provider file loading the library through %s is refused", (_label, source, expected) => {
    expect(violations("read.ts", source)).toEqual([...expected, `read.ts imports ${LIBRARY}`]);
    expect(importsLibrary("x.ts", source)).toBe(true);
  });

  test("a provider file loads no module through a require function, whatever the module", () => {
    expect(violations("read.ts", 'const load = createRequire(import.meta.url);\nconst m = load("./read");')).toEqual([
      "read.ts loads a module through load",
    ]);
    expect(violations("read.ts", "const m = require(name);")).toEqual([
      "read.ts loads a module through require",
      "read.ts imports a computed module name",
    ]);
    expect(violations("read.ts", "const m = require.apply(null, names);")).toEqual([
      "read.ts loads a module through require.apply",
      "read.ts imports a computed module name",
    ]);
  });

  test("a provider file importing the library's files by path is refused", () => {
    expect(
      violations(
        "read.ts",
        'import * as kafka from "../../../../../../node_modules/@platformatic/kafka/dist/index.js";',
      ),
    ).toEqual([`read.ts imports ${LIBRARY}`]);
  });

  // Invalid TypeScript, which tsc refuses too, but each parses with no diagnostic, so it is read.
  test.each<[string, string]>([
    ["an export-from", "export * from someName;"],
    ["an import-equals", "import kafka = require(someName);"],
    ["an import in a type position", "type Lib = typeof import(someName);"],
  ])("a module name that is not a plain string is refused in %s", (_label, source) => {
    expect(violations("read.ts", source)).toEqual(["read.ts imports a computed module name"]);
  });

  test("an import in a type position is an import", () => {
    expect(violations("read.ts", `type Lib = typeof import("${LIBRARY}");`)).toEqual([`read.ts imports ${LIBRARY}`]);
  });

  test.each<[string, string]>([
    ["a static import", `import { Admin } from "${LIBRARY}";`],
    ["a type-only import", `import type { Admin } from "${LIBRARY}";`],
    ["a re-export", `export { Admin } from "${LIBRARY}";`],
    ["an import-equals", `import kafka = require("${LIBRARY}");`],
    ["a require", `const kafka = require("${LIBRARY}");`],
    ["a dynamic import", `const kafka = await import("${LIBRARY}");`],
    ["an import in a type position", `let lib: typeof import("${LIBRARY}");`],
    ["a specifier spelled with escapes", 'import { Admin } from "\\u0040platformatic\\u002fkafka";'],
    ["a subpath of the package", `import { Admin } from "${LIBRARY}/dist/index.js";`],
    ["a path into the package's files", 'import * as kafka from "./node_modules/@platformatic/kafka/dist/index.js";'],
    [
      "an import() of a path into them",
      'const kafka = await import("./node_modules/@platformatic/kafka/dist/index.js");',
    ],
    [
      "the tsconfig alias to a path into them",
      'import * as kafka from "@/../node_modules/@platformatic/kafka/dist/index.js";',
    ],
  ])("the importer check counts %s", (_label, source) => {
    expect(importsLibrary("x.ts", source)).toBe(true);
  });

  // The TLS test resolves the library's file and writes the import of a Node child as text, so
  // the file itself imports nothing (spec 10); the dependency test names the library in prose.
  test.each<[string, string]>([
    ["a mention in a comment", `// import { Admin } from "${LIBRARY}";\nexport {};`],
    ["a mention in a string", `const note = "reads through ${LIBRARY}";`],
    ["a resolution of its file", `const file = Bun.resolveSync("${LIBRARY}", import.meta.dir);`],
    ["a resolution through require", `const file = require.resolve("${LIBRARY}");`],
    ["a resolution through createRequire", `const file = createRequire(import.meta.url).resolve("${LIBRARY}");`],
    ["a resolution through import.meta", `const file = import.meta.resolve("${LIBRARY}");`],
    [
      "a resolution through require.resolve called through call",
      `const file = require.resolve.call(null, "${LIBRARY}");`,
    ],
    ["a call through call of a function that is no require function", `const k = walk.call(null, "${LIBRARY}");`],
    ["an apply of a function that is no require function", `const k = walk.apply(null, ["${LIBRARY}"]);`],
    ["a require bound to the module by bind and never called", `const load = require.bind(null, "${LIBRARY}");`],
    ["an import of another package", `import { Admin } from "${LIBRARY}-admin";`],
    ["a path into another package", 'import ts from "./node_modules/typescript/lib/typescript.js";'],
  ])("the importer check does not count %s", (_label, source) => {
    expect(importsLibrary("x.ts", source)).toBe(false);
  });

  const TEST_FILE = "tests/unit/db/kafka/x.test.ts";
  const THE_ADAPTER = "@/lib/db/providers/stream/kafka/platformatic-client";
  test.each<[string, string, boolean]>([
    ["loadPlatformatic imported by name", `import { loadPlatformatic } from "${THE_ADAPTER}";`, true],
    [
      "loadPlatformatic imported under another name",
      `import { loadPlatformatic as load } from "${THE_ADAPTER}";`,
      true,
    ],
    ["the adapter as a namespace", `import * as adapter from "${THE_ADAPTER}";`, true],
    ["the adapter through import-equals", `import adapter = require("${THE_ADAPTER}");`, true],
    ["the adapter through import()", `const adapter = await import("${THE_ADAPTER}");`, true],
    ["the adapter through require", `const adapter = require("${THE_ADAPTER}");`, true],
    ["every name of the adapter re-exported", `export * from "${THE_ADAPTER}";`, true],
    ["loadPlatformatic re-exported", `export { loadPlatformatic } from "${THE_ADAPTER}";`, true],
    [
      "loadPlatformatic re-exported under another name",
      `export { loadPlatformatic as load } from "${THE_ADAPTER}";`,
      true,
    ],
    ["only the adapter's types re-exported", `export type { PlatformaticLib } from "${THE_ADAPTER}";`, false],
    ["loadPlatformatic in a type-only re-export", `export type { loadPlatformatic } from "${THE_ADAPTER}";`, false],
    ["loadPlatformatic re-exported as a type only", `export { type loadPlatformatic } from "${THE_ADAPTER}";`, false],
    ["the adapter through a type-only import-equals", `import type adapter = require("${THE_ADAPTER}");`, false],
    ["the adapter's types in a type position", `let lib: typeof import("${THE_ADAPTER}");`, false],
    [
      "the adapter by a relative path",
      'import { loadPlatformatic } from "../../../../src/lib/db/providers/stream/kafka/platformatic-client";',
      true,
    ],
    ["only the adapter's types", `import type { PlatformaticLib } from "${THE_ADAPTER}";`, false],
    ["loadPlatformatic as a type only", `import { type loadPlatformatic } from "${THE_ADAPTER}";`, false],
    ["loadPlatformatic in a type-only import", `import type { loadPlatformatic } from "${THE_ADAPTER}";`, false],
    ["another export of the adapter", `import { translateError } from "${THE_ADAPTER}";`, false],
    ["a module of the same name elsewhere", 'import { loadPlatformatic } from "./platformatic-client";', false],
    [
      "a path whose text holds the adapter's and that reaches no file",
      'import { loadPlatformatic } from "./stream/kafka/platformatic-client";',
      false,
    ],
    [
      "the adapter by a path TypeScript normalizes",
      'import { loadPlatformatic } from "@/lib/db/providers/stream/kafka/../kafka/platformatic-client";',
      true,
    ],
    [
      "the adapter by a file URL",
      `import { loadPlatformatic } from ${JSON.stringify(pathToFileURL(join(PROVIDER_DIR, ADAPTER)).href)};`,
      true,
    ],
  ])("outside the provider, a file takes the adapter's loader through %s", (_label, source, takes) => {
    const sf = ts.createSourceFile(TEST_FILE, source, ts.ScriptTarget.Latest, true);
    expect(takesTheLoader(TEST_FILE, sf, ROOT)).toBe(takes);
  });

  test.each<[string, string, string, string[]]>([
    [
      "declare global in a module",
      "x.ts",
      "export {};\ndeclare global {\n  interface Object {\n    describeAcls(o: object): Promise<unknown>;\n  }\n}",
      ["x.ts augments the global Object"],
    ],
    [
      "an interface at the top of a script",
      "types.d.ts",
      "interface Function {\n  describeAcls(o: object): Promise<unknown>;\n}",
      ["types.d.ts augments the global Function"],
    ],
    [
      "declare global inside a module declaration",
      "types.d.ts",
      'declare module "m" {\n  global {\n    interface CallableFunction {\n      x(): void;\n    }\n  }\n}',
      ["types.d.ts augments the global CallableFunction"],
    ],
    [
      "declare global of NewableFunction",
      "x.ts",
      "export {};\ndeclare global {\n  interface NewableFunction {\n    x(): void;\n  }\n}",
      ["x.ts augments the global NewableFunction"],
    ],
    ["a module's own interface of that name", "x.ts", "export interface Object {\n  a: 1;\n}", []],
    ["another global interface", "x.ts", "export {};\ndeclare global {\n  interface Window {\n    z: 1;\n  }\n}", []],
    [
      "an interface inside a namespace",
      "types.d.ts",
      "declare namespace A.B {\n  interface Object {\n    x: 1;\n  }\n}",
      [],
    ],
    [
      "an interface inside a module declaration",
      "types.d.ts",
      'declare module "m" {\n  interface Object {\n    x: 1;\n  }\n}',
      [],
    ],
  ])("a global augmentation is found in %s", (_label, file, source, expected) => {
    expect(globalAugmentations(file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))).toEqual(
      expected,
    );
  });
});
