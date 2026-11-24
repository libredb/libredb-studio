#!/usr/bin/env node
/**
 * Loads every module of each entry's closure under Node, once, and prints one line per module that fails.
 *
 * Usage: `node scripts/load-lib-closure.mjs <distDir> <entry>...`, where each entry is a file name inside
 * `<distDir>`. An `.mjs` entry's closure is loaded by `import()`, the way an `import` host loads it; a `.js` entry's
 * closure by `require`, the way a `require` host loads it. The closure is `moduleClosure` from
 * scripts/check-lib-closure.mjs, dynamic imports included, so a chunk a host reaches only through a lazy import is
 * loaded too.
 *
 * Each failing module prints `dist/<file> (<esm|cjs>): <error code or name>: <first line of the message>` on stdout,
 * and the run continues to the end; the last line is `checked <n> modules`. Exit code 1 when any module failed.
 *
 * scripts/check-lib-load.mjs runs this in a child `node` from a consumer-shaped install, with a bounded heap and a
 * timeout, so a module's top-level code can neither hang nor pollute the check. It is a script of its own so the
 * same load can be run by hand against any extracted package.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { moduleClosure } from "./check-lib-closure.mjs";

const [distArgument, ...entries] = process.argv.slice(2);
if (distArgument === undefined || entries.length === 0) {
  console.error("Usage: node scripts/load-lib-closure.mjs <distDir> <entry>...");
  process.exit(2);
}

const distDir = path.resolve(distArgument);
const requireFromDist = createRequire(path.join(distDir, "noop.js"));
const seen = new Set();
let failed = 0;

/** The first line of an error's message, with its code, or its name when it has no code. */
function describe(error) {
  const label = error?.code ?? error?.name ?? "Error";
  const message = String(error?.message ?? error).split("\n")[0];
  return `${label}: ${message}`;
}

for (const entry of entries) {
  const format = entry.endsWith(".mjs") ? "esm" : "cjs";
  for (const file of moduleClosure(distDir, entry)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const absolute = path.join(distDir, file);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one module at a time, so each failure belongs to the module that raised it.
      if (format === "esm") await import(pathToFileURL(absolute).href);
      else requireFromDist(absolute);
    } catch (error) {
      failed += 1;
      console.log(`dist/${file} (${format}): ${describe(error)}`);
    }
  }
}

console.log(`checked ${seen.size} modules`);
process.exitCode = failed === 0 ? 0 : 1;
