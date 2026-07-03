import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapAuth, resolveBootstrapPath, BOOTSTRAP_FILE_NAME } from "@/lib/auth-bootstrap";

const ENV_KEYS = [
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "ADMIN_EMAIL",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "AUTH_BOOTSTRAP",
  "STORAGE_SQLITE_PATH",
] as const;

describe("auth-bootstrap bootstrapAuth()", () => {
  let orig: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(() => {
    orig = {};
    for (const key of ENV_KEYS) {
      orig[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-bootstrap-"));
    process.env.STORAGE_SQLITE_PATH = path.join(tmpDir, "libredb-storage.db");
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (orig[key] === undefined) delete process.env[key];
      else process.env[key] = orig[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readStored(): { jwtSecret?: string; adminPassword?: string; createdAt?: string } {
    return JSON.parse(fs.readFileSync(resolveBootstrapPath(), "utf8"));
  }

  test("generates, persists, and injects JWT_SECRET and ADMIN_PASSWORD when both are unset", () => {
    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.JWT_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(process.env.ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(16);

    const stored = readStored();
    expect(stored.jwtSecret).toBe(process.env.JWT_SECRET!);
    expect(stored.adminPassword).toBe(process.env.ADMIN_PASSWORD!);
    expect(stored.createdAt).toBeDefined();
  });

  test("resolveBootstrapPath() lives in the data dir", () => {
    expect(resolveBootstrapPath()).toBe(path.join(tmpDir, BOOTSTRAP_FILE_NAME));
  });

  test("persists with owner-only file mode", () => {
    if (process.platform === "win32") return; // chmod is a no-op on Windows
    bootstrapAuth();
    expect(fs.statSync(resolveBootstrapPath()).mode & 0o777).toBe(0o600);
  });

  test("reuses persisted credentials across restarts instead of regenerating", () => {
    bootstrapAuth();
    const firstSecret = process.env.JWT_SECRET;
    const firstPassword = process.env.ADMIN_PASSWORD;

    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_PASSWORD;
    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBe(firstSecret!);
    expect(process.env.ADMIN_PASSWORD).toBe(firstPassword!);
  });

  test("generates only the missing field and leaves set env untouched", () => {
    process.env.ADMIN_PASSWORD = "explicit-password";

    bootstrapAuth();

    expect(process.env.ADMIN_PASSWORD).toBe("explicit-password");
    expect(process.env.JWT_SECRET).toBeDefined();
    const stored = readStored();
    expect(stored.jwtSecret).toBeDefined();
    expect(stored.adminPassword).toBeUndefined();
  });

  test("does nothing when both env vars are set", () => {
    process.env.JWT_SECRET = "an-explicit-secret-of-32-characters!";
    process.env.ADMIN_PASSWORD = "explicit-password";

    bootstrapAuth();

    expect(fs.existsSync(resolveBootstrapPath())).toBe(false);
  });
});
