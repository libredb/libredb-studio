/**
 * The read-only file adapter the agent's LibreDB handles open through: the boundary on this engine.
 *
 * `@libredb/libredb` reaches the disk only through the `FileSystem` seam it is given, and writes through exactly one
 * call of it, `append` on the write-ahead log (measured on 0.2.2: a commit appends, then fsyncs; recovery truncates a
 * torn tail, then fsyncs; nothing else writes). So a handle opened through this adapter cannot change the file
 * whatever is asked of it:
 *
 * - the file is opened read-only, a descriptor the operating system will not write through, and a missing file is
 *   refused rather than created; the open does not wait, and what it opened is refused unless it is a regular file, so
 *   a FIFO put at the path since the connection checked it never blocks the server's thread, and refused when a byte
 *   can be read past the size it reports, as a procfs file's can (`LibreDBNotAStoreError`);
 * - `append` refuses before any write call, and the kernel then latches the handle, refusing every later call on it
 *   until it is closed (`FAILED`);
 * - `truncate` and `fsync` change nothing, so recovery drops a torn tail from the handle's memory and leaves the bytes
 *   on disk exactly as found;
 * - there is no `lock`, so the kernel takes no `<path>.lock` and the open neither waits for nor blocks the writer that
 *   holds one: the reader opens beside it and reads what it has committed so far.
 *
 * A handle is a snapshot of what was committed when it opened, which is why each agent statement opens its own.
 *
 * Studio's own adapter rather than the package's `readonlyFileSystem()`: that one reads by path on every call and
 * belongs to the package's command-line inspector, while this one reads through the descriptor it opened, so every
 * read of one handle addresses one file.
 */
import * as fs from "fs";
import type { FileSystem, WalFile } from "@libredb/libredb";
import { openRegularFileForReading } from "../../utils/regular-file";

/** What a write through a read-only handle is refused with; the kernel carries it as the cause of its `FAILED`. */
export const LIBREDB_READ_ONLY_WRITE_REFUSAL = "LibreDB file opened read-only for the agent: a write is refused";

/**
 * What a file whose bytes run past the size it reports is refused with: a procfs file reports a size of 0 and is
 * filled when it is read, and the kernel reads a file's size before its bytes, so it took one for an empty store.
 * Studio's own error rather than the kernel's, which this adapter cannot construct; the provider names it as the
 * kernel's `NOT_A_DATABASE`.
 */
export class LibreDBNotAStoreError extends Error {
  constructor(file: string, size: number) {
    super(`${file} reports ${size} bytes but holds more, so it is not a LibreDB file`);
    this.name = "LibreDBNotAStoreError";
  }
}

/**
 * A read-only descriptor on the regular file at `file`, refused (and closed) when a byte can be read past the size it
 * reports. A writer committing beside the reader grows the file between the two looks, so a byte past the first size
 * counts only when the size, asked again, has not grown past it.
 */
function openStoreForReading(file: string): number {
  const fd = openRegularFileForReading(file);
  try {
    const size = fs.fstatSync(fd).size;
    if (fs.readSync(fd, new Uint8Array(1), 0, 1, size) > 0 && fs.fstatSync(fd).size <= size) {
      throw new LibreDBNotAStoreError(file, size);
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

/** One read-only descriptor on `file`, with the operations the write-ahead log performs. */
function openReadOnlyWal(file: string): WalFile {
  const fd = openStoreForReading(file);
  return Object.freeze({
    size: () => fs.fstatSync(fd).size,
    read(offset: number, length: number): Uint8Array {
      // Looped, because one positional read may return fewer bytes than asked; a short answer only at the end.
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const count = fs.readSync(fd, out, filled, length - filled, offset + filled);
        if (count === 0) break;
        filled += count;
      }
      return filled === length ? out : out.subarray(0, filled);
    },
    append(): void {
      throw new Error(LIBREDB_READ_ONLY_WRITE_REFUSAL);
    },
    fsync(): void {
      // Nothing was written through this descriptor, so there is nothing to flush.
    },
    truncate(): void {
      // A read leaves the file as found: recovery drops a torn tail from memory only.
    },
    close: () => fs.closeSync(fd),
  });
}

/** A fresh read-only filesystem for one open; it declares no `lock`. */
export function libredbReadOnlyFileSystem(): FileSystem {
  return Object.freeze({ open: openReadOnlyWal });
}

/**
 * The read-only filesystem with the writer's lock: the operations profile's own handle, which sends no statement and
 * holds the file as the editor's open does, so nothing commits beside it. `lock` is the writer filesystem's, and is
 * taken only once the file has been opened and checked as a store, so a missing file, or one that is no regular file
 * or whose bytes run past its size, is refused before `<path>.lock` is created, and the file is never created either.
 */
export function libredbLockedReadOnlyFileSystem(lock: (file: string) => () => void): FileSystem {
  return Object.freeze({
    open: openReadOnlyWal,
    lock(file: string): () => void {
      fs.closeSync(openStoreForReading(file));
      return lock(file);
    },
  });
}
