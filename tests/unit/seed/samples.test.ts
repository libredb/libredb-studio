/**
 * The built-in sample service (src/lib/seed/samples.ts): the SAMPLES table, the one enablement rule every row follows,
 * the targets and their admission, the asset directory, the per-sample seed state, and startSampleSeeding, which
 * copies every enabled, admitted sample and logs each outcome once.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REFUSES_DENIED_FILE_ACCESS } from "@/lib/db/compatibility";
import { logger } from "@/lib/logger";
import {
  getSampleSeedState,
  resetSampleSeedStates,
  sampleAdmissions,
  sampleAssetPath,
  sampleConnection,
  sampleConsidered,
  sampleEnabled,
  SAMPLES,
  sampleTarget,
  seedAssetsDirectory,
  setSampleSeedState,
  startSampleSeeding,
  unavailableSentence,
  type SampleSpec,
} from "@/lib/seed/samples";
import type { DatabaseType } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");

const ENV_KEYS = [
  "GOVERNANCE_SOURCE",
  "KUBERNETES_ACCESS_REVIEW",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "LIBREDB_ENABLED_PROVIDERS",
  "SQLITE_EMBEDDED_SAMPLE",
  "SQLITE_EMBEDDED_SAMPLE_PATH",
  "SQLITE_EMBEDDED_SAMPLE_TEMPLATE",
  "LIBREDB_EMBEDDED_SAMPLE",
  "LIBREDB_EMBEDDED_SAMPLE_PATH",
  "SEED_ASSETS_DIR",
  "STORAGE_SQLITE_PATH",
  "NODE_ENV",
] as const;
const saved: Record<string, string | undefined> = {};
/** process.env with NODE_ENV writable, which the env typings declare read-only. */
const env = process.env as Record<string, string | undefined>;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "samples-"));
  temporaryDirectories.push(directory);
  return directory;
}

function row(type: DatabaseType): SampleSpec {
  const spec = SAMPLES.get(type);
  if (spec === undefined) throw new Error(`no sample row for ${type}`);
  return spec;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete env[key];
  }
  // A data directory of this test's own, so a default target never names the developer's ./data.
  process.env.STORAGE_SQLITE_PATH = path.join(temporaryDirectory(), "libredb-storage.db");
  process.env.SEED_ASSETS_DIR = path.join(ROOT, "seed-assets");
  resetSampleSeedStates();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  resetSampleSeedStates();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("the SAMPLES table", () => {
  test("keeps today's seed ids, names, file names, roles and order", () => {
    expect(
      [...SAMPLES].map(([type, spec]) => ({
        type,
        seedId: spec.seedId,
        name: spec.name,
        fileName: spec.fileName,
        roles: spec.roles,
        switchVariable: spec.switchVariable,
        pathVariable: spec.pathVariable,
      })),
    ).toEqual([
      {
        type: "sqlite",
        seedId: "sqlite-embedded-sample",
        name: "Sample (Employees)",
        fileName: "sample-employees.db",
        roles: ["admin"],
        switchVariable: "SQLITE_EMBEDDED_SAMPLE",
        pathVariable: "SQLITE_EMBEDDED_SAMPLE_PATH",
      },
      {
        type: "libredb",
        seedId: "libredb-embedded-sample",
        name: "Sample (LibreDB)",
        fileName: "sample.libredb",
        roles: ["*"],
        switchVariable: "LIBREDB_EMBEDDED_SAMPLE",
        pathVariable: "LIBREDB_EMBEDDED_SAMPLE_PATH",
      },
    ]);
  });

  test("offers a sample only to administrators exactly when its engine refuses a handle under a denied file-access posture", () => {
    for (const [type, spec] of SAMPLES) {
      expect({ type, roles: spec.roles }).toEqual({
        type,
        roles: REFUSES_DENIED_FILE_ACCESS[type] ? ["admin"] : ["*"],
      });
    }
  });

  test("every asset is a relative path with forward slashes under the asset directory", () => {
    for (const spec of SAMPLES.values()) {
      expect(spec.asset.startsWith("/")).toBe(false);
      expect(spec.asset.includes("\\")).toBe(false);
      expect(spec.asset.split("/").includes("..")).toBe(false);
      expect(sampleAssetPath(spec)).toBe(path.join(ROOT, "seed-assets", ...spec.asset.split("/")));
    }
  });
});

describe("enablement", () => {
  test("default on, only the exact value false turns a row off", () => {
    for (const [type, spec] of SAMPLES) {
      expect(sampleEnabled(type, spec)).toBe(true);
      process.env[spec.switchVariable] = "false";
      expect(sampleEnabled(type, spec)).toBe(false);
      process.env[spec.switchVariable] = "FALSE";
      expect(sampleEnabled(type, spec)).toBe(true);
      process.env[spec.switchVariable] = "TRUE";
      expect(sampleEnabled(type, spec)).toBe(true);
    }
  });

  test("under governance every row is off, whatever its switch says", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    for (const [type, spec] of SAMPLES) {
      expect(sampleEnabled(type, spec)).toBe(false);
      process.env[spec.switchVariable] = "true";
      expect(sampleEnabled(type, spec)).toBe(false);
    }
  });

  test("with the access review on, a row offered beyond admin is on only for the exact value true", () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    expect(sampleEnabled("sqlite", row("sqlite"))).toBe(true);
    expect(sampleEnabled("libredb", row("libredb"))).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "TRUE";
    expect(sampleEnabled("libredb", row("libredb"))).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    expect(sampleEnabled("libredb", row("libredb"))).toBe(true);
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(sampleEnabled("sqlite", row("sqlite"))).toBe(false);
  });

  test("a row is off when LIBREDB_ENABLED_PROVIDERS leaves its engine out or is refused as a whole", () => {
    const enabled = () => [...SAMPLES].filter(([type, spec]) => sampleEnabled(type, spec)).map(([type]) => type);
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite";
    expect(enabled()).toEqual(["sqlite"]);
    process.env.LIBREDB_ENABLED_PROVIDERS = "libredb";
    expect(enabled()).toEqual(["libredb"]);
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres, sqlite ,";
    expect(enabled()).toEqual(["sqlite"]);
    process.env.LIBREDB_ENABLED_PROVIDERS = "  ";
    expect(enabled()).toEqual(["sqlite", "libredb"]);
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite,postgresql";
    expect(enabled()).toEqual([]);
    process.env.LIBREDB_ENABLED_PROVIDERS = " , ,";
    expect(enabled()).toEqual([]);
  });

  test("in a test run a row is considered only when its path override is set", () => {
    env.NODE_ENV = "test";
    expect(sampleConsidered(row("sqlite"))).toBe(false);
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = "/somewhere/sample.db";
    expect(sampleConsidered(row("sqlite"))).toBe(true);
    env.NODE_ENV = "production";
    expect(sampleConsidered(row("libredb"))).toBe(true);
  });
});

describe("targets and their admission", () => {
  test("a target is the path override when set, else the file name in the data directory", () => {
    const dataDir = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    expect(sampleTarget(row("sqlite"))).toBe(path.join(dataDir, "sample-employees.db"));
    expect(sampleTarget(row("libredb"))).toBe(path.join(dataDir, "sample.libredb"));
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = "/custom/x.libredb";
    expect(sampleTarget(row("libredb"))).toBe("/custom/x.libredb");
  });

  test("the default targets and their sidecar families are pairwise disjoint and none is a reserved storage path", () => {
    expect(sampleAdmissions().map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "sqlite", refusal: null },
      { type: "libredb", refusal: null },
    ]);
  });

  test("a target that names the storage database is refused as target-reserved", () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = process.env.STORAGE_SQLITE_PATH;
    expect(sampleAdmissions().map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "sqlite", refusal: "target-reserved" },
      { type: "libredb", refusal: null },
    ]);
    // A sidecar of the storage database is the storage database's too: the sample's -wal names it.
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = "";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(
      path.dirname(process.env.STORAGE_SQLITE_PATH ?? ""),
      "libredb-storage.db-wal",
    );
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-reserved"]);
  });

  test("a second sample on the first one's file is refused as target-conflict", () => {
    const shared = path.join(temporaryDirectory(), "one.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = shared;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = shared;
    expect(sampleAdmissions().map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "sqlite", refusal: null },
      { type: "libredb", refusal: "target-conflict" },
    ]);
    // A target that is another's sidecar conflicts as well.
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = `${shared}-wal`;
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
  });

  test("only enabled rows are admitted, so a disabled row conflicts with nothing", () => {
    const shared = path.join(temporaryDirectory(), "one.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = shared;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = shared;
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(sampleAdmissions().map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "libredb", refusal: null },
    ]);
  });
});

describe("the seed assets directory", () => {
  test("reads the seed assets directory from SEED_ASSETS_DIR, else the working directory's seed-assets", () => {
    process.env.SEED_ASSETS_DIR = "/opt/studio/seed-assets";
    expect(seedAssetsDirectory()).toBe(path.resolve("/opt/studio/seed-assets"));
    process.env.SEED_ASSETS_DIR = "  relative/assets ";
    expect(seedAssetsDirectory()).toBe(path.resolve(process.cwd(), "relative/assets"));
    process.env.SEED_ASSETS_DIR = "   ";
    expect(seedAssetsDirectory()).toBe(path.join(process.cwd(), "seed-assets"));
    delete process.env.SEED_ASSETS_DIR;
    expect(seedAssetsDirectory()).toBe(path.join(process.cwd(), "seed-assets"));
  });

  test("no longer reads SQLITE_EMBEDDED_SAMPLE_TEMPLATE", () => {
    const elsewhere = path.join(temporaryDirectory(), "template.db");
    writeFileSync(elsewhere, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE = elsewhere;
    expect(sampleAssetPath(row("sqlite"))).toBe(path.join(ROOT, "seed-assets", "sqlite", "employee.db"));
  });
});

describe("the seed state and the connection record", () => {
  test("a state is kept per seed id, on the process, until reset", () => {
    expect(getSampleSeedState("sqlite-embedded-sample")).toBeUndefined();
    setSampleSeedState("sqlite-embedded-sample", { phase: "seeding" });
    setSampleSeedState("libredb-embedded-sample", {
      phase: "failed",
      reason: "asset-missing",
      sentence: unavailableSentence("asset-missing"),
    });
    expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({ phase: "seeding" });
    expect(getSampleSeedState("libredb-embedded-sample")?.phase).toBe("failed");
    resetSampleSeedStates();
    expect(getSampleSeedState("sqlite-embedded-sample")).toBeUndefined();
    expect(getSampleSeedState("libredb-embedded-sample")).toBeUndefined();
  });

  test("the connection record is today's: editable, unmanaged, at the target, created at the epoch", () => {
    for (const [type, spec] of SAMPLES) {
      expect(sampleConnection(type, spec)).toEqual({
        id: `seed:${spec.seedId}`,
        seedId: spec.seedId,
        name: spec.name,
        type,
        database: sampleTarget(spec),
        managed: false,
        roles: [...spec.roles],
        createdAt: new Date(0),
      });
    }
  });

  test("every reason has a sentence that names no path, and copy-failed names its code when it has one", () => {
    expect(unavailableSentence("asset-missing")).toBe(
      "This sample's file is not in the seed assets directory (SEED_ASSETS_DIR), so it was not copied. The server log names the path.",
    );
    expect(unavailableSentence("digest-mismatch")).toBe(
      "This sample's file in the seed assets directory is not the one this LibreDB Studio ships, so it was not copied.",
    );
    expect(unavailableSentence("copy-failed", "EACCES")).toBe(
      "This sample could not be copied into the server's data directory (EACCES). The server log names the path.",
    );
    expect(unavailableSentence("copy-failed")).toBe(
      "This sample could not be copied into the server's data directory. The server log names the path.",
    );
    expect(unavailableSentence("target-reserved")).toBe(
      "This sample's path names one of the server's own storage files, so the sample is not created there.",
    );
    expect(unavailableSentence("target-conflict")).toBe(
      "This sample's path is another sample's, so only the first one is created.",
    );
  });
});

describe("startSampleSeeding", () => {
  test("marks every enabled sample seeding at once, then copies each and logs one info line", async () => {
    const dataDir = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const seeding = startSampleSeeding();
      expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({ phase: "seeding" });
      expect(getSampleSeedState("libredb-embedded-sample")).toEqual({ phase: "seeding" });
      await seeding;
      expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({ phase: "done" });
      expect(getSampleSeedState("libredb-embedded-sample")).toEqual({ phase: "done" });
      expect(readdirSync(dataDir).sort()).toEqual(["sample-employees.db", "sample.libredb"]);
      expect(
        readFileSync(path.join(dataDir, "sample.libredb")).equals(
          readFileSync(path.join(ROOT, "seed-assets", "libredb", "sample.libredb")),
        ),
      ).toBe(true);
      // The two copies run concurrently, so their lines arrive in either order.
      expect(info.mock.calls.map(([message, context]) => `${message}: ${context?.seedId}`).sort()).toEqual([
        "Embedded sample copied: libredb-embedded-sample",
        "Embedded sample copied: sqlite-embedded-sample",
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test("a sample already present is one debug line and no info line", async () => {
    const dataDir = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    writeFileSync(path.join(dataDir, "sample-employees.db"), "the user's edits");
    writeFileSync(path.join(dataDir, "sample.libredb"), "the user's edits");
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await startSampleSeeding();
      expect(info).not.toHaveBeenCalled();
      expect(debug.mock.calls.map(([message, context]) => `${message}: ${context?.seedId}`).sort()).toEqual([
        "Embedded sample already present: libredb-embedded-sample",
        "Embedded sample already present: sqlite-embedded-sample",
      ]);
      expect(readFileSync(path.join(dataDir, "sample.libredb"), "utf8")).toBe("the user's edits");
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

  test("a copy that fails is failed with its reason and sentence, logged once as a warning", async () => {
    process.env.SEED_ASSETS_DIR = temporaryDirectory();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await startSampleSeeding();
      for (const seedId of ["sqlite-embedded-sample", "libredb-embedded-sample"]) {
        expect(getSampleSeedState(seedId)).toEqual({
          phase: "failed",
          reason: "asset-missing",
          sentence: unavailableSentence("asset-missing"),
        });
      }
      expect(
        warn.mock.calls.map(([message, context]) => `${message}: ${context?.seedId} ${context?.reason}`).sort(),
      ).toEqual([
        "Embedded sample unavailable: libredb-embedded-sample asset-missing",
        "Embedded sample unavailable: sqlite-embedded-sample asset-missing",
      ]);
      const [, context] = warn.mock.calls.find(([, c]) => c?.seedId === "sqlite-embedded-sample") ?? [];
      expect(context?.assets).toBe(process.env.SEED_ASSETS_DIR);
      expect(context?.target).toBe(sampleTarget(row("sqlite")));
      expect(String(context?.error)).toContain("employee.db");
    } finally {
      warn.mockRestore();
    }
  });

  test("an admission refusal is failed at once, logged once, and copies nothing", async () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = process.env.STORAGE_SQLITE_PATH;
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const seeding = startSampleSeeding();
      expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({
        phase: "failed",
        reason: "target-reserved",
        sentence: unavailableSentence("target-reserved"),
      });
      await seeding;
      expect(warn.mock.calls.map(([message, context]) => [message, context?.seedId, context?.reason])).toEqual([
        ["Embedded sample unavailable", "sqlite-embedded-sample", "target-reserved"],
      ]);
      expect(getSampleSeedState("libredb-embedded-sample")).toBeUndefined();
      expect(readdirSync(path.dirname(process.env.STORAGE_SQLITE_PATH ?? ""))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("seeds nothing when no row is enabled", async () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    await startSampleSeeding();
    for (const spec of SAMPLES.values()) expect(getSampleSeedState(spec.seedId)).toBeUndefined();
  });
});
