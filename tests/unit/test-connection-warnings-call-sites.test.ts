/**
 * `DatabaseProvider.testConnectionWarnings()` has exactly one caller: `POST /api/db/test-connection`.
 *
 * The method exists so a provider can run probes that cost requests of their own, and only a
 * user's Test Connection pays for them. `connect()` also runs on every background cache miss,
 * where nobody reads a caution, which is why those probes are not in `connect()`. A second call
 * site, on a cached provider or a background path, would put that cost back where the split took
 * it out, and every provider's tests would stay green, because each one tests the method, not its
 * callers. So the rule is pinned on the shape of the source.
 *
 * A source scan reads text: a call reached through a helper that takes the method by another
 * name passes. It catches the careless second call site, which is the case it exists for.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const METHOD = "testConnectionWarnings";
const THE_CALLER = "src/app/api/db/test-connection/route.ts";

/** A member declaration or definition of the method, which is not a use of it. */
const DEFINITION = new RegExp(
  `^\\s*(?:(?:public|protected|private|override|readonly|async)\\s+)*${METHOD}\\s*\\??\\s*\\(`,
);
/** A comment line: a docblock line, a line comment, or the opening of a block comment. */
const COMMENT = /^\s*(?:\*|\/\/|\/\*)/;

/** The lines of `source` that use the method: every mention that is not a definition or a comment. */
const usesOf = (source: string): string[] =>
  source.split("\n").filter((line) => line.includes(METHOD) && !DEFINITION.test(line) && !COMMENT.test(line));

describe("the scan tells a use from a definition", () => {
  test.each([
    ["an optional call", "const found = await provider.testConnectionWarnings?.();"],
    ["a plain call", "return await this.testConnectionWarnings();"],
    ["a presence check", "if (!provider.testConnectionWarnings) return [];"],
    ["an element access", 'const probe = provider["testConnectionWarnings"];'],
    ["a destructure", "const { testConnectionWarnings } = provider;"],
  ])("counts %s", (_, line) => {
    expect(usesOf(line)).toEqual([line]);
  });

  test.each([
    ["the interface member", "  testConnectionWarnings?(): Promise<QueryWarning[]>;"],
    ["a class method", "  public async testConnectionWarnings(): Promise<QueryWarning[]> {"],
    ["a docblock line", "   * the route calls `testConnectionWarnings()` once,"],
    ["a line comment", "  // testConnectionWarnings() runs on a user's click only"],
  ])("skips %s", (_, line) => {
    expect(usesOf(line)).toEqual([]);
  });
});

describe(`${METHOD}() is called from ${THE_CALLER} alone`, () => {
  const files = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync(ROOT)].map((hit) => hit.replaceAll("\\", "/"));

  test("the scan found source files (an empty scan would pass for the wrong reason)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(THE_CALLER);
  });

  test("the interface declares the method, so the scan looks for a name that exists", () => {
    const declarations = readFileSync(path.join(ROOT, "src/lib/db/types.ts"), "utf8");
    expect(declarations).toMatch(/^\s*testConnectionWarnings\?\(\): Promise<QueryWarning\[\]>;$/m);
  });

  test("every file that uses it is the Test Connection route", () => {
    const users = files.filter((file) => usesOf(readFileSync(path.join(ROOT, file), "utf8")).length > 0);
    expect(users).toEqual([THE_CALLER]);
  });
});
