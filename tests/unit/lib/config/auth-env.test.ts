import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { AuthConfigError } from "@/lib/auth-errors";
import { SignJWT } from "jose";
import { verifyJWT } from "@/lib/auth";
import {
  derivedSigningKey,
  getJwtSecret,
  JWT_SECRET_MISSING_MESSAGE,
  JWT_SECRET_TOO_SHORT_MESSAGE,
  SESSION_TTL_DEFAULT_SECONDS,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MIN_SECONDS,
  sessionTtlSeconds,
} from "@/lib/config/auth-env";

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

describe("config/auth-env derivedSigningKey", () => {
  const origSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (origSecret === undefined) delete (process.env as Record<string, string>).JWT_SECRET;
    else process.env.JWT_SECRET = origSecret;
  });

  test("a derived key differs from the raw secret and differs per label", async () => {
    process.env.JWT_SECRET = "a-valid-secret-that-is-32-chars!";
    const a = await derivedSigningKey("a");
    const b = await derivedSigningKey("b");

    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(getJwtSecret()))).toBe(false);
    expect(Buffer.from(await derivedSigningKey("a")).equals(Buffer.from(a))).toBe(true);
  });

  test("a derived key is HMAC-SHA256 of the label under JWT_SECRET", async () => {
    // The derivation is fixed, not just deterministic: moving an existing key onto it must keep its tokens valid.
    const secret = "a-valid-secret-that-is-32-chars!";
    process.env.JWT_SECRET = secret;
    for (const label of ["libredb.passkey.ceremony.v1", "a"]) {
      const expected = createHmac("sha256", secret).update(label).digest();
      // oxlint-disable-next-line no-await-in-loop -- two labels, checked in turn.
      expect(Buffer.from(await derivedSigningKey(label)).equals(expected)).toBe(true);
    }
  });

  test("a derived key honours the JWT_SECRET options and refuses a missing secret without the fallback", async () => {
    delete (process.env as Record<string, string>).JWT_SECRET;
    await expect(
      derivedSigningKey("a", { allowDevFallback: false, missingMessage: "custom missing-secret message" }),
    ).rejects.toThrow("custom missing-secret message");
  });

  test("a token signed with a derived key does not verify as a session", async () => {
    process.env.JWT_SECRET = "a-valid-secret-that-is-32-chars!";
    const token = await new SignJWT({ role: "admin", username: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await derivedSigningKey("libredb.passkey.ceremony.v1"));

    expect(await verifyJWT(token)).toBeNull();
  });
});

describe("config/auth-env sessionTtlSeconds", () => {
  const orig = process.env.AUTH_SESSION_TTL_SECONDS;

  afterEach(() => {
    if (orig === undefined) delete process.env.AUTH_SESSION_TTL_SECONDS;
    else process.env.AUTH_SESSION_TTL_SECONDS = orig;
  });

  test("defaults to 86400 seconds, the fixed 24-hour lifetime, when unset or blank", () => {
    delete process.env.AUTH_SESSION_TTL_SECONDS;
    expect(SESSION_TTL_DEFAULT_SECONDS).toBe(86400);
    expect(sessionTtlSeconds()).toBe(86400);
    process.env.AUTH_SESSION_TTL_SECONDS = "  ";
    expect(sessionTtlSeconds()).toBe(86400);
  });

  test("returns a set integer inside the range, including both bounds, trimmed", () => {
    process.env.AUTH_SESSION_TTL_SECONDS = "28800";
    expect(sessionTtlSeconds()).toBe(28800);
    process.env.AUTH_SESSION_TTL_SECONDS = ` ${SESSION_TTL_MIN_SECONDS} `;
    expect(sessionTtlSeconds()).toBe(300);
    process.env.AUTH_SESSION_TTL_SECONDS = String(SESSION_TTL_MAX_SECONDS);
    expect(sessionTtlSeconds()).toBe(86400);
  });

  test("throws AuthConfigError naming the variable for a non-integer or out-of-range value", () => {
    for (const value of ["299", "86401", "abc", "3600.5", "1e4", "-600", "0x12c"]) {
      process.env.AUTH_SESSION_TTL_SECONDS = value;
      expect(() => sessionTtlSeconds()).toThrow(AuthConfigError);
      expect(() => sessionTtlSeconds()).toThrow("AUTH_SESSION_TTL_SECONDS");
    }
  });
});
