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
  const base = path.resolve(getStorageSqlitePath());
  return [base, `${base}-wal`, `${base}-shm`];
}

/** Resolve existing ancestors too, so aliases of a directory protect files not yet created. */
function canonicalPath(candidate: string): string {
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

/** Studio state and credentials are reserved for all connection roles and file providers. */
export function isReservedStoragePath(candidate: string): boolean {
  const resolved = canonicalPath(path.resolve(candidate));
  const bootstrap = canonicalPath(path.resolve(getDataDir(), "auth-bootstrap.json"));
  if (
    resolved === bootstrap ||
    resolved === `${bootstrap}.bak` ||
    (resolved.startsWith(`${bootstrap}.`) && resolved.endsWith(".tmp"))
  )
    return true;
  const identity = fileIdentity(resolved);
  const reserved = [...reservedStoragePaths(), bootstrap, `${bootstrap}.bak`];
  return reserved.some((file) => {
    if (resolved === canonicalPath(file)) return true;
    const other = fileIdentity(file);
    return identity !== undefined && other !== undefined && identity.dev === other.dev && identity.ino === other.ino;
  });
}
