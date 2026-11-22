import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";

/**
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
