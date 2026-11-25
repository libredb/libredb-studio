/**
 * The providers directory: where an operator puts the provider packages Studio may take in, each as
 * `<name>/<version>/` (a scoped name as `@scope/<name>/<version>/`), beside their lock, `providers.lock.json`
 * (docs/providers/CONTRACT.md, clause C-91). `LIBREDB_PROVIDERS_DIR` names it.
 *
 * This module is the only code that reads `LIBREDB_PROVIDERS_DIR`; `tests/unit/lib/db/provider-environment-scan.test.ts`
 * holds it, and holds that no provider module reaches this one.
 *
 * The directory is taken once per process (`providersDirectory`): at boot on a standalone server, right after Studio's
 * storage location (`src/instrumentation.ts`), and at the first reservation check where no boot runs (the published
 * package, the VS Code backend). The value is trimmed; unset, empty or blank is no providers directory; a relative
 * value is resolved against the working directory at that moment, so an operator sets an absolute one (a standalone
 * Next.js server changes into its own directory before it boots). The outcome lives on `globalThis` under a registered
 * symbol, not in a module-level variable, because Next.js bundles the instrumentation apart from the route handlers, so
 * one server process holds this module twice (`src/lib/data-dir.ts` keeps the storage location the same way).
 *
 * The directory, everything in it and its lock are reserved: no connection's database file or host path may name them
 * (`providersDirectoryCheck`, read by `src/lib/db/provider-files.ts`), as Studio's own storage files are reserved.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalPath, foldPathKey } from "@/lib/data-dir";
import { logger } from "@/lib/logger";

/** The lock's file name in the providers directory. */
export const LOCK_FILE_NAME = "providers.lock.json";

const DIRECTORY_KEY = Symbol.for("libredb-studio.providers-directory");

type DirectoryHolder = { [DIRECTORY_KEY]?: { readonly directory: string | null } };

/**
 * The providers directory for the life of the process, an absolute path, or null when none is set. The first call reads
 * `LIBREDB_PROVIDERS_DIR`, keeps the outcome and logs it once at info; every later call returns the kept outcome.
 */
export function providersDirectory(): string | null {
  const holder = globalThis as DirectoryHolder;
  const kept = holder[DIRECTORY_KEY];
  if (kept !== undefined) return kept.directory;
  const value = process.env.LIBREDB_PROVIDERS_DIR?.trim();
  const directory = value === undefined || value === "" ? null : path.resolve(value);
  holder[DIRECTORY_KEY] = Object.freeze({ directory });
  if (directory === null) {
    logger.info("No providers directory is set for this process, so no provider package is read", {
      route: "providers-directory",
    });
  } else {
    logger.info("Studio's providers directory is taken for this process", {
      route: "providers-directory",
      providersDirectory: directory,
    });
  }
  return directory;
}

/** Test seam: forgets this process's providers directory, so the next read takes it as a new process would. */
export function forgetProvidersDirectory(): void {
  delete (globalThis as DirectoryHolder)[DIRECTORY_KEY];
}

/** The codes that mean "nothing at this path": Bun raises ENOTDIR for a path below a file where Node answers none. */
const NO_ENTRY: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * The device and inode of the file at `file`, following links, as bigint stats, since a Number loses an NTFS or ReFS
 * file id above 2^53; undefined when nothing is there. Any other error is thrown.
 */
function identityOf(file: string): fs.BigIntStats | undefined {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (error) {
    if (NO_ENTRY.has((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

/** Whether two identities are one file. */
function sameFile(a: fs.BigIntStats | undefined, b: fs.BigIntStats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/**
 * The check of a connection's path against the providers directory: with none set, nothing is reserved. Otherwise
 * `candidate`, resolved against the working directory and canonicalized (`canonicalize`, `canonicalPath` by default),
 * is reserved when:
 *
 * - its folded key (`foldPathKey`: letter case and Unicode normalization folded) is the lock's, as configured or as its
 *   real path, or is the directory's or lies inside it, as configured or as its real path; or
 * - it exists and is the lock's file (device and inode), so a hard link to the lock elsewhere is reserved too; or
 * - it, or one of its existing ancestors, is the providers directory's file (device and inode).
 *
 * The identity of an ancestor reserves a spelling the folded key cannot see: Node's JavaScript real-path read keeps the
 * given spelling of a component that is not a link, so on Windows a short 8.3 name of the directory, and anywhere a bind
 * mount, names it under another key. `canonicalize` is a parameter so a test can stand for that read.
 *
 * The providers directory and its lock are read here, and an error reading their identity other than "nothing there"
 * is the server's and is thrown here. The check this returns reads only the candidate, so what it throws is about the
 * candidate's path. A hard link made elsewhere to a file inside an artifact is not recognised.
 */
export function providersDirectoryCheck(
  canonicalize: (file: string) => string = canonicalPath,
): (candidate: string) => boolean {
  const directory = providersDirectory();
  if (directory === null) return () => false;
  const lock = path.join(directory, LOCK_FILE_NAME);
  const lockKeys = new Set([lock, canonicalize(lock)].map((key) => foldPathKey(key)));
  const directoryKeys = [...new Set([directory, canonicalize(directory)].map((key) => foldPathKey(key)))];
  const directoryIdentity = identityOf(directory);
  const lockIdentity = identityOf(lock);
  return (candidate) => {
    const resolved = canonicalize(path.resolve(candidate));
    const key = foldPathKey(resolved);
    if (lockKeys.has(key)) return true;
    if (
      directoryKeys.some(
        (root) => key === root || key.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`),
      )
    ) {
      return true;
    }
    if (sameFile(identityOf(resolved), lockIdentity)) return true;
    if (directoryIdentity === undefined) return false;
    for (let up = resolved; ; up = path.dirname(up)) {
      if (sameFile(identityOf(up), directoryIdentity)) return true;
      if (path.dirname(up) === up) return false;
    }
  };
}
