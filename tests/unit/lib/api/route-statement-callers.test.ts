/**
 * The routes' statements run on the host core (docs/providers/CONTRACT.md, clause C-83).
 *
 * A native provider is served through the contract alone, so a route that calls a provider's statement member itself
 * is a path no native provider can serve. Each route's statements move onto the host core in their own part of the
 * provider host's moves; this census names the routes whose statements still run on the provider, and fails on any
 * other. Each part that moves one removes it here.
 *
 * The scan reads the TypeScript syntax tree of every tracked source under src/app/api, so a comment or a field that
 * names a member is never a finding: a finding is a call of one of the members, directly, through an optional chain,
 * by a bracketed name, or through `.call` or `.apply`, with any parentheses, `as` or `!` around its callee.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..");

/** A provider's statement members, each a path that sends a statement or acts on one the provider runs. */
const STATEMENT_MEMBERS: ReadonlySet<string> = new Set([
  "query",
  "queryInTransaction",
  "prepareQuery",
  "cancelQuery",
  "queryReadOnly",
  "endOpenQueryTransaction",
]);

/** The routes whose statements still run on the provider, each until its own part moves it. */
const STILL_ON_THE_PROVIDER = [
  // The transaction route's script of several statements.
  path.join("src", "app", "api", "db", "transaction", "route.ts"),
  // The data profile's reads.
  path.join("src", "app", "api", "db", "profile", "route.ts"),
].sort();

/** `node` with every parenthesis, `as`, `satisfies` and `!` around it stepped over. */
function inner(node: ts.Expression): ts.Expression {
  let at = node;
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isNonNullExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isSatisfiesExpression(at)
  ) {
    at = at.expression;
  }
  return at;
}

/** The member `node` reads by name, `x.name`, `x?.name` or `x["name"]`, or undefined for any other expression. */
function memberName(node: ts.Expression): string | undefined {
  const at = inner(node);
  if (ts.isPropertyAccessExpression(at)) return at.name.text;
  if (ts.isElementAccessExpression(at) && ts.isStringLiteralLike(at.argumentExpression)) {
    return at.argumentExpression.text;
  }
  return undefined;
}

/** The statement member a call's callee names, through `.call` and `.apply` too, or undefined. */
function calledMember(callee: ts.Expression): string | undefined {
  const name = memberName(callee);
  const at = inner(callee);
  if (
    (name === "call" || name === "apply") &&
    (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at))
  ) {
    const through = memberName(at.expression);
    if (through !== undefined && STATEMENT_MEMBERS.has(through)) return through;
  }
  return name !== undefined && STATEMENT_MEMBERS.has(name) ? name : undefined;
}

/** Every statement member `text`, a source named `file`, calls, in source order. */
function statementCalls(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const member = calledMember(node.expression);
      if (member !== undefined) found.push(member);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every tracked `.ts` and `.tsx` source under src/app/api, repository-relative. */
function trackedRoutes(): string[] {
  return execFileSync("git", ["ls-files", "--", path.join("src", "app", "api")], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => path.join(...file.split("/")));
}

describe("the routes' statement calls", () => {
  test("the scan finds a call of a provider statement member, and not a comment or a field that names one", () => {
    // A module, as every route is, so each `await` is the operator and never a call of a function named so.
    const planted = [
      "export {};",
      "// provider.query(sql) in a comment",
      "/** provider.prepareQuery(sql, options) in a docblock */",
      "const field = { query: 'SELECT 1', cancelQuery: true };",
      "const read = provider.queryReadOnly;",
      "await provider.query(sql);",
      "await provider?.queryInTransaction(sql);",
      'provider["prepareQuery"](sql, options);',
      "await provider.cancelQuery.call(provider, id);",
      "await provider.queryReadOnly.apply(provider, [sql]);",
      "await (provider as Provider).endOpenQueryTransaction(scope);",
      "await provider!.query(sql);",
      "await (provider.query)(sql);",
      "other.call(provider, sql);",
      "provider.describeObject(path);",
    ].join("\n");

    expect(statementCalls("planted.ts", planted)).toEqual([
      "query",
      "queryInTransaction",
      "prepareQuery",
      "cancelQuery",
      "queryReadOnly",
      "endOpenQueryTransaction",
      "query",
      "query",
    ]);
  });

  test("no route calls a provider statement member except the transaction route's script and the profile, whose statements still run on the provider", () => {
    const callers = trackedRoutes()
      .filter((file) => statementCalls(file, readFileSync(path.join(ROOT, file), "utf8")).length > 0)
      .sort();

    expect(callers).toEqual(STILL_ON_THE_PROVIDER);
  });
});
