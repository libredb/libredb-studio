/**
 * The coverage directory, which the runner empties before every coverage run.
 *
 * Emptying it is necessary: a stale report from a previous run would be merged into
 * this one, and the merge cannot tell the two apart. But `--coverage-dir` is a path
 * the caller chooses, and `rmSync(dir, { recursive: true })` on a mistyped one is
 * not a mistake anybody recovers from: `--coverage-dir=src` would delete the
 * product. Every other option in this runner validates what it is given; this is
 * that validation.
 *
 * The rule is ownership, not a name: a directory the runner may empty either does
 * not exist yet, is empty, or holds nothing but what a previous coverage run of this
 * runner put there.
 */

/** What a coverage run leaves behind: one directory per test file, plus the merge's own inputs. */
const OWNED = /^(file-\d+|lcov\.info|inputs\.txt)$/;

export function unownedCoverageEntries(entries: string[]): string[] {
  return entries.filter((entry) => !OWNED.test(entry)).sort();
}

/**
 * Raises when the directory holds anything this runner did not write, naming what it
 * found. The caller passes the entries rather than a path so the rule is testable
 * without building a directory that proves the point by being deleted.
 */
export function assertCoverageDirIsOurs(directory: string, entries: string[]): void {
  const unowned = unownedCoverageEntries(entries);
  if (unowned.length === 0) return;

  throw new Error(
    `Refusing to empty ${directory}: it holds ${unowned.length} entr${unowned.length === 1 ? "y" : "ies"} ` +
      `this runner did not write (${unowned.slice(0, 5).join(", ")}). ` +
      "Point --coverage-dir at a directory that is empty or holds only a previous coverage run.",
  );
}

/**
 * Raises unless an existing `--merge-into` target is a coverage report.
 *
 * The runner removes that file before a coverage run, so that a run which ends red
 * cannot leave a stale report for `coverage:check` to pass. Removing is only safe
 * for a file this runner or `scripts/merge-lcov.mjs` wrote: `--merge-into=package.json`
 * would otherwise delete package.json. An lcov report starts with `TN:` (as bun writes
 * it) or `SF:` (as the merge writes it), and an empty file is a merge that found no
 * records, so those three are ours and anything else is somebody's work.
 */
export function assertMergeTargetIsOurs(target: string, content: string): void {
  const firstLine = content.split("\n", 1)[0] ?? "";
  if (content.trim() === "" || /^(TN|SF):/.test(firstLine)) return;

  throw new Error(
    `Refusing to replace ${target}: it is not a coverage report (it starts ${JSON.stringify(firstLine.slice(0, 40))}). ` +
      "Point --merge-into at an lcov file or at a path that does not exist yet.",
  );
}
