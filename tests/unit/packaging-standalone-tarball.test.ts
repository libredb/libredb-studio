/**
 * Unit test for the standalone tarball layout fix (issue #133): the release
 * tarball must extract under a top-level `libredb-studio-<version>/` root
 * instead of spilling its ~50 files into the caller's current directory
 * (a tarbomb). Exercises the real `scripts/lib/pack-standalone-tarball.sh`
 * as a subprocess against a small fixture payload dir - no full `bun run
 * build` needed, since that script only wraps an already-assembled payload.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/lib/pack-standalone-tarball.sh");
const VERSION = "9.9.9";

describe("scripts/lib/pack-standalone-tarball.sh (#133)", () => {
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

  test("packs the payload under a top-level libredb-studio-<version>/ root", () => {
    const { payloadDir, tarball } = makeFixturePayload();

    const run = Bun.spawnSync(["bash", SCRIPT, payloadDir, VERSION, tarball], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);

    const list = Bun.spawnSync(["tar", "tzf", tarball], { stdout: "pipe", stderr: "pipe" });
    expect(list.exitCode).toBe(0);
    const entries = list.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.startsWith(`libredb-studio-${VERSION}/`)).toBe(true);
    }
    expect(entries).toContain(`libredb-studio-${VERSION}/server.js`);
    expect(entries.some((entry) => entry === "./" || entry.startsWith("./"))).toBe(false);
  });

  test("rejects a wrong number of arguments", () => {
    const run = Bun.spawnSync(["bash", SCRIPT, "/tmp/x"], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("Usage:");
  });
});
