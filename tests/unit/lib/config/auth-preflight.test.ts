import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { verifyAuthEnvAtBoot } from "@/lib/config/auth-preflight";

/**
 * Issue #227: a set-but-too-short JWT_SECRET used to pass every startup path
 * untouched (zero-config bootstrap only fills a MISSING secret) and only
 * surfaced as a 503 when a user tried to log in, while GET /api/db/health kept
 * reporting "healthy". The preflight turns that into a boot-time hard exit.
 */
describe("config/auth-preflight verifyAuthEnvAtBoot", () => {
  const origSecret = process.env.JWT_SECRET;

  afterEach(() => {
    setSecret(origSecret);
  });

  function setSecret(value: string | undefined): void {
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;
  }

  /** Stub process.exit so a fatal preflight cannot take the test runner down. */
  function stubProcessExit(): { exitCalls: Array<number | undefined>; restore: () => void } {
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    return {
      exitCalls,
      restore: () => {
        process.exit = originalExit;
      },
    };
  }

  test("allows boot to continue when JWT_SECRET meets the 32-character minimum", () => {
    setSecret("a-valid-secret-that-is-32-chars!");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("allows boot to continue when JWT_SECRET is unset (zero-config bootstrap owns that case)", () => {
    setSecret(undefined);
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  test("treats an empty JWT_SECRET as unset, not as too short", () => {
    setSecret("");
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  test("exits 1 with an actionable banner when JWT_SECRET is shorter than 32 characters", () => {
    setSecret("x".repeat(24)); // Cosmos randomString(24), issue #227
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(false);
      expect(exitCalls).toEqual([1]);
      const banner = errorSpy.mock.calls.flat().join("\n");
      expect(banner).toContain("JWT_SECRET is too short");
      expect(banner).toContain("24 characters");
      expect(banner).toContain("32");
      expect(banner).toContain("openssl rand -base64 32");
      // The secret value itself must never reach the logs.
      expect(banner).not.toContain("x".repeat(24));
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("fails a one-character-under secret (boundary)", () => {
    setSecret("y".repeat(31));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(false);
      expect(exitCalls).toEqual([1]);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("31 characters");
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("accepts an exactly-32-character secret (boundary)", () => {
    setSecret("z".repeat(32));
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
    } finally {
      restore();
    }
  });
});
