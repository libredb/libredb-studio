/**
 * The built-in SQLite sample, through the sample service: its enablement, and a copy of its committed asset as the
 * SQLite provider opens it. The copy opens nothing itself (src/lib/seed/sample-copy.ts); these cases prove that the
 * published file needs no switch to WAL on its first opens, which the asset being committed in WAL mode guarantees.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "bun:sqlite";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { admittedFileConnection } from "@/lib/db/provider-files";
import { copySampleAsset } from "@/lib/seed/sample-copy";
import { SAMPLES, sampleAssetPath, sampleEnabled, type SampleSpec } from "@/lib/seed/samples";

const ROOT = path.resolve(import.meta.dir, "../../..");
const tmpDirs: string[] = [];

function sqliteRow(): SampleSpec {
  const spec = SAMPLES.get("sqlite");
  if (spec === undefined) throw new Error("no SQLite sample row");
  return spec;
}

function tmpPath(): string {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-sample-"));
  tmpDirs.push(dir);
  return path.join(dir, "sample-employees.db");
}

/** The sample as boot publishes it: the committed asset, copied and verified against its pin. */
async function seededSample(): Promise<string> {
  const spec = sqliteRow();
  process.env.SEED_ASSETS_DIR = path.join(ROOT, "seed-assets");
  const asset = sampleAssetPath(spec);
  if (asset === null) throw new Error("SEED_ASSETS_DIR is set above, so the sample has an asset path");
  const file = tmpPath();
  expect(await copySampleAsset({ asset, sha256: spec.sha256, bytes: spec.bytes }, file)).toBe("copied");
  return file;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.SQLITE_EMBEDDED_SAMPLE;
  delete process.env.GOVERNANCE_SOURCE;
  delete process.env.LIBREDB_SQLITE_WORKER;
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  delete process.env.SEED_ASSETS_DIR;
});

/** A provider on the seeded sample, the way the server builds one for the seed connection. */
function sampleProvider(file: string): SQLiteProvider {
  return new SQLiteProvider(
    admittedFileConnection({
      id: "seed:sqlite-embedded-sample",
      name: "Sample",
      type: "sqlite",
      database: file,
      createdAt: new Date(0),
    }),
  );
}

describe("the SQLite sample", () => {
  test('enabled by default; only "false" disables', () => {
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(true);
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
    process.env.SQLITE_EMBEDDED_SAMPLE = "true";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(true);
  });

  // Governance mode offers no sample (docs/GOVERNANCE.md): the boot check refuses a sample switched on, and the
  // switch answers off under governance whatever the variable says, so a bypassed check seeds and lists no sample.
  test("under governance it is off although SQLITE_EMBEDDED_SAMPLE is true", () => {
    process.env.SQLITE_EMBEDDED_SAMPLE = "true";
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
    delete process.env.SQLITE_EMBEDDED_SAMPLE;
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
  });

  // The factory refuses every open of a type LIBREDB_ENABLED_PROVIDERS leaves out, so a server whose list leaves out
  // sqlite neither seeds the sample nor lists one that could never open.
  test("it is off when LIBREDB_ENABLED_PROVIDERS is set and does not name sqlite", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres,mysql";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres, sqlite ,";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(true);
    process.env.LIBREDB_ENABLED_PROVIDERS = "  ";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(true);
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
  });

  // The factory refuses every open under a value it cannot read, so the sample, which names sqlite there, is off too.
  test("it is off when LIBREDB_ENABLED_PROVIDERS is a value the factory refuses as a whole", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite,postgresql";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = " , ,";
    expect(sampleEnabled("sqlite", sqliteRow())).toBe(false);
  });

  test("the copy is a queryable SQLite file in WAL mode, with no sidecar beside it", async () => {
    const file = await seededSample();
    expect([...fs.readFileSync(file).subarray(18, 20)]).toEqual([2, 2]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["sample-employees.db"]);
    // Writable: Apple's system SQLite, which bun:sqlite uses on macOS, cannot open a WAL file read-only without its
    // -shm file (SQLITE_CANTOPEN on macos-latest), and the sample is published in WAL mode with no sidecar.
    const db = new Database(file);
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM employee").get()).toEqual({ n: 1000 });
    } finally {
      db.close();
    }
  });

  // A template in rollback-journal mode had every writable open switch the file to WAL, and two opens making that
  // switch at once fail with "database is locked" whatever the busy timeout, because SQLite refuses the read lock's
  // upgrade to the write lock the switch needs instead of waiting. The first page load opens the sample from several
  // routes at once. The committed asset is already in WAL mode, so no open of the published sample has a switch to
  // make.
  test("an open of the fresh sample succeeds while another connection is reading it", async () => {
    const file = await seededSample();
    // Writable: Apple's system SQLite, which bun:sqlite uses on macOS, cannot open a WAL file read-only without its
    // -shm file (SQLITE_CANTOPEN on macos-latest); a read transaction holds the same read lock either way.
    const reader = new Database(file);
    reader.exec("BEGIN");
    try {
      expect((reader.query("SELECT COUNT(*) AS n FROM employee").get() as { n: number }).n).toBeGreaterThan(0);
      for (const worker of ["1", "0"]) {
        process.env.LIBREDB_SQLITE_WORKER = worker;
        const provider = sampleProvider(file);
        try {
          await provider.connect();
          expect((await provider.listObjects([], "table")).length).toBeGreaterThan(0);
        } finally {
          await provider.disconnect();
        }
      }
    } finally {
      reader.exec("COMMIT");
      reader.close();
    }
  });

  test("concurrent first opens of a freshly seeded sample all succeed", async () => {
    const file = await seededSample();
    const providers = Array.from({ length: 4 }, () => sampleProvider(file));
    try {
      const opens = await Promise.allSettled(
        providers.map(async (provider) => {
          await provider.connect();
          return (await provider.listObjects([], "table")).length;
        }),
      );
      expect(opens.map((open) => (open.status === "fulfilled" ? "opened" : String(open.reason)))).toEqual([
        "opened",
        "opened",
        "opened",
        "opened",
      ]);
    } finally {
      await Promise.all(providers.map((provider) => provider.disconnect()));
    }
  });
});
