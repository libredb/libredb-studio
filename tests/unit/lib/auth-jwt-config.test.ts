import { describe, test, expect, mock, afterEach } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";

// auth.ts imports `cookies` from next/headers at module load; stub it so the
// module imports cleanly in the test runtime (signJWT itself never uses it).
// The mock replaces the whole module, so every import auth.ts makes must appear
// here - a missing name is a link-time "Export named 'x' not found" that fails
// the file in isolation (which is how tests/run-core.sh runs it).
mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => ({ get: () => null }),
}));

const { signJWT } = await import("@/lib/auth");

// ORDER-INDEPENDENT BY CONSTRUCTION: the dev-fallback success case runs FIRST, so a
// successful secret read is always behind us by the time the guards are exercised.
// signJWT re-reads JWT_SECRET on every call, so there is nothing to carry over. If a
// module-level memo is ever reintroduced in auth.ts, the two throwing cases below fail
// immediately - here, and under `bun run test`, where every file shares one process and
// any earlier signature would otherwise answer before the guard could throw.
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

  test("uses the dev fallback (no throw) when JWT_SECRET is missing outside production", async () => {
    delete (process.env as Record<string, string>).JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "development";

    await expect(signJWT({ role: "admin", username: "admin" })).resolves.toBeString();
  });

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

  test("signs with the current JWT_SECRET after a rotation, without a restart", async () => {
    (process.env as Record<string, string>).JWT_SECRET = "a".repeat(32);
    (process.env as Record<string, string>).NODE_ENV = "production";
    const before = await signJWT({ role: "admin", username: "admin" });

    (process.env as Record<string, string>).JWT_SECRET = "b".repeat(32);
    const after = await signJWT({ role: "admin", username: "admin" });

    expect(after.split(".")[2]).not.toBe(before.split(".")[2]);
  });
});
