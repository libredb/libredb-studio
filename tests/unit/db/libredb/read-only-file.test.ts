/**
 * The LibreDB read-only file adapter, against the REAL @libredb/libredb kernel and real temp files.
 *
 * The adapter is the agent boundary on this engine: the store file is opened read-only, takes no writer lock, and
 * refuses the one call the kernel writes through. So every case here compares the file, and the writer's lock beside
 * it, byte for byte before and after, rather than trusting what the kernel says it did.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { open, kv } from "@libredb/libredb";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LIBREDB_READ_ONLY_WRITE_REFUSAL,
  libredbReadOnlyFileSystem,
} from "@/lib/db/providers/embedded/libredb-read-only-file";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-read-only-file-"));
  file = path.join(dir, "store.libredb");
  const db = open({ path: file });
  kv(db).set("users:1", "Ada");
  kv(db).set("users:2", "Grace");
  db.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file in the directory with its bytes and its modification time: what an open must leave as it found. */
function snapshot(): Record<string, { bytes: string; mtimeMs: number }> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((name) => {
        const full = path.join(dir, name);
        return [name, { bytes: fs.readFileSync(full).toString("base64"), mtimeMs: fs.statSync(full).mtimeMs }];
      }),
  );
}

describe("libredbReadOnlyFileSystem", () => {
  test("declares no lock, so the kernel takes no writer lock through it", () => {
    expect(libredbReadOnlyFileSystem().lock).toBeUndefined();
  });

  test("opens beside a held writer, reads its committed state, and leaves the file and the lock as they were", () => {
    const writer = open({ path: file });
    try {
      const before = snapshot();
      expect(Object.keys(before)).toEqual(["store.libredb", "store.libredb.lock"]);

      const reader = open({ path: file, fs: libredbReadOnlyFileSystem() });
      expect(kv(reader).get("users:1")).toBe("Ada");
      expect([...kv(reader).prefix("users:")].map((entry) => entry.key)).toEqual(["users:1", "users:2"]);
      reader.close();

      expect(snapshot()).toEqual(before);
      // The writer is untouched by the reader: it still commits.
      kv(writer).set("users:3", "Linus");
    } finally {
      writer.close();
    }
  });

  test("a bypassed kv.set, delete and raw transaction write all fail, and the file stays byte-identical", () => {
    const writer = open({ path: file });
    try {
      const before = snapshot();
      const reader = open({ path: file, fs: libredbReadOnlyFileSystem() });

      const setError = (() => {
        try {
          kv(reader).set("users:9", "Mallory");
          return null;
        } catch (error) {
          return error as Error & { code?: string; cause?: unknown };
        }
      })();
      expect(setError).not.toBeNull();
      expect(setError?.code).toBe("FAILED");
      expect(((setError as { cause?: unknown }).cause as Error).message).toBe(LIBREDB_READ_ONLY_WRITE_REFUSAL);
      // The kernel latches a handle whose commit could not reach the disk: every later call on it is refused.
      expect(() => kv(reader).delete("users:1")).toThrow(/failed to reach the disk/);
      expect(() => reader.transact((tx) => tx.set(new Uint8Array([1]), new Uint8Array([2])))).toThrow(
        /failed to reach the disk/,
      );
      reader.close();

      expect(snapshot()).toEqual(before);
      const fresh = open({ path: file, fs: libredbReadOnlyFileSystem() });
      expect(kv(fresh).get("users:9")).toBeUndefined();
      expect(kv(fresh).get("users:1")).toBe("Ada");
      fresh.close();
    } finally {
      writer.close();
    }
  });

  test("the WAL handle refuses an append itself, whoever calls it, and opens the file for reading only", () => {
    const handle = libredbReadOnlyFileSystem().open(file);
    const before = snapshot();
    try {
      expect(() => handle.append(new Uint8Array([1, 2, 3]))).toThrow(LIBREDB_READ_ONLY_WRITE_REFUSAL);
      handle.fsync();
      handle.truncate(0);
      expect(handle.size()).toBe(fs.statSync(file).size);
    } finally {
      handle.close();
    }
    expect(snapshot()).toEqual(before);
  });

  test("reads by position and stops at the end of the file", () => {
    const handle = libredbReadOnlyFileSystem().open(file);
    try {
      const whole = fs.readFileSync(file);
      expect(Buffer.from(handle.read(0, whole.length))).toEqual(whole);
      expect(Buffer.from(handle.read(4, 8))).toEqual(whole.subarray(4, 12));
      // Past the end the read is short, never padded: the kernel reads a short read as the file ending early.
      expect(handle.read(whole.length - 2, 10).length).toBe(2);
    } finally {
      handle.close();
    }
  });

  test("a missing file is refused and never created", () => {
    const missing = path.join(dir, "missing.libredb");
    expect(() => open({ path: missing, fs: libredbReadOnlyFileSystem() })).toThrow(/ENOENT/);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["store.libredb"]);
  });

  test("a torn tail is recovered in memory and left on disk", () => {
    fs.appendFileSync(file, Buffer.from([1, 2, 3, 4, 5]));
    const before = snapshot();
    const recovered: number[] = [];
    const reader = open({
      path: file,
      fs: libredbReadOnlyFileSystem(),
      onRecovery: (info) => recovered.push(info.truncatedBytes),
    });
    expect(kv(reader).get("users:2")).toBe("Grace");
    reader.close();
    expect(recovered).toEqual([5]);
    expect(snapshot()).toEqual(before);
  });
});
