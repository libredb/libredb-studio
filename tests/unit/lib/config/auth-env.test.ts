import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";
import { getJwtSecret, JWT_SECRET_MISSING_MESSAGE, JWT_SECRET_TOO_SHORT_MESSAGE } from "@/lib/config/auth-env";

// getJwtSecret is stateless (no memoization), so every test sees a fresh read of
// process.env. Consumers (auth.ts, proxy.ts) layer their own lazy caches on top.
describe("config/auth-env getJwtSecret", () => {
  const origSecret = process.env.JWT_SECRET;
  const origNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    setEnv("JWT_SECRET", origSecret);
    setEnv("NODE_ENV", origNodeEnv);
  });

  function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete (process.env as Record<string, string>)[key];
    else (process.env as Record<string, string>)[key] = value;
  }

  test("returns the encoded secret when JWT_SECRET is valid", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");

    expect(getJwtSecret()).toEqual(new TextEncoder().encode("a-valid-secret-that-is-32-chars!"));
  });

  test("throws AuthConfigError with the missing message when JWT_SECRET is missing in production", () => {
    setEnv("JWT_SECRET", undefined);
    setEnv("NODE_ENV", "production");

    expect(() => getJwtSecret()).toThrow(AuthConfigError);
    expect(() => getJwtSecret()).toThrow(JWT_SECRET_MISSING_MESSAGE);
  });

  test("throws AuthConfigError when JWT_SECRET is shorter than 32 characters", () => {
    setEnv("JWT_SECRET", "too-short");
    setEnv("NODE_ENV", "production");

    expect(() => getJwtSecret()).toThrow(AuthConfigError);
    expect(() => getJwtSecret()).toThrow(JWT_SECRET_TOO_SHORT_MESSAGE);
  });

  test("enforces the 32-character minimum outside production too", () => {
    setEnv("JWT_SECRET", "too-short");
    setEnv("NODE_ENV", "development");

    expect(() => getJwtSecret()).toThrow(AuthConfigError);
    expect(() => getJwtSecret()).toThrow(JWT_SECRET_TOO_SHORT_MESSAGE);
  });

  test("returns the development fallback with a warning when JWT_SECRET is missing outside production", () => {
    setEnv("JWT_SECRET", undefined);
    setEnv("NODE_ENV", "development");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(getJwtSecret()).toEqual(new TextEncoder().encode("development-fallback-secret-32ch"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("allowDevFallback: false throws even outside production when JWT_SECRET is missing", () => {
    setEnv("JWT_SECRET", undefined);
    setEnv("NODE_ENV", "development");

    expect(() => getJwtSecret({ allowDevFallback: false })).toThrow(AuthConfigError);
    expect(() => getJwtSecret({ allowDevFallback: false })).toThrow(JWT_SECRET_MISSING_MESSAGE);
  });

  test("missingMessage overrides the error text when JWT_SECRET is missing", () => {
    setEnv("JWT_SECRET", undefined);
    setEnv("NODE_ENV", "production");

    expect(() => getJwtSecret({ missingMessage: "custom missing-secret message" })).toThrow(
      "custom missing-secret message",
    );
  });
});
