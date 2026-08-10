import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Closes the gap named in the pull request: the threat suite
 * (tests/security/credential-at-rest.test.ts) proves the DECORATOR never hands plaintext to a
 * provider, using an in-memory CaptureProvider standing in for one. Nothing in `bun run test` or
 * `bun run test:e2e` (which runs with STORAGE_PROVIDER unset) exercises the decorator against a
 * REAL STORAGE_PROVIDER=sqlite file. This does: it bundles the harness for Node (Bun cannot load
 * better-sqlite3) and checks the actual bytes on disk after a write, and the actual read-back
 * after a key rotation.
 */

const nodeSqliteProbe = spawnSync("node", ["-e", "require('better-sqlite3'); process.exit(0)"], { timeout: 30_000 });
const nodeBetterSqliteTestable = nodeSqliteProbe.status === 0;
if (!nodeBetterSqliteTestable) {
  console.warn("Skipping the real-file credential-encryption test: `node` cannot load better-sqlite3 here");
}

describe.skipIf(!nodeBetterSqliteTestable)(
  "credential encryption at rest against a real STORAGE_PROVIDER=sqlite file (posture control 3.1)",
  () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "libredb-storage-sqlite-enc-"));
      // The bundle is `--external better-sqlite3` (a native addon; a bundler cannot inline it),
      // so plain Node module resolution needs a node_modules it can find by walking up from the
      // bundle's own directory. tmpDir sits outside the project tree, so nothing is found without
      // this: a symlink is cheaper and more honest than moving the bundle output into the repo.
      symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(tmpDir, "node_modules"), "dir");
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("a canary password never reaches the file on disk, and a rotated key omits it on read instead of exposing it or crashing", () => {
      const harnessEntry = join(import.meta.dir, "sqlite-credential-encryption-node-harness.ts");
      const bundlePath = join(tmpDir, "sqlite-credential-encryption-node-harness.mjs");
      const dbPath = join(tmpDir, "storage.db");

      const build = spawnSync(
        process.execPath,
        [
          "build",
          harnessEntry,
          "--target=node",
          "--format=esm",
          "--external",
          "better-sqlite3",
          "--outfile",
          bundlePath,
        ],
        { timeout: 60_000 },
      );
      if (build.status !== 0) {
        throw new Error(`bun build failed: ${build.stderr?.toString()}`);
      }

      const run = spawnSync("node", [bundlePath, dbPath], { timeout: 60_000 });
      if (run.status !== 0) {
        throw new Error(`node harness failed: ${run.stderr?.toString() || run.stdout?.toString()}`);
      }

      const report = JSON.parse(run.stdout.toString()) as Record<string, unknown>;

      expect(report.runtime).toBe("node");
      expect(existsSync(dbPath)).toBe(true); // a real file-backed database, not an in-memory stand-in

      // The canary is never in the bytes a backup or volume snapshot would actually contain.
      expect(report.canaryInFile).toBe(false);
      expect(report.rowContainsCanary).toBe(false);
      expect(report.rowLooksSealed).toBe(true);

      // A rotated key omits the field on the SAME on-disk file - it does not expose the old
      // password, and it does not crash or drop the record.
      expect(report.survivesRotation).toBe(true);
      expect(report.passwordOmittedAfterRotation).toBe(true);
      expect(report.hostStillReadableAfterRotation).toBe("db.internal");
    });
  },
);
