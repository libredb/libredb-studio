import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";
import {
  AccountError,
  ownFactorStatus,
  provisionLaunchAccount,
  requireAccountStore,
  resolveLocalAuthUsers,
  storedAccountAllows,
} from "@/lib/local-accounts";
import { getAuthUsers } from "@/lib/local-auth";
import { closeStorageProvider } from "@/lib/storage/factory";

// openshift mode behaves as oidc for the account store: every account path answers before the store is opened, so a
// postgres store with no URL (which fails the moment it is opened) proves the store was never reached. An unknown mode
// value throws the invalid-mode message at each of the five places instead of falling back to local sign-in.
const KEYS = [
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "STORAGE_PROVIDER",
  "STORAGE_POSTGRES_URL",
  "ADMIN_PASSWORD",
  "GOVERNANCE_SOURCE",
] as const;
const INVALID = "NEXT_PUBLIC_AUTH_PROVIDER must be local, oidc or openshift, or unset for local";
const SESSION = { username: "dev-a", role: "user" as const, iat: 1 };
const LAUNCH = { email: "dev-a@example.com", role: "user" as const, issuer: "platform", subject: "platform-user-1" };

let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  await closeStorageProvider();
  process.env.STORAGE_PROVIDER = "postgres";
  process.env.ADMIN_PASSWORD = "password-set-by-admin";
});

afterEach(async () => {
  await closeStorageProvider();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function thrown(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("local accounts in openshift mode", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
  });

  test("requireAccountStore answers 409 before it opens the store", async () => {
    const error = await thrown(() => requireAccountStore());
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).status).toBe(409);
  });

  test("resolveLocalAuthUsers keeps the environment accounts without opening the store", async () => {
    expect(await resolveLocalAuthUsers()).toEqual(getAuthUsers());
  });

  test("storedAccountAllows accepts without opening the store", async () => {
    expect(await storedAccountAllows(SESSION)).toBe(true);
  });

  test("provisionLaunchAccount answers 409 before it opens the store", async () => {
    const error = await thrown(() => provisionLaunchAccount(LAUNCH));
    expect((error as AccountError).status).toBe(409);
  });

  test("ownFactorStatus offers no authenticator", async () => {
    expect(await ownFactorStatus("dev-a@example.com")).toEqual({
      available: false,
      reason: "Two-factor authentication for this sign-in is managed by your identity provider.",
    });
  });
});

describe("local accounts under an unknown mode value", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "OpenShift";
  });

  test("each of the five places throws the invalid-mode message", async () => {
    const errors = await Promise.all([
      thrown(() => requireAccountStore()),
      thrown(() => resolveLocalAuthUsers()),
      thrown(() => storedAccountAllows(SESSION)),
      thrown(() => provisionLaunchAccount(LAUNCH)),
      thrown(() => ownFactorStatus("dev-a@example.com")),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(AuthConfigError);
      expect(error.message).toBe(INVALID);
    }
  });
});
