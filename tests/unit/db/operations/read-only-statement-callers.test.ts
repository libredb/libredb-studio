import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";

/**
 * The protected read path has one core caller.
 *
 * A provider's `queryReadOnly` is the read-only statement path the agent, the hand-over replay and MCP run statements
 * on, and `runReadOnlyStatement` (`src/lib/db/operations/read-only-statement.ts`) is the one core function that holds
 * its answer to the budget handed out. A second core caller would be a path where the caps are only the provider's
 * claim, so outside provider code no module reads the method except to test that it exists (`typeof`), and that
 * function is the one exception. Any read counts, not only a call: a read is how a call, a `.bind`, a `.call`, an
 * `.apply` or an alias begins.
 *
 * The agent's other budgeted reads, the catalog read `readCatalogReadOnly` and the cluster readings `readClusterUsage`
 * and `readWorkloadProfile`, are held the same way: each is read once outside provider code, in the one agent function
 * that hands it to `runReadOnlyReading`, so a second caller cannot skip core's row, byte and time check either.
 *
 * The same paths never fall back to the writable path: under the agent, hand-over and MCP sources the only call of a
 * method named `query` is the operations-profile statistics read, which sends a statement the statement guard has
 * admitted. There the rule counts calls, since other objects on those paths carry a plain `query` field.
 *
 * Both scans read the TypeScript syntax tree, so a comment or a docblock that names a method is never a finding, and
 * a finding names its file and its innermost declaration.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SOURCE_ROOTS = ["src", join("vscode-extension", "src")];
const PROVIDER_CODE = join("src", "lib", "db", "providers") + sep;
const CORE_CALLER = join("src", "lib", "db", "operations", "read-only-statement.ts");
const AGENT_AND_MCP_SOURCES = [
  join("src", "lib", "agent"),
  join("src", "lib", "mcp"),
  join("src", "app", "api", "agent"),
  join("src", "app", "api", "mcp"),
];
const STATISTICS_READ = "readStatisticsForGrounding";
const CORE_READING = "runReadOnlyReading";
/** Each budgeted read that is not a statement, and the one function outside provider code that reads it. */
const BUDGETED_READS = [
  {
    method: "readCatalogReadOnly",
    file: join("src", "lib", "agent", "languages", "mongo", "tools.ts"),
    caller: "mongoInspectSchemaTool",
  },
  {
    method: "readClusterUsage",
    file: join("src", "lib", "agent", "languages", "kubectl", "tools.ts"),
    caller: "runClusterUsage",
  },
  {
    method: "readWorkloadProfile",
    file: join("src", "lib", "agent", "languages", "kubectl", "tools.ts"),
    caller: "runWorkloadProfile",
  },
] as const;

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

/** Whether `node` only wraps an expression without changing its value: parentheses, `!`, `as`, `satisfies`, `<T>`. */
function isTransparent(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/** The parent of `node` with every transparent wrapper around it stepped over. */
function outer(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (parent !== undefined && isTransparent(parent)) parent = parent.parent;
  return parent;
}

/** `node` with every transparent wrapper inside it stepped over. */
function inner(node: ts.Node): ts.Node {
  let at = node;
  while (isTransparent(at)) at = (at as ts.ParenthesizedExpression).expression;
  return at;
}

/** Whether `node` is an entry of an object literal that is the target of a destructuring assignment. */
function isAssignmentPatternEntry(node: ts.Node): node is ts.ShorthandPropertyAssignment | ts.PropertyAssignment {
  if (!ts.isShorthandPropertyAssignment(node) && !ts.isPropertyAssignment(node)) return false;
  const literal = node.parent;
  const assignment = literal.parent;
  return (
    ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.left === literal
  );
}

/**
 * Whether `node` reads a member called `name`: `x.name`, `x?.name`, `x["name"]`, `const { name } = x`, or
 * `({ name } = x)`.
 */
function readsMember(node: ts.Node, name: string): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === name;
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === name;
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === name;
  }
  if (isAssignmentPatternEntry(node)) {
    return (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) && node.name.text === name;
  }
  return false;
}

/**
 * Whether the member read `node` is called: `x.name(...)`, `x.name?.(...)`, or through `.bind`, `.call`, `.apply`,
 * with any transparent wrapper (`isTransparent`) between the read and the call.
 */
function isCalled(node: ts.Node): boolean {
  const parent = outer(node);
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) && inner(parent.expression) === node) return true;
  return (
    ts.isPropertyAccessExpression(parent) &&
    ["bind", "call", "apply"].includes(parent.name.text) &&
    ts.isCallExpression(outer(parent)) &&
    inner((outer(parent) as ts.CallExpression).expression) === parent
  );
}

/** Whether `node` is a function body's own declaration: a function, a method, or a name bound to a function. */
function namedFunction(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return undefined;
}

/** The name of the innermost function around `node`, or the file's top level. */
function enclosingDeclaration(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    const name = namedFunction(at);
    if (name !== undefined) return name;
  }
  return "(top level)";
}

/** The names of every function declaration around `node`, innermost first. */
function enclosingFunctions(node: ts.Node): string[] {
  const names: string[] = [];
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name !== undefined) names.push(at.name.text);
  }
  return names;
}

interface Finding {
  readonly file: string;
  readonly declaration: string;
  readonly functions: readonly string[];
  readonly called: boolean;
  readonly typeofTest: boolean;
}

/** Every read of a member called `name` in `text`, with whether it is called and whether it is only a `typeof` test. */
function memberReads(file: string, text: string, name: string): Finding[] {
  const source = parse(file, text);
  const found: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (readsMember(node, name)) {
      const parent = outer(node);
      found.push({
        file,
        declaration: enclosingDeclaration(node),
        functions: enclosingFunctions(node),
        called: !ts.isBindingElement(node) && !isAssignmentPatternEntry(node) && isCalled(node),
        typeofTest: parent !== undefined && ts.isTypeOfExpression(parent),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The reads of `queryReadOnly` that are more than a test of whether it exists. */
function queryReadOnlyUses(file: string, text: string): Finding[] {
  return memberReads(file, text, "queryReadOnly").filter((finding) => !finding.typeofTest);
}

/** Whether `node` is a function: a declaration, an expression, an arrow or a method. */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Whether `node` contains a call of the function named `name`. */
function callsFunction(node: ts.Node, name: string): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(inner(node.expression)) &&
    (inner(node.expression) as ts.Identifier).text === name
  ) {
    return true;
  }
  return ts.forEachChild(node, (child) => callsFunction(child, name) || undefined) === true;
}

interface BudgetedReadUse {
  readonly file: string;
  readonly declaration: string;
  readonly functions: readonly string[];
  /** Whether the innermost function around the read also calls `runReadOnlyReading`. */
  readonly heldByCore: boolean;
}

/** The reads of a member called `name` that are more than a test of whether it exists. */
function budgetedReadUses(file: string, text: string, name: string): BudgetedReadUse[] {
  const source = parse(file, text);
  const found: BudgetedReadUse[] = [];
  const visit = (node: ts.Node) => {
    if (readsMember(node, name) && !ts.isTypeOfExpression(outer(node))) {
      let scope: ts.Node | undefined = node.parent;
      while (scope !== undefined && !isFunctionLike(scope)) scope = scope.parent;
      found.push({
        file,
        declaration: enclosingDeclaration(node),
        functions: enclosingFunctions(node),
        heldByCore: scope !== undefined && callsFunction(scope, CORE_READING),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The calls of a method named `query`. */
function queryCalls(file: string, text: string): Finding[] {
  return memberReads(file, text, "query").filter((finding) => finding.called);
}

const label = (finding: Finding) => `${finding.file} in ${finding.declaration}`;

describe("the protected read path", () => {
  test("the scan finds every form of a queryReadOnly call, and not a comment that names one", () => {
    const planted = [
      "function direct(p) { return p.queryReadOnly('SELECT 1', budget); }",
      "function optional(p) { return p.queryReadOnly?.('SELECT 1', budget); }",
      "function bound(p) { const run = p.queryReadOnly.bind(p); return run('SELECT 1', budget); }",
      "function called(p) { return p.queryReadOnly.call(p, 'SELECT 1', budget); }",
      "function applied(p) { return p.queryReadOnly.apply(p, ['SELECT 1', budget]); }",
      "function indexed(p) { return p['queryReadOnly']('SELECT 1', budget); }",
      "function destructured(p) { const { queryReadOnly } = p; return queryReadOnly('SELECT 1', budget); }",
      "function assigned(p) { let queryReadOnly; ({ queryReadOnly } = p); return queryReadOnly('SELECT 1', budget); }",
      "function renamed(p) { let run; ({ queryReadOnly: run } = p); return run('SELECT 1', budget); }",
      "function tested(p) { return typeof p.queryReadOnly === 'function'; }",
      "/** p.queryReadOnly('SELECT 1', budget) */ // p.queryReadOnly?.('SELECT 1')",
    ].join("\n");
    expect(queryReadOnlyUses("planted.ts", planted).map((finding) => finding.declaration)).toEqual([
      "direct",
      "optional",
      "bound",
      "called",
      "applied",
      "indexed",
      "destructured",
      "assigned",
      "renamed",
    ]);
  });

  test("no module outside the providers calls queryReadOnly except runReadOnlyStatement", () => {
    const outside = SOURCE_ROOTS.flatMap(sourceFiles).filter(
      (file) => !file.startsWith(PROVIDER_CODE) && file !== CORE_CALLER,
    );
    expect(outside.length).toBeGreaterThan(0);
    const uses = outside.flatMap((file) => queryReadOnlyUses(file, readFileSync(join(ROOT, file), "utf8")));
    expect(uses.map(label)).toEqual([]);
    // The one caller is still there, so the rule above is not vacuous: inside `runReadOnlyStatement`, in the read it
    // hands `runReadOnlyReading`.
    const core = queryReadOnlyUses(CORE_CALLER, readFileSync(join(ROOT, CORE_CALLER), "utf8"));
    expect(core.map((use) => `${use.file} in ${use.functions.at(-1)}`)).toEqual([
      `${CORE_CALLER} in runReadOnlyStatement`,
    ]);
  }, 60_000);

  test("the scan finds a budgeted read outside the function that hands it to runReadOnlyReading", () => {
    const planted = [
      "function held(p) { const read = p.readClusterUsage; return runReadOnlyReading({ read: () => read.call(p) }); }",
      "function direct(p) { return p.readClusterUsage(input, budget); }",
      "function tested(p) { return typeof p.readClusterUsage === 'function'; }",
      "/** p.readClusterUsage(input, budget) */",
    ].join("\n");
    expect(
      budgetedReadUses("planted.ts", planted, "readClusterUsage").map((use) => [use.declaration, use.heldByCore]),
    ).toEqual([
      ["held", true],
      ["direct", false],
    ]);
  });

  test("no module outside the providers reads readCatalogReadOnly, readClusterUsage or readWorkloadProfile except to hand it to runReadOnlyReading", () => {
    const outside = SOURCE_ROOTS.flatMap(sourceFiles).filter((file) => !file.startsWith(PROVIDER_CODE));
    expect(outside.length).toBeGreaterThan(0);
    for (const { method, file, caller } of BUDGETED_READS) {
      const uses = outside.flatMap((each) => budgetedReadUses(each, readFileSync(join(ROOT, each), "utf8"), method));
      expect(uses.map((use) => `${use.file} in ${use.functions.at(-1)}, held by core: ${use.heldByCore}`)).toEqual([
        `${file} in ${caller}, held by core: true`,
      ]);
    }
  }, 60_000);

  test("the scan finds a query() call, and not a comment that names one", () => {
    const planted = [
      "function direct(p) { return p.query('SELECT 1'); }",
      "function optional(p) { return p.query?.('SELECT 1'); }",
      "function bound(p) { return p.query.bind(p)('SELECT 1'); }",
      "function indexed(p) { return p['query']('SELECT 1'); }",
      "function called(p) { return p.query.call(p, 'SELECT 1'); }",
      "function applied(p) { return p.query.apply(p, ['SELECT 1']); }",
      "function nonNull(p) { return p.query!('SELECT 1'); }",
      "function cast(p) { return (p.query as QueryFn)('SELECT 1'); }",
      "function satisfied(p) { return (p.query satisfies unknown as QueryFn)('SELECT 1'); }",
      "function asserted(p) { return (<QueryFn>p.query)('SELECT 1'); }",
      "function nonNullCalled(p) { return p.query!.call(p, 'SELECT 1'); }",
      "function field(entry) { return { text: entry.query }; }",
      "/** p.query('SELECT 1') */ // p.query('SELECT 1')",
    ].join("\n");
    expect(queryCalls("planted.ts", planted).map((finding) => finding.declaration)).toEqual([
      "direct",
      "optional",
      "bound",
      "indexed",
      "called",
      "applied",
      "nonNull",
      "cast",
      "satisfied",
      "asserted",
      "nonNullCalled",
    ]);
  });

  test("the agent, hand-over and MCP sources call query() only in the operations-profile statistics read", () => {
    const files = AGENT_AND_MCP_SOURCES.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const calls = files.flatMap((file) => queryCalls(file, readFileSync(join(ROOT, file), "utf8")));
    expect(calls.filter((call) => !call.functions.includes(STATISTICS_READ)).map(label)).toEqual([]);
    // The one call is still there, so the rule above is not vacuous.
    expect(calls.map((call) => `${call.file} in ${call.functions.at(-1)}`)).toEqual([
      `${join("src", "lib", "agent", "tools.ts")} in ${STATISTICS_READ}`,
    ]);
  });
});

/** The function declared as `name` in `file`, parsed from the source. */
function declaredFunction(file: string, name: string): ts.FunctionDeclaration {
  const source = parse(file, readFileSync(join(ROOT, file), "utf8"));
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  if (found === undefined) throw new Error(`${file} declares no function ${name}`);
  return found;
}

/**
 * The source position of the first call in `node` whose callee is `callee`: a bare name (`f(...)`) or a member of a
 * named object (`object.f(...)`, written `object.f`), with any transparent wrapper stepped over; `-1` when there is none.
 */
function firstCall(node: ts.Node, callee: string): number {
  const [object, member] = callee.includes(".") ? callee.split(".") : [undefined, callee];
  let first = -1;
  const visit = (at: ts.Node) => {
    if (first !== -1) return;
    if (ts.isCallExpression(at)) {
      const target = inner(at.expression);
      const matches =
        object === undefined
          ? ts.isIdentifier(target) && target.text === member
          : ts.isPropertyAccessExpression(target) &&
            target.name.text === member &&
            ts.isIdentifier(inner(target.expression)) &&
            (inner(target.expression) as ts.Identifier).text === object;
      if (matches) {
        first = at.getStart();
        return;
      }
    }
    ts.forEachChild(at, visit);
  };
  visit(node);
  return first;
}

/** Whether, in `node`, the first call of `gate` comes before the first call of every one of `reaches`, each present. */
function gatedBefore(node: ts.Node, gate: string, reaches: readonly string[]): Record<string, string> {
  const gateAt = firstCall(node, gate);
  return Object.fromEntries(
    reaches.map((reach) => {
      const reachAt = firstCall(node, reach);
      if (gateAt === -1) return [reach, `${gate} is never called`];
      if (reachAt === -1) return [reach, `${reach} is never called`];
      return [reach, gateAt < reachAt ? "gated" : `${reach} comes before ${gate}`];
    }),
  );
}

/**
 * How `statement`, the then-branch of an absence test, refuses: `"throw"` when it is a `throw` or a block whose last
 * statement is one, `"returned-refusal"` when it is (or a block ends in) `return [ownWordsError(...), "<reason>"]`,
 * the shape a tool that answers its refusal as a value returns, and `null` for anything else. A bare `return`, a
 * default result, a `query()` fallback or any other value is not a refusal, whatever the branch logs first.
 */
function refusalOf(statement: ts.Statement): PresenceTest["refusal"] {
  const last = ts.isBlock(statement) ? statement.statements.at(-1) : statement;
  if (last === undefined) return null;
  if (ts.isThrowStatement(last)) return "throw";
  if (!ts.isReturnStatement(last) || last.expression === undefined) return null;
  const returned = inner(last.expression);
  if (!ts.isArrayLiteralExpression(returned) || returned.elements.length !== 2) return null;
  const [error, reason] = returned.elements.map(inner);
  return ts.isCallExpression(error) &&
    ts.isIdentifier(error.expression) &&
    error.expression.text === "ownWordsError" &&
    ts.isStringLiteralLike(reason)
    ? "returned-refusal"
    : null;
}

/**
 * How the `typeof` test `test` refuses the method's absence, or `null` where it does not only refuse it: it is one
 * operand of a `!==` or `!=` comparison with the string `"function"`, that comparison reaches an `if` condition only
 * through parentheses, `&&` and `||`, and the `if`'s then-branch refuses (`refusalOf`). Anything else (a `===` test, a
 * negation, a ternary, a value kept in a name) is a presence test that could open a path.
 */
function absenceRefusal(test: ts.TypeOfExpression): PresenceTest["refusal"] {
  const comparison = outer(test);
  if (
    comparison === undefined ||
    !ts.isBinaryExpression(comparison) ||
    ![ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(
      comparison.operatorToken.kind,
    )
  ) {
    return null;
  }
  const other = inner(comparison.left) === test ? comparison.right : comparison.left;
  if (!ts.isStringLiteralLike(inner(other)) || (inner(other) as ts.StringLiteralLike).text !== "function") return null;
  let at: ts.Node = comparison;
  let parent = at.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)))
  ) {
    at = parent;
    parent = at.parent;
  }
  return parent !== undefined && ts.isIfStatement(parent) && parent.expression === at
    ? refusalOf(parent.thenStatement)
    : null;
}

interface PresenceTest {
  readonly file: string;
  readonly declaration: string;
  readonly refusal: "throw" | "returned-refusal" | null;
}

/** Every `typeof` test of a member called `queryReadOnly` in `text`, with how it refuses the absence. */
function presenceTests(file: string, text: string): PresenceTest[] {
  const source = parse(file, text);
  const found: PresenceTest[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeOfExpression(node) && readsMember(inner(node.expression), "queryReadOnly")) {
      found.push({ file, declaration: enclosingDeclaration(node), refusal: absenceRefusal(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const REVIEW_GATE = "assertStatementsReviewed";
/** The presence tests outside provider code today, each refusing the absence: none opens a path. */
const FACTORY = join("src", "lib", "db", "factory.ts");
const KNOWN_PRESENCE_TESTS: readonly string[] = [
  `${join("src", "app", "api", "agent", "runs", "[runId]", "handover", "route.ts")} in POST`,
  `${join("src", "lib", "agent", "tools.ts")} in runStatement`,
  `${FACTORY} in acquireExecutionProfileProvider`,
  `${CORE_CALLER} in read`,
  `${join("src", "lib", "mcp", "tools", "run-statement.ts")} in execute`,
];
/** The presence tests that return their refusal as a value: MCP's statement tool answers every refusal that way. */
const RETURNED_REFUSALS: readonly string[] = [`${join("src", "lib", "mcp", "tools", "run-statement.ts")} in execute`];

describe("the review record gates the protected read path", () => {
  test("the scan finds a presence test that opens, and not one that refuses the absence", () => {
    const planted = [
      "function opens(p) { if (typeof p.queryReadOnly === 'function') run(); }",
      "function ternary(p) { return typeof p.queryReadOnly === 'function' ? run() : refuse(); }",
      "function kept(p) { const has = typeof p.queryReadOnly === 'function'; return has; }",
      "function negated(p) { if (!(typeof p.queryReadOnly !== 'function')) run(); }",
      "function throws(p) { if (typeof p.queryReadOnly !== 'function') throw new Error('no path'); }",
      "async function cleans(p, gate) { if (gate && typeof p.queryReadOnly !== 'function') { await cleanup(); throw new Error('no path'); } }",
      "function returnsName(p) { if (typeof p.queryReadOnly !== 'function') return refusal; }",
      "function returnsNothing(p) { if (typeof p.queryReadOnly !== 'function') return; }",
      "function fallsBack(p, sql) { if (typeof p.queryReadOnly !== 'function') return p.query(sql); }",
      "function defaults(p) { if (typeof p.queryReadOnly !== 'function') return { rows: [], fields: [], rowCount: 0 }; }",
      "function warns(p) { if (typeof p.queryReadOnly !== 'function') { logger.warn('no path'); return null; } }",
      "function otherTuple(p) { if (typeof p.queryReadOnly !== 'function') return [result, 'mcp_execution_failed']; }",
      "function tuple(p) { if (typeof p.queryReadOnly !== 'function') { const refusal = text(); return [ownWordsError(refusal), 'mcp_execution_failed']; } }",
    ].join("\n");
    expect(
      presenceTests("planted.ts", planted)
        .filter((found) => found.refusal === null)
        .map((found) => found.declaration),
    ).toEqual([
      "opens",
      "ternary",
      "kept",
      "negated",
      "returnsName",
      "returnsNothing",
      "fallsBack",
      "defaults",
      "warns",
      "otherTuple",
    ]);
    expect(
      presenceTests("planted.ts", planted)
        .filter((found) => found.refusal !== null)
        .map((found) => [found.declaration, found.refusal]),
    ).toEqual([
      ["throws", "throw"],
      ["cleans", "throw"],
      ["tuple", "returned-refusal"],
    ]);
  });

  test("no module outside the providers decides from the presence of queryReadOnly", () => {
    const outside = SOURCE_ROOTS.flatMap(sourceFiles).filter((file) => !file.startsWith(PROVIDER_CODE));
    expect(outside.length).toBeGreaterThan(0);
    const found = outside.flatMap((file) => presenceTests(file, readFileSync(join(ROOT, file), "utf8")));
    expect(found.filter((test) => test.refusal === null).map((test) => `${test.file} in ${test.declaration}`)).toEqual(
      [],
    );
    // A refusal returned as a value is admitted only where the tool answers its refusal as a value.
    expect(
      found.filter((test) => test.refusal === "returned-refusal").map((test) => `${test.file} in ${test.declaration}`),
    ).toEqual([...RETURNED_REFUSALS]);
    // Not vacuous: the known presence tests are found, each one a refusal of the absence.
    expect(found.map((test) => `${test.file} in ${test.declaration}`).sort()).toEqual([...KNOWN_PRESENCE_TESTS]);
  }, 60_000);

  test("the scan finds a choke point that reaches the provider before the record is read", () => {
    const file = "planted.ts";
    const planted = parse(
      file,
      [
        "async function late(c) { const p = await createDatabaseProvider(c); assertStatementsReviewed(c.type); return p; }",
        "async function early(c) { assertStatementsReviewed(c.type); return createDatabaseProvider(c); }",
        "async function never(c) { return createDatabaseProvider(c); }",
        "async function read(call) { assertStatementsReviewed(call.type); return call.read(); }",
      ].join("\n"),
    );
    const named = (name: string) =>
      planted.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      ) as ts.FunctionDeclaration;
    expect(gatedBefore(named("late"), REVIEW_GATE, ["createDatabaseProvider"])).toEqual({
      createDatabaseProvider: `createDatabaseProvider comes before ${REVIEW_GATE}`,
    });
    expect(gatedBefore(named("early"), REVIEW_GATE, ["createDatabaseProvider"])).toEqual({
      createDatabaseProvider: "gated",
    });
    expect(gatedBefore(named("never"), REVIEW_GATE, ["createDatabaseProvider"])).toEqual({
      createDatabaseProvider: `${REVIEW_GATE} is never called`,
    });
    expect(gatedBefore(named("read"), REVIEW_GATE, ["call.read"])).toEqual({ "call.read": "gated" });
  });

  test("acquireExecutionProfileProvider reads the review record before it builds a provider", () => {
    const body = declaredFunction(FACTORY, "acquireExecutionProfileProvider");
    expect(gatedBefore(body, REVIEW_GATE, ["profiledCacheKey", "createSSHTunnel", "createDatabaseProvider"])).toEqual({
      profiledCacheKey: "gated",
      createSSHTunnel: "gated",
      createDatabaseProvider: "gated",
    });
  });

  test("runReadOnlyReading reads the review record before it makes the read", () => {
    const body = declaredFunction(CORE_CALLER, CORE_READING);
    expect(gatedBefore(body, REVIEW_GATE, ["assertReadOnlyBudget", "call.read", "call.holdUntilSettled"])).toEqual({
      assertReadOnlyBudget: "gated",
      "call.read": "gated",
      "call.holdUntilSettled": "gated",
    });
  });
});
