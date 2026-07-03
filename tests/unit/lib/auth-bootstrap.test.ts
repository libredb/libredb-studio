import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapAuth, isBootstrapEnabled, resolveBootstrapPath, BOOTSTRAP_FILE_NAME } from "@/lib/auth-bootstrap";

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

    expect(process.env.JWT_SECRET!).toBe(firstSecret!);
    expect(process.env.ADMIN_PASSWORD!).toBe(firstPassword!);
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

  test("AUTH_BOOTSTRAP=off disables bootstrap entirely (strict PR #106 behavior)", () => {
    process.env.AUTH_BOOTSTRAP = "off";

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(process.env.ADMIN_PASSWORD).toBeUndefined();
    expect(fs.existsSync(resolveBootstrapPath())).toBe(false);
  });

  test.each(["off", "OFF", " Off ", "false", "FALSE", "0"])("isBootstrapEnabled() treats %j as opt-out", (value) => {
    process.env.AUTH_BOOTSTRAP = value;
    expect(isBootstrapEnabled()).toBe(false);
  });

  test.each([
    undefined,
    "",
    "on",
    "ON",
    "true",
    "1",
  ])("isBootstrapEnabled() stays on for %j without warning", (value) => {
    if (value === undefined) delete process.env.AUTH_BOOTSTRAP;
    else process.env.AUTH_BOOTSTRAP = value;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(isBootstrapEnabled()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("isBootstrapEnabled() warns on an unrecognized value and stays on", () => {
    process.env.AUTH_BOOTSTRAP = "offf";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(isBootstrapEnabled()).toBe(true);
      expect(warn.mock.calls.flat().join("\n")).toContain('unrecognized AUTH_BOOTSTRAP value "offf"');
    } finally {
      warn.mockRestore();
    }
  });

  test("OIDC mode bootstraps the JWT secret but never a password", () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeUndefined();
    const stored = readStored();
    expect(stored.jwtSecret).toBeDefined();
    expect(stored.adminPassword).toBeUndefined();
  });

  test("does not read the bootstrap file at all when both env vars are set", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(resolveBootstrapPath(), "{not json");
    process.env.JWT_SECRET = "an-explicit-secret-of-32-characters!";
    process.env.ADMIN_PASSWORD = "explicit-password";

    expect(() => bootstrapAuth()).not.toThrow();
    expect(fs.readFileSync(resolveBootstrapPath(), "utf8")).toBe("{not json");
  });

  test("recovers from a corrupt bootstrap file by renaming it to .bak and regenerating", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(resolveBootstrapPath(), "{not json");

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
  });

  test("recovers from a bootstrap file containing JSON null by renaming it to .bak and regenerating", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(resolveBootstrapPath(), "null");

    expect(() => bootstrapAuth()).not.toThrow();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
  });

  test("recovers from a bootstrap file containing a JSON array by renaming it to .bak and regenerating", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(resolveBootstrapPath(), "[]");

    expect(() => bootstrapAuth()).not.toThrow();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
  });

  test("fails open when the data dir is not writable: no throw, no injection", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // perms not enforceable
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.chmodSync(tmpDir, 0o500);
    try {
      expect(() => bootstrapAuth()).not.toThrow();
      expect(process.env.JWT_SECRET).toBeUndefined();
      expect(process.env.ADMIN_PASSWORD).toBeUndefined();
    } finally {
      fs.chmodSync(tmpDir, 0o700);
    }
  });

  test("prints the password in a banner on generation, but not on reuse", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      bootstrapAuth();
      const password = process.env.ADMIN_PASSWORD!;
      const firstRunOutput = log.mock.calls.flat().join("\n");
      expect(firstRunOutput).toContain(password);
      expect(firstRunOutput).not.toContain(process.env.JWT_SECRET!);

      log.mockClear();
      delete process.env.JWT_SECRET;
      delete process.env.ADMIN_PASSWORD;
      bootstrapAuth();
      const reuseOutput = log.mock.calls.flat().join("\n");
      expect(reuseOutput).not.toContain(password);
      expect(reuseOutput).toContain(resolveBootstrapPath());
    } finally {
      log.mockRestore();
    }
  });

  test("regenerates when the stored jwtSecret is shorter than the 32-char minimum", () => {
    fs.writeFileSync(resolveBootstrapPath(), JSON.stringify({ jwtSecret: "short" }));

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.JWT_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
  });

  test("corrupt-file recovery still works when a stale .bak already exists", () => {
    fs.writeFileSync(resolveBootstrapPath(), "{not json");
    fs.writeFileSync(`${resolveBootstrapPath()}.bak`, "older evidence");

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.readFileSync(`${resolveBootstrapPath()}.bak`, "utf8")).toBe("{not json");
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
  });

  test("recovers when the file contains primitive JSON", () => {
    fs.writeFileSync(resolveBootstrapPath(), "42");

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
  });

  test("recovers when jwtSecret is not a string", () => {
    fs.writeFileSync(resolveBootstrapPath(), JSON.stringify({ jwtSecret: 12345 }));

    bootstrapAuth();

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
  });

  test("recovers when adminPassword is not a string", () => {
    fs.writeFileSync(resolveBootstrapPath(), JSON.stringify({ adminPassword: false }));

    bootstrapAuth();

    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(fs.existsSync(`${resolveBootstrapPath()}.bak`)).toBe(true);
  });

  test("generates only the password when JWT_SECRET is set, bannering the custom admin email", () => {
    process.env.JWT_SECRET = "an-explicit-secret-of-32-characters!";
    process.env.ADMIN_EMAIL = "ops@example.org";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      bootstrapAuth();

      expect(process.env.JWT_SECRET).toBe("an-explicit-secret-of-32-characters!");
      expect(process.env.ADMIN_PASSWORD).toBeDefined();
      const stored = readStored();
      expect(stored.adminPassword).toBe(process.env.ADMIN_PASSWORD!);
      expect(stored.jwtSecret).toBeUndefined();
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("ops@example.org");
      expect(output).toContain(process.env.ADMIN_PASSWORD!);
    } finally {
      log.mockRestore();
    }
  });

  test("adds the missing password to a jwtSecret-only file, reusing secret and createdAt", () => {
    const existingSecret = "persisted-secret-that-is-32-chars-x";
    fs.writeFileSync(
      resolveBootstrapPath(),
      JSON.stringify({ jwtSecret: existingSecret, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      bootstrapAuth();
    } finally {
      log.mockRestore();
    }

    expect(process.env.JWT_SECRET).toBe(existingSecret);
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    const stored = readStored();
    expect(stored.jwtSecret).toBe(existingSecret);
    expect(stored.adminPassword).toBe(process.env.ADMIN_PASSWORD!);
    expect(stored.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("write falls back to copy-over when rename fails, keeping mode 600 and no temp", () => {
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EPERM: simulated Windows rename failure");
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      bootstrapAuth();
    } finally {
      renameSpy.mockRestore();
      log.mockRestore();
    }

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
    if (process.platform !== "win32") {
      expect(fs.statSync(resolveBootstrapPath()).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  test("still injects when the post-copy chmod fails (best-effort hardening)", () => {
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EPERM: simulated rename failure");
    });
    const chmodSpy = spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("ENOSYS: simulated unsupported chmod");
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      bootstrapAuth();
      expect(warn.mock.calls.flat().join("\n")).toContain("could not restrict permissions");
    } finally {
      renameSpy.mockRestore();
      chmodSpy.mockRestore();
      log.mockRestore();
      warn.mockRestore();
    }

    expect(process.env.JWT_SECRET).toBeDefined();
    expect(process.env.ADMIN_PASSWORD).toBeDefined();
    expect(readStored().jwtSecret).toBe(process.env.JWT_SECRET!);
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  test("fails open when both rename and copy fail, leaving no temp behind", () => {
    const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EPERM: simulated rename failure");
    });
    const copySpy = spyOn(fs, "copyFileSync").mockImplementation(() => {
      // A non-Error throw also exercises the String(error) logging branch.
      throw "simulated non-Error copy failure";
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => bootstrapAuth()).not.toThrow();
      expect(warn.mock.calls.flat().join("\n")).toContain("auth bootstrap skipped");
    } finally {
      renameSpy.mockRestore();
      copySpy.mockRestore();
      warn.mockRestore();
    }

    expect(process.env.JWT_SECRET).toBeUndefined();
    expect(process.env.ADMIN_PASSWORD).toBeUndefined();
    expect(fs.existsSync(resolveBootstrapPath())).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
