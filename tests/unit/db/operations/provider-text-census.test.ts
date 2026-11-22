import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";

/**
 * The one scrub of provider text, and who wrote a refusal, held by the syntax tree.
 *
 * On the agent, hand-over and MCP paths every text a provider hands core (an error's message, name, stack, detail or
 * fix statement, a result's warnings) passes core's one scrub (src/lib/db/operations/provider-text.ts) before it
 * reaches a prompt, the ledger, a response or a log line. The census below records each crossing and the core function
 * it calls, and every other read of such a text on those paths is classified, with its reason, as not provider text.
 * A new read of a provider's text on those paths is a finding until it is recorded as one or the other. The scan is
 * syntactic and keyed on names (`error`, `refusal`, `warnings`, `logger.error`, `createErrorResponse`); a provider
 * text carried under another name escapes it, which tests/security/provider-text-scrub.test.ts catches by behaviour.
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
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SOURCE_ROOTS = ["src", join("vscode-extension", "src")];
const PROVIDER_CODE = join("src", "lib", "db", "providers") + sep;
const READ_ALLOWANCE = join("src", "lib", "db", "read-allowance.ts");
const PROVIDER_TEXT = join("src", "lib", "db", "operations", "provider-text.ts");

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

/** Every `new <className>(...)` in `text`, as "file: declaration". */
function constructions(file: string, text: string, className: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === className) {
      found.push(`${file}: ${enclosingDeclaration(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  return found;
}

const FILES = SOURCE_ROOTS.flatMap(sourceFiles).map((file) => ({
  file,
  text: readFileSync(join(ROOT, file), "utf8"),
  provider: file.startsWith(PROVIDER_CODE),
}));

/** The constructions of `className` in the files `where` keeps. */
function constructed(className: string, where: (file: { file: string; provider: boolean }) => boolean): string[] {
  return FILES.filter(where).flatMap(({ file, text }) => constructions(file, text, className));
}

describe("who wrote a refusal", () => {
  test("the scan finds a construction and not a comment naming one", () => {
    const planted = [
      "// new ExecutionProfileError('x', 'UNSUPPORTED_PROFILE')",
      "/** new ExecutionProfileError */",
      "function acquire() { throw new ExecutionProfileError('x', 'UNSUPPORTED_PROFILE'); }",
    ].join("\n");
    expect(constructions("planted.ts", planted, "ExecutionProfileError")).toEqual(["planted.ts: acquire"]);
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

  test("only the core scrub constructs a ProviderTextWithheldError", () => {
    const found = constructed("ProviderTextWithheldError", () => true);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((finding) => finding.startsWith(`${PROVIDER_TEXT}: `))).toBe(true);
  });
});

/** The paths the census covers: the agent, the hand-over and MCP, and the core read path they share. */
const PROVIDER_TEXT_PATHS = [
  join("src", "lib", "agent"),
  join("src", "lib", "mcp"),
  join("src", "app", "api", "agent"),
  join("src", "app", "api", "mcp"),
  join("src", "lib", "db", "operations", "read-only-statement.ts"),
];

function pathFiles(path: string): string[] {
  return statSync(join(ROOT, path)).isDirectory() ? sourceFiles(path) : [path];
}

/** The innermost named function or method around `node`, as `constructions` names it, without classes. */
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

/**
 * Every read of a provider's text in `text`, as "file: declaration: read": a text member of a caught error, of an
 * `error` or `refusal` property or of a `refusal`; any `warnings`; the error a `logger.error` line is given; the error
 * `createErrorResponse` renders.
 */
function providerTextReads(file: string, text: string): string[] {
  const source = parse(file, text);
  const found: string[] = [];
  const at = (node: ts.Node, read: string) => found.push(`${file}: ${functionAround(node)}: ${read}`);
  const visit = (node: ts.Node) => {
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
      if (ts.isIdentifier(callee) && callee.text === "createErrorResponse" && node.arguments[0] !== undefined) {
        at(node, `createErrorResponse(${node.arguments[0].getText(source)})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether the function or method called `declaration` in `text` calls `callee`, as a function or as a method. */
function declarationCalls(file: string, text: string, declaration: string, callee: string): boolean {
  let calls = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && functionAround(node) === declaration) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (name === callee) calls = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  return calls;
}

const agent = (...path: string[]) => join("src", "lib", "agent", ...path);
const mcp = (...path: string[]) => join("src", "lib", "mcp", ...path);
const api = (...path: string[]) => join("src", "app", "api", "agent", ...path);

/** Every crossing of provider text on the three paths, and the core function each calls: one row per call. */
const CROSSINGS: readonly (readonly [file: string, declaration: string, callee: string])[] = [
  [agent("tools.ts"), "runAuditedAgentCall", "providerTextScrub"],
  [agent("tools.ts"), "runAuditedAgentCall", "scrubProviderText"],
  [agent("tools.ts"), "runAuditedAgentCall", "withScrubbedWarnings"],
  [agent("tools.ts"), "runAuditedAgentCall", "fenceProviderText"],
  [agent("tools.ts"), "enumerateGroundingContainers", "scrubProviderText"],
  [agent("tools.ts"), "runStatement", "providerTextScrub"],
  [agent("languages", "kubectl", "tools.ts"), "runClusterUsage", "providerTextScrub"],
  [agent("languages", "kubectl", "tools.ts"), "runWorkloadProfile", "providerTextScrub"],
  [agent("languages", "mongo", "tools.ts"), "invoke", "providerTextScrub"],
  [agent("investigation.ts"), "describeSettled", "scrubProviderText"],
  [agent("investigation.ts"), "describeSettled", "fenceProviderText"],
  [agent("runtime.ts"), "driveAgentRun", "withholdProviderError"],
  [api("runs", "route.ts"), "POST", "withholdProviderError"],
  [api("runs", "[runId]", "handover", "route.ts"), "POST", "withholdProviderError"],
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
];

/**
 * Every read of such a text on the three paths outside a recorded crossing, each with the reason it is not a
 * provider's text, or is one a crossing already scrubbed.
 */
const NOT_PROVIDER_TEXT: Readonly<Record<string, string>> = {
  [`${agent("model-tuning", "index.ts")}: readOperatorDocument: error.message`]: "an operator document's parse error",
  [`${agent("capability-probe.ts")}: observeProbe: part.warnings`]: "the model SDK's warnings on a probe",
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
  [`${api("drive", "route.ts")}: POST: error.message`]: "an AgentRunServiceError, the run service's own sentence",
  [`${api("drive", "route.ts")}: POST: createErrorResponse(error)`]: "a drive's failure, which driveAgentRun withheld",
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
    ].join("\n");
    expect(providerTextReads("planted.ts", planted)).toEqual([
      "planted.ts: answer: logger.error(error)",
      "planted.ts: answer: createErrorResponse(error)",
      "planted.ts: answer: failure.message",
      "planted.ts: answer: refusal.message",
      "planted.ts: answer: result.warnings",
      "planted.ts: answer: settled.error.stack",
    ]);
  });

  test("outside provider code and the shared auth layer only the core module reads secretForms or holdsSecretForm", () => {
    const allowed = [PROVIDER_CODE, join("src", "lib", "db", "auth") + sep];
    const readers = FILES.filter(
      ({ file }) =>
        !allowed.some((prefix) => file.startsWith(prefix)) &&
        file !== PROVIDER_TEXT &&
        file !== join("src", "lib", "db", "utils", "server-text.ts"),
    ).filter(({ file, text }) => referencesIdentifier(file, text, ["secretForms", "holdsSecretForm"]));
    expect(readers.map(({ file }) => file)).toEqual([]);
  });

  test("on the agent, hand-over and MCP paths only the core module reads secretFieldValues", () => {
    const readers = PROVIDER_TEXT_PATHS.flatMap(pathFiles).filter((file) =>
      referencesIdentifier(file, readFileSync(join(ROOT, file), "utf8"), ["secretFieldValues"]),
    );
    expect(readers).toEqual([]);
  });

  test("every crossing the census records calls the core function it is listed with", () => {
    const missing = CROSSINGS.filter(
      ([file, declaration, callee]) =>
        !declarationCalls(file, readFileSync(join(ROOT, file), "utf8"), declaration, callee),
    ).map((row) => row.join(": "));
    expect(missing).toEqual([]);
  });

  test("every provider text read and every error rendered on those paths is a recorded crossing or classified as not provider text", () => {
    const crossings = new Set(CROSSINGS.map(([file, declaration]) => `${file}: ${declaration}`));
    const findings = PROVIDER_TEXT_PATHS.flatMap(pathFiles).flatMap((file) =>
      providerTextReads(file, readFileSync(join(ROOT, file), "utf8")),
    );
    const unrecorded = findings.filter((finding) => {
      const [file, declaration] = finding.split(": ");
      return !crossings.has(`${file}: ${declaration}`) && !Object.hasOwn(NOT_PROVIDER_TEXT, finding);
    });
    expect(unrecorded).toEqual([]);
    // Every classified read still exists, so the list cannot keep a reason for a read that is gone.
    const found = new Set(findings);
    expect(Object.keys(NOT_PROVIDER_TEXT).filter((entry) => !found.has(entry))).toEqual([]);
  });
});

/** Whether `text` names any of `names` as an identifier, a comment never counting. */
function referencesIdentifier(file: string, text: string, names: readonly string[]): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && names.includes(node.text)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  return found;
}
