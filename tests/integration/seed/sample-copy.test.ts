/**
 * The verified copy of one pinned sample asset to its target (src/lib/seed/sample-copy.ts): never over an existing
 * file, checked against the pinned size before a byte is written and against the pinned size and digest before it is
 * published, flushed, then published by a rename, and with no temp left behind on any failure.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@/lib/logger";
import { copySampleAsset, SampleCopyError, type PinnedAsset } from "@/lib/seed/sample-copy";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "sample-copy-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** An asset file of `content` with its pin, and a target in a directory of its own that does not exist yet. */
function fixture(content: Buffer = Buffer.from("a pinned sample asset, several bytes long")): {
  pinned: PinnedAsset;
  target: string;
  targetDir: string;
} {
  const assets = temporaryDirectory();
  const asset = path.join(assets, "sample.db");
  fs.writeFileSync(asset, content);
  const targetDir = path.join(temporaryDirectory(), "data");
  return {
    pinned: { asset, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length },
    target: path.join(targetDir, "sample.db"),
    targetDir,
  };
}

/** The copy's rejection, settled with a plain await so nothing is asserted on a promise a timer settles. */
async function failure(promise: Promise<unknown>): Promise<SampleCopyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SampleCopyError) return error;
    throw error;
  }
  throw new Error("the copy did not fail");
}

describe("copySampleAsset", () => {
  test("copies the asset byte for byte, publishes it by rename and leaves no temp", async () => {
    const { pinned, target, targetDir } = fixture();
    expect(await copySampleAsset(pinned, target)).toBe("copied");
    expect(fs.readFileSync(target).equals(fs.readFileSync(pinned.asset))).toBe(true);
    expect(fs.readdirSync(targetDir)).toEqual(["sample.db"]);
  });

  test("copies a multi-chunk asset whole", async () => {
    const { pinned, target } = fixture(Buffer.alloc(300_000, 7));
    expect(await copySampleAsset(pinned, target)).toBe("copied");
    expect(fs.readFileSync(target).equals(fs.readFileSync(pinned.asset))).toBe(true);
  });

  test("leaves an existing target untouched and reports present", async () => {
    const { pinned, target, targetDir } = fixture();
    fs.mkdirSync(targetDir);
    fs.writeFileSync(target, "the user's edits");
    expect(await copySampleAsset(pinned, target)).toBe("present");
    expect(fs.readFileSync(target, "utf8")).toBe("the user's edits");
  });

  test("with no seed assets directory the copy is asset-directory-unset, names the target, and creates nothing", async () => {
    const { target, targetDir } = fixture();
    const error = await failure(copySampleAsset(null, target));
    expect(error.reason).toBe("asset-directory-unset");
    expect(error.code).toBeUndefined();
    expect(error.message).toContain(target);
    expect(error.message).toContain("SEED_ASSETS_DIR");
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  test("an existing target is present before the seed assets directory is consulted", async () => {
    const { target, targetDir } = fixture();
    fs.mkdirSync(targetDir);
    fs.writeFileSync(target, "the user's edits");
    expect(await copySampleAsset(null, target)).toBe("present");
    expect(fs.readFileSync(target, "utf8")).toBe("the user's edits");
  });

  test("refuses an asset of another size before writing anything", async () => {
    const { pinned, target } = fixture();
    const open = spyOn(fs.promises, "open");
    try {
      const error = await failure(copySampleAsset({ ...pinned, bytes: pinned.bytes + 1 }, target));
      expect(error.reason).toBe("digest-mismatch");
      expect(error.message).toContain(pinned.asset);
      expect(open).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      open.mockRestore();
    }
  });

  test("refuses an asset whose bytes differ from the pin and publishes nothing", async () => {
    const { pinned, target, targetDir } = fixture();
    const changed = fs.readFileSync(pinned.asset);
    changed[0] = (changed[0] ?? 0) ^ 1;
    fs.writeFileSync(pinned.asset, changed);
    const error = await failure(copySampleAsset(pinned, target));
    expect(error.reason).toBe("digest-mismatch");
    expect(fs.readdirSync(targetDir)).toEqual([]);
  });

  test("refuses an asset that grows past the pin while it is copied", async () => {
    const { pinned, target, targetDir } = fixture(Buffer.alloc(200_000, 1));
    // The stat answers the pinned size, as it would have before the file grew; the stream then carries more.
    fs.appendFileSync(pinned.asset, Buffer.alloc(100_000, 2));
    const realStat = fs.promises.stat;
    const stat = spyOn(fs.promises, "stat").mockImplementation((async (file: fs.PathLike) => {
      const stats = await realStat(file);
      return file === pinned.asset ? Object.assign(stats, { size: pinned.bytes }) : stats;
    }) as typeof fs.promises.stat);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect(error.reason).toBe("digest-mismatch");
      expect(error.message).toContain("more than");
      expect(fs.readdirSync(targetDir)).toEqual([]);
    } finally {
      stat.mockRestore();
    }
  });

  test("names a missing asset asset-missing", async () => {
    const { pinned, target } = fixture();
    fs.rmSync(pinned.asset);
    const error = await failure(copySampleAsset(pinned, target));
    expect(error.reason).toBe("asset-missing");
    expect(error.message).toContain(pinned.asset);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  test("names an asset that is not a regular file asset-missing", async () => {
    const { pinned, target } = fixture();
    fs.rmSync(pinned.asset);
    fs.mkdirSync(pinned.asset);
    expect((await failure(copySampleAsset(pinned, target))).reason).toBe("asset-missing");
    // A path through a regular file is ENOTDIR, which is missing too.
    const blocker = path.join(temporaryDirectory(), "blocker");
    fs.writeFileSync(blocker, "");
    expect((await failure(copySampleAsset({ ...pinned, asset: path.join(blocker, "x") }, target))).reason).toBe(
      "asset-missing",
    );
  });

  test("an asset that cannot be checked for another reason is asset-unreadable naming its code", async () => {
    const { pinned, target } = fixture();
    const stat = spyOn(fs.promises, "stat").mockImplementation((async (file: fs.PathLike) => {
      if (file === pinned.asset) throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      throw Object.assign(new Error("ENOENT: simulated"), { code: "ENOENT" });
    }) as typeof fs.promises.stat);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "asset-unreadable", code: "EACCES" });
      expect(error.message).toContain(pinned.asset);
    } finally {
      stat.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an asset that exists but cannot be read is asset-unreadable naming EACCES and leaves no temp (POSIX, not root)",
    async () => {
      const { pinned, target, targetDir } = fixture();
      fs.chmodSync(pinned.asset, 0o000);
      try {
        const error = await failure(copySampleAsset(pinned, target));
        expect({ reason: error.reason, code: error.code }).toEqual({ reason: "asset-unreadable", code: "EACCES" });
        expect(error.message).toContain(pinned.asset);
        expect(fs.readdirSync(targetDir)).toEqual([]);
      } finally {
        fs.chmodSync(pinned.asset, 0o600);
      }
    },
  );

  test("a target that cannot be checked is copy-failed naming its code", async () => {
    const { pinned, target } = fixture();
    const stat = spyOn(fs.promises, "stat").mockImplementation((async () => {
      throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
    }) as typeof fs.promises.stat);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: "EACCES" });
    } finally {
      stat.mockRestore();
    }
  });

  test("a write that fails (ENOSPC) removes the temp and names the code", async () => {
    const { pinned, target, targetDir } = fixture();
    const realOpen = fs.promises.open;
    const open = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, flags?: string | number) => {
      const handle = await realOpen(file, flags);
      return Object.assign(Object.create(handle), {
        write: async () => {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      });
    }) as typeof fs.promises.open);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: "ENOSPC" });
      expect(error.message).toContain("ENOSPC");
      expect(fs.readdirSync(targetDir)).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  test("a short write is copy-failed and leaves no temp", async () => {
    const { pinned, target, targetDir } = fixture();
    const realOpen = fs.promises.open;
    const open = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, flags?: string | number) => {
      const handle = await realOpen(file, flags);
      return Object.assign(Object.create(handle), {
        write: async (buffer: Buffer) => ({ bytesWritten: buffer.length - 1, buffer }),
        close: () => handle.close(),
      });
    }) as typeof fs.promises.open);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: undefined });
      expect(error.message).toContain("short write");
      expect(fs.readdirSync(targetDir)).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  test("flushes the temp before the rename publishes it", async () => {
    const { pinned, target } = fixture();
    const calls: string[] = [];
    const realOpen = fs.promises.open;
    const open = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, flags?: string | number) => {
      const handle = await realOpen(file, flags);
      return Object.assign(Object.create(handle), {
        write: (...args: Parameters<typeof handle.write>) => {
          calls.push("write");
          return handle.write(...args);
        },
        sync: async () => {
          calls.push("sync");
          await handle.sync();
        },
        close: async () => {
          calls.push("close");
          await handle.close();
        },
      });
    }) as typeof fs.promises.open);
    const realRename = fs.promises.rename;
    const rename = spyOn(fs.promises, "rename").mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      calls.push("rename");
      await realRename(from, to);
    }) as typeof fs.promises.rename);
    try {
      expect(await copySampleAsset(pinned, target)).toBe("copied");
      // Every write lands before the flush, so the flush covers the last byte.
      expect(calls.filter((call) => call !== "write").length).toBe(3);
      expect(calls.indexOf("write")).toBe(0);
      expect(calls.slice(calls.lastIndexOf("write") + 1)).toEqual(["sync", "close", "rename"]);
    } finally {
      open.mockRestore();
      rename.mockRestore();
    }
  });

  test("each copy writes a temp of its own, named for its pid and a random part", async () => {
    const { pinned, target, targetDir } = fixture(Buffer.alloc(300_000, 3));
    const temps: string[] = [];
    const realOpen = fs.promises.open;
    const open = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, flags?: string | number) => {
      if (flags === "wx") temps.push(String(file));
      return realOpen(file, flags);
    }) as typeof fs.promises.open);
    try {
      // Two copies in one process share its pid, as two replicas that each run the server as pid 1 do.
      const outcomes = await Promise.all([copySampleAsset(pinned, target), copySampleAsset(pinned, target)]);
      expect(outcomes.includes("copied")).toBe(true);
      expect(outcomes.every((outcome) => outcome === "copied" || outcome === "present")).toBe(true);
    } finally {
      open.mockRestore();
    }
    expect(temps.length).toBe(2);
    expect(new Set(temps).size).toBe(2);
    const prefix = `${target}.${process.pid}.`;
    for (const temp of temps) {
      expect(temp.startsWith(prefix)).toBe(true);
      expect(temp.endsWith(".seeding")).toBe(true);
      expect(temp.slice(prefix.length, -".seeding".length)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(fs.readdirSync(targetDir)).toEqual(["sample.db"]);
    expect(fs.readFileSync(target).equals(fs.readFileSync(pinned.asset))).toBe(true);
  });

  test("never touches a temp another copy left, even one of this pid", async () => {
    const { pinned, target, targetDir } = fixture();
    fs.mkdirSync(targetDir);
    const leftover = `${target}.${process.pid}.seeding`;
    fs.writeFileSync(leftover, "another copy's unfinished temp");
    expect(await copySampleAsset(pinned, target)).toBe("copied");
    expect(fs.readdirSync(targetDir).sort()).toEqual(["sample.db", path.basename(leftover)].sort());
    expect(fs.readFileSync(leftover, "utf8")).toBe("another copy's unfinished temp");
    expect(fs.readFileSync(target).equals(fs.readFileSync(pinned.asset))).toBe(true);
  });

  test("a rename that fails after another seeder published reports present", async () => {
    const { pinned, target, targetDir } = fixture();
    const rename = spyOn(fs.promises, "rename").mockImplementation((async () => {
      // Another seeder publishes the same verified bytes, then this rename is refused, as Windows refuses one.
      fs.copyFileSync(pinned.asset, target);
      throw Object.assign(new Error("EPERM: simulated rename failure"), { code: "EPERM" });
    }) as typeof fs.promises.rename);
    try {
      expect(await copySampleAsset(pinned, target)).toBe("present");
      expect(fs.readdirSync(targetDir)).toEqual(["sample.db"]);
    } finally {
      rename.mockRestore();
    }
  });

  test("a rename that fails with no target is copy-failed and leaves no temp", async () => {
    const { pinned, target, targetDir } = fixture();
    const rename = spyOn(fs.promises, "rename").mockImplementation((async () => {
      throw Object.assign(new Error("EACCES: simulated rename failure"), { code: "EACCES" });
    }) as typeof fs.promises.rename);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: "EACCES" });
      expect(fs.readdirSync(targetDir)).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  test("a temp that cannot be removed after a failure is logged, and the first error is the one reported", async () => {
    const { pinned, target } = fixture();
    const rename = spyOn(fs.promises, "rename").mockImplementation((async () => {
      throw Object.assign(new Error("EACCES: simulated rename failure"), { code: "EACCES" });
    }) as typeof fs.promises.rename);
    const realRm = fs.promises.rm;
    const removed: string[] = [];
    const rm = spyOn(fs.promises, "rm").mockImplementation((async (file: fs.PathLike, options?: fs.RmOptions) => {
      removed.push(String(file));
      // The only removal is the cleanup after the failure.
      if (removed.length === 1) throw Object.assign(new Error("EBUSY: simulated removal failure"), { code: "EBUSY" });
      await realRm(file, options);
    }) as typeof fs.promises.rm);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: "EACCES" });
      expect(removed.length).toBe(1);
      expect(removed[0]?.startsWith(`${target}.${process.pid}.`)).toBe(true);
      expect(warn.mock.calls.map(([message, context]) => [message, context?.temp, context?.error])).toEqual([
        ["Embedded sample temp not removed", removed[0], "EBUSY: simulated removal failure"],
      ]);
    } finally {
      rename.mockRestore();
      rm.mockRestore();
      warn.mockRestore();
    }
  });

  test("a close that fails after a failure is logged, and the first failure is the one reported", async () => {
    const { pinned, target, targetDir } = fixture();
    const changed = fs.readFileSync(pinned.asset);
    changed[0] = (changed[0] ?? 0) ^ 1;
    fs.writeFileSync(pinned.asset, changed);
    const realOpen = fs.promises.open;
    const open = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, flags?: string | number) => {
      const handle = await realOpen(file, flags);
      return Object.assign(Object.create(handle), {
        write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
        close: async () => {
          await handle.close();
          throw Object.assign(new Error("EIO: simulated close failure"), { code: "EIO" });
        },
      });
    }) as typeof fs.promises.open);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect(error.reason).toBe("digest-mismatch");
      expect(warn.mock.calls.map(([message, context]) => [message, context?.error])).toEqual([
        ["Embedded sample temp not closed", "EIO: simulated close failure"],
      ]);
      expect(String(warn.mock.calls[0]?.[1]?.temp).startsWith(`${target}.${process.pid}.`)).toBe(true);
      expect(fs.readdirSync(targetDir)).toEqual([]);
    } finally {
      open.mockRestore();
      warn.mockRestore();
    }
  });

  test("a close that fails after a verified write is copy-failed naming its code", async () => {
    const { pinned, target, targetDir } = fixture();
    const realOpen = fs.promises.open;
    const open = spyOn(fs.promises, "open").mockImplementation((async (file: fs.PathLike, flags?: string | number) => {
      const handle = await realOpen(file, flags);
      return Object.assign(Object.create(handle), {
        write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
        close: async () => {
          await handle.close();
          throw Object.assign(new Error("EIO: simulated close failure"), { code: "EIO" });
        },
      });
    }) as typeof fs.promises.open);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: "EIO" });
      expect(fs.readdirSync(targetDir)).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  test("a failure that is not an Error is still copy-failed, with its text", async () => {
    const { pinned, target } = fixture();
    const rename = spyOn(fs.promises, "rename").mockImplementation((async () => {
      throw "a thrown string";
    }) as typeof fs.promises.rename);
    try {
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: undefined });
      expect(error.message).toContain("a thrown string");
    } finally {
      rename.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unwritable data directory is copy-failed naming EACCES (POSIX, not root)",
    async () => {
      const { pinned, target, targetDir } = fixture();
      fs.mkdirSync(targetDir);
      fs.chmodSync(targetDir, 0o500);
      const error = await failure(copySampleAsset(pinned, target));
      expect({ reason: error.reason, code: error.code }).toEqual({ reason: "copy-failed", code: "EACCES" });
      expect(fs.readdirSync(targetDir)).toEqual([]);
    },
  );
});
