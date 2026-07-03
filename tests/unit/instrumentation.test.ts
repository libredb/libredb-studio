import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { register } from "@/instrumentation";
import { logger } from "@/lib/logger";

const ENV_KEYS = [
  "NEXT_RUNTIME",
  "LIBREDB_EMBEDDED_SAMPLE",
  "LIBREDB_EMBEDDED_SAMPLE_PATH",
  "STORAGE_SQLITE_PATH",
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "AUTH_BOOTSTRAP",
] as const;

describe("instrumentation register()", () => {
  let orig: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(() => {
    orig = {};
    for (const key of ENV_KEYS) {
      orig[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instrumentation-"));
    process.env.STORAGE_SQLITE_PATH = path.join(tmpDir, "libredb-storage.db");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("does nothing outside the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test("runs auth bootstrap, then returns early when the sample is disabled", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await register();
    } finally {
      log.mockRestore();
    }

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.existsSync(path.join(tmpDir, "auth-bootstrap.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
  });

  test("seeds the sample file on a nodejs boot", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");

    await register();

    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(true);
    expect(fs.statSync(path.join(tmpDir, "sample.libredb")).size).toBeGreaterThan(0);
  });

  test("logs a warning and keeps boot alive when seeding fails", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // perms not enforceable
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    const lockedDir = path.join(tmpDir, "locked");
    fs.mkdirSync(lockedDir);
    fs.chmodSync(lockedDir, 0o500);
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(lockedDir, "sample.libredb");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(register()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain("seeding skipped");
    } finally {
      warn.mockRestore();
      fs.chmodSync(lockedDir, 0o700);
    }
  });
});
