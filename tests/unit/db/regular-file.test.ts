/**
 * The check every embedded engine runs on its database path before anything opens it.
 *
 * Opening a FIFO for reading waits for a writer that never comes, synchronously, on the server's own
 * thread: one Test Connection with a FIFO path froze the whole server (DuckDB's header read and a
 * read-only SQLite open, measured on bun 1.4.2). The check asks `stat`, which never opens the path,
 * so every FIFO case runs in a child under a hard limit: a regression to opening it fails here
 * instead of hanging the suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRegularFileOrMissing, type FileKind } from "@/lib/db/utils/regular-file";
import { describeIf, testIf } from "../../helpers/posix-tools";
import { CHILD_TEST_TIMEOUT_MS, MISSING_POSIX_SPECIAL_FILES, makeFifo, runInChild } from "../../helpers/special-files";

/** The refusal's message, or null when the check passed. */
function refusal(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** A stat answer of one kind, or of none: a block device no test can make, and a kind no predicate names. */
function kindOf(kind: keyof FileKind | null): FileKind {
  const is = (name: keyof FileKind) => () => name === kind;
  return {
    isFile: is("isFile"),
    isDirectory: is("isDirectory"),
    isFIFO: is("isFIFO"),
    isSocket: is("isSocket"),
    isCharacterDevice: is("isCharacterDevice"),
    isBlockDevice: is("isBlockDevice"),
  };
}

describe("assertRegularFileOrMissing, from what stat answers", () => {
  test("a regular file passes", () => {
    expect(refusal(() => assertRegularFileOrMissing("/data/app.db", () => kindOf("isFile")))).toBeNull();
  });

  test("a missing path passes, so the engine creates the file as before", () => {
    expect(refusal(() => assertRegularFileOrMissing("/data/app.db", () => undefined))).toBeNull();
  });

  test.each([
    ["isDirectory", "a directory"],
    ["isFIFO", "a named pipe (FIFO)"],
    ["isSocket", "a socket"],
    ["isCharacterDevice", "a character device"],
    ["isBlockDevice", "a block device"],
    [null, "a special file"],
  ] as const)("%p is refused, naming the path and what it is", (kind, name) => {
    expect(refusal(() => assertRegularFileOrMissing("/data/app.db", () => kindOf(kind)))).toBe(
      `/data/app.db is ${name}, not a regular file`,
    );
  });
});

describe("on the real filesystem", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "regular-file-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a regular file passes", () => {
    const file = join(scratch, "regular.db");
    writeFileSync(file, "");
    expect(refusal(() => assertRegularFileOrMissing(file))).toBeNull();
  });

  test("a missing path passes, and nothing is created", () => {
    const missing = join(scratch, "missing.db");
    expect(refusal(() => assertRegularFileOrMissing(missing))).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  // Node answers a path below a file as no entry and Bun raises ENOTDIR (measured, Node v24.14.0 and
  // bun 1.4.2), so the check names both as missing, and the folder walk or the engine reports the path
  // in its own words on both runtimes, exactly as before.
  test("a path below a regular file passes as missing on every runtime", () => {
    const file = join(scratch, "a-file");
    writeFileSync(file, "");
    expect(refusal(() => assertRegularFileOrMissing(join(file, "app.db")))).toBeNull();
  });

  test("a directory is refused", () => {
    const dir = join(scratch, "a-directory");
    mkdirSync(dir);
    expect(refusal(() => assertRegularFileOrMissing(dir))).toBe(`${dir} is a directory, not a regular file`);
  });

  testIf(MISSING_POSIX_SPECIAL_FILES, "a symlink to a regular file passes: stat follows it", () => {
    const file = join(scratch, "target.db");
    writeFileSync(file, "");
    const link = join(scratch, "link-to-target.db");
    symlinkSync(file, link);
    expect(refusal(() => assertRegularFileOrMissing(link))).toBeNull();
  });

  testIf(MISSING_POSIX_SPECIAL_FILES, "a character device is refused", () => {
    expect(refusal(() => assertRegularFileOrMissing("/dev/null"))).toBe(
      "/dev/null is a character device, not a regular file",
    );
  });

  testIf(MISSING_POSIX_SPECIAL_FILES, "a socket is refused", async () => {
    const socket = join(scratch, "s.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(refusal(() => assertRegularFileOrMissing(socket))).toBe(`${socket} is a socket, not a regular file`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  testIf(
    MISSING_POSIX_SPECIAL_FILES,
    "a stat failure other than a missing entry is raised as it came: a symlink loop answers ELOOP",
    () => {
      const loop = join(scratch, "loop.db");
      symlinkSync(loop, loop);
      expect(refusal(() => assertRegularFileOrMissing(loop))).toStartWith("ELOOP");
    },
  );
});

// Its own timeout, above the child's hard limit, so a regression is reported by the kill rather than
// by bun's 5 s default with the child still blocked.
describeIf(MISSING_POSIX_SPECIAL_FILES, "a FIFO, checked in a child under a hard limit", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "regular-file-fifo-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test(
    "a FIFO and a symlink to one are refused at once, without opening them",
    async () => {
      const fifo = join(scratch, "nobody-writes");
      makeFifo(fifo);
      const link = join(scratch, "link-to-fifo");
      symlinkSync(fifo, link);
      const check = JSON.stringify(join(import.meta.dir, "../../../src/lib/db/utils/regular-file.ts"));
      const outcome = await runInChild(
        [
          `const { assertRegularFileOrMissing } = await import(${check});`,
          "const refusals = [];",
          `for (const target of ${JSON.stringify([fifo, link])}) {`,
          "  try { assertRegularFileOrMissing(target); refusals.push(null); }",
          "  catch (error) { refusals.push(error.message); }",
          "}",
          "report(refusals);",
        ].join("\n"),
      );
      expect(outcome).toEqual({
        report: [
          `${fifo} is a named pipe (FIFO), not a regular file`,
          `${link} is a named pipe (FIFO), not a regular file`,
        ],
        failure: null,
      });
      expect(statSync(fifo).isFIFO()).toBe(true);
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});
