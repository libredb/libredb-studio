/**
 * The import closure of a provider package (src/lib/provider-host/provider-closure.ts): every recorded import of its
 * module files is a built-in of the running runtime, a relative path that stays inside the package's directory, or a
 * package a `node_modules` directory of the package holds on the way up from the importing file. The check reads only
 * the listing and the record, never a file, so it answers the same on every platform.
 *
 * Built-ins here are names Node.js and Bun both answer true for in `isBuiltin`: Bun also answers true for `ws`,
 * `undici` and `bun`, which Node does not, and Studio's server runs under Node, so no case relies on those.
 */
import { describe, expect, test } from "bun:test";
import { closureOutside } from "@/lib/provider-host/provider-closure";

/** A listing of these paths; only the paths are read. */
function listing(...paths: string[]) {
  return paths.map((file) => ({ path: file, mode: "644" as const, sha256: "0".repeat(64) }));
}

const FILES = listing(
  "package.json",
  "dist/index.mjs",
  "dist/lib/util.mjs",
  "dist/node_modules/near/index.js",
  "node_modules/dep/package.json",
  "node_modules/dep/lib/index.js",
  "node_modules/@scope/pkg/index.js",
  "node_modules/dep/node_modules/inner/index.js",
  "node_modules/node_modules/hidden/index.js",
);

/** Whether the one import `specifier` of `from` is outside the package. */
function outside(from: string, specifier: string): boolean {
  return closureOutside(FILES, [{ from, specifier }]);
}

describe("the import closure", () => {
  test("a built-in, a relative file inside the artifact and a package its own node_modules holds are inside", () => {
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
      ["dist/index.mjs", "dep"],
      ["dist/index.mjs", "dep/lib/index.js"],
      ["dist/index.mjs", "near"],
      ["node_modules/dep/lib/index.js", "inner"],
      ["node_modules/dep/lib/index.js", "dep"],
    ];
    for (const [from, specifier] of inside)
      expect([from, specifier, outside(from, specifier)]).toEqual([from, specifier, false]);
    expect(closureOutside(FILES, [])).toBe(false);
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
    for (const [from, specifier] of cases)
      expect([from, specifier, outside(from, specifier)]).toEqual([from, specifier, true]);
    // One import outside among others inside refuses the record.
    expect(
      closureOutside(FILES, [
        { from: "dist/index.mjs", specifier: "./lib/util.mjs" },
        { from: "dist/index.mjs", specifier: "../../x.mjs" },
      ]),
    ).toBe(true);
  });

  test("a package found only above the artifact, or only in a node_modules directory directly under another, is outside", () => {
    // `inner` is held only under node_modules/dep, which dist/index.mjs never walks through.
    expect(outside("dist/index.mjs", "inner")).toBe(true);
    // `near` is held only under dist, above which node_modules/dep/lib/index.js sits.
    expect(outside("node_modules/dep/lib/index.js", "near")).toBe(true);
    // `hidden` sits in node_modules/node_modules, a directory the CommonJS lookup skips.
    expect(outside("node_modules/dep/lib/index.js", "hidden")).toBe(true);
    expect(outside("dist/index.mjs", "hidden")).toBe(true);
    // A package no node_modules directory of the artifact holds.
    expect(outside("dist/index.mjs", "absent")).toBe(true);
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

  test("a package subpath with a . or .. segment is outside, and a scoped package is found by its two segments", () => {
    expect(outside("dist/index.mjs", "@scope/pkg")).toBe(false);
    expect(outside("dist/index.mjs", "@scope/pkg/index.js")).toBe(false);
    expect(outside("dist/index.mjs", "@scope/other")).toBe(true);
    expect(outside("dist/index.mjs", "@scope")).toBe(true);
    expect(outside("dist/index.mjs", "dep/../../../x")).toBe(true);
    expect(outside("dist/index.mjs", "dep/./lib/index.js")).toBe(true);
    expect(outside("dist/index.mjs", ".dep")).toBe(true);
  });

  test("the answer reads only the record and the listing, so it is the same on every platform", () => {
    for (const specifier of ["C:\\x.mjs", "C:/x.mjs", "\\\\server\\share\\x.mjs", "\\x.mjs"]) {
      expect([specifier, outside("dist/index.mjs", specifier)]).toEqual([specifier, true]);
    }
    expect(closureOutside(listing("a.mjs"), [{ from: "a.mjs", specifier: "./a.mjs" }])).toBe(false);
  });
});
