/**
 * An answer's `retryable` is advice to a person, and nothing resends a request because of it
 * (docs/providers/CONTRACT.md, clause E-8).
 *
 * The routes, the proxy and the LLM errors write `retryable` on an error body. A component that resent on it would
 * run a write twice, or bill a read twice, on the strength of a flag that says only that trying again may help. So
 * every read of a property named `retryable` in Studio's source (`src/`, `bin/`, `vscode-extension/src/` and every
 * `packages/*\/src/`) is one of the recorded copies below, each of which carries the flag to the next hop and decides
 * nothing; a new read anywhere else fails here, naming its file and enclosing declaration.
 *
 * A read is a property access or an element access by that name that is not the target of an assignment, or a
 * destructuring binding of that name. The scan reads the TypeScript syntax tree of only the files whose text holds
 * the word, so a comment is never a finding, and a finding names its file and innermost named declaration, never a
 * line.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface SourceText {
  readonly path: string;
  readonly text: string;
}

interface Read {
  readonly file: string;
  readonly declaration: string;
}

/** The recorded copies: each carries the answer's flag onward and nothing branches on it. */
const RECORDED_COPIES: readonly (Read & { readonly why: string })[] = [
  {
    file: "vscode-extension/src/backend/handlers.ts",
    declaration: "toResponseError",
    why: "forwards the error body's flag into the JSON-RPC error data the host reads",
  },
  {
    file: "vscode-extension/src/host/backend-client.ts",
    declaration: "BackendError",
    why: "copies the answer's flag onto the error the host raises, for the person to read",
  },
];

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Every source file under `directory`, as repository-relative POSIX paths, or none when it does not exist. */
function sourceFiles(directory: string): string[] {
  if (!existsSync(path.join(ROOT, directory))) return [];
  return readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSION.test(entry.name) && !entry.name.endsWith(".d.ts"))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !file.split("/").includes("node_modules"))
    .sort();
}

/** Studio's source files whose text holds `retryable`. */
function sourcesNamingRetryable(): SourceText[] {
  const packages = readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`);
  return ["src", "bin", "vscode-extension/src", ...packages]
    .flatMap(sourceFiles)
    .map((file) => ({ path: file, text: readFileSync(path.join(ROOT, file), "utf8") }))
    .filter((file) => file.text.includes("retryable"));
}

/** The name of the innermost named declaration around `node`; a constructor is named by its class. */
function enclosingDeclaration(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isConstructorDeclaration(current) && ts.isClassLike(current.parent) && current.parent.name) {
      return current.parent.name.text;
    }
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name !== undefined &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
  }
  return "<module>";
}

/** Whether `node` is the target of an assignment: `x.retryable = ...`, or a compound assignment to it. */
function isAssigned(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** The script kind a file's extension names, so a `.ts` file's `<T>` reads as a type and never as a JSX tag. */
function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Every read of a property named `retryable` in `files`, in file order and then source order. */
function retryableReads(files: readonly SourceText[]): Read[] {
  const found: Read[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind(file.path));
    const visit = (node: ts.Node): void => {
      const reads =
        (ts.isPropertyAccessExpression(node) && node.name.text === "retryable" && !isAssigned(node)) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === "retryable" &&
          !isAssigned(node)) ||
        (ts.isBindingElement(node) &&
          ts.isObjectBindingPattern(node.parent) &&
          (node.propertyName ?? node.name).getText(source) === "retryable");
      if (reads) found.push({ file: file.path, declaration: enclosingDeclaration(node) });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function key(read: Read): string {
  return `${read.file} ${read.declaration}`;
}

describe("nothing resends on retryable", () => {
  const recorded = RECORDED_COPIES.map(key);
  const reads = retryableReads(sourcesNamingRetryable()).map(key);

  test("every read of an answer's retryable is a recorded copy, so nothing resends on it", () => {
    expect(reads.filter((read) => !recorded.includes(read))).toEqual([]);
  });

  test("every recorded copy is still in the source", () => {
    expect(recorded.filter((copy) => !reads.includes(copy))).toEqual([]);
  });

  test("the scan finds a read, a destructured binding and an element access, and not a write or a comment", () => {
    const planted: SourceText[] = [
      {
        path: "src/lib/planted.ts",
        text: [
          "// if (body.retryable) send() is named here only in a comment.",
          "export function resend(body: { retryable?: boolean }, send: () => void): void {",
          "  if (body.retryable) send();",
          "}",
          "export function unpack(body: { retryable?: boolean }): boolean | undefined {",
          "  const { retryable } = body;",
          "  return retryable;",
          "}",
          'export const flag = (body: Record<string, boolean>) => body["retryable"];',
          "export class Holder {",
          "  readonly retryable: boolean;",
          "  constructor(x: boolean) {",
          "    this.retryable = x;",
          "  }",
          "}",
          "export const written = { retryable: true };",
        ].join("\n"),
      },
    ];

    expect(retryableReads(planted)).toEqual([
      { file: "src/lib/planted.ts", declaration: "resend" },
      { file: "src/lib/planted.ts", declaration: "unpack" },
      { file: "src/lib/planted.ts", declaration: "flag" },
    ]);
  });
});
