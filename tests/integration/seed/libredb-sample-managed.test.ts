import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type LogContext, logger } from "@/lib/logger";
import { getManagedConnections, getPendingSeeds, getUnavailableSamples } from "@/lib/seed";
import {
  getSampleSeedState,
  resetSampleSeedStates,
  setSampleSeedState,
  startSampleSeeding,
  unavailableSentence,
} from "@/lib/seed/samples";
import { seedSamples } from "../../helpers/sample-seeding";

const SAMPLE_SEED_ID = "libredb-embedded-sample";
const SQLITE_SAMPLE_SEED_ID = "sqlite-embedded-sample";

const ENV_KEYS = [
  "LIBREDB_EMBEDDED_SAMPLE",
  "LIBREDB_EMBEDDED_SAMPLE_PATH",
  "SQLITE_EMBEDDED_SAMPLE",
  "SQLITE_EMBEDDED_SAMPLE_PATH",
  "KUBERNETES_ACCESS_REVIEW",
  "LIBREDB_ENABLED_PROVIDERS",
  "SEED_ASSETS_DIR",
] as const;

let file: string;
const tmpDirs: string[] = [];

beforeEach(() => {
  resetSampleSeedStates();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
  resetSampleSeedStates();
});

function tempDir(): string {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-mc-"));
  tmpDirs.push(dir);
  return dir;
}

function useTempSamplePath(): void {
  file = path.join(tempDir(), "sample.libredb");
  process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = file;
}

describe("getManagedConnections — embedded sample", () => {
  beforeEach(() => {
    // These cases are about the LibreDB sample alone.
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
  });

  test("includes the sample when enabled and the file exists", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, ""); // file exists
    await seedSamples();
    const conns = await getManagedConnections(["*"]);
    const sample = conns.find((c) => c.seedId === SAMPLE_SEED_ID);
    expect(sample).toBeDefined();
    expect(sample?.managed).toBe(false);
    expect(sample?.type).toBe("libredb");
    expect(sample?.database).toBe(file);
  });

  test("excludes the sample when the file is absent, and lists it unavailable", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    await seedSamples();
    // Admitted at boot, but the listing checks the file on every request.
    fs.rmSync(file);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const conns = await getManagedConnections(["*"]);
      expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
      expect(getUnavailableSamples(["*"]).map(({ seedId, reason }) => [seedId, reason])).toEqual([
        [SAMPLE_SEED_ID, "target-lost"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("excludes the sample when disabled", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    await seedSamples();
    const conns = await getManagedConnections(["*"]);
    expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
  });

  // Rancher mode: no review gates the sample, so with the review on it is listed to no one by default.
  test("excludes the sample for every role when the access review is on", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    await seedSamples();
    for (const roles of [["*"], ["user"], ["admin"]]) {
      const conns = await getManagedConnections(roles);
      expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
    }
  });

  test("includes the sample with the access review on when LIBREDB_EMBEDDED_SAMPLE is true", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    await seedSamples();
    const conns = await getManagedConnections(["user"]);
    expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeDefined();
  });

  test("with LIBREDB_ENABLED_PROVIDERS=sqlite no LibreDB sample is seeded, listed, pending or unavailable", async () => {
    useTempSamplePath();
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite";
    await startSampleSeeding();
    expect(fs.existsSync(file)).toBe(false);
    // A file put there by hand is not listed either: the factory could never open it.
    fs.writeFileSync(file, "");
    expect((await getManagedConnections(["admin"])).find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
    setSampleSeedState(SAMPLE_SEED_ID, { phase: "seeding" });
    expect(getPendingSeeds()).toEqual([]);
    setSampleSeedState(SAMPLE_SEED_ID, {
      phase: "failed",
      reason: "asset-missing",
      sentence: unavailableSentence("asset-missing"),
    });
    expect(getUnavailableSamples(["admin"])).toEqual([]);
  });
});

describe("the samples a listing offers are the ones boot admitted", () => {
  test("a process that never started seeding offers no sample, even when both files exist", async () => {
    const sqliteFile = path.join(tempDir(), "sample-employees.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
    useTempSamplePath();
    fs.writeFileSync(sqliteFile, "");
    fs.writeFileSync(file, "");
    setSampleSeedState(SAMPLE_SEED_ID, { phase: "seeding" });

    expect((await getManagedConnections(["admin"])).filter((c) => c.seedId.endsWith("-embedded-sample"))).toEqual([]);
    expect(getPendingSeeds()).toEqual([]);
    expect(getUnavailableSamples(["admin"])).toEqual([]);
  });

  test("a change to the environment after seeding changes neither what is listed nor where, nor what is pending", async () => {
    const sqliteFile = path.join(tempDir(), "sample-employees.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
    useTempSamplePath();
    fs.writeFileSync(sqliteFile, "");
    fs.writeFileSync(file, "");
    await startSampleSeeding();

    const elsewhere = path.join(tempDir(), "elsewhere.libredb");
    fs.writeFileSync(elsewhere, "");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = elsewhere;
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres";

    const listed = (await getManagedConnections(["admin"]))
      .filter((c) => c.seedId.endsWith("-embedded-sample"))
      .map((c) => [c.seedId, c.database]);
    expect(listed).toEqual([
      [SQLITE_SAMPLE_SEED_ID, sqliteFile],
      [SAMPLE_SEED_ID, file],
    ]);
    setSampleSeedState(SAMPLE_SEED_ID, { phase: "seeding" });
    expect(getPendingSeeds()).toEqual([SAMPLE_SEED_ID]);
  });

  test("a sample boot found unavailable stays unavailable after the environment changes", async () => {
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    useTempSamplePath();
    process.env.SEED_ASSETS_DIR = tempDir(); // empty: the asset is missing
    await startSampleSeeding();

    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";

    expect(getUnavailableSamples(["user"])).toEqual([
      {
        seedId: SAMPLE_SEED_ID,
        name: "Sample (LibreDB)",
        reason: "asset-missing",
        sentence: unavailableSentence("asset-missing"),
      },
    ]);
  });
});

describe("a sample whose file is lost after boot", () => {
  beforeEach(() => {
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
  });

  /** The unavailable warnings about this sample, as [reason, target]. */
  function lostWarnings(warn: { mock: { calls: [string, LogContext?][] } }): unknown[][] {
    return warn.mock.calls
      .filter(([message, context]) => message === "Embedded sample unavailable" && context?.seedId === SAMPLE_SEED_ID)
      .map(([, context]) => [context?.reason, context?.target]);
  }

  test("a removed file is listed unavailable as target-lost naming ENOENT, logged once, and listed again once it is back", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    await seedSamples();
    expect(getSampleSeedState(SAMPLE_SEED_ID)).toEqual({ phase: "done" });
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toContain(SAMPLE_SEED_ID);

    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      fs.rmSync(file);
      const lost = {
        seedId: SAMPLE_SEED_ID,
        name: "Sample (LibreDB)",
        reason: "target-lost" as const,
        sentence: unavailableSentence("target-lost", "ENOENT"),
      };
      expect((await getManagedConnections(["user"])).map((c) => c.seedId)).not.toContain(SAMPLE_SEED_ID);
      expect(getUnavailableSamples(["user"])).toEqual([lost]);
      expect(getUnavailableSamples(["admin"])).toEqual([lost]);
      expect(getPendingSeeds()).toEqual([]);
      expect(lostWarnings(warn)).toEqual([["target-lost", file]]);
      expect(String(warn.mock.calls[0]?.[1]?.error)).toContain("ENOENT");

      // Back again: listed, not unavailable.
      fs.writeFileSync(file, "");
      expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toContain(SAMPLE_SEED_ID);
      expect(getUnavailableSamples(["user"])).toEqual([]);

      // Gone again: unavailable, and the process does not log it a second time.
      fs.rmSync(file);
      expect(getUnavailableSamples(["user"])).toEqual([lost]);
      expect((await getManagedConnections(["user"])).map((c) => c.seedId)).not.toContain(SAMPLE_SEED_ID);
      expect(lostWarnings(warn)).toEqual([["target-lost", file]]);
    } finally {
      warn.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a file in a directory the server can no longer search is listed unavailable as target-lost naming EACCES (POSIX, not root)",
    async () => {
      useTempSamplePath();
      fs.writeFileSync(file, "");
      await seedSamples();
      const directory = path.dirname(file);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      fs.chmodSync(directory, 0o000);
      try {
        expect((await getManagedConnections(["admin"])).map((c) => c.seedId)).not.toContain(SAMPLE_SEED_ID);
        expect(getUnavailableSamples(["admin"])).toEqual([
          {
            seedId: SAMPLE_SEED_ID,
            name: "Sample (LibreDB)",
            reason: "target-lost",
            sentence: unavailableSentence("target-lost", "EACCES"),
          },
        ]);
        expect(lostWarnings(warn)).toEqual([["target-lost", file]]);
      } finally {
        fs.chmodSync(directory, 0o700);
        warn.mockRestore();
      }
    },
  );

  test("a sample still copying, or whose copy failed, has no file to lose", async () => {
    useTempSamplePath();
    process.env.SEED_ASSETS_DIR = tempDir(); // empty: the asset is missing
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await startSampleSeeding();
      expect(getUnavailableSamples(["user"]).map(({ reason }) => reason)).toEqual(["asset-missing"]);
      setSampleSeedState(SAMPLE_SEED_ID, { phase: "seeding" });
      expect(getUnavailableSamples(["user"])).toEqual([]);
      expect((await getManagedConnections(["user"])).map((c) => c.seedId)).not.toContain(SAMPLE_SEED_ID);
      expect(getSampleSeedState(SAMPLE_SEED_ID)).toEqual({ phase: "seeding" });
      expect(lostWarnings(warn)).toEqual([["asset-missing", file]]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("both samples while they copy, and after a copy fails", () => {
  test("both samples are pending while they copy", async () => {
    const sqliteFile = path.join(tempDir(), "sample-employees.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
    useTempSamplePath();
    fs.writeFileSync(sqliteFile, "");
    fs.writeFileSync(file, "");
    await seedSamples();
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "seeding" });
    setSampleSeedState(SAMPLE_SEED_ID, { phase: "seeding" });
    expect(getPendingSeeds()).toEqual([SQLITE_SAMPLE_SEED_ID, SAMPLE_SEED_ID]);
    setSampleSeedState(SQLITE_SAMPLE_SEED_ID, { phase: "done" });
    expect(getPendingSeeds()).toEqual([SAMPLE_SEED_ID]);
  });

  test("a failed sample is listed unavailable for the roles it is offered to", async () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tempDir(), "sample-employees.db");
    useTempSamplePath();
    process.env.SEED_ASSETS_DIR = tempDir(); // empty: both assets are missing
    await startSampleSeeding();

    const failed = (seedId: string, name: string) => ({
      seedId,
      name,
      reason: "asset-missing" as const,
      sentence: unavailableSentence("asset-missing"),
    });
    expect(getPendingSeeds()).toEqual([]);
    expect(getUnavailableSamples(["admin"])).toEqual([
      failed(SQLITE_SAMPLE_SEED_ID, "Sample (Employees)"),
      failed(SAMPLE_SEED_ID, "Sample (LibreDB)"),
    ]);
    expect(getUnavailableSamples(["user"])).toEqual([failed(SAMPLE_SEED_ID, "Sample (LibreDB)")]);
    // Never a connection: no picker, route or MCP tool can reach a sample that has no file.
    expect((await getManagedConnections(["admin"])).filter((c) => c.seedId.endsWith("-embedded-sample"))).toEqual([]);
  });

  test("a sample whose file exists is listed, not unavailable, whatever its state says", async () => {
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    useTempSamplePath();
    fs.writeFileSync(file, "");
    await seedSamples();
    setSampleSeedState(SAMPLE_SEED_ID, {
      phase: "failed",
      reason: "copy-failed",
      sentence: unavailableSentence("copy-failed"),
    });
    expect(getUnavailableSamples(["user"])).toEqual([]);
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toContain(SAMPLE_SEED_ID);
  });

  test("in a test run a sample without its path override is never unavailable", async () => {
    // Seeded into a data directory of this test's own from an empty assets directory, so both copies fail.
    const savedStorage = process.env.STORAGE_SQLITE_PATH;
    process.env.STORAGE_SQLITE_PATH = path.join(tempDir(), "libredb-storage.db");
    process.env.SEED_ASSETS_DIR = tempDir();
    try {
      await startSampleSeeding();
      expect(getSampleSeedState(SAMPLE_SEED_ID)?.phase).toBe("failed");
      expect(getUnavailableSamples(["admin"])).toEqual([]);
    } finally {
      if (savedStorage === undefined) delete process.env.STORAGE_SQLITE_PATH;
      else process.env.STORAGE_SQLITE_PATH = savedStorage;
    }
  });

  test("a target refused at admission is never listed although its file exists, and is listed unavailable", async () => {
    const shared = path.join(tempDir(), "one.db");
    fs.writeFileSync(shared, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = shared;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = shared;
    await startSampleSeeding();
    expect((await getManagedConnections(["admin"])).map((c) => c.seedId)).toEqual([SQLITE_SAMPLE_SEED_ID]);
    expect(getUnavailableSamples(["user"])).toEqual([
      {
        seedId: SAMPLE_SEED_ID,
        name: "Sample (LibreDB)",
        reason: "target-conflict",
        sentence: unavailableSentence("target-conflict"),
      },
    ]);
  });
});
