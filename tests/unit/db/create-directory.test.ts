/**
 * The folder an embedded engine's database file goes in, created one level at a time.
 *
 * Node's recursive mkdir never returns for a path under /proc (measured on Node v24.14.0, sync and
 * async alike): procfs answers ENOENT for a parent that exists, and Node's loop retries forever,
 * so one Test Connection hung the whole production server. The helper never passes `recursive`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMissingDirectories, type DirectoryOps, systemDirectoryOps } from "@/lib/db/utils/create-directory";
import { testIf } from "../../helpers/posix-tools";

/** A stand-in filesystem that records every call, so the test sees exactly what was asked of it. */
function recordingOps(
  existing: ReadonlySet<string>,
  failures: Readonly<Record<string, string>> = {},
  directories: ReadonlySet<string> = new Set(),
) {
  const calls: string[] = [];
  const ops: DirectoryOps = {
    exists: (dir) => existing.has(dir),
    mkdir: (dir, ...rest) => {
      calls.push(`mkdir ${dir}${rest.length > 0 ? ` ${JSON.stringify(rest)}` : ""}`);
      const code = failures[dir];
      if (code !== undefined) throw Object.assign(new Error(`${code}: mkdir '${dir}'`), { code });
    },
    isDirectory: (dir) => {
      calls.push(`isDirectory ${dir}`);
      return directories.has(dir);
    },
  };
  return { ops, calls };
}

describe("createMissingDirectories", () => {
  test("creates each missing level in order, from the nearest existing ancestor down, never recursively", () => {
    const { ops, calls } = recordingOps(new Set(["/", "/data"]));
    createMissingDirectories("/data/a/b/c", ops);
    expect(calls).toEqual(["mkdir /data/a", "mkdir /data/a/b", "mkdir /data/a/b/c"]);
  });

  test("an existing folder asks for nothing", () => {
    const { ops, calls } = recordingOps(new Set(["/", "/data"]));
    createMissingDirectories("/data", ops);
    expect(calls).toEqual([]);
  });

  test("stops at the first refused level and raises the filesystem's own error", () => {
    const { ops, calls } = recordingOps(new Set(["/", "/proc"]), { "/proc/libredb-x": "ENOENT" });
    expect(() => createMissingDirectories("/proc/libredb-x/y", ops)).toThrow("ENOENT: mkdir '/proc/libredb-x'");
    expect(calls).toEqual(["mkdir /proc/libredb-x"]);
  });

  test("a level another process made meanwhile is accepted when it is a directory", () => {
    const { ops, calls } = recordingOps(new Set(["/", "/data"]), { "/data/a": "EEXIST" }, new Set(["/data/a"]));
    createMissingDirectories("/data/a/b", ops);
    expect(calls).toEqual(["mkdir /data/a", "isDirectory /data/a", "mkdir /data/a/b"]);
  });

  test("EEXIST for an entry that is not a directory is raised, and nothing below it is tried", () => {
    const { ops, calls } = recordingOps(new Set(["/", "/data"]), { "/data/a": "EEXIST" });
    expect(() => createMissingDirectories("/data/a/b", ops)).toThrow("EEXIST: mkdir '/data/a'");
    expect(calls).toEqual(["mkdir /data/a", "isDirectory /data/a"]);
  });

  test("the walk stops at the root even when nothing reports existing", () => {
    const { ops, calls } = recordingOps(new Set());
    createMissingDirectories("/a", ops);
    expect(calls).toEqual(["mkdir /", "mkdir /a"]);
  });
});

describe("on the real filesystem", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "create-directory-"));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("creates a missing nested folder", () => {
    const target = join(scratch, "one", "two", "three");
    createMissingDirectories(target);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  test("isDirectory answers for a directory, a file and a missing path", () => {
    const file = join(scratch, "file");
    writeFileSync(file, "");
    mkdirSync(join(scratch, "dir"));
    expect(systemDirectoryOps.isDirectory(join(scratch, "dir"))).toBe(true);
    expect(systemDirectoryOps.isDirectory(file)).toBe(false);
    expect(systemDirectoryOps.isDirectory(join(scratch, "missing"))).toBe(false);
  });

  test("a file where a folder should be is refused by the filesystem, and nothing is made below it", () => {
    const file = join(scratch, "blocker");
    writeFileSync(file, "");
    // Windows names it a missing path: a file mid-path fails the open with STATUS_OBJECT_PATH_NOT_FOUND
    // (MS-FSA 2.1.5.1), and libuv, which carries a plain mkdir there for Bun and Node alike, reports ENOENT.
    const refusal = process.platform === "win32" ? "ENOENT" : "ENOTDIR";
    expect(() => createMissingDirectories(join(file, "below"))).toThrow(refusal);
    expect(existsSync(join(file, "below"))).toBe(false);
  });
});

/** Why the Node case cannot run here, or null when it can. */
function missingNodeProc(): string | null {
  if (!existsSync("/proc/self")) return "no /proc on this platform: the hang is procfs-specific";
  if (Bun.which("node") === null) return "no node on PATH: the hang is Node's recursive mkdir";
  return null;
}

/** Below bun's 5s per-test default, so a regression to recursive mkdir fails instead of hanging the suite. */
const NODE_HARD_TIMEOUT_MS = 3_000;

testIf(
  missingNodeProc(),
  "under Node, a folder under /proc is refused at once with ENOENT instead of looping forever",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "create-directory-node-"));
    try {
      const child = join(dir, "child.ts");
      writeFileSync(
        child,
        [
          `import { createMissingDirectories } from ${JSON.stringify(join(import.meta.dir, "../../../src/lib/db/utils/create-directory.ts"))};`,
          `const target = ${JSON.stringify(`/proc/libredb-${process.pid}-${Date.now()}/x`)};`,
          "try { createMissingDirectories(target); console.log(JSON.stringify({ created: true })); }",
          "catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }",
          "",
        ].join("\n"),
      );
      // `.mjs`, so Node reads the child as ESM without asking a package.json above the temp folder.
      const build = await Bun.build({
        entrypoints: [child],
        target: "node",
        format: "esm",
        outdir: dir,
        naming: "[name].mjs",
      });
      if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
      const started = Date.now();
      const run = Bun.spawnSync([Bun.which("node") as string, join(dir, "child.mjs")], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: NODE_HARD_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const elapsed = Date.now() - started;
      const signal = run.signalCode ?? null;
      // stderr explains a failed run only, as in the other Node-child tests: a clean one may carry a Node warning.
      if (run.exitCode !== 0 || signal !== null) {
        throw new Error(
          `The Node child ended with exit code ${run.exitCode} and signal ${signal}: ${run.stderr.toString()}`,
        );
      }
      const outcome = JSON.parse(run.stdout.toString());
      expect(outcome.code).toBe("ENOENT");
      expect(outcome.message).toContain("/proc/libredb-");
      expect(elapsed).toBeLessThan(NODE_HARD_TIMEOUT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
