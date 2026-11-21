import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isSqliteSampleEnabled,
  resolveSqliteSamplePath,
  resolveSqliteSampleTemplatePath,
  seedSqliteSampleFile,
  buildSqliteSampleConnection,
  getSqliteSampleSeedState,
  setSqliteSampleSeedState,
  SQLITE_SAMPLE_SEED_ID,
} from "@/lib/seed/sqlite-sample";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";

const tmpDirs: string[] = [];
function tmpPath(): string {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-sample-"));
  tmpDirs.push(dir);
  return path.join(dir, "sample-employees.db");
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
  delete process.env.GOVERNANCE_SOURCE;
  delete process.env.LIBREDB_SQLITE_WORKER;
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  setSqliteSampleSeedState("idle");
});

/** A provider on the seeded sample, the way the server builds one for the seed connection. */
function sampleProvider(file: string): SQLiteProvider {
  return new SQLiteProvider({
    id: "seed:sqlite-embedded-sample",
    name: "Sample",
    type: "sqlite",
    database: file,
    createdAt: new Date(0),
  });
}

/** Bytes 18 and 19 of the file header, the write and read format versions: 2 in WAL mode, 1 under a rollback journal. */
function formatVersions(file: string): number[] {
  return [...fs.readFileSync(file).subarray(18, 20)];
}

describe("sqlite-sample", () => {
  test('isSqliteSampleEnabled: default on; only "false" disables', () => {
    expect(isSqliteSampleEnabled()).toBe(true);
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(isSqliteSampleEnabled()).toBe(false);
    process.env.SQLITE_EMBEDDED_SAMPLE = "true";
    expect(isSqliteSampleEnabled()).toBe(true);
  });

  // Governance mode offers no sample (docs/GOVERNANCE.md): the boot check refuses a sample switched on, and the
  // switch answers off under governance whatever the variable says, so a bypassed check seeds and lists no sample.
  test("under governance isSqliteSampleEnabled() is false although SQLITE_EMBEDDED_SAMPLE is true", () => {
    process.env.SQLITE_EMBEDDED_SAMPLE = "true";
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(isSqliteSampleEnabled()).toBe(false);
    // Unset is on by default, and still off under governance.
    delete process.env.SQLITE_EMBEDDED_SAMPLE;
    expect(isSqliteSampleEnabled()).toBe(false);
  });

  // The factory refuses every open of a type LIBREDB_ENABLED_PROVIDERS leaves out, so a server whose list leaves out
  // sqlite neither seeds the sample, which would load the SQLite provider, nor lists one that could never open.
  test("isSqliteSampleEnabled() is false when LIBREDB_ENABLED_PROVIDERS is set and does not name sqlite", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres,mysql";
    expect(isSqliteSampleEnabled()).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres, sqlite ,";
    expect(isSqliteSampleEnabled()).toBe(true);
    process.env.LIBREDB_ENABLED_PROVIDERS = "  ";
    expect(isSqliteSampleEnabled()).toBe(true);
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(isSqliteSampleEnabled()).toBe(false);
  });

  // The factory refuses every open under a value it cannot read, so the sample, which names sqlite there, is off too.
  test("isSqliteSampleEnabled() is false when LIBREDB_ENABLED_PROVIDERS is a value the factory refuses as a whole", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite,postgresql";
    expect(isSqliteSampleEnabled()).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = " , ,";
    expect(isSqliteSampleEnabled()).toBe(false);
  });

  test("resolveSqliteSamplePath: override wins; else derives from data dir", () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = "/custom/employees.db";
    expect(resolveSqliteSamplePath()).toBe("/custom/employees.db");
    delete process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
    expect(resolveSqliteSamplePath().endsWith(`${path.sep}sample-employees.db`)).toBe(true);
  });

  test("resolveSqliteSampleTemplatePath: override wins; else cwd-relative seed-assets", () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE = "/custom/template.db";
    expect(resolveSqliteSampleTemplatePath()).toBe("/custom/template.db");
    delete process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE;
    expect(resolveSqliteSampleTemplatePath()).toBe(path.join(process.cwd(), "seed-assets", "sqlite", "employee.db"));
  });

  test("seedSqliteSampleFile: copies the vendored template to a queryable SQLite file", async () => {
    const file = tmpPath();
    expect(await seedSqliteSampleFile(file)).toBe("seeded");
    expect(fs.existsSync(file)).toBe(true);

    const db = new Database(file, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS n FROM employee").get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("seedSqliteSampleFile: idempotent — reports skipped and does not modify an existing file", async () => {
    const file = tmpPath();
    fs.writeFileSync(file, "user data, not a sample");
    expect(await seedSqliteSampleFile(file)).toBe("skipped");
    expect(fs.readFileSync(file, "utf8")).toBe("user data, not a sample");
  });

  test("seedSqliteSampleFile: throws when the template is missing", async () => {
    process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE = path.join(path.dirname(tmpPath()), "missing-template.db");
    const file = tmpPath();
    await expect(seedSqliteSampleFile(file)).rejects.toThrow("template");
    expect(fs.existsSync(file)).toBe(false);
  });

  test("seedSqliteSampleFile: discards a stale temp left by a crashed boot with the same pid", async () => {
    const file = tmpPath();
    const tempPath = `${file}.${process.pid}.seeding`;
    fs.writeFileSync(tempPath, "partial junk from a crashed seed");

    await seedSqliteSampleFile(file);

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(tempPath)).toBe(false);
    const db = new Database(file, { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM employee").get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("seedSqliteSampleFile: treats a rename race as success when another worker published first", async () => {
    const file = tmpPath();
    const realRename = fs.promises.rename;
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (to === file) {
        fs.copyFileSync(from, file);
        throw new Error("EEXIST: file already exists");
      }
      return realRename(from, to);
    }) as typeof fs.promises.rename);
    try {
      await seedSqliteSampleFile(file);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.${process.pid}.seeding`)).toBe(false);
  });

  test("seedSqliteSampleFile: rethrows a rename failure when nothing was published, leaving no temp", async () => {
    const file = tmpPath();
    const realRename = fs.promises.rename;
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
      if (to === file) throw new Error("EACCES: simulated rename failure");
      return realRename(from, to);
    }) as typeof fs.promises.rename);
    try {
      await expect(seedSqliteSampleFile(file)).rejects.toThrow("EACCES: simulated rename failure");
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.${process.pid}.seeding`)).toBe(false);
  });

  // The template is in rollback-journal mode, and every writable open switches the file to WAL.
  // Two opens making that switch at once fail with "database is locked" whatever the busy timeout,
  // because SQLite refuses the read lock's upgrade to the write lock the switch needs instead of
  // waiting, so the first opens of a fresh copy, made by several routes at once, failed. The seed
  // switches its private copy once, before the rename publishes it, so no open of the published
  // sample has a switch to make, and the open's busy bound covers the WAL recovery of its first open.
  test("seedSqliteSampleFile: publishes the sample already in WAL journal mode, with no sidecar left beside it", async () => {
    const file = tmpPath();
    expect(formatVersions(resolveSqliteSampleTemplatePath())).toEqual([1, 1]);

    await seedSqliteSampleFile(file);

    expect(formatVersions(file)).toEqual([2, 2]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["sample-employees.db"]);
  });

  test("seedSqliteSampleFile: an open of the fresh sample succeeds while another connection is reading it", async () => {
    const file = tmpPath();
    await seedSqliteSampleFile(file);
    const reader = new Database(file, { readonly: true });
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

  test("seedSqliteSampleFile: concurrent first opens of a freshly seeded sample all succeed", async () => {
    const file = tmpPath();
    await seedSqliteSampleFile(file);
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

  test("seedSqliteSampleFile: a template that is not a SQLite database is refused and nothing is published", async () => {
    const template = path.join(path.dirname(tmpPath()), "not-a-database.db");
    fs.writeFileSync(template, "this is not a SQLite database, and it is long enough to have a header");
    process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE = template;
    const file = tmpPath();

    await expect(seedSqliteSampleFile(file)).rejects.toThrow("file is not a database");

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("sample-employees.db"))).toEqual([]);
  });

  test("buildSqliteSampleConnection: editable sqlite seed pointing at the resolved path", () => {
    const conn = buildSqliteSampleConnection();
    expect(conn.seedId).toBe(SQLITE_SAMPLE_SEED_ID);
    expect(conn.id).toBe(`seed:${SQLITE_SAMPLE_SEED_ID}`);
    expect(conn.type).toBe("sqlite");
    expect(conn.managed).toBe(false);
    expect(conn.roles).toEqual(["admin"]);
    expect(conn.name).toBe("Sample (Employees)");
    expect(conn.database).toBe(resolveSqliteSamplePath());
  });

  test("seed state: idle by default, settable, readable across callers", () => {
    expect(getSqliteSampleSeedState()).toBe("idle");
    setSqliteSampleSeedState("seeding");
    expect(getSqliteSampleSeedState()).toBe("seeding");
    setSqliteSampleSeedState("done");
    expect(getSqliteSampleSeedState()).toBe("done");
    setSqliteSampleSeedState("failed");
    expect(getSqliteSampleSeedState()).toBe("failed");
  });
});
