/**
 * Unit test for the standalone tarball layout fix (issue #133): the release
 * tarball must extract under a top-level `libredb-studio-<version>/` root
 * instead of spilling its ~50 files into the caller's current directory
 * (a tarbomb). Exercises the real `scripts/lib/pack-standalone-tarball.sh`
 * as a subprocess against a small fixture payload dir - no full `bun run
 * build` needed, since that script only wraps an already-assembled payload.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeIf,
  missingPosixShell,
  missingUnixTool,
  posixShell,
  resolveUnixTool,
  testIf,
} from "../helpers/posix-tools";

const SCRIPT = join(import.meta.dir, "../../scripts/lib/pack-standalone-tarball.sh");
const VERSION = "9.9.9";

/*
  Both tools are resolved rather than spawned by bare name: `Bun.spawnSync` THROWS ("Executable not
  found in $PATH", measured in this worktree) when a name does not resolve, and in a PowerShell
  session `bash` either is absent or is WSL's Linux shell, which cannot stat the Win32 temp path
  this hands it. The script itself packs with tar, so listing with tar adds no dependency the
  artifact does not already have; Windows 11 ships bsdtar in System32 and Git for Windows ships GNU
  tar, and both read the .tar.gz this produces.
*/
const SHELL = posixShell("bash");
const TAR = resolveUnixTool("tar");
const CANNOT_PACK = missingPosixShell("bash") ?? missingUnixTool("tar");

/*
  A colon is an ordinary character in a POSIX file name and an impossible one on Windows: NTFS reads
  it as the alternate data stream separator, so `out:1.tar.gz` is not a name Win32 can hold and
  existsSync would go looking for a stream on a file called `out`. Platform rather than a probe, for
  the reason posix-tools gives for MISSING_POSIX_FILE_MODES: a probe that answered "no" on Linux
  would turn a real regression into a skip.
*/
const MISSING_COLON_FILE_NAMES: string | null =
  process.platform === "win32" ? "colon in a file name: NTFS reads ':' as the stream separator" : null;

describeIf(CANNOT_PACK, "scripts/lib/pack-standalone-tarball.sh (#133)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixturePayload(): { root: string; payloadDir: string; tarball: string } {
    const root = mkdtempSync(join(tmpdir(), "pack-standalone-tarball-"));
    fixtureRoots.push(root);
    const payloadDir = join(root, "payload");
    mkdirSync(payloadDir, { recursive: true });
    writeFileSync(join(payloadDir, "server.js"), "// stub");
    mkdirSync(join(payloadDir, "data"));
    return { root, payloadDir, tarball: join(root, "out.tar.gz") };
  }

  /** The archive's entry names. The script's own stderr rides on the assertion: a shell script that
      dies under `set -e` says why there and nowhere else, and an exit code alone names no cause. */
  function listEntries(tarball: string): string[] {
    const list = Bun.spawnSync([TAR!, "tzf", tarball], { stdout: "pipe", stderr: "pipe" });
    expect(list.exitCode, `tar tzf ${tarball} stderr: ${list.stderr.toString()}`).toBe(0);
    return list.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  test("packs the payload under a top-level libredb-studio-<version>/ root", () => {
    const { payloadDir, tarball } = makeFixturePayload();

    const run = Bun.spawnSync([SHELL!, SCRIPT, payloadDir, VERSION, tarball], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, `pack-standalone-tarball.sh stderr: ${run.stderr.toString()}`).toBe(0);

    const entries = listEntries(tarball);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.startsWith(`libredb-studio-${VERSION}/`)).toBe(true);
    }
    expect(entries).toContain(`libredb-studio-${VERSION}/server.js`);
    expect(entries.some((entry) => entry === "./" || entry.startsWith("./"))).toBe(false);
  });

  testIf(MISSING_COLON_FILE_NAMES, "resolves an output path tar would otherwise dial as a remote host", () => {
    const { root, payloadDir } = makeFixturePayload();

    /*
      GNU tar reads a -f argument whose first colon comes before any slash as `host:file` and tries
      to reach that host: measured with tar 1.35, `-f out:1.tar.gz` answers "Cannot connect to out:
      resolve failed" and exits 2 having written nothing. Windows reaches that line through every
      absolute path it has - `C:\payload\out.tar.gz` is `host:file` by the same rule - so a script
      that forwards the caller's path straight to tar breaks for any native caller there. A colon in
      a plain file name is how a machine with no drive letters states the same case; resolving the
      path first is what makes both local.
    */
    const run = Bun.spawnSync([SHELL!, SCRIPT, payloadDir, VERSION, "out:1.tar.gz"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, `pack-standalone-tarball.sh stderr: ${run.stderr.toString()}`).toBe(0);

    const tarball = join(root, "out:1.tar.gz");
    expect(existsSync(tarball)).toBe(true);
    expect(listEntries(tarball)).toContain(`libredb-studio-${VERSION}/server.js`);
  });

  test("rejects a wrong number of arguments", () => {
    const run = Bun.spawnSync([SHELL!, SCRIPT, join(tmpdir(), "x")], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Usage:");
  });
});
