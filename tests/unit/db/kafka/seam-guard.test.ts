/**
 * Kafka read-only seam guard (spec 3.6 K4).
 *
 * The read-only promise rests on facts this test keeps true: the client library is
 * imported by exactly one provider file, and elsewhere in the repository only by the
 * fixture seed; that file declares a fixed, narrow shape of the library's objects; and it
 * calls only read methods on them. It parses every source file under the provider
 * directory from disk, so it holds as the provider grows. Both directions are proven:
 * the detector must fire on a sample that breaks each rule, and stay silent on the real
 * sources.
 *
 * The declared shapes are the part tsc enforces: a member the adapter does not declare
 * cannot be called on its library objects, aliased or destructured. So each shape is pinned
 * member by member, signature included, and every way past the shapes that tsc and lint let
 * through is refused in the adapter: a cast of a library object or of what it answers, the
 * type any, a computed member of a library object, a constructor read, which leads to the
 * prototype, and a comment that switches tsc off. The library reaches the adapter through
 * loadPlatformatic() alone, leaves it through its pinned exports alone, and goes from there
 * straight into createPlatformaticClient(), so no other file holds one of its objects.
 * What a syntactic guard cannot see is a library object handed to a name of a wider type,
 * such as a variable or a parameter typed object or unknown that is cast later, or to a
 * reflection call; such a name still cannot spell a write, which the provider may not name
 * even as a string. The broker-side diff of the live check is the second check K4 requires.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "stream", "kafka");
const ADAPTER = "platformatic-client.ts";
const LIBRARY = "@platformatic/kafka";
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

/** The only files in the repository that may import the library: the adapter, and the fixture seed. */
const IMPORTERS = ["docker/kafka/seed-binary.ts", "src/lib/db/providers/stream/kafka/platformatic-client.ts"];

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
 * Write or membership vocabulary that may not appear anywhere in the provider, as a name or as
 * a string, so neither a name typed wider than its shape nor a reflection call can reach it.
 * It holds every write of the library's Admin and Consumer, the two Consumer members that ask
 * the broker about the Consumer's own group, the sentinel (dist/clients/consumer/consumer.js:
 * #performFindGroupCoordinator and #listCommittedOffsets send its groupId, and a first
 * coordinator lookup creates __consumer_offsets), and `socket`, a connection's raw transport,
 * which would write any request's bytes.
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
 * The library's classes whose instances the adapter holds, and their base, as the installed
 * package declares them under dist/: each named member is allowed, forbidden or left unused,
 * so a version that adds a member fails the guard until someone classifies it.
 */
const LIBRARY_CLASS_FILES = [
  "clients/base/base.d.ts",
  "clients/admin/admin.d.ts",
  "clients/consumer/consumer.d.ts",
  "network/connection.d.ts",
  "network/connection-pool.d.ts",
];
/**
 * Members of those classes the adapter neither calls nor forbids: reads, state and bookkeeping,
 * none of which writes or names a group to the broker (read in the 2.11.0 dist on 2026-09-25;
 * Consumer.getLag asks listOffsets, and takes committed offsets from the Consumer's own streams,
 * in memory).
 */
const UNUSED_MEMBERS = new Set([
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
  "ownerId",
  "port",
  "ready",
  "reauthenticate",
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
/** The types a cast escapes every declaration through. */
const ESCAPE_TYPES = [ts.SyntaxKind.NeverKeyword, ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.UnknownKeyword];
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
 * directories kept here, so a new directory and the root's own files are read too.
 */
function repositorySources(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return [...new Set(listed.split("\0"))]
    .filter((path) => SOURCE_FILE.test(path) && existsSync(join(root, path)))
    .sort();
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

/** The expression inside its parentheses and awaits. */
function unwrapped(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) ? unwrapped(node.expression) : node;
}

function insideFunctionNamed(node: ts.Node, name: string): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name?.text === name) return true;
  }
  return false;
}

/** The module a declaration, a call or a type imports, a string when it is written as one, `computed` when it is not. */
function importedModule(node: ts.Node): string | "computed" | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
    return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : "computed";
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return ts.isStringLiteralLike(expression) ? expression.text : "computed";
  }
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    return ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)
      ? argument.literal.text
      : "computed";
  }
  if (ts.isCallExpression(node)) {
    const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (!isImport && !isRequire) return undefined;
    const argument = node.arguments[0];
    return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "computed";
  }
  return undefined;
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

/**
 * Whether `loadPlatformatic` is named the one way the provider may name it outside the adapter:
 * imported under its own name, or called with its answer awaited straight into
 * createPlatformaticClient(), so no other provider file ever holds the library.
 */
function handsTheLibraryOn(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isImportSpecifier(parent)) return parent.propertyName === undefined;
  if (!(ts.isCallExpression(parent) && parent.expression === node && ts.isAwaitExpression(parent.parent))) return false;
  // An await whose parent is a call is one of its arguments: as a callee it would sit in parentheses.
  const client = parent.parent.parent;
  return (
    ts.isCallExpression(client) &&
    ts.isIdentifier(client.expression) &&
    client.expression.text === "createPlatformaticClient"
  );
}

/** An interface member as the pin writes it: printed without comments, on one line. */
function printed(member: ts.Node, sf: ts.SourceFile): string {
  return PRINTER.printNode(ts.EmitHint.Unspecified, member, sf).replace(/\s+/g, " ");
}

function violations(file: string, text: string): string[] {
  const found: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const adapter = file === ADAPTER;
  const visit = (node: ts.Node) => {
    const imported = importedModule(node);
    if (imported === "computed") found.push(`${file} imports a computed module name`);
    else if (imported === LIBRARY && !adapter) found.push(`${file} imports ${LIBRARY}`);
    // In the adapter too, the library comes in through loadPlatformatic() alone, whose answer
    // holds the pinned members only: an import anywhere else, a re-export included, is refused.
    else if (imported === LIBRARY && !insideFunctionNamed(node, "loadPlatformatic"))
      found.push(`${file} imports ${LIBRARY} outside loadPlatformatic()`);

    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && FORBIDDEN.includes(node.text))
      found.push(`${file} names ${node.text}`);
    if (ts.isIdentifier(node) && RAW_MODULE_NAME.test(node.text) && !RAW_MODULES.has(node.text))
      found.push(`${file} names raw API ${node.text}`);
    if (!adapter && ts.isIdentifier(node) && node.text === "loadPlatformatic" && !handsTheLibraryOn(node))
      found.push(
        `${file} takes the library from loadPlatformatic() other than straight into createPlatformaticClient()`,
      );

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
    // tsc allows `constructor` on every object, and an instance's constructor leads to the
    // prototype, which holds every member the library has; the adapter reads it off nothing.
    const constructorOf =
      ts.isPropertyAccessExpression(node) && node.name.text === "constructor"
        ? node.expression
        : ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            node.argumentExpression.text === "constructor"
          ? node.expression
          : undefined;
    if (adapter && constructorOf !== undefined)
      found.push(`${file} reads the constructor of ${constructorOf.getText(sf)}`);
    if (adapter && ts.isElementAccessExpression(node)) {
      const root = receiverRoot(node.expression);
      if (root !== undefined && LIBRARY_RECEIVERS.has(root)) found.push(`${file} reads a computed member of ${root}`);
    }
    // Any type put on a library object, or on what it answers, outside loadPlatformatic(). The one
    // cast left is a raw call's answer, which its module declares unknown, to the response shape
    // this file declares for it; a raw call's answer put through never, any or unknown is refused.
    if (adapter && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) {
      const root = receiverRoot(node.expression);
      const operand = unwrapped(node.expression);
      const rawAnswer =
        ts.isCallExpression(operand) &&
        RAW_CALLS.has(operand.expression.getText(sf).replace(/\s+/g, "")) &&
        !ESCAPE_TYPES.includes(node.type.kind);
      if (
        root !== undefined &&
        LIBRARY_RECEIVERS.has(root) &&
        !rawAnswer &&
        !insideFunctionNamed(node, "loadPlatformatic")
      ) {
        found.push(`${file} casts ${node.expression.getText(sf)} past its declared shape`);
      }
    }
    // A name typed any holds a library object as freely as a cast does, with no cast to see.
    if (adapter && node.kind === ts.SyntaxKind.AnyKeyword) found.push(`${file} writes the type any`);
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

/**
 * The files of the repository at `root` that import the library. Every source file is parsed:
 * a search of the text for the name would pass over a specifier spelled with escapes.
 */
function importersIn(root: string): string[] {
  return repositorySources(root).filter((path) => importsLibrary(path, readFileSync(join(root, path), "utf8")));
}

/**
 * Whether a file imports the library, by parsing it, so a mention in a string or a comment does
 * not count, and a specifier spelled with escapes, which names the library without its text
 * holding the name, does.
 */
function importsLibrary(file: string, text: string): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (importedModule(node) === LIBRARY) found = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false));
  return found;
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

  test("the adapter and the fixture seed are the only files in the repository that import the library", () => {
    expect(importersIn(ROOT)).toEqual(IMPORTERS);
  }, 30_000);

  test("in a repository, the sources are what git tracks or would take in, and the importers are what a parse finds", () => {
    const repo = mkdtempSync(join(tmpdir(), "kafka-seam-guard-"));
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      git(["init", "-q", "--initial-branch=main"]);
      const files: Record<string, string> = {
        ".gitignore": "ignored/\n",
        // Its text never holds the name its specifier's escapes spell.
        "tracked.ts": 'import { Admin } from "\\u0040platformatic\\u002fkafka";\n',
        "removed.ts": `import { Admin } from "${LIBRARY}";\n`,
        "nested/untracked.mts": "export {};\n",
        "bin/tool.cjs": `// require("${LIBRARY}") is prose here\n`,
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
      expect(repositorySources(repo)).toEqual(["bin/tool.cjs", "nested/untracked.mts", "tracked.ts", "ui/view.tsx"]);
      expect(importersIn(repo)).toEqual(["tracked.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
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

  test("every named member of the library's classes the adapter holds is allowed, forbidden or left unused", () => {
    const unclassified = LIBRARY_CLASS_FILES.flatMap((file) => {
      const path = join(ROOT, "node_modules", ...LIBRARY.split("/"), "dist", ...file.split("/"));
      const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      // A symbol-keyed member is reachable only through the library's own symbols, which only an
      // import of the library holds, and a #private one not at all.
      return sf.statements.filter(ts.isClassDeclaration).flatMap((declaration) =>
        declaration.members
          .map((member) => member.name)
          .filter((name): name is ts.Identifier => name !== undefined && ts.isIdentifier(name))
          .map((name) => name.text)
          .filter((name) => !ALLOWED.has(name) && !FORBIDDEN.includes(name) && !UNUSED_MEMBERS.has(name))
          .map((name) => `${declaration.name?.text}.${name}`),
      );
    });
    expect(unclassified).toEqual([]);
    // One list per member: an unused one is neither allowed nor forbidden.
    expect([...UNUSED_MEMBERS].filter((name) => ALLOWED.has(name) || FORBIDDEN.includes(name))).toEqual([]);
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
      `${ADAPTER} loads Admin, Connection, Consumer, Producer, consumerGroupDescribeV0`,
      `${ADAPTER} names Producer`,
      `${ADAPTER} names Producer`,
    ]);
  });

  // Each form below compiles and passes lint in the adapter, and each reaches a member no
  // shape declares (measured with tsc, ESLint and oxlint on the adapter, 2026-09-25).
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
      "a cast of an answer that is not a raw call's",
      "const m = (await admin.metadata({})) as LibMetadata;",
      [`${ADAPTER} casts (await admin.metadata({})) past its declared shape`],
    ],
    [
      "a raw call's answer put through never",
      "const r = (await lib.fetchV13.api.async(connection, 250)) as never;",
      [`${ADAPTER} casts (await lib.fetchV13.api.async(connection, 250)) past its declared shape`],
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
      [`${ADAPTER} reads the constructor of admin`],
    ],
    [
      "the constructor of an alias, by a string key",
      'const a = admin;\na["constructor"].prototype.alterPartitionReassignments.call(a, {});',
      [`${ADAPTER} reads the constructor of a`],
    ],
    [
      "a call on a receiver held by another object",
      "this.admin.alterPartitionReassignments({});",
      [`${ADAPTER} calls admin.alterPartitionReassignments`],
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
      [`${ADAPTER} declares ConnectionLike other than as an interface`],
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
      "a pooled connection's raw socket reached through a wider name",
      "const o: object = await fetchPool.get(broker);\n(o as { socket: { write(b: Uint8Array): boolean } }).socket.write(frame);",
      [`${ADAPTER} names socket`, `${ADAPTER} names socket`],
    ],
  ])("the detector refuses %s", (_label, source, expected) => {
    expect(violations(ADAPTER, source)).toEqual(expected);
  });

  test.each<[string, string]>([
    [
      "a raw call's answer given the response shape the adapter declares for it",
      'const r = (await lib.consumerGroupDescribeV0.api.async(connection, ["g"], false)) as LibGroupDescribeResponse;',
    ],
    [
      "a pinned option written as its literal under a quoted key",
      'const o = { "autocreateTopics": false, groupProtocol: "classic" };',
    ],
    [
      "the library imported in loadPlatformatic(), types included",
      `async function loadPlatformatic(load: () => Promise<typeof import("${LIBRARY}")> = () => import("${LIBRARY}")) { return load(); }`,
    ],
    ["an export the adapter is pinned to", 'export const KAFKA_SENTINEL_GROUP_ID = "libredb-studio-never-joined";'],
  ])("the detector lets %s through", (_label, source) => {
    expect(violations(ADAPTER, source)).toEqual([]);
  });

  const TAKES_THE_LIBRARY =
    "index.ts takes the library from loadPlatformatic() other than straight into createPlatformaticClient()";
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
    [
      "reached through a namespace",
      'import * as adapter from "./platformatic-client";\nconst lib = adapter.loadPlatformatic();',
      [TAKES_THE_LIBRARY],
    ],
    [
      "awaited into another function",
      'import { loadPlatformatic } from "./platformatic-client";\nconst lib = keep(await loadPlatformatic());',
      [TAKES_THE_LIBRARY],
    ],
    [
      "handed straight to the client, the one way it is taken",
      'import { createPlatformaticClient, loadPlatformatic } from "./platformatic-client";\nconst make = async (o: object) => createPlatformaticClient(o, await loadPlatformatic());',
      [],
    ],
  ])("outside the adapter, the library from loadPlatformatic() %s", (_label, source, expected) => {
    expect(violations("index.ts", source)).toEqual(expected);
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
  ])("the importer check counts %s", (_label, source) => {
    expect(importsLibrary("x.ts", source)).toBe(true);
  });

  // The TLS test resolves the library's file and writes the import of a Node child as text, so
  // the file itself imports nothing (spec 10); the dependency test names the library in prose.
  test.each<[string, string]>([
    ["a mention in a comment", `// import { Admin } from "${LIBRARY}";\nexport {};`],
    ["a mention in a string", `const note = "reads through ${LIBRARY}";`],
    ["a resolution of its file", `const file = Bun.resolveSync("${LIBRARY}", import.meta.dir);`],
    ["an import of another package", `import { Admin } from "${LIBRARY}-admin";`],
  ])("the importer check does not count %s", (_label, source) => {
    expect(importsLibrary("x.ts", source)).toBe(false);
  });
});
