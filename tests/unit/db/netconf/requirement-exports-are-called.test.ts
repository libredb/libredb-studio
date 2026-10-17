/**
 * A symbol that carries a requirement has to be called from somewhere in `src`.
 *
 * This band exists because the repository's unused-export check cannot see the shape it is built
 * against: that check counts TESTS as users, so a module used only by its own tests is reported
 * clean. Measured three times in one evening, by hand, and all three were defects: a Source reader
 * declared by two object kinds and never implemented, a row filter documented as "the one path out
 * of a row" with no caller at all, and the secrets module behind it. Three hand checks, three
 * findings, so the question belongs in a gate rather than in somebody's memory.
 *
 * The set it asks about is deliberately NARROW, and the narrowing is the whole design: asking it of
 * every export would make code that is written and not yet wired fail, which is legitimate work in
 * progress. A requirement is different. A docblock that says "requirement Y-S2" is a claim that the
 * product behaves a certain way, and a claim nothing calls is not a limitation, it is false.
 *
 * So: a symbol whose docblock names a requirement must be reachable from `src`. Code with no
 * requirement in its docblock is not asked about at all.
 */
import { test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectEqual, expectTruthy, strippedSource } from "./helpers";

const DIR = join(import.meta.dir, "../../../../src/lib/db/providers/network/netconf");
const SRC = join(import.meta.dir, "../../../../src");
const REQUIREMENT = /\b(?:Y-S\d+|NC-S\d+)\b/;

interface Bound {
  readonly file: string;
  readonly name: string;
  readonly requirement: string;
}

/** Exported values whose own docblock names a requirement. Types are not asked about: a type is */
/** used by being written down, and the band is about behaviour that has to run. */
function requirementBound(): Bound[] {
  const found: Bound[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(DIR, file), "utf8");
    for (const match of source.matchAll(/\/\*\*([\s\S]*?)\*\/\s*export (?:async )?(?:function|const|class) (\w+)/g)) {
      const doc = match[1] ?? "";
      const name = match[2] ?? "";
      const requirement = REQUIREMENT.exec(doc)?.[0];
      if (requirement !== undefined) found.push({ file, name, requirement });
    }
  }
  return found;
}

/** Every mention of `name` under `src`, minus the line that declares it. */
function callersInSrc(name: string): number {
  let seen = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      // Comments and strings removed first: a name that appears only in a comment is not a caller,
      // and counting one made this band pass on an export with no caller at all, which is the very
      // thing it exists to find. Measured with a probe whose only other mention was a comment.
      for (const line of strippedSource(readFileSync(path, "utf8")).split("\n")) {
        if (!new RegExp(`\\b${name}\\b`).test(line)) continue;
        if (new RegExp(`export (?:async )?(?:function|const|class) ${name}\\b`).test(line)) continue;
        seen += 1;
      }
    }
  };
  walk(SRC);
  return seen;
}

test("every export that carries a requirement is reachable from src", () => {
  const bound = requirementBound();
  // The set has to be non-empty or the band is asserting nothing, which is how a scan like this
  // dies: a pattern stops matching, the list goes empty, and empty passes.
  expectTruthy(bound.length >= 3, `only ${bound.length} requirement-bound exports were found`);
  const unreachable = bound
    .filter((b) => callersInSrc(b.name) === 0)
    .map((b) => `${b.file}: ${b.name} (${b.requirement})`);
  expectEqual(unreachable, []);
});

test("the band finds a caller that exists and misses one that does not", () => {
  // A name this provider really calls, and one no file contains. Without this pair the counter
  // could answer the same number for everything and the band above would still pass.
  expectTruthy(callersInSrc("buildRpc") > 0);
  expectEqual(callersInSrc("aNameNothingInThisRepositoryUses"), 0);
});
