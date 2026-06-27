import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getManagedConnections } from "@/lib/seed";
import { SAMPLE_SEED_ID } from "@/lib/seed/libredb-sample";

let file: string;
let tmpDir: string | undefined;
afterEach(() => {
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  tmpDir = undefined;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
});

function useTempSamplePath(): void {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-mc-"));
  file = path.join(tmpDir, "sample.libredb");
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
});
