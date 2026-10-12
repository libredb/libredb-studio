/**
 * `DatabaseProvider.testConnectionWarnings()` has exactly one caller: `POST /api/db/test-connection`.
 *
 * The method exists so a provider can run probes that cost requests of their own, and only a
 * user who asked pays for them, through Test Connection or the connection dialog's Save.
 * `connect()` also runs on every background cache miss, where nobody reads a caution, which is
 * why those probes are not in `connect()`. A second call site, on a cached provider or a
 * background path, would put that cost back where the split took it out, and every provider's
 * tests would stay green, because each one tests the method, not its callers. So the rule is
 * pinned on the shape of the source.
 *
 * A source scan reads text: a call reached through a helper that takes the method by another
 * name passes, and a quote inside a regular expression literal can hide what follows it. It
 * catches the careless second call site, which is the case it exists for.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const METHOD = "testConnectionWarnings";
const THE_CALLER = "src/app/api/db/test-connection/route.ts";

/**
 * A member declaration or definition of the method at the start of a line, which is not a use of
 * it: the parameter list is followed by a return annotation or a body, so a bare call is not one.
 */
const DEFINITION = new RegExp(
  `^\\s*(?:(?:public|protected|private|static|abstract|declare|override|readonly|async)\\s+)*${METHOD}\\s*\\??\\s*\\([^)]*\\)\\s*[:{]`,
);
/**
 * `source` with its comments blanked out and its newlines kept, so its lines still line up with
 * the source's. String literals are stepped over, so a `//` or `/*` inside one hides nothing.
 */
const withoutComments = (source: string): string => {
  let code = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote !== null) {
      code += char;
      if (char === "\\") code += source[++i] ?? "";
      else if (char === quote || (char === "\n" && quote !== "`")) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      code += char;
    } else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      code += (end < 0 ? source.slice(i) : source.slice(i, end + 2)).replace(/[^\n]/g, "");
      if (end < 0) break;
      i = end + 1;
    } else {
      code += char;
    }
  }
  return code;
};

/**
 * The lines of `source` that use the method. Mentions are counted after comments are removed, and
 * a definition at the start of the line takes away one of them, so a use that shares a line with
 * a definition or follows a block comment still counts.
 */
const usesOf = (source: string): string[] => {
  const code = withoutComments(source).split("\n");
  return source.split("\n").filter((_, n) => {
    const mentions = code[n].split(METHOD).length - 1;
    return mentions - (DEFINITION.test(code[n]) ? 1 : 0) > 0;
  });
};

describe("the scan tells a use from a definition", () => {
  test.each([
    ["an optional call", "const found = await provider.testConnectionWarnings?.();"],
    ["a plain call", "return await this.testConnectionWarnings();"],
    ["a presence check", "if (!provider.testConnectionWarnings) return [];"],
    ["an element access", 'const probe = provider["testConnectionWarnings"];'],
    ["a destructure", "const { testConnectionWarnings } = provider;"],
    ["a call after a leading block comment", "  /* refresh */ await provider.testConnectionWarnings?.();"],
    ["a bare call of a same-named function", "  testConnectionWarnings(provider);"],
    ["a call after a string that holds //", '  await run("http://host", provider.testConnectionWarnings());'],
    ["a call after a string that holds /*", "  const found = [glob('src/*'), provider.testConnectionWarnings()];"],
    [
      "a call inside a one-line delegating method",
      "  async testConnectionWarnings() { return this.inner.testConnectionWarnings(); }",
    ],
  ])("counts %s", (_, line) => {
    expect(usesOf(line)).toEqual([line]);
  });

  test.each([
    ["the interface member", "  testConnectionWarnings?(): Promise<QueryWarning[]>;"],
    ["a class method", "  public async testConnectionWarnings(): Promise<QueryWarning[]> {"],
    ["a docblock", ["  /**", "   * the route calls `testConnectionWarnings()` once,", "   */"].join("\n")],
    ["a line comment", "  // testConnectionWarnings() runs on a user's click only"],
    ["a docblock opening", "  /** testConnectionWarnings() runs on a user's click only */"],
    ["a trailing comment after code", "  const cautions = []; // filled by testConnectionWarnings()"],
    ["an object-literal method", "  async testConnectionWarnings() {"],
    ["an abstract member", "  public abstract testConnectionWarnings(): Promise<QueryWarning[]>;"],
    ["a static method", "  static async testConnectionWarnings(): Promise<QueryWarning[]> {"],
    ["a comment after a string that holds a quote", `  const q = "'"; // testConnectionWarnings()`],
  ])("skips %s", (_, line) => {
    expect(usesOf(line)).toEqual([]);
  });

  test("skips a line inside a block comment whose lines do not start with a star", () => {
    expect(usesOf(["/*", "  testConnectionWarnings() runs on a user's click only", "*/"].join("\n"))).toEqual([]);
  });

  test("counts a call after a block comment that closes on its line", () => {
    const call = "*/ await provider.testConnectionWarnings?.();";
    expect(usesOf(["/*", "  refresh", call].join("\n"))).toEqual([call]);
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
