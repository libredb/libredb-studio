import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";
import { AccountError } from "@/lib/local-accounts";
import { requirePasskeyStoreMode, requireReadyPasskeys } from "@/lib/passkey/readiness";

const VARS = ["PASSKEY_ORIGIN", "STORAGE_PROVIDER", "NEXT_PUBLIC_AUTH_PROVIDER"] as const;
const saved: Record<string, string | undefined> = {};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  for (const name of VARS) delete process.env[name];
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("passkey readiness", () => {
  test("requireReadyPasskeys raises AccountError 409 when unavailable and AuthConfigError when misconfigured", () => {
    process.env.PASSKEY_ORIGIN = "https://studio.example.com";
    const local = thrown(requireReadyPasskeys);
    expect(local).toBeInstanceOf(AccountError);
    expect((local as AccountError).status).toBe(409);
    expect((local as AccountError).message).toContain("STORAGE_PROVIDER=sqlite or postgres");

    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const oidc = thrown(requireReadyPasskeys);
    expect(oidc).toBeInstanceOf(AccountError);
    expect((oidc as AccountError).status).toBe(409);
    expect((oidc as AccountError).message).toContain("identity provider");
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;

    process.env.STORAGE_PROVIDER = "sqlite";
    delete process.env.PASSKEY_ORIGIN;
    const off = thrown(requireReadyPasskeys);
    expect(off).toBeInstanceOf(AccountError);
    expect((off as AccountError).status).toBe(409);
    expect((off as AccountError).message).toContain("Passkeys are off on this server");

    process.env.PASSKEY_ORIGIN = "https://192.168.1.10";
    const bad = thrown(requireReadyPasskeys);
    expect(bad).toBeInstanceOf(AuthConfigError);
    expect((bad as AuthConfigError).message).toContain("IP address");

    process.env.PASSKEY_ORIGIN = "https://studio.example.com";
    expect(requireReadyPasskeys()).toEqual({ origin: "https://studio.example.com", rpId: "studio.example.com" });
  });

  test("requirePasskeyStoreMode refuses only the modes without a store", () => {
    const local = thrown(requirePasskeyStoreMode);
    expect(local).toBeInstanceOf(AccountError);
    expect((local as AccountError).status).toBe(409);

    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const oidc = thrown(requirePasskeyStoreMode);
    expect(oidc).toBeInstanceOf(AccountError);
    expect((oidc as AccountError).status).toBe(409);
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;

    expect(requirePasskeyStoreMode()).toBeUndefined();
    process.env.PASSKEY_ORIGIN = "not a url";
    expect(requirePasskeyStoreMode()).toBeUndefined();
  });
});
