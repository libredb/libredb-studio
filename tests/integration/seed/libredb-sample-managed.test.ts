import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getManagedConnections, getPendingSeeds, getUnavailableSamples } from "@/lib/seed";
import { resetSampleSeedStates, setSampleSeedState, startSampleSeeding, unavailableSentence } from "@/lib/seed/samples";

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
  test("includes the sample when enabled and the file exists", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, ""); // file exists
    const conns = await getManagedConnections(["*"]);
    const sample = conns.find((c) => c.seedId === SAMPLE_SEED_ID);
    expect(sample).toBeDefined();
    expect(sample?.managed).toBe(false);
    expect(sample?.type).toBe("libredb");
    expect(sample?.database).toBe(file);
  });

  test("excludes the sample when the file is absent", async () => {
    useTempSamplePath(); // env points at a path, but no file created
    const conns = await getManagedConnections(["*"]);
    expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
  });

  test("excludes the sample when disabled", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    const conns = await getManagedConnections(["*"]);
    expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
  });

  // Rancher mode: no review gates the sample, so with the review on it is listed to no one by default.
  test("excludes the sample for every role when the access review is on", async () => {
    useTempSamplePath();
    fs.writeFileSync(file, "");
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
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

describe("both samples while they copy, and after a copy fails", () => {
  test("both samples are pending while they copy", () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tempDir(), "sample-employees.db");
    useTempSamplePath();
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
    useTempSamplePath();
    fs.writeFileSync(file, "");
    setSampleSeedState(SAMPLE_SEED_ID, {
      phase: "failed",
      reason: "copy-failed",
      sentence: unavailableSentence("copy-failed"),
    });
    expect(getUnavailableSamples(["user"])).toEqual([]);
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toContain(SAMPLE_SEED_ID);
  });

  test("in a test run a sample without its path override is never unavailable", () => {
    setSampleSeedState(SAMPLE_SEED_ID, {
      phase: "failed",
      reason: "asset-missing",
      sentence: unavailableSentence("asset-missing"),
    });
    expect(getUnavailableSamples(["admin"])).toEqual([]);
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
