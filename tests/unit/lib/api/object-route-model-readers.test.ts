/**
 * The object routes read an engine's object model from the session they read through, never from a built provider's
 * capabilities (docs/providers/CONTRACT.md, clause M-89).
 *
 * Every call of a member named `getCapabilities` in the object routes' helpers (src/lib/api/object-route.ts), the tree
 * facade (src/lib/api/object-tree.ts), the source facade (src/lib/api/object-source.ts), the container walk
 * (src/lib/db/container-walk.ts) and every route under src/app/api/db/objects is found with the TypeScript parser, so a
 * comment or a string that names the member is not a call. Each allowed call is listed by file with its reason, and a
 * new call anywhere else fails here by file. Files are read with `path.join` and parsed whole, so no platform's path
 * separator or line ending reaches the census.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const ROUTES = path.join("src", "app", "api", "db", "objects");

/** Each file allowed to call `getCapabilities`, by its path from the repository root, with how many calls and why. */
const ALLOWED: Readonly<Record<string, { readonly calls: number; readonly reason: string }>> = Object.freeze({
  "src/app/api/db/objects/edit-plan/route.ts": {
    calls: 1,
    reason: "the object edit is parked with 10c5's edit and stays refused for a package engine",
  },
  "src/app/api/db/objects/edit-apply/route.ts": {
    calls: 1,
    reason: "the object edit is parked with 10c5's edit and stays refused for a package engine",
  },
});

/** Every file the census reads, by its path from the repository root with forward slashes. */
function censusFiles(): string[] {
  const routes = readdirSync(path.join(ROOT, ROUTES), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [ROUTES, entry.name, "route.ts"].join("/").split(path.sep).join("/"));
  return [
    "src/lib/api/object-route.ts",
    "src/lib/api/object-source.ts",
    "src/lib/api/object-tree.ts",
    "src/lib/db/container-walk.ts",
    ...routes.sort(),
  ];
}

/** How many calls of a member named `getCapabilities` `text` holds, comments and strings not read. */
function capabilityCalls(fileName: string, text: string): number {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
          ? callee.argumentExpression.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
      if (name === "getCapabilities") calls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

describe("the object routes' model readers", () => {
  test("no object route or its helpers reads a provider's capabilities, but the edit routes parked with 10c5's edit", () => {
    const files = censusFiles();
    const found = Object.fromEntries(
      files.flatMap((file) => {
        const calls = capabilityCalls(file, readFileSync(path.join(ROOT, file), "utf8"));
        return calls === 0 ? [] : [[file, calls]];
      }),
    );

    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { calls }]) => [file, calls])));
    // Vacuity: the census reads every route the object routes are, the source route and both edit routes among them.
    expect(files).toEqual(
      expect.arrayContaining([
        "src/app/api/db/objects/list/route.ts",
        "src/app/api/db/objects/source/route.ts",
        "src/app/api/db/objects/edit-plan/route.ts",
        "src/lib/api/object-source.ts",
      ]),
    );
    expect(files.length).toBeGreaterThan(9);
  });

  test("a planted call is found in every spelling, and a comment or a string naming the member is not a call", () => {
    const planted = [
      "provider.getCapabilities();",
      "tree.provider.getCapabilities().objectKinds;",
      'provider["getCapabilities"]();',
      "const { getCapabilities } = provider; getCapabilities();",
    ];
    const named = [
      "// provider.getCapabilities() is read by the edit routes",
      "/** `provider.getCapabilities()` */",
      'const text = "provider.getCapabilities()";',
      "const member = provider.getCapabilities;",
    ];

    expect(planted.map((text) => capabilityCalls("planted.ts", text))).toEqual([1, 1, 1, 1]);
    expect(named.map((text) => capabilityCalls("named.ts", text))).toEqual([0, 0, 0, 0]);
  });
});
