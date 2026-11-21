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
    // The one caller is still there, so the rule above is not vacuous.
    expect(queryReadOnlyUses(CORE_CALLER, readFileSync(join(ROOT, CORE_CALLER), "utf8")).map(label)).toEqual([
      `${CORE_CALLER} in runReadOnlyStatement`,
    ]);
  });

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
