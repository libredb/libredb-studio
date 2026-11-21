/**
 * The built-in sample service (src/lib/seed/samples.ts): the SAMPLES table, the one enablement rule every row follows,
 * the targets and their admission, the asset directory, the per-sample seed state, and startSampleSeeding, which
 * copies every enabled, admitted sample and logs each outcome once.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  seededSampleAdmissions,
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

  test("a target that names a storage file in another letter case is refused as target-reserved, before that file exists", () => {
    // On macOS and Windows each spelling is the storage file itself; none of the files exists yet, as on a first boot.
    const dataDir = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    for (const name of [
      "LIBREDB-STORAGE.db",
      "LibreDB-Storage.db-WAL",
      "libredb-storage.DB-shm",
      "Auth-Bootstrap.json",
      "AUTH-BOOTSTRAP.JSON.BAK",
      "Auth-Bootstrap.json.1234.TMP",
    ]) {
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(dataDir, name);
      expect([name, sampleAdmissions().map(({ refusal }) => refusal)]).toEqual([name, ["target-reserved", null]]);
    }
  });

  test("a target that spells a storage file in another Unicode normalization form is refused as target-reserved", () => {
    // APFS ignores normalization, so on macOS the decomposed spelling is the storage file itself; it does not exist yet.
    const dataDir = temporaryDirectory();
    process.env.STORAGE_SQLITE_PATH = path.join(dataDir, "st\u00f6rage.db");
    for (const name of ["sto\u0308rage.db", "STO\u0308RAGE.db-wal"]) {
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(dataDir, name);
      expect([name, sampleAdmissions().map(({ refusal }) => refusal)]).toEqual([name, ["target-reserved", null]]);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a storage database reached through a symlinked directory spelled in another case is target-reserved (POSIX)",
    () => {
      const root = temporaryDirectory();
      symlinkSync(temporaryDirectory(), path.join(root, "Data"), "dir");
      process.env.STORAGE_SQLITE_PATH = path.join(root, "Data", "libredb-storage.db");
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(root, "data", "libredb-storage.db");
      expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual(["target-reserved", null]);
    },
  );

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

  test.each(["", "-wal", "-shm", "-journal", ".lock"])(
    "a sample on another's file or on its %p sidecar is refused as target-conflict, in either direction",
    (suffix) => {
      const base = path.join(temporaryDirectory(), "one.db");
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = base;
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = `${base}${suffix}`;
      expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = `${base}${suffix}`;
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = base;
      expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
    },
  );

  test("two paths to one file through a symlinked directory are one target, so the second is target-conflict", () => {
    const data = temporaryDirectory();
    const alias = path.join(temporaryDirectory(), "alias");
    symlinkSync(data, alias, process.platform === "win32" ? "junction" : "dir");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(data, "shared.db");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(alias, "shared.db");
    expect(sampleAdmissions().map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "sqlite", refusal: null },
      { type: "libredb", refusal: "target-conflict" },
    ]);
  });

  test("two targets equal ignoring letter case are one target on every OS, so the second is target-conflict", () => {
    // On macOS and Windows the two spellings name one file; the comparison is the same on every OS, so this runs on Linux.
    const data = temporaryDirectory();
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(data, "Shared.db");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(data, "shared.DB");
    expect(sampleAdmissions().map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "sqlite", refusal: null },
      { type: "libredb", refusal: "target-conflict" },
    ]);
    // A sidecar spelled in another case, and a directory that does not exist yet spelled in another case.
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(data, "SHARED.db-WAL");
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(data, "Sub", "one.db");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(data, "sub", "one.db");
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
  });

  test("a symlinked directory and another spelling of it in letter case are one target, in either order", () => {
    // On Linux `dir` does not exist and is not followed, so the paths as given are compared too; on macOS and Windows `dir` is `Dir`.
    const root = temporaryDirectory();
    symlinkSync(temporaryDirectory(), path.join(root, "Dir"), process.platform === "win32" ? "junction" : "dir");
    const linked = path.join(root, "Dir", "s.db");
    const spelled = path.join(root, "dir", "s.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = linked;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = spelled;
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = spelled;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = linked;
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
  });

  test("two targets that differ only in Unicode normalization form are one target on every OS, so the second is target-conflict", () => {
    // APFS ignores normalization, so on macOS the precomposed and the decomposed u with diaeresis name one file.
    const data = temporaryDirectory();
    for (const [first, second] of [
      ["m\u00fcller.db", "mu\u0308ller.db"],
      ["Mu\u0308ller.db", "m\u00fcller.db-wal"],
      [path.join("\u00dcber", "one.db"), path.join("u\u0308ber", "one.db")],
    ]) {
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(data, first);
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(data, second);
      expect([first, second, sampleAdmissions().map(({ refusal }) => refusal)]).toEqual([
        first,
        second,
        [null, "target-conflict"],
      ]);
    }
  });

  test("two targets whose names are different letters are both admitted, whatever their normalization form", () => {
    const data = temporaryDirectory();
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(data, "m\u00fcller.db");
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(data, "mo\u0308ller.db");
    expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, null]);
  });

  test("letter case is folded one code point at a time, so the two lower-case sigmas are one letter", () => {
    // NTFS upcases both σ and ς to Σ, and APFS folds ς to σ.
    const data = temporaryDirectory();
    for (const [first, second] of [
      ["οδοσ.db", "οδος.db"],
      ["ΟΔΟΣ.db", "οδος.db"],
    ]) {
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(data, first);
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(data, second);
      expect([first, second, sampleAdmissions().map(({ refusal }) => refusal)]).toEqual([
        first,
        second,
        [null, "target-conflict"],
      ]);
    }
  });

  test.skipIf(process.platform === "win32")(
    "a dangling symlink target claims both the link path and its target, so a sidecar of either is target-conflict (POSIX)",
    () => {
      const data = temporaryDirectory();
      const elsewhere = temporaryDirectory();
      const link = path.join(data, "link.db");
      symlinkSync(path.join(elsewhere, "x.db"), link);
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = link;
      // The copy's rename replaces the dangling link with a regular file, so the sample and its sidecars live at the link path.
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = `${link}-wal`;
      expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
      // An engine that opens the link while it is live reaches the link's target.
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(elsewhere, "x.db-wal");
      expect(sampleAdmissions().map(({ refusal }) => refusal)).toEqual([null, "target-conflict"]);
    },
  );

  test("a target whose path cannot be checked is refused as target-unreadable with its error, and the other row is admitted", () => {
    const blocker = path.join(temporaryDirectory(), "a-regular-file");
    writeFileSync(blocker, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(blocker, "sample-employees.db");
    const admissions = sampleAdmissions();
    expect(admissions.map(({ type, refusal }) => ({ type, refusal }))).toEqual([
      { type: "sqlite", refusal: "target-unreadable" },
      { type: "libredb", refusal: null },
    ]);
    expect(admissions[0]?.failure?.code).toBe("ENOTDIR");
    expect(admissions[0]?.failure?.message).toContain(blocker);
    expect(admissions[1]?.failure).toBeUndefined();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a target in a directory the server cannot search is refused as target-unreadable naming EACCES (POSIX, not root)",
    () => {
      const locked = temporaryDirectory();
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(locked, "sample-employees.db");
      chmodSync(locked, 0o000);
      try {
        const admissions = sampleAdmissions();
        expect(admissions.map(({ refusal }) => refusal)).toEqual(["target-unreadable", null]);
        expect(admissions[0]?.failure?.code).toBe("EACCES");
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

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

  test("the connection record is today's: editable, unmanaged, at the admitted target, created at the epoch", () => {
    for (const [type, spec] of SAMPLES) {
      const target = path.join(temporaryDirectory(), spec.fileName);
      expect(sampleConnection(type, spec, target)).toEqual({
        id: `seed:${spec.seedId}`,
        seedId: spec.seedId,
        name: spec.name,
        type,
        database: target,
        managed: false,
        roles: [...spec.roles],
        createdAt: new Date(0),
      });
    }
  });

  test("every reason has a sentence that names no path, and a failure names its code when it has one", () => {
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
    expect(unavailableSentence("asset-unreadable", "EACCES")).toBe(
      "This sample's file in the seed assets directory (SEED_ASSETS_DIR) could not be read (EACCES), so it was not copied. The server log names the path.",
    );
    expect(unavailableSentence("asset-unreadable")).toBe(
      "This sample's file in the seed assets directory (SEED_ASSETS_DIR) could not be read, so it was not copied. The server log names the path.",
    );
    expect(unavailableSentence("target-unreadable", "ENOTDIR")).toBe(
      "The server could not check this sample's path (ENOTDIR), so the sample is not created there. The server log names the path.",
    );
    expect(unavailableSentence("target-unreadable")).toBe(
      "The server could not check this sample's path, so the sample is not created there. The server log names the path.",
    );
    expect(unavailableSentence("target-reserved")).toBe(
      "This sample's path names one of the server's own storage files, so the sample is not created there.",
    );
    expect(unavailableSentence("target-conflict")).toBe(
      "This sample's path is another sample's, so only the first one is created.",
    );
    expect(unavailableSentence("copy-defect")).toBe(
      "This sample's copy met an internal error, so it was not copied. The server log shows the error as an unhandled rejection.",
    );
    expect(unavailableSentence("target-lost", "ENOENT")).toBe(
      "The server can no longer find or check this sample's file (ENOENT). The server log names the path.",
    );
    expect(unavailableSentence("target-lost")).toBe(
      "The server can no longer find or check this sample's file. The server log names the path.",
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

  test("a target whose path cannot be checked is failed at once with its code, logged once, and the other sample is still copied", async () => {
    const dataDir = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    const blocker = path.join(temporaryDirectory(), "a-regular-file");
    writeFileSync(blocker, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(blocker, "sample-employees.db");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const seeding = startSampleSeeding();
      expect(getSampleSeedState("sqlite-embedded-sample")).toEqual({
        phase: "failed",
        reason: "target-unreadable",
        sentence: unavailableSentence("target-unreadable", "ENOTDIR"),
      });
      expect(getSampleSeedState("libredb-embedded-sample")).toEqual({ phase: "seeding" });
      await seeding;
      expect(getSampleSeedState("libredb-embedded-sample")).toEqual({ phase: "done" });
      expect(readdirSync(dataDir)).toEqual(["sample.libredb"]);
      expect(warn.mock.calls.map(([message, context]) => [message, context?.seedId, context?.reason])).toEqual([
        ["Embedded sample unavailable", "sqlite-embedded-sample", "target-unreadable"],
      ]);
      expect(String(warn.mock.calls[0]?.[1]?.error)).toContain("ENOTDIR");
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  test("keeps the admissions it computed for the process, replacing an earlier call's, until a reset", async () => {
    const dataDir = path.dirname(process.env.STORAGE_SQLITE_PATH ?? "");
    writeFileSync(path.join(dataDir, "sample-employees.db"), "");
    writeFileSync(path.join(dataDir, "sample.libredb"), "");
    expect(seededSampleAdmissions()).toEqual([]);
    await startSampleSeeding();
    expect(seededSampleAdmissions()).toEqual(sampleAdmissions());
    // Read from the environment as it was: a later change is not seen until the next call.
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(seededSampleAdmissions().map(({ type }) => type)).toEqual(["sqlite", "libredb"]);
    await startSampleSeeding();
    expect(seededSampleAdmissions().map(({ type }) => type)).toEqual(["libredb"]);
    expect(getSampleSeedState("sqlite-embedded-sample")).toBeUndefined();
    resetSampleSeedStates();
    expect(seededSampleAdmissions()).toEqual([]);
  });

  test("seeds nothing when no row is enabled", async () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    await startSampleSeeding();
    for (const spec of SAMPLES.values()) expect(getSampleSeedState(spec.seedId)).toBeUndefined();
  });
});
