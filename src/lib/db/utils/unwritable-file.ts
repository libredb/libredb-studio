/**
 * "May this process write the database file at this path?", for the embedded engines.
 *
 * SQLite and DuckDB both keep a journal beside the database (`-wal` and `-shm`, or
 * `.wal`), and both refuse or fail an ordinary read-write open of a file this process
 * cannot write: a read-only Docker mount, or a file owned by another user. Each provider
 * opens such a file read-only instead, and this is the one question both ask first. It
 * names no engine.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * The `access()` refusals that mean "this process may not write here": no permission
 * (`EACCES`, `EPERM`) or a read-only filesystem (`EROFS`, a `:ro` Docker mount). Any
 * other answer is a real failure and is raised as one.
 */
const NOT_WRITABLE_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * True when `dbPath` names an existing file that this process cannot write, or whose
 * directory it cannot write. The directory counts because the journal both engines keep
 * lives beside the database. A missing file and `:memory:` answer false: the caller
 * creates the file, exactly as before.
 */
export function isUnwritableExistingFile(dbPath: string): boolean {
  if (dbPath === ":memory:" || !fs.existsSync(dbPath)) {
    return false;
  }
  for (const target of [dbPath, path.dirname(dbPath)]) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch (error) {
      if (NOT_WRITABLE_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
        return true;
      }
      throw error;
    }
  }
  return false;
}
