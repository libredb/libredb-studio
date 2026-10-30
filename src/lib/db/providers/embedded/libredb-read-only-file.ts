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
 *   a FIFO put at the path since the connection checked it never blocks the server's thread;
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

/** One read-only descriptor on `file`, with the operations the write-ahead log performs. */
function openReadOnlyWal(file: string): WalFile {
  const fd = openRegularFileForReading(file);
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
