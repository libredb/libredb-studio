import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeAccount, createAccount, removeAccount, seedAccountsIfEmpty } from "@/lib/local-accounts";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage/factory";

// The registry must never be left without an enabled admin. A check in application code that
// reads, awaits, then writes lets two concurrent requests both pass it, so the store enforces the
// rule inside the write's own transaction. These cases race two requests in one process.

const dir = mkdtempSync(join(tmpdir(), "libredb-last-admin-"));
const KEYS = ["STORAGE_PROVIDER", "STORAGE_SQLITE_PATH", "NEXT_PUBLIC_AUTH_PROVIDER", "ADMIN_TOTP_SECRET", "USER_TOTP_SECRET"];
const savedEnv: Record<string, string | undefined> = {};
const ENV_ADMIN = "admin@libredb.org";

async function enabledAdmins(): Promise<string[]> {
  const provider = await getStorageProvider();
  return (await provider?.listAccounts() ?? [])
    .filter((account) => account.role === "admin" && !account.disabled)
    .map((account) => account.email);
}

describe("the last enabled admin under concurrent changes", () => {
  beforeAll(() => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
  });

  beforeEach(async () => {
    await closeStorageProvider();
    process.env.STORAGE_SQLITE_PATH = join(dir, `store-${crypto.randomUUID()}.db`);
    const provider = await getStorageProvider();
    if (!provider) throw new Error("sqlite provider missing");
    await seedAccountsIfEmpty(provider);
    await createAccount(ENV_ADMIN, { email: "second@libredb.org", password: "second-pass-1", role: "admin" });
    expect(await enabledAdmins()).toHaveLength(2);
  });

  afterAll(async () => {
    await closeStorageProvider();
    for (const key of KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const removals: Record<string, (email: string) => Promise<unknown>> = {
    demote: (email) => changeAccount(ENV_ADMIN, email, { role: "user" }),
    disable: (email) => changeAccount(ENV_ADMIN, email, { disabled: true }),
    delete: (email) => removeAccount(ENV_ADMIN, email),
  };

  for (const [first, firstChange] of Object.entries(removals)) {
    for (const [second, secondChange] of Object.entries(removals)) {
      test(`${first} and ${second} of the two admins at once leave one of them`, async () => {
        const outcomes = await Promise.allSettled([firstChange(ENV_ADMIN), secondChange("second@libredb.org")]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const refused = outcomes.find((outcome) => outcome.status === "rejected");
        expect((refused as PromiseRejectedResult).reason).toMatchObject({
          status: 409,
          message: "The last enabled admin cannot be removed.",
        });
        expect(await enabledAdmins()).toHaveLength(1);
      });
    }
  }

  test("a change that keeps an admin is not held back by the check", async () => {
    await createAccount(ENV_ADMIN, { email: "someone@libredb.org", password: "someone-pass-1", role: "user" });
    const outcomes = await Promise.allSettled([
      changeAccount(ENV_ADMIN, "second@libredb.org", { role: "user" }),
      changeAccount(ENV_ADMIN, "someone@libredb.org", { disabled: true }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(await enabledAdmins()).toEqual([ENV_ADMIN]);
  });
});
