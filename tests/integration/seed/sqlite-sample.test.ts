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
  setSqliteSampleSeedState("idle");
});

describe("sqlite-sample", () => {
  test('isSqliteSampleEnabled: default on; only "false" disables', () => {
    expect(isSqliteSampleEnabled()).toBe(true);
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    expect(isSqliteSampleEnabled()).toBe(false);
    process.env.SQLITE_EMBEDDED_SAMPLE = "true";
    expect(isSqliteSampleEnabled()).toBe(true);
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

  test("buildSqliteSampleConnection: editable sqlite seed pointing at the resolved path", () => {
    const conn = buildSqliteSampleConnection();
    expect(conn.seedId).toBe(SQLITE_SAMPLE_SEED_ID);
    expect(conn.id).toBe(`seed:${SQLITE_SAMPLE_SEED_ID}`);
    expect(conn.type).toBe("sqlite");
    expect(conn.managed).toBe(false);
    expect(conn.roles).toEqual(["*"]);
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
