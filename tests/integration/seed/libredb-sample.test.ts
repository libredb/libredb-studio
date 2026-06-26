import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { open, catalog, kv } from "@libredb/libredb";
import {
  isSampleEnabled,
  resolveSamplePath,
  seedSampleFile,
  buildSampleConnection,
  SAMPLE_SEED_ID,
} from "@/lib/seed/libredb-sample";

const tmpDirs: string[] = [];
function tmpPath(): string {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-sample-"));
  tmpDirs.push(dir);
  return path.join(dir, "sample.libredb");
}
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
});

describe("libredb-sample", () => {
  test('isSampleEnabled: default on; only "false" disables', () => {
    expect(isSampleEnabled()).toBe(true);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    expect(isSampleEnabled()).toBe(true);
  });

  test("resolveSamplePath: override wins; else derives from data dir", () => {
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = "/custom/x.libredb";
    expect(resolveSamplePath()).toBe("/custom/x.libredb");
    delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
    expect(resolveSamplePath().endsWith(`${path.sep}sample.libredb`)).toBe(true);
  });

  test("seedSampleFile: seeds all three lenses, catalog-aware", async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    expect(fs.existsSync(file)).toBe(true);

    const db = open({ path: file });
    const reg = catalog(db);
    expect(reg.get("users")?.kind).toBe("relational");
    expect(reg.get("articles")?.kind).toBe("document");
    const configKeys = kv(db)
      .prefix("config:")
      .toArray()
      .map((e) => e.key);
    expect(configKeys.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  test("seedSampleFile: idempotent — does not modify an existing file", async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    const before = fs.readFileSync(file);
    await seedSampleFile(file);
    const after = fs.readFileSync(file);
    expect(after.equals(before)).toBe(true);
  });

  test("buildSampleConnection: editable libredb seed pointing at the resolved path", () => {
    const conn = buildSampleConnection();
    expect(conn.seedId).toBe(SAMPLE_SEED_ID);
    expect(conn.id).toBe(`seed:${SAMPLE_SEED_ID}`);
    expect(conn.type).toBe("libredb");
    expect(conn.managed).toBe(false);
    expect(conn.roles).toEqual(["*"]);
    expect(conn.name).toBe("Sample (LibreDB)");
    expect(conn.database).toBe(resolveSamplePath());
  });
});
