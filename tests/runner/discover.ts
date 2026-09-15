/**
 * Which files the test runner runs, and which of them are measured for coverage.
 *
 * One rule, in one place: every `*.test.ts` / `*.test.tsx` file under `tests/`,
 * except `tests/live/`, whose files drive real database engines and are started by
 * hand (`bun tests/live/<file>.ts`). The rule is deliberately a rule and not a
 * hand-written list: `tests/components/WireCompatibilityHint.test.tsx` shipped with
 * #426 and never ran once, because the runner of the day named its files one by one.
 *
 * A symbolic link or junction under `tests/` is refused by name rather than followed:
 * following one can run files from outside the repository, loop on a link to a parent
 * and list one file twice under two names, while skipping it drops its tests silently.
 *
 * `scripts/security-check.mjs` asks this module (through `bun tests/run-tests.ts
 * --list`) whether a test named by `docs/SECURITY.md` is actually executed, so the
 * discovery rule is also the repository's definition of "this test runs".
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const TESTS_DIRECTORY = "tests";
const TEST_FILE = /\.test\.tsx?$/;

/** Directories under `tests/` that the runner never collects, with the reason. */
const EXCLUDED = new Map([["live", "drives real engines, started by hand"]]);

/**
 * Files that run WITHOUT coverage collection.
 *
 * Both import a whole module chain without exercising it: the CJS shim pulls in
 * every component, and the loader wiring file imports the editor to observe a call
 * it makes at module scope. bun's lcov is per-function, so a process that only
 * LOADS a module emits a coarse zero-hit block for it, and `scripts/merge-lcov.mjs`
 * picks the record with the most executed lines as the authority for which lines
 * are coverable. When one of these two processes is the only one that ever loaded a
 * file, its coarse block becomes that authority and its zero lines are reported as
 * uncovered: measured 2026-09-15, `src/lib/llm/factory.ts` gains 31 phantom
 * uncovered lines from the shim alone. Today the core layer happens to supply a
 * better record for each of them, so the merged gate still reaches 100%; this list
 * is what makes that a property rather than a coincidence.
 *
 * `sonar-project.properties` states the same exemption for `src/exports/index.js`
 * from the other side.
 */
export const COVERAGE_EXEMPT_FILES: readonly string[] = [
  "tests/isolated/exports-shim.test.ts",
  "tests/isolated/monaco-loader-wiring.test.ts",
];

/**
 * Every entry is classified with lstat rather than by its Dirent type. A Dirent for
 * a link is neither a directory nor a file (measured on bun 1.4.2), which is how a
 * linked test used to be skipped without a word, and what bun's Dirent reports for a
 * Windows junction could not be measured; lstat reports a junction as a symbolic
 * link, as it does on POSIX. The extra lstat per entry is cheap: measured on Linux
 * over the 543 files the tree held then, `discoverTestFiles` went from 0.43 ms to
 * 1.1 ms a call.
 */
function collect(root: string, directory: string): string[] {
  return readdirSync(path.join(root, directory)).flatMap((name) => {
    const child = `${directory}/${name}`;
    const stats = lstatSync(path.join(root, child));
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${child} is a symbolic link or junction: the test runner does not follow links, so a test behind one would never run. Replace it with the real file or directory.`,
      );
    }
    if (stats.isDirectory()) {
      return directory === TESTS_DIRECTORY && EXCLUDED.has(name) ? [] : collect(root, child);
    }
    return stats.isFile() && TEST_FILE.test(name) ? [child] : [];
  });
}

/** Every test file the runner runs, as repository-relative POSIX paths, sorted. */
export function discoverTestFiles(root: string): string[] {
  return collect(root, TESTS_DIRECTORY).sort();
}

/**
 * A selector as the user typed it, reduced to a repository-relative POSIX path.
 *
 * A relative selector is resolved against the working directory, not against the
 * repository root, because that is what the person typing it meant: from
 * `tests/unit`, `bun ../run-tests.ts lib/lazy.test.ts` names the file beside them.
 * Resolving against the root instead answered "is not under tests/", which is a true
 * sentence about a path they never wrote.
 */
function normalizeSelector(root: string, selector: string): string {
  // Both sides in real-path space, because one directory can have two spellings and
  // path.relative compares spellings. Measured on windows-latest: os.tmpdir() is the
  // 8.3 short form (C:\Users\RUNNER~1\...) and import.meta.dir the long one, so a
  // runner started from a temp directory called a correct selector "not under
  // tests/". A junction or a symlinked checkout does the same anywhere. The two
  // realpaths that carry it are the root's and the resolved selector's: the resolved
  // path is realpathed when it exists, which covers a link inside a relative selector
  // (`u/x.test.ts` with u -> tests/unit) and, on Windows, a wrong-case or 8.3 segment.
  // The working directory itself is not realpathed again: measured on bun 1.4.2, after
  // chdir into a link `process.cwd()` already answers the real path, so the call could
  // only ever have changed which message a selector that does not EXIST is refused
  // with, and an unfalsifiable line is worse than the message it might improve.
  // The realpath is of the resolved path, never of the raw selector: bun's existsSync
  // follows a link before a "..", its realpath collapses the ".." as text first, so
  // for `u/../unit/x.test.ts` the two disagree and realpath threw a raw ENOENT
  // (measured on 1.4.2). A selector that does not exist keeps its spelling, and
  // matches no file either way.
  const resolved = path.resolve(process.cwd(), selector);
  const absolute = existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  return path.relative(realpathSync.native(root), absolute).split(path.sep).join("/").replace(/\/+$/, "");
}

/**
 * The files named by the command line, or all of them when nothing is named.
 *
 * A selector that matches nothing raises: an empty run that exits 0 is the one
 * outcome a test runner must never produce.
 */
export function selectTestFiles(root: string, selectors: string[]): string[] {
  const all = discoverTestFiles(root);
  if (selectors.length === 0) return all;

  const selected = new Set<string>();
  for (const selector of selectors) {
    const target = normalizeSelector(root, selector);
    if (target !== TESTS_DIRECTORY && !target.startsWith(`${TESTS_DIRECTORY}/`)) {
      throw new Error(`"${selector}" is not under tests/: name a test file or a directory under tests/.`);
    }

    const matches = all.filter((file) => file === target || file.startsWith(`${target}/`));
    if (matches.length === 0) {
      throw new Error(
        `"${selector}" matched no test files. Run "bun tests/run-tests.ts --list" to see what the runner runs.`,
      );
    }
    for (const file of matches) selected.add(file);
  }

  return [...selected].sort();
}
