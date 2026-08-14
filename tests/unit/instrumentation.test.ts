import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { register } from "@/instrumentation";
import { logger } from "@/lib/logger";
import { getSqliteSampleSeedState, setSqliteSampleSeedState } from "@/lib/seed/sqlite-sample";

const ENV_KEYS = [
  "NEXT_RUNTIME",
  "LIBREDB_EMBEDDED_SAMPLE",
  "LIBREDB_EMBEDDED_SAMPLE_PATH",
  "SQLITE_EMBEDDED_SAMPLE",
  "SQLITE_EMBEDDED_SAMPLE_PATH",
  "SQLITE_EMBEDDED_SAMPLE_TEMPLATE",
  "STORAGE_SQLITE_PATH",
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "AUTH_BOOTSTRAP",
  "LIBREDB_NO_BANNER",
] as const;

/** The sqlite sample seeds fire-and-forget; poll for its observable effects. */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
    // Keep the boot banner out of the test output; the banner tests below opt
    // back in explicitly.
    process.env.LIBREDB_NO_BANNER = "1";
    setSqliteSampleSeedState("idle");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setSqliteSampleSeedState("idle");
  });

  test("does nothing outside the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test("runs auth bootstrap, then seeds nothing when both samples are disabled", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
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
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(getSqliteSampleSeedState()).toBe("idle");
  });

  test("hard-exits before seeding when JWT_SECRET is set but too short (#227)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.JWT_SECRET = "x".repeat(24); // Cosmos randomString(24)
    process.env.ADMIN_PASSWORD = "set-so-bootstrap-has-nothing-to-do";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");

    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let banner = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      banner = errorSpy.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
    }

    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("JWT_SECRET is too short");
    // register() must abandon the rest of boot: no sample seeding is started,
    // and the short secret is left exactly as the operator set it.
    expect(getSqliteSampleSeedState()).toBe("idle");
    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
    expect(process.env.JWT_SECRET).toBe("x".repeat(24));
  });

  test("seeds the sample file on a nodejs boot", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample.libredb");

    await register();

    expect(fs.existsSync(path.join(tmpDir, "sample.libredb"))).toBe(true);
    expect(fs.statSync(path.join(tmpDir, "sample.libredb")).size).toBeGreaterThan(0);
  });

  test("seeds the sqlite sample asynchronously without blocking boot", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");

    await register(); // must resolve without waiting for the copy

    // Non-blocking proof: the copy needs event-loop turns this synchronous
    // check does not grant — right after register() resolves the seed MUST
    // still be in flight. If the seeder ever regresses to sync fs calls, the
    // state is already "done" here and this fails.
    expect(getSqliteSampleSeedState()).toBe("seeding");
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);

    await waitFor(() => fs.existsSync(path.join(tmpDir, "sample-employees.db")));
    await waitFor(() => getSqliteSampleSeedState() === "done");
    expect(fs.statSync(path.join(tmpDir, "sample-employees.db")).size).toBeGreaterThan(0);
  });

  test("fast-path boot (sample already present) stays quiet: one debug line, no info pair", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    const samplePath = path.join(tmpDir, "sample-employees.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = samplePath;
    fs.writeFileSync(samplePath, "already seeded on a previous boot");

    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      await register();
      await waitFor(() => getSqliteSampleSeedState() === "done");

      const infoMessages = info.mock.calls.map((c) => String(c[0]));
      expect(infoMessages.some((m) => m.includes("SQLite embedded sample"))).toBe(false);
      expect(debug.mock.calls.map((c) => String(c[0]))).toContain("SQLite embedded sample already present");
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
    expect(fs.readFileSync(samplePath, "utf8")).toBe("already seeded on a previous boot");
  });

  test("marks the sqlite seed failed and keeps boot alive when the template is missing", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = path.join(tmpDir, "sample-employees.db");
    process.env.SQLITE_EMBEDDED_SAMPLE_TEMPLATE = path.join(tmpDir, "no-such-template.db");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(register()).resolves.toBeUndefined();
      await waitFor(() => getSqliteSampleSeedState() === "failed");
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain("SQLite embedded sample seeding skipped");
    } finally {
      warn.mockRestore();
    }
    expect(fs.existsSync(path.join(tmpDir, "sample-employees.db"))).toBe(false);
  });

  test("prints the boot banner even when the sqlite sample is disabled", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTH_BOOTSTRAP = "off";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    delete process.env.LIBREDB_NO_BANNER;

    const log = spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      await register();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      output = log.mock.calls.flat().join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("LibreDB Studio");
    expect(output).toContain("https://github.com/libredb/libredb-studio");
  });

  test("prints no banner when the server refuses to boot (#227)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.JWT_SECRET = "x".repeat(24);
    process.env.ADMIN_PASSWORD = "set-so-bootstrap-has-nothing-to-do";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    process.env.SQLITE_EMBEDDED_SAMPLE = "false";
    delete process.env.LIBREDB_NO_BANNER;

    const originalExit = process.exit;
    process.exit = (() => {}) as unknown as typeof process.exit;
    const log = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let output = "";
    try {
      await register();
      output = log.mock.calls.flat().join("\n");
    } finally {
      process.exit = originalExit;
      log.mockRestore();
      errorSpy.mockRestore();
    }

    expect(output).not.toContain("Star the project");
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
