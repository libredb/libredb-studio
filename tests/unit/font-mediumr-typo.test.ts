import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * #1124: `font-mediumr` is not a Tailwind utility, so Tailwind emits no CSS for
 * it and every element carrying it renders at the inherited weight (400) instead
 * of the medium weight (500) the class name intends. The typo first landed in
 * `26cb0732` and survived because nothing failed on it; `7c25808c` (#335) fixed
 * one site by hand when a new sibling label needed the same weight.
 *
 * This test is the failure that was missing: it reads every `.tsx` under `src/`
 * and fails naming each file and line that carries the token, so the typo cannot
 * come back. It scans comments too: a comment that names the typo explains
 * nothing once no use is left.
 */

const ROOT = join(import.meta.dir, "..", "..");

/** Every component source, sorted: `readdirSync` returns filesystem order. */
function srcFiles(): { path: string; lines: string[] }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : /\.tsx$/.test(entry) ? [path] : [];
      });
  return walk(join(ROOT, "src")).map((path) => ({
    path: path.slice(ROOT.length + 1),
    lines: readFileSync(path, "utf8").split("\n"),
  }));
}

describe("no font-mediumr typo in src (issue #1124)", () => {
  test("every .tsx under src/ is free of the font-mediumr token", () => {
    const offenders = srcFiles().flatMap(({ path, lines }) =>
      lines.map((line, i) => ({ path, line: i + 1, text: line })).filter(({ text }) => text.includes("font-mediumr")),
    );

    expect(offenders.map(({ path, line }) => `${path}:${line}`)).toEqual([]);
  });
});
