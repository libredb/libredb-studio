/**
 * `logger.error` takes the error SECOND and the context THIRD.
 *
 * Passing the context where the error belongs compiles, runs, and produces a log line
 * that names neither: `error?: unknown` accepts anything by design — you can throw a
 * string — so the compiler cannot object, and the formatter renders the object as
 * `Unknown: [object Object]` while the `context` slot stays empty, so the route and
 * the ids that were carefully assembled never appear either.
 *
 * That is not hypothetical. Four call sites had it, and the loudest of them fired on
 * every managed-connections request:
 *
 *     [ERROR] Seed connection skipped due to credential resolution failure | Unknown: [object Object]
 *
 * The connection id and the reason were both in the object being swallowed. An
 * operator meeting that line learns only that something, somewhere, was skipped.
 *
 * A grep is a blunt instrument, and it is the right one here: the mistake is a shape
 * the type system deliberately permits, so nothing but a reader — or this — will catch
 * the fifth occurrence.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

/** `logger.error("...", {` — an object literal in the argument reserved for the error. */
const CONTEXT_AS_ERROR = /logger\.error\(\s*(["'`])(?:(?!\1).)*\1\s*,\s*\{/;

describe("logger.error is called with the error second and the context third", () => {
  const files = [...new Bun.Glob("src/**/*.{ts,tsx}").scanSync(ROOT)];

  test("the scan found source files (an empty scan would pass for the wrong reason)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("no call site passes a context object where the error belongs", async () => {
    const offenders: string[] = [];
    for (const relative of files) {
      const source = await Bun.file(path.join(ROOT, relative)).text();
      if (!source.includes("logger.error(")) continue;
      const lines = source.split("\n");
      for (const [index, line] of lines.entries()) {
        // Anchored on the line the call STARTS on, so a wrapped call is reported once
        // and at the line a reader would go to. The next line joins it because the
        // context object commonly begins there.
        if (!line.includes("logger.error(")) continue;
        const window = `${line} ${(lines[index + 1] ?? "").trim()}`;
        if (CONTEXT_AS_ERROR.test(window)) offenders.push(`${relative}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
