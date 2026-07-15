/**
 * Unit tests for the win32 flat-zip packer (issue #114):
 * scripts/lib/pack-standalone-zip.sh must produce a zip whose entries sit at
 * the archive root (server.js, .next/, ...) with NO libredb-studio-<version>/
 * wrapper - winget resolves NestedInstallerFiles.RelativeFilePath against the
 * zip root and `wingetcreate update` never rewrites that path, so a versioned
 * wrapper would break every subsequent release. Exercises the real script as
 * a subprocess against a small fixture payload (mirrors
 * packaging-standalone-tarball.test.ts; 7z is preinstalled on the CI runners).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/lib/pack-standalone-zip.sh");

function listZipEntries(zipPath: string): string[] {
  const list = Bun.spawnSync(["7z", "l", "-ba", "-slt", zipPath], { stdout: "pipe", stderr: "pipe" });
  expect(list.exitCode).toBe(0);
  return list.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length).trim())
    .filter(Boolean);
}

describe("scripts/lib/pack-standalone-zip.sh (#114)", () => {
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

    const run = Bun.spawnSync(["bash", SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
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

    const run = Bun.spawnSync(["bash", SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    expect(listZipEntries(zip)).toContain("server.js");
  });

  test("refuses a payload missing a required root entry (server.js)", () => {
    const { payloadDir, zip } = makeFixturePayload();
    rmSync(join(payloadDir, "server.js"));

    const run = Bun.spawnSync(["bash", SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("server.js");
  });

  test("matches required entries as fixed strings, not regexes (serverXjs must not satisfy server.js)", () => {
    const { payloadDir, zip } = makeFixturePayload();
    rmSync(join(payloadDir, "server.js"));
    writeFileSync(join(payloadDir, "serverXjs"), "// imposter");

    const run = Bun.spawnSync(["bash", SCRIPT, payloadDir, zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("server.js");
  });

  test("fails loudly for a missing payload directory", () => {
    const { root, zip } = makeFixturePayload();

    const run = Bun.spawnSync(["bash", SCRIPT, join(root, "nope"), zip], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Payload dir not found");
  });

  test("rejects wrong usage", () => {
    const run = Bun.spawnSync(["bash", SCRIPT, "only-one-arg"], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Usage:");
  });
});
