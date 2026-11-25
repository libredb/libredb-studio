/**
 * The import closure of a provider package (src/lib/provider-host/provider-closure.ts): every recorded import of its
 * module files is a built-in of the running runtime or a relative path that stays inside the package's directory, and
 * every bare specifier is outside, whether an import or a require names it. The check reads only the record, never a
 * file, so it answers the same on every platform.
 *
 * Built-ins here are names Node.js and Bun both answer true for in `isBuiltin`: Bun also answers true for `ws`,
 * `undici` and `bun`, which Node does not, and Studio's server runs under Node, so no case relies on those.
 */
import { describe, expect, test } from "bun:test";
import { closureOutside } from "@/lib/provider-host/provider-closure";
import type { ImportKind } from "@/lib/provider-host/providers-lock-format";

/** Whether the one import `specifier` of `from`, of `kind`, is outside the package. */
function outside(from: string, specifier: string, kind: ImportKind = "import"): boolean {
  return closureOutside([{ from, specifier, kind }]);
}

describe("the import closure", () => {
  test("a built-in and a relative file inside the artifact are inside, named by an import or a require", () => {
    const inside: [string, string][] = [
      ["dist/index.mjs", "node:fs"],
      ["dist/index.mjs", "fs"],
      ["dist/index.mjs", "fs/promises"],
      ["dist/index.mjs", "node:test"],
      ["dist/index.mjs", "./lib/util.mjs"],
      ["dist/lib/util.mjs", "../index.mjs"],
      ["dist/lib/util.mjs", "../../package.json"],
      ["dist/lib/util.mjs", "."],
      ["dist/lib/util.mjs", ".."],
    ];
    for (const kind of ["import", "require"] as const) {
      for (const [from, specifier] of inside)
        expect([kind, from, specifier, outside(from, specifier, kind)]).toEqual([kind, from, specifier, false]);
    }
    expect(closureOutside([])).toBe(false);
  });

  test("a relative import that leaves the artifact, or holds %, ?, # or a backslash, is outside", () => {
    const cases: [string, string][] = [
      ["dist/index.mjs", "../../outside.mjs"],
      ["dist/lib/util.mjs", "../../.."],
      ["package.json", ".."],
      ["package.json", "../x"],
      ["dist/lib/util.mjs", "./%2e%2e/%2e%2e/%2e%2e/x.mjs"],
      ["dist/index.mjs", "./util.mjs?x"],
      ["dist/index.mjs", "./util.mjs#x"],
      ["dist/index.mjs", ".\\lib\\util.mjs"],
    ];
    for (const kind of ["import", "require"] as const) {
      for (const [from, specifier] of cases)
        expect([kind, from, specifier, outside(from, specifier, kind)]).toEqual([kind, from, specifier, true]);
    }
    // One import outside among others inside refuses the record.
    expect(
      closureOutside([
        { from: "dist/index.mjs", specifier: "./lib/util.mjs", kind: "import" },
        { from: "dist/index.mjs", specifier: "../../x.mjs", kind: "import" },
      ]),
    ).toBe(true);
  });

  test("every bare specifier, named by an import or a require, is outside whatever node_modules folder the package holds", () => {
    // The record alone decides: no listing is read, so a vendored node_modules/<name> folder changes nothing. Bun's ES
    // module resolver, and the CommonJS resolvers of Node.js and Bun, move on past a folder that lacks the file.
    for (const kind of ["import", "require"] as const) {
      for (const [from, specifier] of [
        ["dist/index.mjs", "dep"],
        ["dist/index.mjs", "dep/lib/index.js"],
        ["dist/index.mjs", "near"],
        ["dist/index.mjs", "@scope/pkg"],
        ["dist/index.mjs", "@scope/pkg/index.js"],
        ["dist/index.mjs", "@scope"],
        ["dist/index.mjs", "dep/../../../x"],
        ["dist/index.mjs", ".dep"],
        ["node_modules/dep/lib/index.js", "inner"],
        ["node_modules/dep/lib/index.js", "dep"],
      ] as const) {
        expect([kind, from, specifier, outside(from, specifier, kind)]).toEqual([kind, from, specifier, true]);
      }
    }
  });

  test("an absolute path, a URL, another scheme and a subpath import are outside", () => {
    for (const specifier of [
      "/etc/passwd",
      "file:///etc/passwd",
      "data:text/javascript,export default 1",
      "https://example.invalid/x.mjs",
      "npm:left-pad",
      "node:nope",
      "#internal",
    ]) {
      expect([specifier, outside("dist/index.mjs", specifier)]).toEqual([specifier, true]);
    }
  });

  test("the answer reads only the record, so it is the same on every platform", () => {
    for (const specifier of ["C:\\x.mjs", "C:/x.mjs", "\\\\server\\share\\x.mjs", "\\x.mjs"]) {
      expect([specifier, outside("dist/index.mjs", specifier)]).toEqual([specifier, true]);
    }
    expect(closureOutside([{ from: "a.mjs", specifier: "./a.mjs", kind: "import" }])).toBe(false);
  });
});
