/**
 * startSampleSeeding when a copy rejects with anything but a SampleCopyError: a defect, since copySampleAsset wraps
 * every failure it knows in one. The sample is set failed `copy-failed` and logged once, so nothing stays pending, and
 * the error itself is rethrown by the seeding promise once every copy has settled. register() does not wait for that
 * promise, so on the server the rethrow is the process's unhandled rejection; bun's test runner fails any test that
 * leaves one, so that last step is not exercised here.
 *
 * Its own file because it replaces copySampleAsset with mock.module, which lasts for the whole process.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@/lib/logger";

const realCopy = { ...(await import("@/lib/seed/sample-copy")) };
/** Each target's rejection; a target without one is copied for real. */
const rejections = new Map<string, unknown>();
const copySampleAsset = mock((pinned: Parameters<typeof realCopy.copySampleAsset>[0], target: string) =>
  rejections.has(target) ? Promise.reject(rejections.get(target)) : realCopy.copySampleAsset(pinned, target),
);
mock.module("@/lib/seed/sample-copy", () => ({ ...realCopy, copySampleAsset }));

const { getPendingSeeds, getUnavailableSamples } = await import("@/lib/seed");
const { getSampleSeedState, resetSampleSeedStates, startSampleSeeding, unavailableSentence } = await import(
  "@/lib/seed/samples"
);

const ROOT = path.resolve(import.meta.dir, "../../..");
const ENV_KEYS = [
  "SQLITE_EMBEDDED_SAMPLE_PATH",
  "LIBREDB_EMBEDDED_SAMPLE_PATH",
  "SEED_ASSETS_DIR",
  "STORAGE_SQLITE_PATH",
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let sqliteFile: string;
let libredbFile: string;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(path.join(tmpdir(), "sample-seeding-defect-"));
  sqliteFile = path.join(dir, "sample-employees.db");
  libredbFile = path.join(dir, "sample.libredb");
  process.env.STORAGE_SQLITE_PATH = path.join(dir, "libredb-storage.db");
  process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteFile;
  process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbFile;
  process.env.SEED_ASSETS_DIR = path.join(ROOT, "seed-assets");
  rejections.clear();
  copySampleAsset.mockClear();
  resetSampleSeedStates();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSampleSeedStates();
  rmSync(dir, { recursive: true, force: true });
});

/** The seeding promise's rejection, or "resolved": settled with a plain await, never through a matcher. */
async function settle(seeding: Promise<void>): Promise<unknown> {
  return seeding.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

describe("a copy that rejects with anything but a SampleCopyError", () => {
  test("sets its sample failed copy-failed, logs it once, and is rethrown once every copy has settled", async () => {
    const defect = new TypeError("a defect in the copy");
    rejections.set(sqliteFile, defect);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await settle(startSampleSeeding())).toBe(defect);

      expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({
        phase: "failed",
        reason: "copy-failed",
        sentence: unavailableSentence("copy-failed"),
      });
      // The other copy settled before the rejection: it is done, not left in flight.
      expect(getSampleSeedState("libredb-embedded-sample")).toEqual({ phase: "done" });
      expect(getPendingSeeds()).toEqual([]);
      expect(getUnavailableSamples(["admin"]).map(({ seedId, reason }) => [seedId, reason])).toEqual([
        ["sqlite-embedded-sample", "copy-failed"],
      ]);
      expect(warn.mock.calls.map(([message, context]) => [message, context?.seedId, context?.reason])).toEqual([
        ["Embedded sample unavailable", "sqlite-embedded-sample", "copy-failed"],
      ]);
      expect(warn.mock.calls[0]?.[1]?.error).toBe("a defect in the copy");
      expect(warn.mock.calls[0]?.[1]?.target).toBe(sqliteFile);
    } finally {
      warn.mockRestore();
    }
  });

  test("two defects reject with an AggregateError holding both, in table order", async () => {
    const first = new TypeError("the first defect");
    const second = new RangeError("the second defect");
    rejections.set(sqliteFile, first);
    rejections.set(libredbFile, second);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const outcome = await settle(startSampleSeeding());
      expect(outcome).toBeInstanceOf(AggregateError);
      expect((outcome as AggregateError).errors).toEqual([first, second]);
      expect(getPendingSeeds()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a SampleCopyError is still read for its reason and never rethrown", async () => {
    rejections.set(sqliteFile, new realCopy.SampleCopyError("asset-missing", "The sample asset is gone."));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await settle(startSampleSeeding())).toBe("resolved");
      expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({
        phase: "failed",
        reason: "asset-missing",
        sentence: unavailableSentence("asset-missing"),
      });
    } finally {
      warn.mockRestore();
    }
  });
});
