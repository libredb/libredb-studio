/**
 * Server-side data directory resolution. The data dir is wherever the SQLite
 * storage DB lives (writable in Docker as /app/data); the sample .libredb file
 * and generated auth credentials live alongside it. Launchers (npx/brew/deb)
 * point STORAGE_SQLITE_PATH at a platform-appropriate location.
 *
 * This module is the only code that reads STORAGE_SQLITE_PATH (FND-2 slice 3, the provider plugins design section 0.1;
 * `tests/unit/lib/db/provider-environment-scan.test.ts` holds it, and holds that no provider module reaches this one).
 *
 * Studio's storage location, the storage file the variable names resolved against the working directory and the
 * directory that holds it, is taken once per process (`storageLocation`): at boot on a standalone server, after the
 * shutdown handler and before the auth bootstrap (`src/instrumentation.ts`), and at the first call of the provider
 * factory, whatever engine it builds, where no boot runs (the published package, the VS Code backend). The reserved set
 * below is derived from it, so a later change of the working directory or of the variable moves neither the files
 * Studio protects nor what a connection is compared with. The location lives on `globalThis` under a registered
 * symbol, not in a module-level variable, because Next.js bundles the instrumentation apart from the route handlers,
 * so one server process holds this module twice (`src/lib/db/egress-decision.ts` does the same for the same reason).
 * Real paths and file identities are not part of it: they are read at each check, so a symbolic link made at a sidecar
 * or backup name still reserves the file it points to.
 *
 * Studio's own writers, the SQLite storage provider and the bootstrap credentials writer, still resolve the variable
 * when they run (`getStorageSqlitePath`, `getDataDir`), which names the same file unless the working directory changes
 * after boot; reading the location there too is BACKLOG D491.
 */
import * as path from "path";
import * as fs from "fs";
import { logger } from "@/lib/logger";

/** Studio's storage location as this process keeps it: absolute paths, taken once (`storageLocation`). */
export interface StorageLocation {
  /** The storage database, `STORAGE_SQLITE_PATH` (or the default) resolved against the working directory then. */
  readonly storageFile: string;
  /** The directory that holds it, where the bootstrap credentials file and OPC UA's default PKI root live. */
  readonly dataDirectory: string;
}

const LOCATION_KEY = Symbol.for("libredb-studio.storage-location");

type LocationHolder = { [LOCATION_KEY]?: StorageLocation };

/**
 * Studio's storage location for the life of the process. The first call reads `STORAGE_SQLITE_PATH`, resolves it
 * against the working directory at that moment, keeps the outcome and logs it once at info; every later call returns
 * the kept location.
 */
export function storageLocation(): StorageLocation {
  const holder = globalThis as LocationHolder;
  const kept = holder[LOCATION_KEY];
  if (kept !== undefined) return kept;
  const storageFile = path.resolve(getStorageSqlitePath());
  const location: StorageLocation = Object.freeze({ storageFile, dataDirectory: path.dirname(storageFile) });
  holder[LOCATION_KEY] = location;
  logger.info("Studio's storage location is taken for this process", {
    route: "storage-location",
    storageFile: location.storageFile,
    dataDirectory: location.dataDirectory,
  });
  return location;
}

/** Test seam: forgets this process's storage location, so the next read takes it as a new process would. */
export function forgetStorageLocation(): void {
  delete (globalThis as LocationHolder)[LOCATION_KEY];
}

export const DEFAULT_STORAGE_SQLITE_PATH = "./data/libredb-storage.db";

export function getDataDir(): string {
  return path.dirname(getStorageSqlitePath());
}

/** The configured storage database path, or the default when the variable is unset or empty. */
export function getStorageSqlitePath(): string {
  return process.env.STORAGE_SQLITE_PATH || DEFAULT_STORAGE_SQLITE_PATH;
}

/**
 * The server's own storage database file and its WAL/SHM sidecars, as real paths.
 *
 * These are Studio's to manage, not a target a connection may open: a database connection
 * that points a file-based provider at one of them would be reaching into the server's own
 * state rather than a user's data. The set is derived from the storage location this process
 * took (`storageLocation`), so a later working directory moves none of it. The `-wal` and
 * `-shm` sidecars are included because SQLite's write-ahead log keeps committed changes there
 * until a checkpoint.
 */
export function reservedStoragePaths(): string[] {
  const base = canonicalPath(storageLocation().storageFile);
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

/** The bootstrap credentials file's name in the data directory: the file the server writes and the one it reserves. */
export const BOOTSTRAP_FILE_NAME = "auth-bootstrap.json";

/**
 * Whether a folded path (`foldPathKey`) names one of the server's own storage files: the storage database, its `-wal`
 * and `-shm` files, and the bootstrap credentials file with its `.bak` and temporary (`<file>.<id>.tmp`) names, as
 * configured and as real paths, each name also resolved on its own, so a symbolic link at a sidecar or backup name
 * reserves the file it points to. The names are those of the storage location this process took (`storageLocation`),
 * and their real paths are read at each call. Two spellings that differ only in letter case, or only in Unicode
 * normalization form (NFC against NFD), are one file here on every OS, because on macOS (both) and Windows (letter
 * case) they name one file, whether or not it exists yet. Throws what the path check throws.
 */
export function reservedStorageKey(): (key: string) => boolean {
  const location = storageLocation();
  const storage = location.storageFile;
  const bootstrap = path.join(location.dataDirectory, BOOTSTRAP_FILE_NAME);
  const bootstraps = [bootstrap, canonicalPath(bootstrap)];
  const named = [
    ...reservedStoragePaths(),
    storage,
    `${storage}-wal`,
    `${storage}-shm`,
    ...bootstraps.flatMap((file) => [file, `${file}.bak`]),
  ];
  const files = new Set([...named, ...named.map(canonicalPath)].map(foldPathKey));
  const temps = bootstraps.map((file) => foldPathKey(`${file}.`));
  const tmp = foldPathKey(".tmp");
  return (key) => files.has(key) || temps.some((prefix) => key.startsWith(prefix) && key.endsWith(tmp));
}

/**
 * Studio state and credentials are reserved for all connection roles and file providers. A path is reserved when its
 * real path names one of the server's own storage files with letter case and Unicode normalization folded
 * (`reservedStorageKey`), or, for a file that exists, when it is the same file (device and inode) as one of them, so a
 * hard link is refused too.
 *
 * Studio's own files are read here, and anything reading them throws is thrown here; the check this returns reads only
 * the candidate, so what it throws is about the candidate's path.
 */
export function reservedStorageCheck(): (candidate: string) => boolean {
  const isReservedKey = reservedStorageKey();
  const bootstrap = canonicalPath(path.join(storageLocation().dataDirectory, BOOTSTRAP_FILE_NAME));
  const identities = [...reservedStoragePaths(), bootstrap, `${bootstrap}.bak`]
    .map(fileIdentity)
    .filter((identity) => identity !== undefined);
  return (candidate) => {
    const resolved = canonicalPath(path.resolve(candidate));
    if (isReservedKey(foldPathKey(resolved))) return true;
    const identity = fileIdentity(resolved);
    if (identity === undefined) return false;
    return identities.some((other) => identity.dev === other.dev && identity.ino === other.ino);
  };
}

/** Whether `candidate` is one of Studio's own storage files (`reservedStorageCheck`). Throws what that check throws. */
export function isReservedStoragePath(candidate: string): boolean {
  return reservedStorageCheck()(candidate);
}
