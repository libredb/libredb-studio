/**
 * Refuse a database path that exists and is not a regular file, for the embedded engines.
 *
 * SQLite, DuckDB and LibreDB open the file a person typed, on the server itself. Opening a FIFO for
 * reading waits for a writer that never comes, and these opens are synchronous: DuckDB's header read
 * and SQLite's read-only open of a FIFO never returned (measured on bun 1.4.2). In the server's own
 * process that blocks the event loop, so one Test Connection hung the whole server; in SQLite's worker
 * process it left the request unanswered for good. Other kinds answered wrongly instead: SQLite
 * reported a connection to /dev/null and /dev/zero, and LibreDB to a FIFO.
 *
 * So this asks `stat`, which never opens the path and follows a symlink to its target, before anything
 * opens or reads it. A regular file passes, a symlink to one too, and a missing path passes so the
 * engine creates the file where it always did. Any other kind is refused with an error naming the path
 * and what it is, and a stat failure that is not a missing entry is raised as it came. It names no
 * engine: each provider raises the refusal as its own open failure.
 *
 * The engines also open the files they keep beside the database by name, and a FIFO at one of those
 * hung the server the same way: LibreDB's `.lock`, SQLite's `-journal` and DuckDB's `.wal` (measured on
 * bun 1.4.2 and Node v24.14.0). So each provider passes its sidecar suffixes too
 * (`assertRegularFilesOrMissing`).
 *
 * `stat` and a later open are two looks at the path, and a FIFO renamed onto it between them is opened.
 * The engines' own opens cannot be told to look at what they opened, but a read the server makes on its
 * own thread can: `readRegularFileStart` opens without waiting and asks the descriptor, not the path.
 */
import * as fs from "node:fs";

/** What the check reads of a `stat` answer, injectable so a test can hand it a kind no test can make. */
export type FileKind = Pick<
  fs.Stats,
  "isFile" | "isDirectory" | "isFIFO" | "isSocket" | "isCharacterDevice" | "isBlockDevice"
>;

/**
 * The codes that mean "nothing at this path": ENOENT, and ENOTDIR for a path below a file. Node's
 * `throwIfNoEntry: false` answers both as no entry while Bun raises ENOTDIR (measured, Node v24.14.0
 * and bun 1.4.2), so the check names them itself and reads the same on both runtimes.
 */
const NO_ENTRY_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** `stat`, or undefined when nothing is at the path; any other failure is raised as it came. */
function statOrMissing(filePath: string): FileKind | undefined {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (NO_ENTRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

/** How a kind that is not a regular file is named in the refusal, in the order they are asked. */
const KIND_NAMES: ReadonlyArray<readonly [Exclude<keyof FileKind, "isFile">, string]> = [
  ["isDirectory", "a directory"],
  ["isFIFO", "a named pipe (FIFO)"],
  ["isSocket", "a socket"],
  ["isCharacterDevice", "a character device"],
  ["isBlockDevice", "a block device"],
];

/**
 * Raise unless `filePath` is a regular file, a symlink to one, or missing. The message names the path
 * and its kind, for example `/data/app.db is a named pipe (FIFO), not a regular file`.
 */
export function assertRegularFileOrMissing(
  filePath: string,
  stat: (target: string) => FileKind | undefined = statOrMissing,
): void {
  const kind = stat(filePath);
  if (kind !== undefined) refuseUnlessRegular(filePath, kind);
}

/** Raise the refusal unless `kind` is a regular file. */
function refuseUnlessRegular(filePath: string, kind: FileKind): void {
  if (kind.isFile()) return;
  const name = KIND_NAMES.find(([is]) => kind[is]())?.[1] ?? "a special file";
  throw new Error(`${filePath} is ${name}, not a regular file`);
}

/**
 * `assertRegularFileOrMissing` for the database path, then for each file the engine keeps beside it,
 * named by its suffix (`.lock`, `-journal`, `.wal`). The first that is not a regular file is the one
 * named, so a refused database path is reported before its sidecars.
 */
export function assertRegularFilesOrMissing(dbPath: string, sidecarSuffixes: readonly string[]): void {
  for (const filePath of [dbPath, ...sidecarSuffixes.map((suffix) => `${dbPath}${suffix}`)]) {
    assertRegularFileOrMissing(filePath);
  }
}

/**
 * Read-only, and O_NONBLOCK so that opening a FIFO returns at once instead of waiting for a writer.
 * Windows defines no O_NONBLOCK and has no FIFO in its filesystem, and OR-ing its `undefined` adds nothing.
 */
const READ_WITHOUT_WAITING = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

/**
 * The first `length` bytes of the file at `filePath`, or fewer when it is shorter, read on the caller's
 * thread without ever waiting: the open does not wait for a FIFO's writer, and the refusal is raised
 * from what was opened (`fstat` of the descriptor), so a FIFO renamed onto the path after
 * `assertRegularFileOrMissing` passed is refused here instead of read. Null when the path cannot be
 * opened (missing, unreadable), which the caller leaves to the engine.
 */
export function readRegularFileStart(filePath: string, length: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, READ_WITHOUT_WAITING);
  } catch {
    return null;
  }
  try {
    refuseUnlessRegular(filePath, fs.fstatSync(fd));
    const start = Buffer.alloc(length);
    return start.subarray(0, fs.readSync(fd, start, 0, length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A read-only descriptor on `filePath`, for an engine's own read of a file the server opens again after
 * `assertRegularFileOrMissing` passed. Opened without waiting, and refused (the descriptor closed) unless
 * what was opened is a regular file, so a FIFO put at the path since the check is refused instead of read.
 * An open failure (missing, unreadable) is raised as it came, for the caller to describe.
 */
export function openRegularFileForReading(filePath: string): number {
  const fd = fs.openSync(filePath, READ_WITHOUT_WAITING);
  try {
    refuseUnlessRegular(filePath, fs.fstatSync(fd));
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}
