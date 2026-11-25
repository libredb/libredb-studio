/**
 * The directories of the provider packages that passed their lock in this process, for the uncaught-exception line
 * (src/lib/uncaught-exception.ts; docs/providers/CONTRACT.md, clause C-108), which names the package whose code an
 * uncaught error's stack runs through.
 *
 * Boot admission (./boot) records every package that passed its lock, since any of them may have been imported and a
 * package refused after its import has run its top level, which may have left a timer; a frame cannot point into a
 * directory whose code never ran. Each package is recorded with the prefixes a stack frame names its files by: its
 * directory's real path followed by the path separator, as Bun prints a frame, and its file URL followed by a slash, as
 * Node.js prints a frame of an ES module imported by its file URL, the loader's way.
 *
 * The record lives in a global under a registered symbol, as the uncaught-exception exit keeps its installation, so
 * every bundled copy of this module in one process reads the one record. The module imports nothing, so the
 * uncaught-exception exit, the first boot step, loads nothing more by reading it.
 */

/** A package that passed its lock, by name and version, and the prefixes a stack frame names its files by. */
export interface PackageDirectory {
  readonly name: string;
  readonly version: string;
  readonly prefixes: readonly string[];
}

const DIRECTORIES_KEY = Symbol.for("libredb-studio.provider-package-directories");

type DirectoriesHolder = { [DIRECTORIES_KEY]?: readonly PackageDirectory[] };

/** Records the packages that passed their lock in this process, replacing an earlier record. */
export function recordPackageDirectories(packages: readonly PackageDirectory[]): void {
  (globalThis as DirectoriesHolder)[DIRECTORIES_KEY] = Object.freeze(
    packages.map((pkg) =>
      Object.freeze({ name: pkg.name, version: pkg.version, prefixes: Object.freeze([...pkg.prefixes]) }),
    ),
  );
}

/**
 * Null when no package passed its lock in this process, without calling `readStack`; otherwise `<name> <version>` of
 * each recorded package a frame of the stack `readStack` answers runs through, once each, in the order of its first
 * frame. A frame is a line whose text, trimmed, starts with `at `, so a message that names a directory names no
 * package. The stack is read only where a package was recorded, since reading it can throw for an error whose message
 * is not text.
 */
export function packagesInStack(readStack: () => string): readonly string[] | null {
  const recorded = (globalThis as DirectoriesHolder)[DIRECTORIES_KEY];
  if (recorded === undefined) return null;
  const found: string[] = [];
  for (const line of readStack().split("\n")) {
    if (!line.trim().startsWith("at ")) continue;
    for (const pkg of recorded) {
      const named = `${pkg.name} ${pkg.version}`;
      if (!found.includes(named) && pkg.prefixes.some((prefix) => line.includes(prefix))) found.push(named);
    }
  }
  return found;
}

/** Test seam: forgets the record, as a new process would; a process never calls it. */
export function forgetPackageDirectories(): void {
  delete (globalThis as DirectoriesHolder)[DIRECTORIES_KEY];
}
