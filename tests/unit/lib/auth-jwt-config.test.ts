import { describe, test, expect, mock, afterEach } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";

// auth.ts imports `cookies` from next/headers at module load; stub it so the
// module imports cleanly in the test runtime (signJWT itself never uses it).
mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const { signJWT } = await import("@/lib/auth");

// NOTE ON ORDERING: getJwtSecret() memoizes the first *successful* result in a
// module-level cache. The throwing cases below never cache, so they are safe in
// any order — but the dev-fallback success case must run LAST, otherwise its
// cached key would mask the throws. This file runs in its own process (see
// tests/run-core.sh), so the cache starts empty.
describe("auth JWT_SECRET config guard", () => {
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

  test("throws AuthConfigError when JWT_SECRET is missing in production", async () => {
    delete (process.env as Record<string, string>).JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";

    await expect(signJWT({ role: "admin", username: "admin" })).rejects.toThrow(AuthConfigError);
  });

  test("throws AuthConfigError when JWT_SECRET is shorter than 32 characters", async () => {
    (process.env as Record<string, string>).JWT_SECRET = "too-short";
    (process.env as Record<string, string>).NODE_ENV = "production";

    await expect(signJWT({ role: "admin", username: "admin" })).rejects.toThrow(AuthConfigError);
  });

  // Must run last — this is the only case that populates the memoized cache.
  test("uses the dev fallback (no throw) when JWT_SECRET is missing outside production", async () => {
    delete (process.env as Record<string, string>).JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "development";

    await expect(signJWT({ role: "admin", username: "admin" })).resolves.toBeString();
  });
});
