import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "@/lib/logger";
import { rehashStoredPassword, seedAccountsIfEmpty } from "@/lib/local-accounts";
import { closeStorageProvider } from "@/lib/storage/factory";
import type { ServerStorageProvider, StoredAccount } from "@/lib/storage/types";

const saved: Record<string, string | undefined> = {};

function remember(keys: string[]) {
  for (const key of keys) saved[key] = process.env[key];
}

function restore(keys: string[]) {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function stub(overrides: Partial<ServerStorageProvider>): ServerStorageProvider {
  return {
    initialize: async () => {},
    isHealthy: async () => true,
    close: async () => {},
    getAllData: async () => ({}),
    getCollection: async () => null,
    setCollection: async () => {},
    mergeData: async () => {},
    listAccounts: async () => [],
    getAccount: async () => null,
    insertAccount: async () => {},
    updateAccount: async () => {},
    deleteAccount: async () => {},
    ...overrides,
  };
}

const row: StoredAccount = {
  email: "admin@libredb.org",
  passwordHash: "scrypt$already",
  role: "admin",
  totpSecret: null,
  totpPending: null,
  disabled: false,
  createdAt: "t",
  updatedAt: "t",
};

describe("seedAccountsIfEmpty", () => {
  afterEach(() => {
    restore(["USER_PASSWORD"]);
  });

  test("does nothing when the store already has a row", async () => {
    const insertAccount = mock(async () => {});
    await seedAccountsIfEmpty(stub({ listAccounts: async () => [row], insertAccount }));
    expect(insertAccount).not.toHaveBeenCalled();
  });

  test("adopts the row when a concurrent seed won the insert", async () => {
    delete process.env.USER_PASSWORD;
    const insertAccount = mock(async () => {
      throw Object.assign(new Error("UNIQUE constraint failed: accounts.email"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      });
    });
    await seedAccountsIfEmpty(stub({ insertAccount, getAccount: async () => row }));
    expect(insertAccount).toHaveBeenCalledTimes(1);
  });

  test("accepts a postgres unique violation the same way", async () => {
    delete process.env.USER_PASSWORD;
    const insertAccount = mock(async () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    });
    await expect(seedAccountsIfEmpty(stub({ insertAccount, getAccount: async () => row }))).resolves.toBeUndefined();
  });

  test("rethrows a unique violation that did not leave a row", async () => {
    delete process.env.USER_PASSWORD;
    const insertAccount = mock(async () => {
      throw new Error("UNIQUE constraint failed: accounts.email");
    });
    await expect(seedAccountsIfEmpty(stub({ insertAccount, getAccount: async () => null }))).rejects.toThrow(/UNIQUE/);
  });

  test("rethrows anything that is not a unique violation", async () => {
    delete process.env.USER_PASSWORD;
    await expect(
      seedAccountsIfEmpty(
        stub({
          insertAccount: async () => {
            throw new Error("disk");
          },
        }),
      ),
    ).rejects.toThrow("disk");
    await expect(
      seedAccountsIfEmpty(
        stub({
          insertAccount: async () => {
            throw { code: "no" };
          },
        }),
      ),
    ).rejects.toEqual({ code: "no" });
  });
});

describe("rehashStoredPassword", () => {
  const keys = ["STORAGE_PROVIDER", "STORAGE_POSTGRES_URL", "STORAGE_SQLITE_PATH"];

  afterEach(async () => {
    await closeStorageProvider();
    restore(keys);
  });

  test("returns when there is no server store", async () => {
    remember(keys);
    delete process.env.STORAGE_PROVIDER;
    await expect(rehashStoredPassword("admin@libredb.org", process.env.ADMIN_PASSWORD ?? "")).resolves.toBeUndefined();
  });

  test("logs and does not throw when the store cannot be opened", async () => {
    remember(keys);
    process.env.STORAGE_PROVIDER = "postgres";
    delete process.env.STORAGE_POSTGRES_URL;
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await rehashStoredPassword("admin@libredb.org", process.env.ADMIN_PASSWORD ?? "");
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("rehash"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
