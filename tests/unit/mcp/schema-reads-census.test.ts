import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * MCP's schema reads go through the host core's tree call (docs/providers/CONTRACT.md, clause C-82).
 *
 * inspect_schema's container listings, relation listings and descriptions, and the database choice's listing, are each
 * one host core tree call on MCP's object tree (`mcpObjectTree` in src/lib/mcp/tools/read-query-limits.ts), under the
 * call's deadline and the request's signal. A provider's tree member called by an MCP module would be a read the host
 * neither bounds nor logs, so no MCP module calls one on anything but an object tree: a name the same function binds to
 * `mcpObjectTree(...)`, or a parameter typed `ObjectTree`. The within-call facade (`objectTreeWithinCall` in
 * src/lib/api/object-tree.ts) is called only by `mcpObjectTree`, and that only by the database choice
 * (`listedDatabases`, for `providerInDatabase`) and inspect_schema (`inspectSchema`), so no other path builds a tree on
 * MCP's deadline.
 *
 * Both scans read the TypeScript syntax tree, so a comment or a docblock that names a member is never a finding, and a
 * finding names its file and its innermost declaration.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const MCP_SOURCES = join("src", "lib", "mcp");
const SOURCE_ROOTS = ["src", join("vscode-extension", "src")];
/** The provider members a tree read answers, the ones the host core's tree call serves. */
const TREE_MEMBERS = new Set(["listContainers", "countObjects", "listObjects", "describeObject", "describeObjects"]);

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

function parse(file: string, text = readFileSync(join(ROOT, file), "utf8")): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined,
  );
}

function visit(node: ts.Node, each: (node: ts.Node) => void): void {
  each(node);
  ts.forEachChild(node, (child) => visit(child, each));
}

/** The name of the innermost function around `node`, or the file's top level. */
function enclosingDeclaration(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) {
      return at.name.getText();
    }
    if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      at.initializer !== undefined &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    ) {
      return at.name.text;
    }
  }
  return "(top level)";
}

/** Whether `node` is a call of the function named `name`. */
function callsFunction(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

/**
 * Whether `name`, read inside `node`, is an object tree: a parameter of a function around it typed `ObjectTree`, or a
 * name a function around it binds to `mcpObjectTree(...)`.
 */
function isObjectTree(node: ts.Node, name: string): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (!ts.isFunctionLike(at)) continue;
    const typed = at.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === name && parameter.type?.getText() === "ObjectTree",
    );
    if (typed) return true;
    let bound = false;
    visit(at, (inside) => {
      if (
        ts.isVariableDeclaration(inside) &&
        ts.isIdentifier(inside.name) &&
        inside.name.text === name &&
        inside.initializer !== undefined &&
        callsFunction(inside.initializer, "mcpObjectTree")
      ) {
        bound = true;
      }
    });
    if (bound) return true;
  }
  return false;
}

/** Every call of a tree member in `file` on a receiver that is not an object tree, as `file: declaration: call`. */
function untreedReads(file: string): string[] {
  const found: string[] = [];
  visit(parse(file), (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const { expression: receiver, name } = node.expression;
    if (!TREE_MEMBERS.has(name.text)) return;
    if (ts.isIdentifier(receiver) && isObjectTree(node, receiver.text)) return;
    found.push(`${file}: ${enclosingDeclaration(node)}: ${receiver.getText()}.${name.text}`);
  });
  return found;
}

/**
 * Every call of the function named `name` across Studio's sources, as `file: declaration`. Only a file whose text holds
 * the name can call it, so the rest are never parsed.
 */
function callersOf(name: string): string[] {
  const found: string[] = [];
  for (const file of SOURCE_ROOTS.flatMap(sourceFiles)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (!text.includes(name)) continue;
    visit(parse(file, text), (node) => {
      if (callsFunction(node, name)) found.push(`${file}: ${enclosingDeclaration(node)}`);
    });
  }
  return found.sort();
}

describe("MCP's schema reads", () => {
  test("no MCP module calls a provider's tree member: the schema reads go through the host core's tree call", () => {
    expect(sourceFiles(MCP_SOURCES).flatMap(untreedReads)).toEqual([]);
  });

  test("objectTreeWithinCall is called only by MCP's object tree, and that only by the database choice and inspect_schema", () => {
    expect(callersOf("objectTreeWithinCall")).toEqual([
      join(MCP_SOURCES, "tools", "read-query-limits.ts") + ": mcpObjectTree",
    ]);
    expect(callersOf("mcpObjectTree")).toEqual([
      `${join(MCP_SOURCES, "tools", "database-choice.ts")}: listedDatabases`,
      `${join(MCP_SOURCES, "tools", "inspect-schema.ts")}: inspectSchema`,
    ]);
  });
});
