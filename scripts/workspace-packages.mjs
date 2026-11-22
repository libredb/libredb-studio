/**
 * The workspace package layout, in one place (packages/README.md, "Layout").
 *
 * A workspace package is a directory `packages/<name>/` holding a `package.json`. Its
 * source is under `packages/<name>/src/` and its tests under `packages/<name>/tests/`.
 * Nothing else under `packages/` is code: a file such as `packages/README.md` is not a
 * package, and a directory without a `package.json` is refused by name, because a gate
 * that skipped it would leave its tests unrun and its source unmeasured without a word.
 *
 * The test runner's discovery (`tests/runner/discover.ts`), the focused-test guard
 * (`scripts/only-check.mjs`), the coverage merge (`scripts/merge-lcov.mjs`) and the
 * coverage gate (`scripts/check-coverage.mjs`) read the layout from here, and
 * `tests/unit/docker-workspace-install.test.ts` holds each Dockerfile to the listing.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

/** The directory every workspace package lives under, as root package.json's `workspaces` names it. */
export const PACKAGES_DIRECTORY = "packages";

const PACKAGE_SOURCE = /^packages\/[^/]+\/src\//;
const PACKAGE_TESTS = /^packages\/[^/]+\/tests\//;

/** Whether a repository-relative POSIX path is a workspace package's source: `packages/<name>/src/...`. */
export function isPackageSourcePath(file) {
  return PACKAGE_SOURCE.test(file);
}

/** Whether a repository-relative POSIX path is under a workspace package's tests: `packages/<name>/tests/...`. */
export function isPackageTestPath(file) {
  return PACKAGE_TESTS.test(file);
}

/**
 * Every workspace package under `root`, as sorted repository-relative `packages/<name>` paths.
 *
 * Returns an empty list when `packages/` is absent or holds only files. Throws, naming
 * the entry, on a directory without a `package.json` and on a symbolic link or junction:
 * a link is refused rather than followed for the reason `tests/runner/discover.ts` gives,
 * since following one can reach code outside the repository or list one package twice.
 */
export function workspacePackageDirectories(root) {
  const packagesPath = path.join(root, PACKAGES_DIRECTORY);
  if (!existsSync(packagesPath)) return [];

  const directories = [];
  for (const name of readdirSync(packagesPath)) {
    const directory = `${PACKAGES_DIRECTORY}/${name}`;
    const stats = lstatSync(path.join(root, directory));
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${directory} is a symbolic link or junction: a workspace package is a real directory under ${PACKAGES_DIRECTORY}/, so replace the link with the directory itself.`,
      );
    }
    if (!stats.isDirectory()) continue;
    if (!existsSync(path.join(root, directory, "package.json"))) {
      throw new Error(
        `${directory} has no package.json, so it is not a workspace package and no gate would read it. Add its package.json or move it out of ${PACKAGES_DIRECTORY}/ (packages/README.md, "Layout").`,
      );
    }
    directories.push(directory);
  }
  return directories.sort();
}
