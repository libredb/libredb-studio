import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getManagedConnections, getPendingSeeds } from "@/lib/seed";
import { seedSqliteSampleFile, setSqliteSampleSeedState, SQLITE_SAMPLE_SEED_ID } from "@/lib/seed/sqlite-sample";

const tmpDirs: string[] = [];
function useTempSamplePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-sample-managed-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "sample-employees.db");
  process.env.SQLITE_EMBEDDED_SAMPLE_PATH = file;
  return file;
}

beforeEach(() => {
  setSqliteSampleSeedState("idle");
});

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
  delete process.env.SQLITE_EMBEDDED_SAMPLE;
  delete process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
  delete process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE;
  setSqliteSampleSeedState("idle");
});

describe("getManagedConnections: sqlite embedded sample", () => {
  test("advertises the sample once the seeded file exists", async () => {
    const file = useTempSamplePath();
    await seedSqliteSampleFile(file);

    const conns = await getManagedConnections(["user"]);
    const sample = conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID);
    expect(sample).toBeDefined();
    expect(sample?.type).toBe("sqlite");
    expect(sample?.name).toBe("Sample (Employees)");
    expect(sample?.database).toBe(file);
    expect(sample?.managed).toBe(false);
  });

  test("omits the sample while the file does not exist", async () => {
    useTempSamplePath(); // path set, file never seeded
    const conns = await getManagedConnections(["user"]);
    expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
  });

  test("omits the sample when disabled via env", async () => {
    const file = useTempSamplePath();
    await seedSqliteSampleFile(file);
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";

    const conns = await getManagedConnections(["user"]);
    expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
  });

  test("in test runs, only considers the sample when an explicit path override is set", async () => {
    // No SQLITE_EMBEDDED_SAMPLE_PATH: a real ./data/sample-employees.db (if any)
    // must not perturb unrelated suites — mirrors the libredb sample guard.
    const conns = await getManagedConnections(["user"]);
    expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
  });
});

describe("getPendingSeeds", () => {
  test("reports the sqlite sample only while seeding is in flight", () => {
    expect(getPendingSeeds()).toEqual([]);
    setSqliteSampleSeedState("seeding");
    expect(getPendingSeeds()).toEqual([SQLITE_SAMPLE_SEED_ID]);
    setSqliteSampleSeedState("done");
    expect(getPendingSeeds()).toEqual([]);
    setSqliteSampleSeedState("failed");
    expect(getPendingSeeds()).toEqual([]);
  });

  test("reports nothing while seeding if the sample is disabled", () => {
    setSqliteSampleSeedState("seeding");
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(getPendingSeeds()).toEqual([]);
  });
});
