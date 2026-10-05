/**
 * The Docker build context must type-check on its own.
 *
 * Every Dockerfile runs `next build`, which type-checks every `**\/*.ts` that
 * tsconfig.json includes and the context still holds. `.dockerignore` drops the
 * test trees (`e2e`, `tests`), so a root-level file the context keeps must not
 * import from them: the build then fails with TS2307 in every image variant,
 * while the CI typecheck passes on the full checkout.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const patterns = readFileSync(join(ROOT, ".dockerignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

function ignored(path: string): boolean {
  let result = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const glob = new Bun.Glob(negated ? pattern.slice(1) : pattern);
    if (glob.match(path) || glob.match(path.split("/")[0])) result = !negated;
  }
  return result;
}

const rootSources = readdirSync(ROOT).filter((name) => /\.(ts|tsx|mts)$/.test(name) && !name.endsWith(".d.ts"));

function relativeImports(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)].map((match) => match[1]);
}

describe(".dockerignore keeps the build context self-contained", () => {
  test("the test trees are excluded from the context", () => {
    expect(ignored("e2e/helpers/launch-token.ts")).toBe(true);
    expect(ignored("tests/setup.ts")).toBe(true);
  });

  test("every Playwright config is excluded from the context", () => {
    const configs = rootSources.filter((name) => name.startsWith("playwright"));
    expect(configs.length).toBeGreaterThan(0);
    for (const name of configs) expect({ name, ignored: ignored(name) }).toEqual({ name, ignored: true });
  });

  test("no root-level source the context keeps imports a file the context drops", () => {
    const offenders: string[] = [];
    for (const name of rootSources) {
      if (ignored(name)) continue;
      for (const specifier of relativeImports(readFileSync(join(ROOT, name), "utf8"))) {
        const target = specifier.replace(/^\.\//, "");
        if (ignored(target)) offenders.push(`${name} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
