import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// One module reads the sign-in mode, so no file can take a branch on a value the boot check never saw (a typo that
// falls back to local sign-in) or read it at build time. Parsed, not grepped: comments and strings that name the
// variable are not reads, and the three shapes below are.
const VARIABLE = "NEXT_PUBLIC_AUTH_PROVIDER";
const READER = "src/lib/config/auth-provider.ts";

function readsTheMode(source: string, fileName = "probe.ts"): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === VARIABLE) found = true;
    else if (
      ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      node.argumentExpression.text === VARIABLE
    )
      found = true;
    else if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(file) === VARIABLE) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "src"], { cwd: process.cwd(), encoding: "utf8" });
  return listed.split("\n").filter((name) => /\.(ts|tsx|mts|cts)$/.test(name));
}

describe("the sign-in mode has one reader", () => {
  test("the detector finds each read shape and ignores comments and plain strings", () => {
    expect(readsTheMode("const a = process.env.NEXT_PUBLIC_AUTH_PROVIDER;")).toBe(true);
    expect(readsTheMode('const a = process.env["NEXT_PUBLIC_AUTH_PROVIDER"];')).toBe(true);
    expect(readsTheMode("const a = process.env['NEXT_PUBLIC_AUTH_PROVIDER'];")).toBe(true);
    expect(readsTheMode("const a = process.env[`NEXT_PUBLIC_AUTH_PROVIDER`];")).toBe(true);
    expect(readsTheMode("const { NEXT_PUBLIC_AUTH_PROVIDER } = process.env;")).toBe(true);
    expect(readsTheMode("const { NEXT_PUBLIC_AUTH_PROVIDER: mode = 'local' } = process.env;")).toBe(true);
    expect(readsTheMode("// process.env.NEXT_PUBLIC_AUTH_PROVIDER\n/* env.NEXT_PUBLIC_AUTH_PROVIDER */")).toBe(false);
    expect(readsTheMode('const message = "set NEXT_PUBLIC_AUTH_PROVIDER to oidc";')).toBe(false);
  });

  test("no file under src/ other than the mode reader reads NEXT_PUBLIC_AUTH_PROVIDER", () => {
    const offenders = sourceFiles().filter(
      (name) => name !== READER && readsTheMode(readFileSync(join(process.cwd(), name), "utf8"), name),
    );
    expect(offenders).toEqual(["src/app/login/page.tsx"]);
  });

  test("the mode reader itself reads the variable", () => {
    expect(readsTheMode(readFileSync(join(process.cwd(), READER), "utf8"))).toBe(true);
  });
});
