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
 * after boot; reading the location there too is backlog D491.
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
 * The number of symbolic links `canonicalPath` follows in one call before it refuses the path with ELOOP: the 40 links
 * Linux follows in one path resolution before it answers ELOOP. macOS stops at 32, so a chain the kernel would refuse
 * is refused here too, never admitted for want of a check.
 */
export const LINKS_FOLLOWED_LIMIT = 40;

/** The errors of a real-path read after which `canonicalPath` canonicalizes the path from its parent. */
const CANONICAL_FROM_PARENT = new Set(["ENOENT", "EACCES", "EPERM"]);

/**
 * The real path of `candidate`, an absolute path: its existing ancestors are resolved too, so aliases of a directory
 * name one path for files not yet created. A path whose last component the process cannot read (EACCES or EPERM, which
 * macOS answers for a file without read permission, where Linux needs only search permission on the directories) is
 * canonicalized from its parent, as a missing one is: a symbolic link there is followed, and anything else is the
 * parent's real path joined with its name. Any other error, any error reading the link, and such an error on the root,
 * which has no parent, is thrown.
 *
 * The walk is one loop, not a recursion, so no runtime's stack limit decides the answer however many missing components
 * a path or a link's target holds, and a path past a missing component is resolved with one lookup per ancestor
 * (`deepestExistingAncestor`), not one real-path read per missing name. It follows at most `LINKS_FOLLOWED_LIMIT`
 * links in one call, counting the links it follows while canonicalizing the path's ancestors, and past that throws an
 * `Error` with code `ELOOP` and the candidate as its `path`: a link's target is resolved without the filesystem (`path.resolve`), so a target that leads
 * back to the link through a missing directory is a loop the filesystem's own limit never sees. ELOOP is the code the
 * filesystem gives a path whose links do not end, so every caller already names it: a connection is refused with
 * `PATH_NOT_CHECKED`, a sample with `target-unreadable (ELOOP)`, and on Studio's own paths it is raised as the
 * server's, as every other filesystem error is.
 */
export function canonicalPath(candidate: string): string {
  const names: string[] = [];
  let current = candidate;
  let followed = 0;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch (error) {
      if (!CANONICAL_FROM_PARENT.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      const entry = fs.lstatSync(current, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) {
        followed += 1;
        if (followed > LINKS_FOLLOWED_LIMIT) throw tooManyLinks(candidate);
        current = path.resolve(parent, fs.readlinkSync(current));
      } else if (entry === undefined) {
        current = deepestExistingAncestor(current, names);
      } else {
        names.push(path.basename(current));
        current = parent;
      }
      continue;
    }
    // Joined into one string first: Bun passes at most 65,536 arguments to a call made with a spread and drops the
    // rest without an error, and 40 links can each add over a thousand names.
    return names.length === 0 ? real : path.join(real, names.reverse().join(path.sep));
  }
}

/**
 * The deepest ancestor of `missing`, a path with no entry, that has one, or the root when none below it has; the names
 * of `missing` and of every ancestor past the one returned are pushed onto `names`, last component first. The ancestors
 * are looked up from the root forward, one lookup each, and the first one without an entry ends the walk: a path that
 * names something inside a missing directory has no entry either, so every ancestor past it is missing too.
 */
function deepestExistingAncestor(missing: string, names: string[]): string {
  const ancestors = [missing];
  for (let up = path.dirname(missing); up !== ancestors[ancestors.length - 1]; up = path.dirname(up)) {
    ancestors.push(up);
  }
  let deepest = ancestors.length - 1;
  while (deepest > 1 && fs.lstatSync(ancestors[deepest - 1], { throwIfNoEntry: false }) !== undefined) deepest -= 1;
  for (let i = 0; i < deepest; i++) names.push(path.basename(ancestors[i]));
  return ancestors[deepest];
}

/** The error `canonicalPath` throws for a path whose resolution follows more than `LINKS_FOLLOWED_LIMIT` links. */
function tooManyLinks(candidate: string): Error {
  return Object.assign(
    new Error(`ELOOP: more than ${LINKS_FOLLOWED_LIMIT} symbolic links followed while resolving '${candidate}'`),
    { code: "ELOOP", path: candidate },
  );
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
 * The start of the label the credential re-seal gives the backup of the store it writes beside the store file, as
 * `<store file>.<label>` (`resealBackupLabel` in `src/lib/storage/reseal.ts`, docs/STORAGE.md).
 */
const STORE_BACKUP_LABEL_PREFIX = "pre-reseal-";

/**
 * The re-seal backups of the store that exist now: every entry of the data directory whose name, letter case and
 * Unicode normalization folded, starts with the store file's name and `.pre-reseal-`. None when the data directory does
 * not exist; any other error reading it is thrown.
 */
function storeBackups(location: StorageLocation): string[] {
  const prefix = foldPathKey(`${path.basename(location.storageFile)}.${STORE_BACKUP_LABEL_PREFIX}`);
  let entries: string[];
  try {
    entries = fs.readdirSync(location.dataDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
  return entries
    .filter((entry) => foldPathKey(entry).startsWith(prefix))
    .map((entry) => path.join(location.dataDirectory, entry));
}

/**
 * Whether a folded path (`foldPathKey`) names one of the server's own storage files: the storage database, its `-wal`
 * and `-shm` files, every name that starts with the store file's name and `.pre-reseal-` (the re-seal's backups of the
 * store and their sidecars, `STORE_BACKUP_LABEL_PREFIX`), and the bootstrap credentials file with its `.bak` and
 * temporary (`<file>.<id>.tmp`) names, as configured and as real paths, each name also resolved on its own, so a
 * symbolic link at a sidecar or backup name reserves the file it points to. The names are those of the storage
 * location this process took (`storageLocation`), and their real paths are read at each call. Two spellings that
 * differ only in letter case, or only in Unicode normalization form (NFC against NFD), are one file here on every OS,
 * because on macOS (both) and Windows (letter case) they name one file, whether or not it exists yet. Throws what the
 * path check throws.
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
    ...storeBackups(location),
  ];
  const files = new Set([...named, ...named.map(canonicalPath)].map(foldPathKey));
  const temps = bootstraps.map((file) => foldPathKey(`${file}.`));
  const tmp = foldPathKey(".tmp");
  // The backups sit beside the store's configured name, so its directory's real path is the other spelling of them.
  const stores = [storage, path.join(canonicalPath(location.dataDirectory), path.basename(storage))];
  const backups = stores.map((file) => foldPathKey(`${file}.${STORE_BACKUP_LABEL_PREFIX}`));
  return (key) =>
    files.has(key) ||
    backups.some((prefix) => key.startsWith(prefix)) ||
    temps.some((prefix) => key.startsWith(prefix) && key.endsWith(tmp));
}

/**
 * Studio state and credentials are reserved for all connection roles and file providers. A path is reserved when its
 * real path names one of the server's own storage files with letter case and Unicode normalization folded
 * (`reservedStorageKey`), or, for a file that exists, when it is the same file (device and inode) as one of them or as
 * a re-seal backup of the store that exists now, so a hard link is refused too.
 *
 * Studio's own files are read here, and anything reading them throws is thrown here; the check this returns reads only
 * the candidate, so what it throws is about the candidate's path.
 */
export function reservedStorageCheck(): (candidate: string) => boolean {
  const isReservedKey = reservedStorageKey();
  const location = storageLocation();
  const bootstrap = canonicalPath(path.join(location.dataDirectory, BOOTSTRAP_FILE_NAME));
  const identities = [...reservedStoragePaths(), bootstrap, `${bootstrap}.bak`, ...storeBackups(location)]
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
