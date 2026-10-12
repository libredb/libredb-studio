/**
 * `DatabaseProvider.testConnectionWarnings()` has exactly one caller: `POST /api/db/test-connection`.
 *
 * The method exists so a provider can run probes that cost requests of their own, and only a
 * user who asked pays for them, through Test Connection or the connection dialog's Save. `connect()` also runs on every background cache miss,
 * where nobody reads a caution, which is why those probes are not in `connect()`. A second call
 * site, on a cached provider or a background path, would put that cost back where the split took
 * it out, and every provider's tests would stay green, because each one tests the method, not its
 * callers. So the rule is pinned on the shape of the source.
 *
 * A source scan reads text: a call reached through a helper that takes the method by another
 * name passes, and a quote inside a regular expression literal or a string that spans lines can
 * hide what follows it on that line. It catches the careless second call site, which is the case
 * it exists for.
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
  `^\\s*(?:(?:public|protected|private|override|readonly|async)\\s+)*${METHOD}\\s*\\??\\s*\\([^)]*\\)\\s*[:{]`,
);
/** A docblock continuation line, all of which is comment. */
const DOCBLOCK_LINE = /^\s*\*/;
/**
 * Removes block comments that open on the line (closed there or not) and a trailing line comment,
 * stepping over string literals, so a `//` or `/*` inside a string does not hide the code after it.
 */
const withoutComments = (line: string): string => {
  let code = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote !== null) {
      code += char;
      if (char === "\\") code += line[++i] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      code += char;
    } else if (line.startsWith("//", i)) {
      break;
    } else if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
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
const usesOf = (source: string): string[] =>
  source.split("\n").filter((line) => {
    if (DOCBLOCK_LINE.test(line)) return false;
    const code = withoutComments(line);
    const mentions = code.split(METHOD).length - 1;
    return mentions - (DEFINITION.test(code) ? 1 : 0) > 0;
  });

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
    ["a docblock line", "   * the route calls `testConnectionWarnings()` once,"],
    ["a line comment", "  // testConnectionWarnings() runs on a user's click only"],
    ["a docblock opening", "  /** testConnectionWarnings() runs on a user's click only */"],
    ["a trailing comment after code", "  const cautions = []; // filled by testConnectionWarnings()"],
    ["an object-literal method", "  async testConnectionWarnings() {"],
    ["a comment after a string that holds a quote", `  const q = "'"; // testConnectionWarnings()`],
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
