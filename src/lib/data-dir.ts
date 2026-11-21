/**
 * Server-side data directory resolution. The data dir is wherever the SQLite
 * storage DB lives (writable in Docker as /app/data); the sample .libredb file
 * and generated auth credentials live alongside it. Launchers (npx/brew/deb)
 * point STORAGE_SQLITE_PATH at a platform-appropriate location.
 */
import * as path from "path";
import * as fs from "fs";

export const DEFAULT_STORAGE_SQLITE_PATH = "./data/libredb-storage.db";

export function getDataDir(): string {
  return path.dirname(getStorageSqlitePath());
}

/** The configured storage database path, or the default when the variable is unset or empty. */
export function getStorageSqlitePath(): string {
  return process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH;
}

/**
 * The server's own storage database file and its WAL/SHM sidecars, as absolute paths.
 *
 * These are Studio's to manage, not a target a connection may open: a database connection
 * that points a file-based provider at one of them would be reaching into the server's own
 * state rather than a user's data. The set is derived from the configured path and resolved
 * the same way the SQLite provider resolves a connection's path, so the two agree on what a
 * given spelling means. The `-wal` and `-shm` sidecars are included because SQLite's
 * write-ahead log keeps committed changes there until a checkpoint.
 */
export function reservedStoragePaths(): string[] {
  const base = canonicalPath(path.resolve(getStorageSqlitePath()));
  return [base, `${base}-wal`, `${base}-shm`];
}

/**
 * The real path of `candidate`, an absolute path: its existing ancestors are resolved too, so aliases of a directory
 * name one path for files not yet created. Any error but ENOENT is thrown.
 */
export function canonicalPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return canonicalPath(path.resolve(parent, fs.readlinkSync(candidate)));
    }
    return path.join(canonicalPath(parent), path.basename(candidate));
  }
}

function fileIdentity(candidate: string): fs.Stats | undefined {
  try {
    return fs.statSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/**
 * A path with Unicode normalization and letter case folded, the key every comparison with the server's own storage
 * files uses: first NFC, so a precomposed ü and a u with a combining diaeresis are one letter, as on APFS, which ignores
 * normalization; then letter case, one code point at a time: lower case, then upper case where that is one code point,
 * so σ and ς, which share Σ, are one letter, while ß, whose upper case is SS, stays itself.
 */
export function foldPathKey(file: string): string {
  return Array.from(file.normalize("NFC").toLowerCase(), (char) => {
    const upper = char.toUpperCase();
    return [...upper].length === 1 ? upper : char;
  }).join("");
}

const BOOTSTRAP_FILE = "auth-bootstrap.json";

/**
 * Whether a folded path (`foldPathKey`) names one of the server's own storage files: the storage database, its `-wal`
 * and `-shm` files, and the bootstrap credentials file with its `.bak` and temporary (`<file>.<id>.tmp`) names, as
 * configured and as real paths. Two spellings that differ only in letter case, or only in Unicode normalization form
 * (NFC against NFD), are one file here on every OS, because on macOS (both) and Windows (letter case) they name one
 * file, whether or not it exists yet. Throws what the path check throws.
 */
export function reservedStorageKey(): (key: string) => boolean {
  const storage = path.resolve(getStorageSqlitePath());
  const bootstrap = path.resolve(getDataDir(), BOOTSTRAP_FILE);
  const bootstraps = [bootstrap, canonicalPath(bootstrap)];
  const files = new Set(
    [
      ...reservedStoragePaths(),
      storage,
      `${storage}-wal`,
      `${storage}-shm`,
      ...bootstraps.flatMap((file) => [file, `${file}.bak`]),
    ].map(foldPathKey),
  );
  const temps = bootstraps.map((file) => foldPathKey(`${file}.`));
  const tmp = foldPathKey(".tmp");
  return (key) => files.has(key) || temps.some((prefix) => key.startsWith(prefix) && key.endsWith(tmp));
}

/**
 * Studio state and credentials are reserved for all connection roles and file providers. A path is reserved when its
 * real path names one of the server's own storage files with letter case and Unicode normalization folded
 * (`reservedStorageKey`), or, for a file that exists, when it is the same file (device and inode) as one of them, so a
 * hard link is refused too.
 */
export function isReservedStoragePath(candidate: string): boolean {
  const resolved = canonicalPath(path.resolve(candidate));
  if (reservedStorageKey()(foldPathKey(resolved))) return true;
  const identity = fileIdentity(resolved);
  if (identity === undefined) return false;
  const bootstrap = canonicalPath(path.resolve(getDataDir(), BOOTSTRAP_FILE));
  return [...reservedStoragePaths(), bootstrap, `${bootstrap}.bak`].some((file) => {
    const other = fileIdentity(file);
    return other !== undefined && identity.dev === other.dev && identity.ino === other.ino;
  });
}
