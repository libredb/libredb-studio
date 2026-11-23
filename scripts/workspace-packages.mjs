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
 * `tests/unit/docker-workspace-install.test.ts` holds each Dockerfile to the listing. The library
 * build (`tsup.config.ts`) bundles every package it names and resolves each package's declarations through
 * {@link workspacePackageSourcePaths}, and the packed library check
 * (`scripts/check-lib-load.mjs`) reads the package manifests from here too.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Every workspace package under `root` with its parsed `package.json`, as `{ directory, manifest }`, in the order
 * of {@link workspacePackageDirectories}. The one reader of package manifests the other listings use.
 */
export function workspacePackageManifests(root) {
  return workspacePackageDirectories(root).map((directory) => ({
    directory,
    manifest: JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")),
  }));
}

/**
 * The manifest `name` of every workspace package under `root`, in the order of {@link workspacePackageDirectories}.
 * Throws, naming the file, on a manifest whose `name` is missing or not a string, because a package without a name
 * cannot be bundled or recognised by name.
 */
export function workspacePackageNames(root) {
  return workspacePackageManifests(root).map(({ directory, manifest }) => {
    if (typeof manifest.name !== "string") {
      throw new Error(
        `${directory}/package.json has no string name, so the library build cannot bundle the package by name. Give it a "name".`,
      );
    }
    return manifest.name;
  });
}

/**
 * TypeScript `paths` for every `exports` entry of every workspace package under `root`: `"<name>"` for `"."` and
 * `"<name>/<sub>"` for `"./<sub>"`, each mapped to its target as `./packages/<dir>/<target>`. The library build's
 * declaration bundler resolves a package through these to its source, outside `node_modules`, so rollup-plugin-dts
 * inlines its declarations instead of leaving an import of the unpublished package (packages/README.md, "Library").
 * Throws, naming the manifest and the entry, on a manifest without an `exports` object and on an entry whose target
 * is not a path string, such as a conditional-exports object, because no single source path stands for it.
 * @param {string} root
 * @returns {Record<string, string[]>}
 */
export function workspacePackageSourcePaths(root) {
  const paths = {};
  const names = workspacePackageNames(root);
  workspacePackageManifests(root).forEach(({ directory, manifest }, index) => {
    if (typeof manifest.exports !== "object" || manifest.exports === null) {
      throw new Error(
        `${directory}/package.json has no exports object, so the library build cannot resolve the package's declarations. Give it an "exports" map (packages/README.md, "Library").`,
      );
    }
    for (const [entry, target] of Object.entries(manifest.exports)) {
      if (typeof target !== "string") {
        throw new Error(
          `${directory}/package.json exports "${entry}" as something other than a path string, so the library build cannot resolve its declarations to one source file. Point the entry at one file under src/.`,
        );
      }
      const specifier = entry === "." ? names[index] : `${names[index]}/${entry.slice(2)}`;
      paths[specifier] = [`./${path.posix.join(directory, target)}`];
    }
  });
  return paths;
}
