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
  if (kind === undefined || kind.isFile()) return;
  const name = KIND_NAMES.find(([is]) => kind[is]())?.[1] ?? "a special file";
  throw new Error(`${filePath} is ${name}, not a regular file`);
}
