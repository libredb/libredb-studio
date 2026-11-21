import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "@/lib/logger";
import { getManagedConnections, getPendingSeeds, getUnavailableSamples } from "@/lib/seed";
import { resetSampleSeedStates, setSampleSeedState, startSampleSeeding, unavailableSentence } from "@/lib/seed/samples";
import { seedSamples } from "../../helpers/sample-seeding";

const SQLITE_SAMPLE_SEED_ID = "sqlite-embedded-sample";
const LIBREDB_SAMPLE_SEED_ID = "libredb-embedded-sample";

/*
  A sample path that runs through a regular file is a path the admission cannot check on POSIX, which reports it as
  ENOTDIR, so the sample is refused target-unreadable. Windows reports the same path as absent (ENOENT), so the
  admission lets it through and its copy fails at the mkdir instead, as copy-failed with EEXIST. Both are a failed
  sample listed unavailable with its reason and code while the rest goes on, which is what the test below holds.
*/
const UNCHECKABLE_PATH =
  process.platform === "win32"
    ? ({ reason: "copy-failed", code: "EEXIST" } as const)
    : ({ reason: "target-unreadable", code: "ENOTDIR" } as const);

/** A file at the sample's path: the listing reads only that it exists, never its content. */
function writeSampleFile(file: string): void {
  fs.writeFileSync(file, "");
}

const tmpDirs: string[] = [];
function useTempSamplePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-sample-managed-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "sample-employees.db");
  process.env.SQLITE_EMBEDDED_SAMPLE_PATH = file;
  return file;
}

beforeEach(() => {
  resetSampleSeedStates();
  // This file is about the SQLite sample: the LibreDB one is off unless a test sets its path and turns it back on.
  process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
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
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
  resetSampleSeedStates();
});

describe("getManagedConnections: sqlite embedded sample", () => {
  test("advertises the sample once the seeded file exists", async () => {
    const file = useTempSamplePath();
    writeSampleFile(file);
    await seedSamples();

    const conns = await getManagedConnections(["admin"]);
    const sample = conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID);
    expect(sample).toBeDefined();
    expect(sample?.type).toBe("sqlite");
    expect(sample?.name).toBe("Sample (Employees)");
    expect(sample?.database).toBe(file);
    expect(sample?.managed).toBe(false);
  });

  test("neither lists nor reports pending a sample the enabled providers leave out", async () => {
    const file = useTempSamplePath();
    writeSampleFile(file);
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres";
    await seedSamples();
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "seeding" });

    const conns = await getManagedConnections(["admin"]);

    expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
    expect(getPendingSeeds()).toEqual([]);
  });

  test("with LIBREDB_ENABLED_PROVIDERS=libredb no SQLite sample is seeded, listed, pending or unavailable", async () => {
    const file = useTempSamplePath();
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.LIBREDB_ENABLED_PROVIDERS = "libredb";
    await startSampleSeeding();
    expect(fs.existsSync(file)).toBe(false);
    writeSampleFile(file);
    expect((await getManagedConnections(["admin"])).find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "seeding" });
    expect(getPendingSeeds()).toEqual([]);
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, {
      phase: "failed",
      reason: "copy-failed",
      sentence: unavailableSentence("copy-failed"),
    });
    expect(getUnavailableSamples(["admin"])).toEqual([]);
  });

  test("a target that names the storage database is refused, never listed although the file exists, and unavailable", async () => {
    const storage = useTempSamplePath();
    writeSampleFile(storage);
    const savedStorage = process.env.STORAGE_SQLITE_PATH;
    process.env.STORAGE_SQLITE_PATH = storage;
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    try {
      await startSampleSeeding();
      expect((await getManagedConnections(["admin"])).find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
      expect(getUnavailableSamples(["admin"])).toEqual([
        {
          seedId: SQLITE_SAMPLE_SEED_ID,
          name: "Sample (Employees)",
          reason: "target-reserved",
          sentence: unavailableSentence("target-reserved"),
        },
      ]);
      expect(getUnavailableSamples(["user"])).toEqual([]);
    } finally {
      if (savedStorage === undefined) delete process.env.STORAGE_SQLITE_PATH;
      else process.env.STORAGE_SQLITE_PATH = savedStorage;
    }
  });

  test("a target whose path cannot be checked is unavailable, and every listing still answers for every role", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-sample-managed-"));
    tmpDirs.push(dir);
    const blocker = path.join(dir, "a-regular-file");
    writeSampleFile(blocker);
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(blocker, "sample-employees.db");
    const libredbFile = path.join(dir, "sample.libredb");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    const savedAssets = process.env.SEED_ASSETS_DIR;
    process.env.SEED_ASSETS_DIR = path.resolve(import.meta.dir, "../../../seed-assets");
    try {
      await startSampleSeeding();
      expect(fs.existsSync(libredbFile)).toBe(true);
      expect((await getManagedConnections(["admin"])).map((c) => c.seedId)).toEqual([LIBREDB_SAMPLE_SEED_ID]);
      expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toEqual([LIBREDB_SAMPLE_SEED_ID]);
      expect(getPendingSeeds()).toEqual([]);
      expect(getUnavailableSamples(["admin"])).toEqual([
        {
          seedId: SQLITE_SAMPLE_SEED_ID,
          name: "Sample (Employees)",
          reason: UNCHECKABLE_PATH.reason,
          sentence: unavailableSentence(UNCHECKABLE_PATH.reason, UNCHECKABLE_PATH.code),
        },
      ]);
      expect(getUnavailableSamples(["user"])).toEqual([]);
    } finally {
      if (savedAssets === undefined) delete process.env.SEED_ASSETS_DIR;
      else process.env.SEED_ASSETS_DIR = savedAssets;
    }
  });

  /*
    Order is the default connection. `useConnectionManager` selects the first merged
    connection when no active id is persisted, so whichever sample leads is what a
    brand-new user lands on, and the agent runtime executes on the engines
    `AGENT_EXECUTION_ENGINES` lists, not on the LibreDB engine, whose provider implements no
    read-only statement path.
    Leading with LibreDB put every zero-config user on the one connection the agent
    can never run against, and it took a real run to notice.

    An operator's own seed config still leads: those are appended before either
    sample, so this only decides which of the two built-ins comes first.
  */
  test("leads the built-in samples, so a first run lands on an engine the agent supports", async () => {
    const sqliteFile = useTempSamplePath();
    writeSampleFile(sqliteFile);

    const libredbDir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-sample-order-"));
    tmpDirs.push(libredbDir);
    const libredbFile = path.join(libredbDir, "sample.libredb");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    fs.writeFileSync(libredbFile, "");
    await seedSamples();

    const seedIds = (await getManagedConnections(["admin"])).map((c) => c.seedId);
    expect(seedIds).toContain(LIBREDB_SAMPLE_SEED_ID);
    expect(seedIds.indexOf(SQLITE_SAMPLE_SEED_ID)).toBeLessThan(seedIds.indexOf(LIBREDB_SAMPLE_SEED_ID));
  });

  test("omits the sample while the file does not exist, and lists it unavailable", async () => {
    const file = useTempSamplePath();
    writeSampleFile(file);
    await seedSamples();
    // Admitted at boot, but the listing checks the file on every request.
    fs.rmSync(file);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const conns = await getManagedConnections(["admin"]);
      expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
      expect(getUnavailableSamples(["admin"]).map(({ seedId, reason }) => [seedId, reason])).toEqual([
        [SQLITE_SAMPLE_SEED_ID, "target-lost"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("omits the sample when disabled via env", async () => {
    const file = useTempSamplePath();
    writeSampleFile(file);
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    await seedSamples();

    const conns = await getManagedConnections(["admin"]);
    expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
  });

  test("in test runs, only considers the sample when an explicit path override is set", async () => {
    // No SQLITE_EMBEDDED_SAMPLE_PATH: a real ./data/sample-employees.db (if any)
    // must not perturb unrelated suites — mirrors the libredb sample guard.
    // Seeded into a data directory of this test's own, with the file at the default target.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-sample-managed-"));
    tmpDirs.push(dataDir);
    writeSampleFile(path.join(dataDir, "sample-employees.db"));
    const savedStorage = process.env.STORAGE_SQLITE_PATH;
    process.env.STORAGE_SQLITE_PATH = path.join(dataDir, "libredb-storage.db");
    try {
      await startSampleSeeding();
      const conns = await getManagedConnections(["admin"]);
      expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
    } finally {
      if (savedStorage === undefined) delete process.env.STORAGE_SQLITE_PATH;
      else process.env.STORAGE_SQLITE_PATH = savedStorage;
    }
  });
});

describe("getPendingSeeds", () => {
  test("reports the sqlite sample only while seeding is in flight", async () => {
    writeSampleFile(useTempSamplePath());
    await seedSamples();
    expect(getPendingSeeds()).toEqual([]);
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "seeding" });
    expect(getPendingSeeds()).toEqual([SQLITE_SAMPLE_SEED_ID]);
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "done" });
    expect(getPendingSeeds()).toEqual([]);
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, {
      phase: "failed",
      reason: "copy-failed",
      sentence: unavailableSentence("copy-failed"),
    });
    expect(getPendingSeeds()).toEqual([]);
  });

  test("reports nothing while seeding if the sample is disabled", async () => {
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    await seedSamples();
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "seeding" });
    expect(getPendingSeeds()).toEqual([]);
  });
});

test("the SQLite sample is omitted for non-admin roles", async () => {
  const file = useTempSamplePath();
  writeSampleFile(file);
  await seedSamples();
  for (const roles of [["user"], ["*"], []]) {
    expect((await getManagedConnections(roles)).find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)).toBeUndefined();
  }
});
