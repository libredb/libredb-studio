import { describe, test, expect, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { open, catalog, kv } from "@libredb/libredb";
import {
  isSampleEnabled,
  resolveSamplePath,
  seedSampleFile,
  buildSampleConnection,
  SAMPLE_SEED_ID,
} from "@/lib/seed/libredb-sample";

const tmpDirs: string[] = [];
function tmpPath(): string {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-sample-"));
  tmpDirs.push(dir);
  return path.join(dir, "sample.libredb");
}
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
  delete process.env.GOVERNANCE_SOURCE;
  delete process.env.KUBERNETES_ACCESS_REVIEW;
});

describe("libredb-sample", () => {
  test('isSampleEnabled: default on; only "false" disables', () => {
    expect(isSampleEnabled()).toBe(true);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    expect(isSampleEnabled()).toBe(true);
  });

  // Governance mode offers no sample (docs/GOVERNANCE.md): the boot check refuses a sample switched on, and the
  // switch answers off under governance whatever the variable says, so a bypassed check seeds and lists no sample.
  test("under governance isSampleEnabled() is false although LIBREDB_EMBEDDED_SAMPLE is true", () => {
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(isSampleEnabled()).toBe(false);
    // Unset is on by default, and still off under governance.
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    expect(isSampleEnabled()).toBe(false);
  });

  // With the Kubernetes access review on (Rancher mode), the sample is not offered unless LIBREDB_EMBEDDED_SAMPLE is
  // exactly "true": every signed-in person would see it, and no review gates it, since it names no Secret.
  test("with the access review on isSampleEnabled() is off unless LIBREDB_EMBEDDED_SAMPLE is exactly true", () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "";
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "TRUE";
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    expect(isSampleEnabled()).toBe(true);
    // A switch value Studio does not know counts as on, so the sample stays off.
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    process.env.KUBERNETES_ACCESS_REVIEW = "maybe";
    expect(isSampleEnabled()).toBe(false);
    // Switched off, the default is on again.
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    expect(isSampleEnabled()).toBe(true);
  });

  test("governance wins over an explicit true with the access review on", () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(isSampleEnabled()).toBe(false);
  });

  test("resolveSamplePath: override wins; else derives from data dir", () => {
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = "/custom/x.libredb";
    expect(resolveSamplePath()).toBe("/custom/x.libredb");
    delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
    expect(resolveSamplePath().endsWith(`${path.sep}sample.libredb`)).toBe(true);
  });

  test("seedSampleFile: seeds all three lenses, catalog-aware", async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    expect(fs.existsSync(file)).toBe(true);

    const db = open({ path: file });
    const reg = catalog(db);
    expect(reg.get("users")?.kind).toBe("relational");
    expect(reg.get("articles")?.kind).toBe("document");
    const configKeys = kv(db)
      .prefix("config:")
      .toArray()
      .map((e) => e.key);
    expect(configKeys.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  test("seedSampleFile: survives a stale temp + lock left by a crashed boot with the same pid", async () => {
    // A boot that crashed mid-seed leaves `<file>.<pid>.seeding` AND (since
    // @libredb/libredb 0.2.x) its exclusive-lock sidecar. In Docker a restarted
    // process often reuses the SAME pid (pid 1), so the stale lock reads as a
    // LIVE holder and open() would refuse with LOCKED forever. The temp name is
    // per-pid, so on entry any existing lock on it is necessarily stale and the
    // seeder must clear it.
    const file = tmpPath();
    const tempPath = `${file}.${process.pid}.seeding`;
    fs.writeFileSync(tempPath, "partial junk from a crashed seed");
    fs.writeFileSync(`${tempPath}.lock`, `libredb-lock\n${process.pid}\n${os.hostname()}\ndeadbeef\n`);

    await seedSampleFile(file);

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(`${tempPath}.lock`)).toBe(false);
    const db = open({ path: file });
    expect(catalog(db).get("users")?.kind).toBe("relational");
    db.close();
  });

  test("seedSampleFile: leaves no lock sidecar next to the published sample", async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.existsSync(`${file}.${process.pid}.seeding.lock`)).toBe(false);
  });

  test("seedSampleFile: treats a rename race as success when the sample was published by another worker", async () => {
    const file = tmpPath();
    const realRename = fs.renameSync;
    // Simulate the Windows-style race: another worker publishes the sample
    // first, then our rename throws because the destination already exists.
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (to === file) {
        fs.copyFileSync(from, file);
        throw new Error("EEXIST: file already exists");
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      await seedSampleFile(file);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.${process.pid}.seeding`)).toBe(false);
    expect(fs.existsSync(`${file}.${process.pid}.seeding.lock`)).toBe(false);
  });

  test("seedSampleFile: rethrows a rename failure when no sample was published, leaving no temp", async () => {
    const file = tmpPath();
    const realRename = fs.renameSync;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (to === file) throw new Error("EACCES: simulated rename failure");
      return realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      await expect(seedSampleFile(file)).rejects.toThrow("EACCES: simulated rename failure");
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.${process.pid}.seeding`)).toBe(false);
    expect(fs.existsSync(`${file}.${process.pid}.seeding.lock`)).toBe(false);
  });

  test("seedSampleFile: idempotent — does not modify an existing file", async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    const before = fs.readFileSync(file);
    await seedSampleFile(file);
    const after = fs.readFileSync(file);
    expect(after.equals(before)).toBe(true);
  });

  test("buildSampleConnection: editable libredb seed pointing at the resolved path", () => {
    const conn = buildSampleConnection();
    expect(conn.seedId).toBe(SAMPLE_SEED_ID);
    expect(conn.id).toBe(`seed:${SAMPLE_SEED_ID}`);
    expect(conn.type).toBe("libredb");
    expect(conn.managed).toBe(false);
    expect(conn.roles).toEqual(["*"]);
    expect(conn.name).toBe("Sample (LibreDB)");
    expect(conn.database).toBe(resolveSamplePath());
  });
});
