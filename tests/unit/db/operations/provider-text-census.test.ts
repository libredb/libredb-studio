import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import ts from "typescript";

/**
 * The one scrub of provider text, and who wrote a refusal, held by the syntax tree.
 *
 * On the paths the census covers (`PROVIDER_TEXT_PATHS`: the agent, hand-over and MCP paths, every database route, the
 * object routes, the fleet health check, the query events those routes record, the provider factory's log lines and the
 * VS Code extension's backend child) every text a provider hands core (an error's message, name, stack, detail or fix
 * statement, a result's warnings, an object read's sentences, the sentences a success answer carries in the provider's
 * words) passes core's one scrub
 * (src/lib/db/operations/provider-text.ts) before it reaches a prompt, the ledger, a response, a query event or a log
 * line. The census below records each crossing and the core function it calls, and every other read of such a text on
 * those paths is classified, with its reason, as not provider text. A read of a provider method whose answer carries
 * the provider's sentences (`SENTENCE_ANSWERS`) is answered through that answer's core scrubs in the same declaration,
 * or is classified.
 * A new read of a provider's text on those paths is a finding until it is recorded as one or the other, and an error
 * response rendered there without the connection's scrub is a finding unless it is classified. The scan is
 * syntactic and keyed on names (`error`, `refusal`, `warnings`, `logger.error`, `createErrorResponse`); a provider
 * text carried under another name escapes it, which tests/security/provider-text-scrub.test.ts catches by behaviour.
 * Every log line of the provider factory that renders a value the code around it caught renders it through
 * `withholdProviderError`, or is classified as rendering no provider text (`FACTORY_LOG_NOT_PROVIDER_TEXT`); which scrub
 * it is given is held by behaviour, in tests/isolated/factory.test.ts.
 *
 * Who wrote a refusal, held by class.
 *
 * The agent and MCP say a refusal Studio wrote in Studio's voice and fence a provider's as the provider's text
 * (src/lib/db/operations/provider-text.ts, `isStudioRefusal`). The line between the two is a class only core
 * constructs, never the text or the reason code, which do not partition by author. So outside provider code no module
 * constructs a plain `ExecutionProfileError` (core writes `StudioProfileRefusal`), no provider constructs a class that
 * marks core's sentence, and the pre-send refusal classes are constructed where their author is known.
 *
 * The scan reads the TypeScript syntax tree, so a comment naming a class is never a finding, and a finding names its
 * file and innermost declaration, never a line.
 *
 * Every source file is parsed once, when this module loads, and only what the tests ask of it is kept: its
 * constructions, the identifiers it names, its reads of provider text and the calls each declaration makes. A test reads
 * that census and never parses the tree again, so no test pays a whole-tree parse inside its own time budget.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SOURCE_ROOTS = ["src", join("vscode-extension", "src")];
const PROVIDER_CODE = join("src", "lib", "db", "providers") + sep;
const READ_ALLOWANCE = join("src", "lib", "db", "read-allowance.ts");
const PROVIDER_TEXT = join("src", "lib", "db", "operations", "provider-text.ts");
const READ_ONLY_STATEMENT = join("src", "lib", "db", "operations", "read-only-statement.ts");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) {
      if (entry !== "node_modules") found.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined,
  );
}

/** The name of the innermost named function, method or class around `node`, or the file's top level. */
function enclosingDeclaration(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isClassDeclaration(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text;
    }
    if (
      (ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at)) &&
      ts.isIdentifier(at.name) &&
      at.initializer !== undefined &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    ) {
      return at.name.text;
    }
  }
  return "(top level)";
}

/** The innermost named function or method around `node`, as `enclosingDeclaration` names it, without classes. */
function functionAround(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text;
    }
    if (
      (ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at)) &&
      ts.isIdentifier(at.name) &&
      at.initializer !== undefined &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    ) {
      return at.name.text;
    }
  }
  return "(top level)";
}

/** The names a rejection is bound to around `node`: a catch clause's, and a `.catch` or `.then` rejection handler's. */
function caughtNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isCatchClause(at) && at.variableDeclaration !== undefined && ts.isIdentifier(at.variableDeclaration.name)) {
      names.add(at.variableDeclaration.name.text);
    }
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      ts.isCallExpression(at.parent) &&
      ts.isPropertyAccessExpression(at.parent.expression) &&
      ["catch", "then"].includes(at.parent.expression.name.text)
    ) {
      const index = at.parent.arguments.indexOf(at);
      if (index === (at.parent.expression.name.text === "catch" ? 0 : 1)) {
        for (const parameter of at.parameters) if (ts.isIdentifier(parameter.name)) names.add(parameter.name.text);
      }
    }
  }
  return names;
}

const PROVIDER_TEXT_MEMBERS = new Set(["message", "stack", "name", "detail", "fixStatement"]);
const PROVIDER_SENTENCE_MEMBERS = new Set(["unavailable", "sampledFrom"]);

/**
 * Each provider method whose answer carries sentences in the provider's words, and the core scrubs a declaration that
 * reads it calls to answer them: the object reads', a monitoring answer's panel errors, a maintenance answer's message,
 * a maintenance preview's sentences, a key page's skipped reason and read outcome, and an object edit's refusal, plan,
 * pre-image and outcome sentences.
 */
const SENTENCE_ANSWERS: Readonly<Record<string, readonly string[]>> = {
  countObjects: ["scrubKindCounts"],
  describeObject: ["scrubObjectDetail"],
  describeObjects: ["scrubObjectDetail"],
  readObjectSource: ["scrubSourceDocument"],
  getMonitoringData: ["scrubMonitoringData"],
  runMaintenance: ["scrubMaintenanceResult"],
  previewMaintenance: ["scrubMaintenancePreview"],
  scanKeysPage: ["scrubKeyScanPage"],
  buildObjectEdit: ["scrubObjectEditRefusal", "scrubObjectEditPlan", "scrubObjectEditPreimage"],
  applyObjectEdit: ["scrubObjectEditOutcome"],
};

/** What the tests ask of one source file, read from its syntax tree in one walk; the tree itself is not kept. */
type Census = {
  /** Every `new <Class>(...)`, by class name, as "file: declaration". */
  constructions: Map<string, string[]>;
  /** Every name the file uses as an identifier, a comment never counting. */
  identifiers: Set<string>;
  /**
   * Every read of a provider's text, as "file: declaration: read": a text member of a caught error, of an `error` or
   * `refusal` property or of a `refusal`; any `warnings`; any `unavailable` or `sampledFrom` sentence and a
   * `truncated.reason`; a read of a provider method whose answer carries the provider's sentences (`SENTENCE_ANSWERS`);
   * the error a `logger.error` line is given; the error `createErrorResponse` renders, marked `, scrub` when its context
   * names the connection's scrub.
   */
  providerTextReads: string[];
  /**
   * Every log line (`logger.<level>` or `console.<method>`) that renders a value the code around it caught: a catch
   * clause's binding, a `.catch` or `.then` rejection handler's parameter, or a settled rejection's `reason`; marked
   * `, scrub` when it is the error `withholdProviderError` withholds. As "file: declaration: callee(value)".
   */
  caughtLogs: string[];
  /** The functions and methods each named function or method calls, as a function or as a method. */
  calls: Map<string, Set<string>>;
};

/** Whether `node` is the error a call of `withholdProviderError` is given, its second argument. */
function withheldArgument(node: ts.Node): boolean {
  const call = node.parent;
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === "withholdProviderError" &&
    call.arguments[1] === node
  );
}

/**
 * The caught values a log call renders, each found once: an identifier a rejection is bound to around the call that is
 * not a member's name (`x.error`) or a property's name (`{ error: ... }`; a shorthand `{ error }` renders it), and a
 * settled rejection's `reason`. A value found is not walked further.
 */
function caughtValues(call: ts.CallExpression, source: ts.SourceFile): string[] {
  const caught = caughtNames(call);
  const values: string[] = [];
  const visit = (node: ts.Node) => {
    const memberName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
    const propertyName = ts.isPropertyAssignment(node.parent) && node.parent.name === node;
    if (
      (ts.isIdentifier(node) && caught.has(node.text) && !memberName && !propertyName) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "reason")
    ) {
      values.push(`${node.getText(source)}${withheldArgument(node) ? ", scrub" : ""}`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const argument of call.arguments) visit(argument);
  return values;
}

/** Whether a `createErrorResponse` context is an object literal that names a `scrub`, assigned or shorthand. */
function givenScrub(context: ts.Expression | undefined): boolean {
  return (
    context !== undefined &&
    ts.isObjectLiteralExpression(context) &&
    context.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "scrub",
    )
  );
}

function scan(file: string, text: string): Census {
  const source = parse(file, text);
  const found: Census = {
    constructions: new Map(),
    identifiers: new Set(),
    providerTextReads: [],
    caughtLogs: [],
    calls: new Map(),
  };
  const at = (node: ts.Node, read: string) => found.providerTextReads.push(`${file}: ${functionAround(node)}: ${read}`);
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const className = node.expression.text;
      found.constructions.set(className, [
        ...(found.constructions.get(className) ?? []),
        `${file}: ${enclosingDeclaration(node)}`,
      ]);
    }
    if (ts.isIdentifier(node)) found.identifiers.add(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      const owner = node.expression;
      if (
        PROVIDER_TEXT_MEMBERS.has(member) &&
        ((ts.isIdentifier(owner) && (caughtNames(node).has(owner.text) || owner.text === "refusal")) ||
          (ts.isPropertyAccessExpression(owner) && ["error", "refusal"].includes(owner.name.text)))
      ) {
        at(node, owner.getText(source) + "." + member);
      }
      if (member === "warnings") at(node, owner.getText(source) + ".warnings");
      // The sentences a provider writes on its inventory answers: a refused count or index read, a sampled count, a
      // bounded description.
      if (
        PROVIDER_SENTENCE_MEMBERS.has(member) ||
        (member === "reason" && ts.isPropertyAccessExpression(owner) && owner.name.text === "truncated")
      ) {
        at(node, owner.getText(source) + "." + member);
      }
      // A provider method whose answer carries the provider's sentences. A `typeof provider.x` type query is an entity
      // name, not a property access, so it is not recorded.
      if (Object.hasOwn(SENTENCE_ANSWERS, member)) at(node, owner.getText(source) + "." + member);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.getText(source) === "logger" &&
        callee.name.text === "error" &&
        node.arguments[1] !== undefined
      ) {
        at(node, `logger.error(${node.arguments[1].getText(source)})`);
      }
      if (ts.isPropertyAccessExpression(callee) && ["logger", "console"].includes(callee.expression.getText(source))) {
        const line = callee.getText(source);
        for (const value of caughtValues(node, source)) {
          found.caughtLogs.push(`${file}: ${functionAround(node)}: ${line}(${value})`);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "createErrorResponse" && node.arguments[0] !== undefined) {
        at(
          node,
          `createErrorResponse(${node.arguments[0].getText(source)}${givenScrub(node.arguments[1]) ? ", scrub" : ""})`,
        );
      }
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== undefined) {
        const declaration = functionAround(node);
        found.calls.set(declaration, (found.calls.get(declaration) ?? new Set()).add(name));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const FILES = SOURCE_ROOTS.flatMap(sourceFiles).map((file) => ({
  file,
  provider: file.startsWith(PROVIDER_CODE),
  census: scan(file, readFileSync(join(ROOT, file), "utf8")),
}));

const CENSUS = new Map(FILES.map(({ file, census }) => [file, census]));

/** The census of `file`, which must be a source file under one of the roots. */
function censusOf(file: string): Census {
  const found = CENSUS.get(file);
  if (found === undefined) throw new Error(`${file} is not a source file under ${SOURCE_ROOTS.join(" or ")}`);
  return found;
}

/** The constructions of `className` in the files `where` keeps. */
function constructed(className: string, where: (file: { file: string; provider: boolean }) => boolean): string[] {
  return FILES.filter(where).flatMap(({ census }) => census.constructions.get(className) ?? []);
}

describe("who wrote a refusal", () => {
  test("the scan finds a construction and not a comment naming one", () => {
    const planted = [
      "// new ExecutionProfileError('x', 'UNSUPPORTED_PROFILE')",
      "/** new ExecutionProfileError */",
      "function acquire() { throw new ExecutionProfileError('x', 'UNSUPPORTED_PROFILE'); }",
    ].join("\n");
    expect(scan("planted.ts", planted).constructions.get("ExecutionProfileError")).toEqual(["planted.ts: acquire"]);
  });

  test("no module outside provider code constructs a plain ExecutionProfileError", () => {
    expect(constructed("ExecutionProfileError", (file) => !file.provider)).toEqual([]);
  });

  test("no provider module constructs StudioProfileRefusal, ReadAllowanceExceededError or ProviderTextWithheldError", () => {
    for (const className of ["StudioProfileRefusal", "ReadAllowanceExceededError", "ProviderTextWithheldError"]) {
      expect(constructed(className, (file) => file.provider)).toEqual([]);
    }
  });

  test("outside provider code only the read allowance constructs a RefusedBeforeSendError, and nothing constructs an OffsetUnsupportedError", () => {
    expect(constructed("RefusedBeforeSendError", (file) => !file.provider)).toEqual([]);
    expect(
      constructed("ReadAllowanceExceededError", (file) => !file.provider).every((finding) =>
        finding.startsWith(`${READ_ALLOWANCE}: `),
      ),
    ).toBe(true);
    expect(constructed("ReadAllowanceExceededError", (file) => !file.provider).length).toBeGreaterThan(0);
    expect(constructed("OffsetUnsupportedError", (file) => !file.provider)).toEqual([]);
  });

  test("no provider module constructs a Studio budget refusal or StudioTimeoutRefusal", () => {
    for (const className of [
      "StudioRowBudgetRefusal",
      "StudioByteBudgetRefusal",
      "StudioTimeBudgetRefusal",
      "StudioTimeoutRefusal",
    ]) {
      expect(constructed(className, (file) => file.provider)).toEqual([]);
    }
  });

  test("no module outside provider code constructs a provider's budget refusal class", () => {
    for (const className of [
      "RowBudgetRefusal",
      "ByteBudgetRefusal",
      "TimeBudgetRefusal",
      "CutValueRefusal",
      "SerialisedResultRefusal",
    ]) {
      expect(constructed(className, (file) => !file.provider)).toEqual([]);
    }
  });

  test("the core read path constructs no plain QueryError, and its row, byte and time refusals are Studio's own", () => {
    const corePath = (file: { file: string }) => file.file === READ_ONLY_STATEMENT;
    expect(constructed("QueryError", corePath)).toEqual([]);
    expect(constructed("StudioRowBudgetRefusal", corePath)).toEqual([`${READ_ONLY_STATEMENT}: sharedRowRefusal`]);
    expect(constructed("StudioByteBudgetRefusal", corePath)).toEqual([`${READ_ONLY_STATEMENT}: sharedByteRefusal`]);
    expect(constructed("StudioTimeBudgetRefusal", corePath)).toEqual([
      `${READ_ONLY_STATEMENT}: withinStatementTimeout`,
    ]);
  });

  test("the agent tool layer constructs a TimeoutError only as Studio's own", () => {
    const agentLayer = (file: { file: string }) => file.file.startsWith(join("src", "lib", "agent") + sep);
    expect(constructed("TimeoutError", agentLayer)).toEqual([]);
    expect(constructed("StudioTimeoutRefusal", agentLayer)).toEqual([
      // The statistics read's own time limit, raised inside the `invoke` of `readStatisticsForGrounding`.
      `${join("src", "lib", "agent", "tools.ts")}: invoke`,
    ]);
  });

  test("only the core scrub constructs a ProviderTextWithheldError", () => {
    const found = constructed("ProviderTextWithheldError", () => true);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((finding) => finding.startsWith(`${PROVIDER_TEXT}: `))).toBe(true);
  });
});

/**
 * The paths the census covers: the agent, the hand-over and MCP, and the core read path they share; every database
 * route, the object routes' shared handler, the fleet health check and the shared steps behind them, the query events
 * those routes record, the provider factory's log lines, and the VS Code extension's backend child.
 */
const PROVIDER_TEXT_PATHS = [
  join("src", "lib", "agent"),
  join("src", "lib", "mcp"),
  join("src", "app", "api", "agent"),
  join("src", "app", "api", "mcp"),
  join("src", "lib", "db", "operations", "read-only-statement.ts"),
  join("src", "app", "api", "db"),
  join("src", "app", "api", "admin", "fleet-health"),
  join("src", "lib", "api", "object-route.ts"),
  join("src", "lib", "api", "editor-query.ts"),
  join("src", "lib", "api", "test-connection.ts"),
  join("src", "lib", "query-events"),
  join("src", "lib", "db", "factory.ts"),
  join("vscode-extension", "src", "backend", "handlers.ts"),
];

function pathFiles(path: string): string[] {
  return statSync(join(ROOT, path)).isDirectory() ? sourceFiles(path) : [path];
}

const agent = (...path: string[]) => join("src", "lib", "agent", ...path);
const mcp = (...path: string[]) => join("src", "lib", "mcp", ...path);
const api = (...path: string[]) => join("src", "app", "api", "agent", ...path);
const dbRoute = (...path: string[]) => join("src", "app", "api", "db", ...path, "route.ts");
const objectRoute = join("src", "lib", "api", "object-route.ts");
const fleetHealth = join("src", "app", "api", "admin", "fleet-health", "route.ts");
const recordedRun = join("src", "lib", "query-events", "recorded-run.ts");
const editorQuery = join("src", "lib", "api", "editor-query.ts");
const testConnectionCore = join("src", "lib", "api", "test-connection.ts");
const routeEvents = join("src", "lib", "query-events", "route-events.ts");
const childHandlers = join("vscode-extension", "src", "backend", "handlers.ts");
const factory = join("src", "lib", "db", "factory.ts");

/** Every crossing of provider text on the covered paths, and the core function each calls: one row per call. */
const CROSSINGS: readonly (readonly [file: string, declaration: string, callee: string])[] = [
  [agent("tools.ts"), "runAuditedAgentCall", "providerTextScrub"],
  [agent("tools.ts"), "runAuditedAgentCall", "scrubProviderText"],
  [agent("tools.ts"), "runAuditedAgentCall", "withScrubbedWarnings"],
  [agent("tools.ts"), "runAuditedAgentCall", "fenceProviderText"],
  [agent("tools.ts"), "enumerateGroundingContainers", "scrubProviderText"],
  [agent("tools.ts"), "walkObjectInventory", "scrubProviderText"],
  [agent("tools.ts"), "runStatement", "providerTextScrub"],
  [agent("languages", "kubectl", "tools.ts"), "runClusterUsage", "providerTextScrub"],
  [agent("languages", "kubectl", "tools.ts"), "runWorkloadProfile", "providerTextScrub"],
  [agent("languages", "mongo", "tools.ts"), "invoke", "providerTextScrub"],
  [agent("investigation.ts"), "describeSettled", "scrubProviderText"],
  [agent("context-snapshot.ts"), "scrubSnapshotSentences", "scrubProviderText"],
  [agent("investigation.ts"), "describeSettled", "fenceProviderText"],
  [agent("runtime.ts"), "driveAgentRun", "withholdProviderError"],
  [agent("runtime.ts"), "driveAgentRunOutcome", "providerTextScrub"],
  [api("drive", "route.ts"), "driveFailure", "withholdProviderError"],
  [api("runs", "route.ts"), "POST", "providerTextScrub"],
  [api("runs", "[runId]", "handover", "route.ts"), "POST", "providerTextScrub"],
  [api("runs", "[runId]", "handover", "route.ts"), "POST", "withScrubbedWarnings"],
  [join("src", "lib", "db", "operations", "read-only-statement.ts"), "logLateSettlement", "scrubProviderText"],
  [mcp("context.ts"), "textScrub", "providerTextScrub"],
  [mcp("output.ts"), "engineMessage", "scrubProviderText"],
  [mcp("tools", "run-statement.ts"), "execute", "textScrub"],
  [mcp("tools", "run-statement.ts"), "failureAnswer", "scrubProviderText"],
  [mcp("tools", "run-statement.ts"), "failureAnswer", "providerTextError"],
  [mcp("tools", "run-statement.ts"), "profileRefusal", "scrubProviderText"],
  [mcp("tools", "run-statement.ts"), "profileRefusal", "providerTextError"],
  [mcp("tools", "run-statement.ts"), "prepare", "providerTextError"],
  [mcp("tools", "run-statement.ts"), "executeOpened", "providerTextError"],
  [mcp("tools", "run-statement.ts"), "executeOpened", "withScrubbedWarnings"],
  [mcp("tools", "inspect-schema.ts"), "inspectSchema", "textScrub"],
  [mcp("tools", "inspect-schema.ts"), "inspectSchema", "providerTextError"],
  [mcp("tools", "inspect-schema.ts"), "inspectSchema", "scrubProviderText"],
  [mcp("tools", "inspect-schema.ts"), "inspectTable", "engineMessage"],
  [dbRoute("query"), "POST", "providerTextScrub"],
  [dbRoute("multi-query"), "POST", "providerTextScrub"],
  [dbRoute("multi-query"), "runStatement", "withScrubbedWarnings"],
  [dbRoute("multi-query"), "statementError", "withholdProviderError"],
  [dbRoute("transaction"), "POST", "providerTextScrub"],
  [dbRoute("transaction"), "POST", "withScrubbedWarnings"],
  [dbRoute("transaction"), "runScriptInTransaction", "withholdProviderError"],
  [dbRoute("transaction"), "eventError", "withheldProviderError"],
  [dbRoute("transaction"), "rollBackOnProvider", "withholdProviderError"],
  [dbRoute("test-connection"), "POST", "providerTextScrub"],
  [testConnectionCore, "testConnection", "providerTextScrub"],
  [testConnectionCore, "testConnection", "scrubProviderWarnings"],
  [testConnectionCore, "testConnection", "withheldProviderError"],
  [testConnectionCore, "testConnectionCautions", "withholdProviderError"],
  [editorQuery, "runEditorQuery", "withScrubbedWarnings"],
  [routeEvents, "failure", "providerTextScrub"],
  [routeEvents, "failure", "withheldProviderError"],
  [recordedRun, "runRecorded", "providerTextScrub"],
  [recordedRun, "runRecorded", "withheldProviderError"],
  [dbRoute("cancel"), "POST", "providerTextScrub"],
  [dbRoute("health"), "POST", "providerTextScrub"],
  [dbRoute("pool-stats"), "POST", "providerTextScrub"],
  [dbRoute("provider-meta"), "POST", "providerTextScrub"],
  [dbRoute("monitoring"), "POST", "providerTextScrub"],
  [dbRoute("monitoring"), "POST", "scrubMonitoringData"],
  [dbRoute("maintenance"), "POST", "providerTextScrub"],
  [dbRoute("maintenance"), "POST", "scrubMaintenanceResult"],
  [dbRoute("maintenance", "preview"), "POST", "providerTextScrub"],
  [dbRoute("maintenance", "preview"), "POST", "scrubMaintenancePreview"],
  [dbRoute("keys", "scan"), "POST", "scrubKeyScanPage"],
  [dbRoute("statement", "analyze"), "POST", "providerTextScrub"],
  [dbRoute("profile"), "POST", "providerTextScrub"],
  [dbRoute("profile"), "reasonOf", "withheldProviderError"],
  [fleetHealth, "POST", "providerTextScrub"],
  [fleetHealth, "POST", "withheldProviderError"],
  [objectRoute, "handleObjectRequest", "providerTextScrub"],
  [dbRoute("objects", "counts"), "POST", "scrubKindCounts"],
  [dbRoute("objects", "describe"), "POST", "scrubObjectDetail"],
  [dbRoute("objects", "inventory"), "POST", "scrubObjectDetail"],
  [dbRoute("objects", "inventory"), "POST", "scrubProviderText"],
  [dbRoute("objects", "source"), "POST", "scrubSourceDocument"],
  [dbRoute("objects", "edit-plan"), "POST", "scrubObjectEditRefusal"],
  [dbRoute("objects", "edit-plan"), "POST", "scrubObjectEditPlan"],
  [dbRoute("objects", "edit-plan"), "POST", "scrubObjectEditPreimage"],
  [dbRoute("objects", "edit-apply"), "POST", "withholdProviderError"],
  [dbRoute("objects", "edit-apply"), "POST", "scrubObjectEditOutcome"],
  [dbRoute("objects", "edit-apply"), "POST", "recordedProviderCode"],
  [childHandlers, "runQuery", "providerTextScrub"],
  [childHandlers, "answeringFor", "providerTextScrub"],
  [childHandlers, "answeringFor", "toResponseError"],
  [childHandlers, "countObjects", "providerTextScrub"],
  [childHandlers, "countObjects", "scrubKindCounts"],
  [childHandlers, "describeObject", "providerTextScrub"],
  [childHandlers, "describeObject", "scrubObjectDetail"],
  [childHandlers, "toResponseError", "withheldProviderError"],
  [childHandlers, "toResponseError", "withWithheldText"],
  [factory, "releaseTunnelOfUnopenedProvider", "withholdProviderError"],
  [factory, "withOneShotTunnel", "providerTextScrub"],
  [factory, "withOneShotTunnel", "withholdProviderError"],
  [factory, "teardownProvider", "withholdProviderError"],
  [factory, "keepsRunInFlight", "withholdProviderError"],
  [factory, "evictIdleProviders", "withholdProviderError"],
  [factory, "getOrCreateProvider", "providerTextScrub"],
  [factory, "getOrCreateProvider", "withholdProviderError"],
  [factory, "acquireExecutionProfileProvider", "providerTextScrub"],
  [factory, "acquireExecutionProfileProvider", "withholdProviderError"],
  [factory, "removeProvider", "withholdProviderError"],
  [factory, "closeCaches", "withholdProviderError"],
];

/** The reason a read of an inventory snapshot's provider sentence is no crossing of its own. */
const SNAPSHOT_SENTENCE =
  "a snapshot's provider sentence: walkObjectInventory scrubbed it at the capture, scrubSnapshotSentences before a prompt";

/**
 * Every read of such a text on the three paths outside a recorded crossing, each with the reason it is not a
 * provider's text, or is one a crossing already scrubbed.
 */
const NOT_PROVIDER_TEXT: Readonly<Record<string, string>> = {
  [`${agent("model-tuning", "index.ts")}: readOperatorDocument: error.message`]: "an operator document's parse error",
  [`${agent("capability-probe.ts")}: observeProbe: part.warnings`]: "the model SDK's warnings on a probe",
  [`${agent("inventory-objects.ts")}: unlistedInventoryReason: kinds[0].unavailable`]: SNAPSHOT_SENTENCE,
  [`${agent("inventory-objects.ts")}: unlistedInventoryReason: kind.unavailable`]: SNAPSHOT_SENTENCE,
  [`${agent("context-snapshot.ts")}: fingerprintInventory: table.indexes.unavailable`]: SNAPSHOT_SENTENCE,
  [`${agent("context-snapshot.ts")}: inventoryNotes: kind.unavailable`]: SNAPSHOT_SENTENCE,
  [`${agent("context-snapshot.ts")}: inventoryNotes: kind.sampledFrom`]: SNAPSHOT_SENTENCE,
  [`${agent("context-snapshot.ts")}: renderOperationsTable: table.indexes.unavailable`]: SNAPSHOT_SENTENCE,
  [`${agent("model-adapter.ts")}: createAgentModel: error.message`]: "an LLM provider configuration error",
  [`${agent("provider-registry.ts")}: openAIResponsesRequestWarnings: prepared.warnings`]: "the model SDK's warnings",
  [`${agent("run-service.ts")}: releaseDrive: logger.error(error)`]: "the run ledger's own failure",
  [`${agent("run-service.ts")}: finalize: logger.error(error)`]: "the run ledger's own failure",
  [`${agent("investigation.ts")}: describeSettled: refusal.detail`]: "Studio's own not-sent and unavailable sentences",
  [`${agent("investigation.ts")}: takeTurn: error.message`]: "an LLM stream error",
  [`${agent("investigation.ts")}: takeTurn: part.warnings`]: "the model SDK's warnings",
  [`${agent("capability-gate.ts")}: admitAgentModel: error.name`]: "an LLM probe error's class",
  [`${agent("runtime.ts")}: recordDriveFailure: logger.error(recordingError)`]: "the run ledger's own failure",
  [`${agent("tools.ts")}: readCatalog: outcome.refusal.message`]:
    "a refusal the funnel already scrubbed, read only to decide a catalog retry",
  [`${agent("tools.ts")}: runReadQueryTool: refusal.message`]: "the language reader's own refusal, Studio's",
  [`${agent("workflow-classifier.ts")}: classifyAgentWorkflow: error.name`]: "an LLM error's class",
  [`${agent("workflow-classifier.ts")}: classifyAgentWorkflow: result.warnings`]: "the model SDK's warnings",
  [`${agent("resume-sweep.ts")}: runResumeSweepOnce: logger.error(error)`]:
    "a drive's failure, which driveAgentRun already withheld",
  [`${mcp("output.ts")}: recordOrRefuse: logger.error(redactError(error))`]: "the audit sink's own failure",
  [`${mcp("preprocess.ts")}: meter: logger.error(auditError)`]: "the audit sink's own failure",
  [`${mcp("preprocess.ts")}: meter: createErrorResponse(new RateLimitError(decision.retryAfterSeconds))`]:
    "Studio's rate limit",
  [`${mcp("preprocess.ts")}: recordInvalidArguments: logger.error(auditError)`]: "the audit sink's own failure",
  [`${mcp("context.ts")}: resolvedSecrets: logger.error(redactError(error))`]:
    "a Vault error, read before any provider",
  [`${mcp("context.ts")}: load: logger.error(redactError(error))`]: "the seed file's own error",
  [`${mcp("tools", "run-statement.ts")}: build: raw.warnings`]: "a result executeOpened scrubbed before resultOf",
  [`${mcp("tools", "statement-arms.ts")}: fence: refusal.message`]: "the language reader's own refusal, Studio's",
  [`${mcp("bearer.ts")}: authenticateMcpRequest: logger.error(redactError(error))`]: "the token store's own failure",
  [`${mcp("bearer.ts")}: auditMcpDenial: logger.error(auditError)`]: "the audit sink's own failure",
  [`${mcp("account-check.ts")}: mcpTokenOwnerAllowed: logger.error(error)`]: "the account store's own failure",
  [`${api("drive", "route.ts")}: POST: logger.error(auditError)`]: "the audit sink's own failure",
  [`${api("drive", "route.ts")}: POST: createErrorResponse(new RateLimitError(decision.retryAfterSeconds))`]:
    "Studio's rate limit",
  [`${api("classify", "route.ts")}: POST: createErrorResponse(error)`]: "an LLM classification error",
  [`${api("runs", "route.ts")}: GET: createErrorResponse(error)`]: "the run ledger's own failure",
  [`${api("runs", "route.ts")}: POST: gate.refusal.message`]: "the capability gate's own refusal, Studio's",
  [`${api("runs", "route.ts")}: POST: logger.error(error)`]:
    "a background drive's failure, which driveAgentRun withheld",
  [`${api("runs", "[runId]", "route.ts")}: DELETE: createErrorResponse(error)`]: "the run ledger's own failure",
  [`${api("runs", "[runId]", "route.ts")}: PATCH: logger.error(error)`]:
    "a background drive's failure, which driveAgentRun withheld",
  [`${api("runs", "[runId]", "route.ts")}: PATCH: error.message`]:
    "an AgentRunServiceError, the run service's own sentence",
  [`${api("runs", "[runId]", "route.ts")}: PATCH: createErrorResponse(error)`]: "the run ledger's own failure",
  [`${api("runs", "[runId]", "handover", "route.ts")}: POST: createErrorResponse(error)`]:
    "the connection's resolution, before any provider is built",
  [`${join("src", "app", "api", "mcp", "token", "route.ts")}: POST: logger.error(auditError)`]:
    "the audit sink's own failure",
  [`${join("src", "app", "api", "mcp", "route.ts")}: admit: logger.error(undefined)`]: "a fixed log line with no error",
  [`${dbRoute("multi-query")}: carriedChannels: source.warnings`]: "a statement result runStatement scrubbed",
  [`${dbRoute("disconnect")}: POST: createErrorResponse(error)`]:
    "a seed resolution or unknown-provider refusal, Studio's own; removeProvider logs a provider's disconnect failure itself and never throws it",
  [`${dbRoute("disconnect")}: POST: logger.error(error)`]:
    "the provider cache's own failure; removeProvider logs a provider's disconnect failure itself and never throws it",
  [`${fleetHealth}: POST: createErrorResponse(error)`]:
    "the request body's own failure; each connection's failure is answered in its own item",
  [`${join("src", "lib", "query-events", "sink.ts")}: recordQueryEvent: logger.error(error)`]:
    "the query event builder's own refusal of an input",
  [`${objectRoute}: boundText: part.truncated.reason`]:
    "a source part's sentence the source route scrubbed before bounding it",
  [`${childHandlers}: runTarget: error.message`]: "the run target rule's RangeError, Studio's",
  [`${agent("tools.ts")}: countForGrounding: provider.countObjects`]:
    "the grounding's counts, whose sentences walkObjectInventory scrubs with scrubProviderText",
  [`${agent("tools.ts")}: walkObjectInventory: provider.describeObjects`]:
    "a batch whose sentences walkObjectInventory scrubs field by field with scrubProviderText",
  [`${mcp("tools", "inspect-schema.ts")}: inspectTable: provider.describeObject`]:
    "a description of which inspectTable answers only the index sentence, through engineMessage, which scrubs it",
  [`${objectRoute}: requireSourceReader: provider.readObjectSource`]:
    "the source reader, whose document the source route answers through scrubSourceDocument",
  [`${childHandlers}: selectStatement: provider.describeObject`]:
    "a description of which selectStatement reads only the columns, database content",
};

/**
 * Every factory log line that renders a caught value without `withholdProviderError`, with the reason it is no provider
 * text. A key names one line, so a second line that renders the same value in the same declaration is a finding.
 */
const FACTORY_LOG_NOT_PROVIDER_TEXT: Readonly<Record<string, string>> = {
  [`${factory}: removeProvider: logger.warn(error)`]:
    "closeSSHTunnel's AggregateError, whose name and message are Studio's (the count of forwards that failed to close and the connection id); String renders none of its inner errors",
};

describe("the one scrub of provider text", () => {
  test("the scan finds a provider text read, an error handed to a log line or an error response, and not a comment naming one", () => {
    const planted = [
      "// catch (error) { error.message; logger.error('x', error); createErrorResponse(error) }",
      "function answer(result) {",
      "  try { run(); } catch (error) { logger.error('failed', error); return createErrorResponse(error); }",
      "  promise.catch((failure) => failure.message);",
      "  return [refusal.message, result.warnings, settled.error.stack];",
      "}",
      "function walk(detail, count, batch, error) {",
      "  return [detail.indexes.unavailable, count.sampledFrom, batch.truncated.reason, error.reason];",
      "}",
      "function respond(error, route, scrub) {",
      "  return [createErrorResponse(error, { route, scrub }), createErrorResponse(error, { route, scrub: scrub })];",
      "}",
      "function read(provider) { return provider.getMonitoringData(); }",
    ].join("\n");
    expect(scan("planted.ts", planted).providerTextReads).toEqual([
      "planted.ts: answer: logger.error(error)",
      "planted.ts: answer: createErrorResponse(error)",
      "planted.ts: answer: failure.message",
      "planted.ts: answer: refusal.message",
      "planted.ts: answer: result.warnings",
      "planted.ts: answer: settled.error.stack",
      "planted.ts: walk: detail.indexes.unavailable",
      "planted.ts: walk: count.sampledFrom",
      "planted.ts: walk: batch.truncated.reason",
      "planted.ts: respond: createErrorResponse(error, scrub)",
      "planted.ts: respond: createErrorResponse(error, scrub)",
      "planted.ts: read: provider.getMonitoringData",
    ]);
  });

  test("outside provider code and the shared auth layer only the core module reads secretForms or holdsSecretForm", () => {
    const allowed = [PROVIDER_CODE, join("src", "lib", "db", "auth") + sep];
    const readers = FILES.filter(
      ({ file }) =>
        !allowed.some((prefix) => file.startsWith(prefix)) &&
        file !== PROVIDER_TEXT &&
        file !== join("src", "lib", "db", "utils", "server-text.ts"),
    ).filter(({ census }) => ["secretForms", "holdsSecretForm"].some((name) => census.identifiers.has(name)));
    expect(readers.map(({ file }) => file)).toEqual([]);
  });

  test("on the paths the census covers only the core module reads secretFieldValues", () => {
    const readers = PROVIDER_TEXT_PATHS.flatMap(pathFiles).filter((file) =>
      censusOf(file).identifiers.has("secretFieldValues"),
    );
    expect(readers).toEqual([]);
  });

  test("every crossing the census records calls the core function it is listed with", () => {
    const missing = CROSSINGS.filter(
      ([file, declaration, callee]) => !censusOf(file).calls.get(declaration)?.has(callee),
    ).map((row) => row.join(": "));
    expect(missing).toEqual([]);
  });

  test("every provider text read and every error rendered on those paths is a recorded crossing or classified as not provider text", () => {
    const crossings = new Set(CROSSINGS.map(([file, declaration]) => `${file}: ${declaration}`));
    const findings = PROVIDER_TEXT_PATHS.flatMap(pathFiles).flatMap((file) => censusOf(file).providerTextReads);
    const unrecorded = findings.filter((finding) => {
      const [file, declaration] = finding.split(": ");
      return !crossings.has(`${file}: ${declaration}`) && !Object.hasOwn(NOT_PROVIDER_TEXT, finding);
    });
    expect(unrecorded).toEqual([]);
    // Every classified read still exists, so the list cannot keep a reason for a read that is gone.
    const found = new Set(findings);
    expect(Object.keys(NOT_PROVIDER_TEXT).filter((entry) => !found.has(entry))).toEqual([]);
  });

  test("on those paths every createErrorResponse is given the connection's scrub or is classified as rendering no provider text", () => {
    // A crossing in the same declaration never excuses a call without the scrub: the call renders the error itself.
    const withoutScrub = PROVIDER_TEXT_PATHS.flatMap(pathFiles)
      .flatMap((file) => censusOf(file).providerTextReads)
      .filter((finding) => finding.includes(": createErrorResponse(") && !finding.endsWith(", scrub)"))
      .filter((finding) => !Object.hasOwn(NOT_PROVIDER_TEXT, finding));
    expect(withoutScrub).toEqual([]);
  });

  test("on those paths every provider read whose answer carries the provider's sentences is answered through that answer's core scrubs in the same declaration, or is classified", () => {
    const findings = PROVIDER_TEXT_PATHS.flatMap(pathFiles).flatMap((file) => censusOf(file).providerTextReads);
    const withoutTheirScrubs = findings.filter((finding) => {
      const member = Object.keys(SENTENCE_ANSWERS).find((name) => finding.endsWith(`.${name}`));
      if (member === undefined || Object.hasOwn(NOT_PROVIDER_TEXT, finding)) return false;
      const [file, declaration] = finding.split(": ");
      const calls = censusOf(file).calls.get(declaration);
      return !SENTENCE_ANSWERS[member].every((scrub) => calls?.has(scrub));
    });
    expect(withoutTheirScrubs).toEqual([]);
  });

  test("the scan finds a log line that renders a caught failure, marked when withholdProviderError withholds it", () => {
    const planted = [
      "function closeAll(entry, settled) {",
      "  try { run(); } catch (error) {",
      '    logger.warn("x", { connectionId, error: String(error) });',
      '    logger.warn("y", { error: String(withholdProviderError(entry.scrub, error)) });',
      '    logger.error("z", error, { connectionId });',
      "  }",
      '  promise.catch((failure) => console.error("w", id, failure));',
      '  settled.forEach((close) => logger.warn("v", { error: String(close.reason) }));',
      '  logger.info("u", { error: other.error });',
      "}",
    ].join("\n");
    expect(scan("planted.ts", planted).caughtLogs).toEqual([
      "planted.ts: closeAll: logger.warn(error)",
      "planted.ts: closeAll: logger.warn(error, scrub)",
      "planted.ts: closeAll: logger.error(error)",
      "planted.ts: closeAll: console.error(failure)",
      "planted.ts: closeAll: logger.warn(close.reason)",
    ]);
  });

  test("every log line of the provider factory renders a failure it caught only through withholdProviderError, or is classified", () => {
    const lines = censusOf(factory).caughtLogs;
    expect(
      lines.filter((line) => !line.endsWith(", scrub)") && !Object.hasOwn(FACTORY_LOG_NOT_PROVIDER_TEXT, line)),
    ).toEqual([]);
    // Each classification names exactly one line: one that is gone keeps no reason, and a second line of the same
    // declaration, callee and value is a line of its own, which needs its own reason.
    expect(
      Object.keys(FACTORY_LOG_NOT_PROVIDER_TEXT).filter((key) => lines.filter((line) => line === key).length !== 1),
    ).toEqual([]);
  });

  test("every route that resolves a connection is on the paths the census covers", () => {
    const covered = new Set(PROVIDER_TEXT_PATHS.flatMap(pathFiles));
    const routes = FILES.filter(
      ({ file, census }) =>
        file.startsWith(join("src", "app", "api") + sep) &&
        basename(file) === "route.ts" &&
        census.identifiers.has("resolveConnection"),
    ).map(({ file }) => file);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((file) => !covered.has(file))).toEqual([]);
  });
});
