/**
 * Create the folder a database file goes in, for the embedded engines, one level at a time.
 *
 * SQLite and DuckDB create a missing folder for the file path a person typed. Node's recursive
 * mkdir (`mkdirSync` and `promises.mkdir` with `recursive: true`) never returns for a path under
 * /proc: procfs answers ENOENT for a parent that exists, and Node's loop retries it forever
 * (measured on Node v24.14.0; Bun throws ENOENT). Node runs the production server, so one Test
 * Connection with such a path blocked the event loop and hung the whole server.
 *
 * So this never passes `recursive`: it walks up to the nearest existing ancestor and makes each
 * missing level in order, and the first refusal is raised as the filesystem's own error, which
 * names its code and the folder. It names no engine.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Everything the walk asks the filesystem, injectable so a test sees each call. */
export interface DirectoryOps {
  exists(dir: string): boolean;
  /** One level, never recursive. */
  mkdir(dir: string): void;
  isDirectory(dir: string): boolean;
}

/** The real filesystem. */
export const systemDirectoryOps: DirectoryOps = {
  exists: (dir) => fs.existsSync(dir),
  mkdir: (dir) => {
    fs.mkdirSync(dir);
  },
  isDirectory: (dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true,
};

/**
 * Make `dir` and every missing folder above it. An existing `dir` asks for nothing. A level that
 * appears between the walk and its mkdir (EEXIST) is accepted only when it is a directory; any
 * other error is raised as it came, and nothing below that level is tried.
 */
export function createMissingDirectories(dir: string, ops: DirectoryOps = systemDirectoryOps): void {
  const missing: string[] = [];
  let current = dir;
  while (!ops.exists(current)) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const level of missing) {
    try {
      ops.mkdir(level);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && ops.isDirectory(level)) continue;
      throw error;
    }
  }
}
