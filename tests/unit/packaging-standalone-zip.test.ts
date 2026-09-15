/**
 * Unit tests for the win32 flat-zip packer (issue #114):
 * scripts/lib/pack-standalone-zip.sh must produce a zip whose entries sit at
 * the archive root (server.js, .next/, ...) with NO libredb-studio-<version>/
 * wrapper - winget resolves NestedInstallerFiles.RelativeFilePath against the
 * zip root and `wingetcreate update` never rewrites that path, so a versioned
 * wrapper would break every subsequent release. Exercises the real script as
 * a subprocess against a small fixture payload (mirrors
 * packaging-standalone-tarball.test.ts), and reads the archive it produced in
 * process, so only the packing side depends on 7-Zip.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeIf, missingPosixShell, missingUnixTool, posixShell } from "../helpers/posix-tools";

const SCRIPT = join(import.meta.dir, "../../scripts/lib/pack-standalone-zip.sh");

/*
  Packing needs the shell and 7-Zip; READING the result does not, and used to anyway.

  `Bun.spawnSync(["7z", ...])` THROWS ("Executable not found in $PATH", measured in this worktree)
  rather than returning a non-zero exit code, so on a fresh clone with no 7-Zip - a stock macOS or
  Windows machine - every test in this file died at its first listing. The layout contract (#114) is
  what these tests protect, so the listing is now read from the archive's own central directory and
  only the packing side is gated, on the same two places the script itself looks for 7-Zip.
*/
const SHELL = posixShell("bash");
const SEVENZIP_WINDOWS_DEFAULT = "C:/Program Files/7-Zip/7z.exe";
const CANNOT_PACK = missingPosixShell("bash") ?? (existsSync(SEVENZIP_WINDOWS_DEFAULT) ? null : missingUnixTool("7z"));

/**
 * The archive's entry names, read from its end-of-central-directory record.
 *
 * Directory entries are returned without the trailing "/" the zip format marks them with, because
 * the contract under test is the PATH an installer resolves (`.next/BUILD_ID` under `.next`), not
 * how the archiver spells a directory - `7z l`, which this replaced, prints them unmarked too.
 */
function listZipEntries(zipPath: string): string[] {
  const zip = readFileSync(zipPath);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error(`${zipPath}: no end-of-central-directory record, so this is not a zip`);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`${zipPath}: central directory entry ${index} does not start with its signature`);
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    names.push(zip.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\/$/, ""));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describeIf(CANNOT_PACK, "scripts/lib/pack-standalone-zip.sh (#114)", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeFixturePayload(): { root: string; payloadDir: string; zip: string } {
    const root = mkdtempSync(join(tmpdir(), "pack-standalone-zip-"));
    fixtureRoots.push(root);
    const payloadDir = join(root, "payload");
    mkdirSync(join(payloadDir, ".next"), { recursive: true });
    mkdirSync(join(payloadDir, "data"), { recursive: true });
    writeFileSync(join(payloadDir, "server.js"), "// stub");
    writeFileSync(join(payloadDir, "package.json"), "{}");
    writeFileSync(join(payloadDir, ".next", "BUILD_ID"), "stub-build");
    return { root, payloadDir, zip: join(root, "out.zip") };
  }

  test("packs the payload contents FLAT at the archive root, including dot-directories", () => {
    const { payloadDir, zip } = makeFixturePayload();

    const run = Bun.spawnSync([SHELL!, SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);

    const entries = listZipEntries(zip).map((entry) => entry.replaceAll("\\", "/"));
    expect(entries).toContain("server.js");
    expect(entries).toContain("package.json");
    expect(entries).toContain(".next");
    expect(entries).toContain(".next/BUILD_ID");
    // Flat contract: nothing may hide under a versioned wrapper root.
    for (const entry of entries) {
      expect(entry.startsWith("libredb-studio-")).toBe(false);
      expect(entry.startsWith("payload/")).toBe(false);
    }
  });

  test("overwrites a stale zip at the output path", () => {
    const { payloadDir, zip } = makeFixturePayload();
    writeFileSync(zip, "not a zip");

    const run = Bun.spawnSync([SHELL!, SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    expect(listZipEntries(zip)).toContain("server.js");
  });

  test("refuses a payload missing a required root entry (server.js)", () => {
    const { payloadDir, zip } = makeFixturePayload();
    rmSync(join(payloadDir, "server.js"));

    const run = Bun.spawnSync([SHELL!, SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("server.js");
  });

  test("matches required entries as fixed strings, not regexes (serverXjs must not satisfy server.js)", () => {
    const { payloadDir, zip } = makeFixturePayload();
    rmSync(join(payloadDir, "server.js"));
    writeFileSync(join(payloadDir, "serverXjs"), "// imposter");

    const run = Bun.spawnSync([SHELL!, SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("server.js");
  });

  test("fails loudly for a missing payload directory", () => {
    const { root, zip } = makeFixturePayload();

    const run = Bun.spawnSync([SHELL!, SCRIPT, join(root, "nope"), zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Payload dir not found");
  });

  test("rejects wrong usage", () => {
    const run = Bun.spawnSync([SHELL!, SCRIPT, "only-one-arg"], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Usage:");
  });
});
